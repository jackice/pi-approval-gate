import crypto from "node:crypto";

import type { ApprovalRisk } from "@jackice/pi-ui";

export type ApprovalDecision = "allow_once" | "deny" | "timeout" | "cancelled";
export type PromptChoice = "allow_once" | "deny";

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  command: string;
  cwd: string;
  reason: string;
  risk: ApprovalRisk;
  fingerprint: string;
}

export interface ApprovalBinding {
  requestId: string;
  sessionId: string;
  toolCallId: string;
  command: string;
  cwd: string;
}

export interface ApprovalAuthorization {
  consume(binding: ApprovalBinding): boolean;
  revoke(): void;
}

export interface ApprovalResult {
  decision: ApprovalDecision;
  request: ApprovalRequest;
  authorization?: ApprovalAuthorization;
}

export interface PromptHandle {
  promise: Promise<PromptChoice>;
  cancel: () => void;
}

export interface GateOptions {
  timeoutMs: number | (() => number);
  maxPending: number;
  createId?: () => string;
}

interface QueuedRequest {
  request: ApprovalRequest;
  prompt: (request: ApprovalRequest) => PromptHandle;
  resolve: (result: ApprovalResult) => void;
  settled: boolean;
  deadline: number;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
  cancelPrompt?: () => void;
  authorization?: ApprovalAuthorization;
}

export function fingerprint(command: string, cwd: string): string {
  return crypto.createHash("sha256").update(`${cwd}\0${command}`).digest("hex");
}

/**
 * 单写者审批队列。超时/abort/shutdown 都走同一幂等 settle 路径，
 * 不依赖 custom<T> 的 Promise 结算。
 */
export class ApprovalGate {
  private readonly timeoutMs: number | (() => number);
  private readonly maxPending: number;
  private readonly createId: () => string;
  private readonly queue: QueuedRequest[] = [];
  private readonly authorizations = new Set<ApprovalAuthorization>();
  private active: QueuedRequest | undefined;
  private closed = false;

  constructor(options: GateOptions) {
    this.timeoutMs = options.timeoutMs;
    this.maxPending = Math.max(1, options.maxPending);
    this.createId = options.createId ?? (() => crypto.randomUUID());
  }

  request(
    request: Omit<ApprovalRequest, "id" | "fingerprint">,
    options: { signal?: AbortSignal; prompt: (request: ApprovalRequest) => PromptHandle },
  ): Promise<ApprovalResult> {
    if (this.closed) return Promise.resolve({ decision: "deny", request: { ...request, id: "", fingerprint: "" } });
    const pending = this.queue.length + (this.active === undefined ? 0 : 1);
    if (pending >= this.maxPending) {
      return Promise.resolve({ decision: "deny", request: { ...request, id: "", fingerprint: "" } });
    }

    const full: ApprovalRequest = {
      ...request,
      id: this.createId(),
      fingerprint: fingerprint(request.command, request.cwd),
    };
    const timeoutMs = typeof this.timeoutMs === "function" ? this.timeoutMs() : this.timeoutMs;
    const { promise, resolve } = Promise.withResolvers<ApprovalResult>();
    const entry: QueuedRequest = {
      request: full,
      prompt: options.prompt,
      resolve,
      settled: false,
      deadline: performance.now() + timeoutMs,
      timer: setTimeout(() => this.settle(entry, "timeout"), timeoutMs),
    };
    entry.timer.unref?.();
    if (options.signal !== undefined) {
      entry.signal = options.signal;
      entry.onAbort = () => {
        if (entry.authorization !== undefined) entry.authorization.revoke();
        else this.settle(entry, "cancelled");
      };
      if (options.signal.aborted) {
        this.settle(entry, "cancelled");
        return promise;
      }
      options.signal.addEventListener("abort", entry.onAbort, { once: true });
    }
    this.queue.push(entry);
    this.pump();
    return promise;
  }

  cancelAll(): void {
    this.closed = true;
    for (const authorization of this.authorizations) authorization.revoke();
    const entries = this.active === undefined ? [...this.queue] : [this.active, ...this.queue];
    for (const entry of entries) this.settle(entry, "cancelled", false);
  }

  get pendingCount(): number {
    return this.queue.length + (this.active === undefined ? 0 : 1);
  }

  private createAuthorization(entry: QueuedRequest): ApprovalAuthorization {
    let active = true;
    const revoke = (): void => {
      if (!active) return;
      active = false;
      clearTimeout(timer);
      if (entry.signal !== undefined && entry.onAbort !== undefined) {
        entry.signal.removeEventListener("abort", entry.onAbort);
      }
      this.authorizations.delete(authorization);
    };
    const authorization: ApprovalAuthorization = {
      consume: (binding) => {
        const valid = active
          && !this.closed
          && entry.signal?.aborted !== true
          && performance.now() < entry.deadline
          && binding.requestId === entry.request.id
          && binding.sessionId === entry.request.sessionId
          && binding.toolCallId === entry.request.toolCallId
          && fingerprint(binding.command, binding.cwd) === entry.request.fingerprint;
        revoke();
        return valid;
      },
      revoke,
    };
    const timer = setTimeout(revoke, Math.max(0, entry.deadline - performance.now()));
    timer.unref?.();
    this.authorizations.add(authorization);
    return authorization;
  }

  private pump(): void {
    if (this.active !== undefined) return;
    const entry = this.queue.shift();
    if (entry === undefined) return;
    if (entry.settled) {
      this.pump();
      return;
    }
    this.active = entry;
    let handle: PromptHandle;
    try {
      handle = entry.prompt(entry.request);
    } catch {
      this.settle(entry, "deny");
      return;
    }
    entry.cancelPrompt = handle.cancel;
    void handle.promise.then(
      (choice) => this.settle(entry, choice),
      () => this.settle(entry, "deny"),
    );
  }

  private settle(entry: QueuedRequest, decision: ApprovalDecision, pump = true): void {
    if (entry.settled) return;
    if (decision === "allow_once") {
      if (this.closed) decision = "cancelled";
      else if (entry.signal?.aborted) decision = "cancelled";
      else if (performance.now() >= entry.deadline) decision = "timeout";
    }
    entry.settled = true;
    clearTimeout(entry.timer);
    try {
      entry.cancelPrompt?.();
    } catch {
      // 宿主组件可能已销毁；结算不依赖关闭 UI。
    }
    if (this.active === entry) this.active = undefined;
    const index = this.queue.indexOf(entry);
    if (index >= 0) this.queue.splice(index, 1);
    if (decision === "allow_once") {
      entry.authorization = this.createAuthorization(entry);
    } else if (entry.signal !== undefined && entry.onAbort !== undefined) {
      entry.signal.removeEventListener("abort", entry.onAbort);
    }
    entry.resolve({
      decision,
      request: entry.request,
      ...(entry.authorization === undefined ? {} : { authorization: entry.authorization }),
    });
    if (pump) this.pump();
  }
}


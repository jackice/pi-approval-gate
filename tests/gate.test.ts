import { afterEach, describe, expect, it, vi } from "vitest";

import { ApprovalGate, type PromptChoice, type PromptHandle } from "../src/gate.ts";

interface PromptControl {
  handle: PromptHandle;
  resolve: (choice: PromptChoice) => void;
  reject: (error: Error) => void;
  cancelled: () => number;
}

function promptControl(): PromptControl {
  const { promise, resolve, reject } = Promise.withResolvers<PromptChoice>();
  let cancelled = 0;
  return {
    handle: {
      promise,
      cancel: () => {
        cancelled++;
      },
    },
    resolve,
    reject,
    cancelled: () => cancelled,
  };
}

const baseRequest = {
  sessionId: "session-1",
  toolCallId: "call-1",
  toolName: "bash",
  command: "rm -rf /tmp/x",
  cwd: "/tmp/work",
  reason: "removal",
  risk: "high" as const,
};

async function approve(gate: ApprovalGate) {
  const control = promptControl();
  const result = gate.request(baseRequest, { prompt: () => control.handle });
  control.resolve("allow_once");
  return result;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ApprovalGate", () => {
  it("returns allow_once and deny from the prompt", async () => {
    const gate = new ApprovalGate({ timeoutMs: 1000, maxPending: 4 });
    const allowed = promptControl();
    const allowPromise = gate.request(baseRequest, { prompt: () => allowed.handle });
    allowed.resolve("allow_once");
    await expect(allowPromise).resolves.toMatchObject({ decision: "allow_once" });

    const denied = promptControl();
    const denyPromise = gate.request(baseRequest, { prompt: () => denied.handle });
    denied.resolve("deny");
    await expect(denyPromise).resolves.toMatchObject({ decision: "deny" });
  });

  it("times out and cancels the prompt", async () => {
    vi.useFakeTimers();
    const gate = new ApprovalGate({ timeoutMs: 1000, maxPending: 4 });
    const control = promptControl();
    const result = gate.request(baseRequest, { prompt: () => control.handle });
    vi.advanceTimersByTime(1000);
    await expect(result).resolves.toMatchObject({ decision: "timeout" });
    expect(control.cancelled()).toBe(1);
  });

  it("cancels on abort and resolves once", async () => {
    const gate = new ApprovalGate({ timeoutMs: 1000, maxPending: 4 });
    const control = promptControl();
    const controller = new AbortController();
    const result = gate.request(baseRequest, { prompt: () => control.handle, signal: controller.signal });
    controller.abort();
    controller.abort();
    await expect(result).resolves.toMatchObject({ decision: "cancelled" });
    expect(control.cancelled()).toBe(1);
  });

  it("rejects immediately when the queue is full", async () => {
    const gate = new ApprovalGate({ timeoutMs: 1000, maxPending: 1 });
    const control = promptControl();
    const first = gate.request(baseRequest, { prompt: () => control.handle });
    const second = await gate.request(baseRequest, { prompt: () => control.handle });
    expect(second.decision).toBe("deny");
    control.resolve("deny");
    await first;
  });

  it("consumes a request-bound authorization exactly once", async () => {
    const gate = new ApprovalGate({ timeoutMs: 1000, maxPending: 1 });
    const control = promptControl();
    const result = gate.request(baseRequest, { prompt: () => control.handle });
    control.resolve("allow_once");
    const approved = await result;
    const authorization = approved.authorization!;
    expect(approved.request.fingerprint).toHaveLength(64);
    expect(authorization.consume({
      requestId: approved.request.id,
      sessionId: baseRequest.sessionId,
      toolCallId: baseRequest.toolCallId,
      command: baseRequest.command,
      cwd: baseRequest.cwd,
    })).toBe(true);
    expect(authorization.consume({
      requestId: approved.request.id,
      sessionId: baseRequest.sessionId,
      toolCallId: baseRequest.toolCallId,
      command: baseRequest.command,
      cwd: baseRequest.cwd,
    })).toBe(false);
  });


  it("expires an allow-once authorization at the original request deadline", async () => {
    vi.useFakeTimers();
    const gate = new ApprovalGate({ timeoutMs: 1000, maxPending: 4, createId: () => "request-1" });
    const control = promptControl();
    const result = gate.request(
      baseRequest,
      { prompt: () => control.handle },
    );
    control.resolve("allow_once");
    const approved = await result;

    vi.advanceTimersByTime(1000);
    expect(approved.authorization!.consume({
      requestId: approved.request.id,
      sessionId: baseRequest.sessionId,
      toolCallId: baseRequest.toolCallId,
      command: baseRequest.command,
      cwd: baseRequest.cwd,
    })).toBe(false);
  });

  it("revokes an unconsumed authorization when its request is aborted", async () => {
    const gate = new ApprovalGate({ timeoutMs: 1000, maxPending: 1 });
    const control = promptControl();
    const controller = new AbortController();
    const result = gate.request(baseRequest, {
      signal: controller.signal,
      prompt: () => control.handle,
    });
    control.resolve("allow_once");
    const approved = await result;

    controller.abort();
    expect(approved.authorization!.consume({
      requestId: approved.request.id,
      sessionId: baseRequest.sessionId,
      toolCallId: baseRequest.toolCallId,
      command: baseRequest.command,
      cwd: baseRequest.cwd,
    })).toBe(false);
  });

  it("binds approvals to a unique request, session, tool call, command, and cwd", async () => {
    const gate = new ApprovalGate({ timeoutMs: 1000, maxPending: 4, createId: () => "request-1" });
    const control = promptControl();
    const result = gate.request(
      baseRequest,
      { prompt: () => control.handle },
    );
    control.resolve("allow_once");
    const approved = await result;

    const authorization = approved.authorization!;
    expect(authorization.consume({
      requestId: "request-2",
      sessionId: baseRequest.sessionId,
      toolCallId: baseRequest.toolCallId,
      command: baseRequest.command,
      cwd: baseRequest.cwd,
    })).toBe(false);
    const fresh = await approve(gate);
    expect(fresh.authorization!.consume({
      requestId: fresh.request.id,
      sessionId: "session-2",
      toolCallId: baseRequest.toolCallId,
      command: baseRequest.command,
      cwd: baseRequest.cwd,
    })).toBe(false);
    const another = await approve(gate);
    expect(another.authorization!.consume({
      requestId: another.request.id,
      sessionId: baseRequest.sessionId,
      toolCallId: "call-2",
      command: baseRequest.command,
      cwd: baseRequest.cwd,
    })).toBe(false);
    const last = await approve(gate);
    expect(last.authorization!.consume({
      requestId: last.request.id,
      sessionId: baseRequest.sessionId,
      toolCallId: baseRequest.toolCallId,
      command: baseRequest.command,
      cwd: "/tmp/other",
    })).toBe(false);
  });


  it("cancelAll revokes approved but unconsumed authorizations", async () => {
    const gate = new ApprovalGate({ timeoutMs: 1000, maxPending: 4 });
    const approved = await approve(gate);
    gate.cancelAll();
    expect(approved.authorization!.consume({
      requestId: approved.request.id,
      sessionId: baseRequest.sessionId,
      toolCallId: baseRequest.toolCallId,
      command: baseRequest.command,
      cwd: baseRequest.cwd,
    })).toBe(false);
    await expect(gate.request(baseRequest, { prompt: () => promptControl().handle })).resolves.toMatchObject({
      decision: "deny",
    });
  });
});

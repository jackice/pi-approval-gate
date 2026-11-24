import { afterEach, describe, expect, it, vi } from "vitest";

import { ApprovalGate, fingerprint, type PromptChoice, type PromptHandle } from "../src/gate.ts";

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
  toolName: "bash",
  command: "rm -rf /tmp/x",
  cwd: "/tmp/work",
  reason: "removal",
  risk: "high" as const,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("ApprovalGate", () => {
  it("returns allow_once and deny from the prompt", async () => {
    const gate = new ApprovalGate({ timeoutMs: 1000, maxPending: 4 });
    const allowed = promptControl();
    const allowPromise = gate.request(baseRequest, { prompt: () => allowed.handle });
    allowed.resolve("allow_once");
    await expect(allowPromise).resolves.toBe("allow_once");

    const denied = promptControl();
    const denyPromise = gate.request(baseRequest, { prompt: () => denied.handle });
    denied.resolve("deny");
    await expect(denyPromise).resolves.toBe("deny");
  });

  it("times out and cancels the prompt", async () => {
    vi.useFakeTimers();
    const gate = new ApprovalGate({ timeoutMs: 1000, maxPending: 4 });
    const control = promptControl();
    const result = gate.request(baseRequest, { prompt: () => control.handle });
    vi.advanceTimersByTime(1000);
    await expect(result).resolves.toBe("timeout");
    expect(control.cancelled()).toBe(1);
  });

  it("cancels on abort and resolves once", async () => {
    const gate = new ApprovalGate({ timeoutMs: 1000, maxPending: 4 });
    const control = promptControl();
    const controller = new AbortController();
    const result = gate.request(baseRequest, { prompt: () => control.handle, signal: controller.signal });
    controller.abort();
    controller.abort();
    await expect(result).resolves.toBe("cancelled");
    expect(control.cancelled()).toBe(1);
  });

  it("rejects immediately when the queue is full", async () => {
    const gate = new ApprovalGate({ timeoutMs: 1000, maxPending: 1 });
    const control = promptControl();
    const first = gate.request(baseRequest, { prompt: () => control.handle });
    const second = await gate.request(baseRequest, { prompt: () => control.handle });
    expect(second).toBe("deny");
    control.resolve("deny");
    await first;
  });

  it("consumes a final-parameter fingerprint once", () => {
    const gate = new ApprovalGate({ timeoutMs: 1000, maxPending: 1 });
    gate.expect("rm -rf /tmp/x", "/tmp/work");
    expect(fingerprint("rm -rf /tmp/x", "/tmp/work")).toHaveLength(64);
    expect(gate.consume("rm -rf /tmp/x", "/tmp/work")).toBe(true);
    expect(gate.consume("rm -rf /tmp/x", "/tmp/work")).toBe(false);
    expect(gate.consume("rm -rf /tmp/y", "/tmp/work")).toBe(false);

    gate.expect("rm -rf /tmp/x", "/tmp/work");
    gate.clear("rm -rf /tmp/x", "/tmp/work");
    expect(gate.consume("rm -rf /tmp/x", "/tmp/work")).toBe(false);
  });

  it("cancelAll clears tokens and rejects new requests", async () => {
    const gate = new ApprovalGate({ timeoutMs: 1000, maxPending: 4 });
    gate.expect("rm -rf /tmp/x", "/tmp/work");
    gate.cancelAll();
    expect(gate.consume("rm -rf /tmp/x", "/tmp/work")).toBe(false);
    const control = promptControl();
    await expect(gate.request(baseRequest, { prompt: () => control.handle })).resolves.toBe("deny");
  });
});

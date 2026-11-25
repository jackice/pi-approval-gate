import { describe, expect, it } from "vitest";

import { verifyFinalBinding } from "../src/binding.ts";
import { ApprovalGate, type ApprovalRequest } from "../src/gate.ts";

const env = {};
const request: Omit<ApprovalRequest, "id" | "fingerprint"> = {
  sessionId: "session-1",
  toolCallId: "call-1",
  toolName: "bash",
  command: "rm -rf target",
  cwd: "/tmp/work",
  reason: "removal",
  risk: "high",
};

async function approved() {
  const gate = new ApprovalGate({ timeoutMs: 1000, maxPending: 1 });
  const { promise, resolve } = Promise.withResolvers<"allow_once" | "deny">();
  const result = gate.request(request, {
    prompt: () => ({ promise, cancel: () => {} }),
  });
  resolve("allow_once");
  const outcome = await result;
  return { authorization: outcome.authorization!, request: outcome.request };
}

describe("verifyFinalBinding", () => {
  it("consumes an approval for its exact execution request once", async () => {
    const approvedCall = await approved();
    const context = verifyFinalBinding(approvedCall.authorization, approvedCall.request, {
      command: request.command,
      cwd: request.cwd,
      env,
    });
    expect(context.command).toBe(request.command);
    expect(() => verifyFinalBinding(approvedCall.authorization, approvedCall.request, {
      command: request.command,
      cwd: request.cwd,
      env,
    })).toThrow("approval binding mismatch");
  });

  it("rejects a mutated command or cwd and consumes the grant", async () => {
    const changedCommand = await approved();
    expect(() => verifyFinalBinding(changedCommand.authorization, changedCommand.request, {
      command: "rm -rf other",
      cwd: request.cwd,
      env,
    })).toThrow("approval binding mismatch");

    const changedCwd = await approved();
    expect(() => verifyFinalBinding(changedCwd.authorization, changedCwd.request, {
      command: request.command,
      cwd: "/tmp/other",
      env,
    })).toThrow("approval binding mismatch");
  });

  it("rejects a changed command even when the replacement looks safe", async () => {
    const changed = await approved();
    expect(() => verifyFinalBinding(changed.authorization, changed.request, {
      command: "echo harmless",
      cwd: request.cwd,
      env,
    })).toThrow("approval binding mismatch");
  });

  it("allows safe commands without an authorization", () => {
    expect(() => verifyFinalBinding(undefined, undefined, {
      command: "echo hi",
      cwd: "/tmp/work",
      env,
    })).not.toThrow();
  });

  it("rejects before binding when the execution signal is aborted", async () => {
    const approvedCall = await approved();
    const controller = new AbortController();
    controller.abort();
    expect(() => verifyFinalBinding(
      approvedCall.authorization,
      approvedCall.request,
      { command: request.command, cwd: request.cwd, env },
      controller.signal,
    )).toThrow("aborted");
  });
});

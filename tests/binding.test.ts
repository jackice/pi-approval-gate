import { describe, expect, it } from "vitest";

import { verifyFinalBinding } from "../src/binding.ts";
import { ApprovalGate } from "../src/gate.ts";

const env = {};
const command = "rm -rf target";

describe("verifyFinalBinding", () => {
  it("consumes an approved dangerous command exactly once", () => {
    const gate = new ApprovalGate({ timeoutMs: 1000, maxPending: 1 });
    gate.expect(command, "/tmp/work");
    const context = verifyFinalBinding(gate, { command, cwd: "/tmp/work", env });
    expect(context.command).toBe(command);
    expect(() => verifyFinalBinding(gate, { command, cwd: "/tmp/work", env })).toThrow(
      "approval binding mismatch",
    );
  });

  it("rejects a mutated command or cwd", () => {
    const gate = new ApprovalGate({ timeoutMs: 1000, maxPending: 1 });
    gate.expect(command, "/tmp/work");
    expect(() => verifyFinalBinding(gate, { command: "rm -rf other", cwd: "/tmp/work", env })).toThrow(
      "approval binding mismatch",
    );
    expect(() => verifyFinalBinding(gate, { command, cwd: "/tmp/other", env })).toThrow(
      "approval binding mismatch",
    );
    // 原批准仍可用于精确匹配的请求。
    expect(() => verifyFinalBinding(gate, { command, cwd: "/tmp/work", env })).not.toThrow();
  });

  it("allows safe commands without a token", () => {
    const gate = new ApprovalGate({ timeoutMs: 1000, maxPending: 1 });
    expect(() => verifyFinalBinding(gate, { command: "echo hi", cwd: "/tmp/work", env })).not.toThrow();
  });
});

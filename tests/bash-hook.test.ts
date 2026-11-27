import { expect, it } from "vitest";

import type { ApprovalAuthorization, ApprovalRequest } from "../src/gate.ts";
import { createBashSpawnHook } from "../src/bash-hook.ts";

const request = {
  id: "req",
  sessionId: "session-1",
  toolCallId: "call-1",
  toolName: "bash",
  command: "rm -rf /tmp/x",
  cwd: "/tmp/work",
  reason: "removal",
  risk: "high",
  fingerprint: "abc",
} as ApprovalRequest;

it("blocks a guarded command before consuming the approval", () => {
  let consumed = 0;
  const authorization = {
    consume: () => {
      consumed += 1;
      return true;
    },
    revoke: () => {},
  } as ApprovalAuthorization;
  const hook = createBashSpawnHook({
    guard: (command) => (command.includes("pip") ? "pip is disabled" : undefined),
    authorization,
    request,
  });

  expect(() => hook({ command: "pip install x", cwd: "/tmp", env: {} })).toThrow("pip is disabled");
  expect(consumed).toBe(0);
});

it("rejects a dangerous command that has no approval", () => {
  const hook = createBashSpawnHook({});

  expect(() => hook({ command: "rm -rf /tmp/x", cwd: "/tmp", env: {} })).toThrow(/binding mismatch/);
});

it("lets a policy-permitted command through without an approval", () => {
  const hook = createBashSpawnHook({});

  expect(() => hook({ command: "git push origin main", cwd: "/tmp", env: {} })).not.toThrow();
});

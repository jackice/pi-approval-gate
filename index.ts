import {
  createBashToolDefinition,
  type BashSpawnContext,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import { createApprovalPrompt } from "./src/dialog.ts";
import { verifyFinalBinding } from "./src/binding.ts";
import { ApprovalGate } from "./src/gate.ts";
import { dangerReason, isDangerousBash } from "./src/policy.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_ARM_MS = 500;
const MAX_PENDING = 16;
const MAX_COMMAND_LINES = 8;

export default function approvalGateExtension(pi: ExtensionAPI): void {
  pi.registerFlag("approval-timeout-ms", {
    description: "Pending bash approval timeout in milliseconds",
    type: "string",
  });
  pi.registerFlag("approval-arm-ms", {
    description: "Confirmation arm delay for Allow once",
    type: "string",
  });

  const timeoutMs = () => numberFlag(pi, "approval-timeout-ms", "PI_APPROVAL_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  const gate = new ApprovalGate({ timeoutMs, maxPending: MAX_PENDING });

  const verify = (spawnContext: BashSpawnContext): BashSpawnContext =>
    verifyFinalBinding(gate, spawnContext);

  const template = createBashToolDefinition(process.cwd(), { spawnHook: verify });
  pi.registerTool({
    ...template,
    executionMode: "sequential",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (!isDangerousBash(params.command)) {
        return createBashToolDefinition(ctx.cwd, { spawnHook: verify }).execute(
          toolCallId,
          params,
          signal,
          onUpdate,
          ctx,
        );
      }

      const decision = await gate.request(
        {
          toolName: "bash",
          command: params.command,
          cwd: ctx.cwd,
          reason: dangerReason(params.command),
          risk: "high",
        },
        {
          ...(signal === undefined ? {} : { signal }),
          prompt: (request) =>
            createApprovalPrompt(request, ctx, {
              armMs: numberFlag(pi, "approval-arm-ms", "PI_APPROVAL_ARM_MS", DEFAULT_ARM_MS),
              maxCommandLines: MAX_COMMAND_LINES,
            }),
        },
      );

      if (decision !== "allow_once") {
        return {
          content: [{ type: "text", text: `Blocked by approval gate (${decision}); command was not executed.` }],
          isError: true,
          details: undefined,
        };
      }

      gate.expect(params.command, ctx.cwd);
      try {
        return await createBashToolDefinition(ctx.cwd, { spawnHook: verify }).execute(
          toolCallId,
          params,
          signal,
          onUpdate,
          ctx,
        );
      } finally {
        gate.clear(params.command, ctx.cwd);
      }
    },
  });

  pi.on("session_shutdown", () => gate.cancelAll());
}

function numberFlag(
  pi: ExtensionAPI,
  flag: string,
  env: string,
  fallback: number,
): number {
  const raw = pi.getFlag(flag);
  const value = typeof raw === "string" ? raw : process.env[env];
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

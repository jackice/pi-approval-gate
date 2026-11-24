import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createBashToolDefinition,
  createLocalBashOperations,
  type BashSpawnContext,
  type BashToolOptions,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import { createApprovalPrompt } from "./src/dialog.ts";
import { verifyFinalBinding } from "./src/binding.ts";
import { ApprovalGate } from "./src/gate.ts";
import { dangerReason } from "./src/policy.ts";

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

  const timeoutMs = () =>
    numberFlag(pi, "approval-timeout-ms", "PI_APPROVAL_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  const gate = new ApprovalGate({ timeoutMs, maxPending: MAX_PENDING });
  const selfPath = fileURLToPath(import.meta.url);
  let shadowed = false;

  const verify = (spawnContext: BashSpawnContext): BashSpawnContext =>
    verifyFinalBinding(gate, spawnContext);

  const template = createBashToolDefinition(process.cwd(), { spawnHook: verify });
  pi.registerTool({
    ...template,
    executionMode: "sequential",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const command = params.command;
      const cwd = ctx.cwd;
      const shell = shellSettings(pi);
      const finalCommand = shell.commandPrefix ? `${shell.commandPrefix}\n${command}` : command;
      const options = bashOptions(shell, verify);
      const reason = dangerReason(finalCommand);

      if (reason === undefined) {
        return createBashToolDefinition(cwd, options).execute(
          toolCallId,
          { ...params, command },
          signal,
          onUpdate,
          ctx,
        );
      }

      const decision = await gate.request(
        {
          toolName: "bash",
          command: finalCommand,
          cwd,
          reason,
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

      gate.expect(finalCommand, cwd);
      try {
        return await createBashToolDefinition(cwd, options).execute(
          toolCallId,
          { ...params, command },
          signal,
          onUpdate,
          ctx,
        );
      } finally {
        gate.clear(finalCommand, cwd);
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const active = pi.getAllTools().find((tool) => tool.name === "bash");
    shadowed = active === undefined || resolve(active.sourceInfo.path) !== resolve(selfPath);
    if (shadowed && ctx.hasUI) {
      ctx.ui.notify(
        "approval gate is not active: another extension registered bash first; bash is blocked",
        "error",
      );
    }
  });

  pi.on("tool_call", (event) => {
    if (shadowed && event.toolName === "bash") {
      return { block: true, reason: "approval gate is not active (bash registration shadowed)" };
    }
    return undefined;
  });

  pi.on("user_bash", async (event, ctx) => {
    const reason = dangerReason(event.command);
    if (reason === undefined) return undefined;
    const decision = await gate.request(
      {
        toolName: "user_bash",
        command: event.command,
        cwd: event.cwd,
        reason,
        risk: "high",
      },
      {
        prompt: (request) =>
          createApprovalPrompt(request, ctx, {
            armMs: numberFlag(pi, "approval-arm-ms", "PI_APPROVAL_ARM_MS", DEFAULT_ARM_MS),
            maxCommandLines: MAX_COMMAND_LINES,
          }),
      },
    );
    if (decision !== "allow_once") {
      return {
        result: {
          output: `Blocked by approval gate (${decision}); command was not executed.`,
          exitCode: 1,
          cancelled: true,
          truncated: false,
        },
      };
    }

    gate.expect(event.command, event.cwd);
    const local = createLocalBashOperations();
    return {
      operations: {
        async exec(command: string, cwd: string, options: Parameters<typeof local.exec>[2]) {
          try {
            if (!gate.consume(command, cwd)) {
              throw new Error("approval binding mismatch: final command/cwd was not approved");
            }
            return await local.exec(command, cwd, options);
          } finally {
            gate.clear(command, cwd);
          }
        },
      },
    };
  });

  pi.on("session_shutdown", () => gate.cancelAll());
}

interface ShellSettings {
  commandPrefix?: string;
  shellPath?: string;
}

function shellSettings(pi: ExtensionAPI): ShellSettings {
  const raw: unknown = pi.getSettings();
  if (typeof raw !== "object" || raw === null) return {};
  const record = raw as Record<string, unknown>;
  return {
    ...(typeof record.shellCommandPrefix === "string" && record.shellCommandPrefix.length > 0
      ? { commandPrefix: record.shellCommandPrefix }
      : {}),
    ...(typeof record.shellPath === "string" && record.shellPath.length > 0
      ? { shellPath: record.shellPath }
      : {}),
  };
}

function bashOptions(
  shell: ShellSettings,
  spawnHook: (context: BashSpawnContext) => BashSpawnContext,
): BashToolOptions {
  return {
    spawnHook,
    ...(shell.commandPrefix === undefined ? {} : { commandPrefix: shell.commandPrefix }),
    ...(shell.shellPath === undefined ? {} : { shellPath: shell.shellPath }),
  };
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
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), 2_147_483_647);
}

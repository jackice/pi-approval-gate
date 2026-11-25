import { randomUUID } from "node:crypto";

import { realpathSync } from "node:fs";
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
import { ApprovalGate, type ApprovalAuthorization, type ApprovalRequest } from "./src/gate.ts";
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
  pi.registerFlag("approval-ui", {
    description: "Approval dialog style (panel or native)",
    type: "string",
  });

  const promptOptions = () => ({
    armMs: numberFlag(pi, "approval-arm-ms", "PI_APPROVAL_ARM_MS", DEFAULT_ARM_MS),
    maxCommandLines: MAX_COMMAND_LINES,
    ...(pi.getFlag("approval-ui") === "native" ? { ui: "native" as const } : {}),
  });

  const timeoutMs = () =>
    numberFlag(pi, "approval-timeout-ms", "PI_APPROVAL_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  const gate = new ApprovalGate({ timeoutMs, maxPending: MAX_PENDING });
  const selfPath = fileURLToPath(import.meta.url);
  let shadowed = false;

  const template = createBashToolDefinition(process.cwd(), {
    spawnHook: (context) => verifyFinalBinding(undefined, undefined, context),
  });
  pi.registerTool({
    ...template,
    executionMode: "sequential",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const command = params.command;
      const cwd = ctx.cwd;
      const shell = shellSettings(pi);
      const finalCommand = shell.commandPrefix ? `${shell.commandPrefix}\n${command}` : command;
      const reason = dangerReason(finalCommand);
      let authorization: ApprovalAuthorization | undefined;
      let approvalRequest: ApprovalRequest | undefined;
      if (reason !== undefined) {
        const approved = await gate.request(
          {
            sessionId: ctx.sessionManager.getSessionId(),
            toolCallId,
            toolName: "bash",
            command: finalCommand,
            cwd,
            reason,
            risk: "high",
          },
          {
            ...(signal === undefined ? {} : { signal }),
            prompt: (request) => createApprovalPrompt(request, ctx, promptOptions()),
          },
        );
        if (approved.decision !== "allow_once" || approved.authorization === undefined) {
          return {
            content: [{ type: "text", text: `Blocked by approval gate (${approved.decision}); command was not executed.` }],
            isError: true,
            details: undefined,
          };
        }
        authorization = approved.authorization;
        approvalRequest = approved.request;
        if (signal?.aborted) {
          authorization.revoke();
          return {
            content: [{ type: "text", text: "Blocked by approval gate (cancelled); command was not executed." }],
            isError: true,
            details: undefined,
          };
        }
      }

      const options = bashOptions(shell, (context) =>
        verifyFinalBinding(authorization, approvalRequest, context, signal));
      try {
        return await createBashToolDefinition(cwd, options).execute(
          toolCallId,
          { ...params, command },
          signal,
          onUpdate,
          ctx,
        );
      } finally {
        authorization?.revoke();
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const active = pi.getAllTools().find((tool) => tool.name === "bash");
    shadowed = active === undefined || !sameSourceFile(active.sourceInfo.path, selfPath);
    if (shadowed && ctx.hasUI) {
      ctx.ui.notify(
        "approval gate is not active: could not verify the registered bash source; bash is blocked",
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
    const shell = shellSettings(pi);
    const command = shell.commandPrefix ? `${shell.commandPrefix}\n${event.command}` : event.command;
    const reason = dangerReason(command);
    if (reason === undefined) return undefined;
    const approved = await gate.request(
      {
        sessionId: ctx.sessionManager.getSessionId(),
        toolCallId: randomUUID(),
        toolName: "user_bash",
        command,
        cwd: event.cwd,
        reason,
        risk: "high",
      },
      {
        prompt: (request) => createApprovalPrompt(request, ctx, promptOptions()),
      },
    );
    if (approved.decision !== "allow_once" || approved.authorization === undefined) {
      return {
        result: {
          output: `Blocked by approval gate (${approved.decision}); command was not executed.`,
          exitCode: 1,
          cancelled: true,
          truncated: false,
        },
      };
    }

    const authorization = approved.authorization;
    const request = approved.request;
    const local = createLocalBashOperations(shell.shellPath === undefined ? undefined : { shellPath: shell.shellPath });
    return {
      operations: {
        async exec(command: string, cwd: string, options: Parameters<typeof local.exec>[2]) {
          try {
            verifyFinalBinding(authorization, request, { command, cwd, env: options.env ?? process.env }, options.signal);
            return await local.exec(command, cwd, options);
          } finally {
            authorization.revoke();
          }
        },
      },
    };
  });

  pi.on("session_shutdown", () => gate.cancelAll());
}

function sameSourceFile(actual: string, expected: string): boolean {
  try {
    return realpathSync(actual) === realpathSync(expected);
  } catch {
    return false;
  }
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

import type { BashSpawnContext } from "@earendil-works/pi-coding-agent";

import type { ApprovalAuthorization, ApprovalRequest } from "./gate.ts";
import type { PolicyConfig } from "./policy-config.ts";
import { evaluatePolicy } from "./policy-rules.ts";

/**
 * Verifies the final command and working directory right before spawn.
 * Commands the active policy requires approval for must consume an approval bound to this
 * exact call. `config` must be the same policy used to decide the verdict, otherwise the
 * binding check and the dialog disagree and a permitted command fails at spawn.
 */
export function verifyFinalBinding(
  authorization: ApprovalAuthorization | undefined,
  request: ApprovalRequest | undefined,
  context: BashSpawnContext,
  signal?: AbortSignal,
  config?: PolicyConfig,
): BashSpawnContext {
  if (signal?.aborted) throw new Error("aborted");
  const requiresApproval = evaluatePolicy(context.command, config).decision !== "allow";
  if (requiresApproval || authorization !== undefined) {
    const bound = authorization !== undefined
      && request !== undefined
      && authorization.consume({
        requestId: request.id,
        sessionId: request.sessionId,
        toolCallId: request.toolCallId,
        command: context.command,
        cwd: context.cwd,
      });
    if (!bound) throw new Error("approval binding mismatch: final command/cwd was not approved");
  }
  return context;
}

import type { BashSpawnContext } from "@earendil-works/pi-coding-agent";

import type { ApprovalAuthorization, ApprovalRequest } from "./gate.ts";
import { isDangerousBash } from "./policy.ts";

/**
 * Verifies the final command and working directory right before spawn.
 * Dangerous commands must consume an approval bound to this exact call.
 */
export function verifyFinalBinding(
  authorization: ApprovalAuthorization | undefined,
  request: ApprovalRequest | undefined,
  context: BashSpawnContext,
  signal?: AbortSignal,
): BashSpawnContext {
  if (signal?.aborted) throw new Error("aborted");
  if (authorization !== undefined || isDangerousBash(context.command)) {
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

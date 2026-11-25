import type { BashSpawnContext } from "@earendil-works/pi-coding-agent";

import type { ApprovalAuthorization, ApprovalRequest } from "./gate.ts";
import { isDangerousBash } from "./policy.ts";

/**
 * 在真正 spawn 前校验最终 command/cwd。
 * 危险命令必须消费绑定到本次调用的一次性批准。
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

import type { BashSpawnContext } from "@earendil-works/pi-coding-agent";

import type { ApprovalGate } from "./gate.ts";
import { isDangerousBash } from "./policy.ts";

/**
 * 在真正 spawn 前校验最终 command/cwd。
 * 危险命令必须消费一次性批准；失败即抛错，不执行副作用。
 */
export function verifyFinalBinding(gate: ApprovalGate, context: BashSpawnContext): BashSpawnContext {
  if (isDangerousBash(context.command) && !gate.consume(context.command, context.cwd)) {
    throw new Error("approval binding mismatch: final command/cwd was not approved");
  }
  return context;
}

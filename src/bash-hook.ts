import type { BashSpawnContext, BashSpawnHook } from "@earendil-works/pi-coding-agent";

import { verifyFinalBinding } from "./binding.ts";
import type { ApprovalAuthorization, ApprovalRequest } from "./gate.ts";

export interface BashGuardOptions {
  /** 返回拦截说明时阻止执行；在消费审批之前运行。 */
  guard?: ((command: string) => string | undefined) | undefined;
  authorization?: ApprovalAuthorization | undefined;
  request?: ApprovalRequest | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * 组合命令拦截与最终审批绑定，供 Bash 工具的 spawn hook 使用。
 */
export function createBashSpawnHook(options: BashGuardOptions): BashSpawnHook {
  return (context: BashSpawnContext): BashSpawnContext => {
    const blocked = options.guard?.(context.command);
    if (blocked !== undefined) throw new Error(blocked);
    return verifyFinalBinding(options.authorization, options.request, context, options.signal);
  };
}

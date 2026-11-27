import type { BashSpawnContext, BashSpawnHook } from "@earendil-works/pi-coding-agent";

import { verifyFinalBinding } from "./binding.ts";
import type { ApprovalAuthorization, ApprovalRequest } from "./gate.ts";
import type { PolicyConfig } from "./policy-config.ts";

export interface BashGuardOptions {
  /** Returns a message to block the command; runs before the approval is consumed. */
  guard?: ((command: string) => string | undefined) | undefined;
  authorization?: ApprovalAuthorization | undefined;
  request?: ApprovalRequest | undefined;
  signal?: AbortSignal | undefined;
  /** The same policy the verdict used; otherwise a permitted command fails binding at spawn. */
  config?: PolicyConfig | undefined;
}

/**
 * Combines the command guard with final approval binding for a Bash spawn hook.
 */
export function createBashSpawnHook(options: BashGuardOptions): BashSpawnHook {
  return (context: BashSpawnContext): BashSpawnContext => {
    const blocked = options.guard?.(context.command);
    if (blocked !== undefined) throw new Error(blocked);
    return verifyFinalBinding(options.authorization, options.request, context, options.signal, options.config);
  };
}

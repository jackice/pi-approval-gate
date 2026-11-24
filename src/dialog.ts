import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { ApprovalView, fromPiTheme } from "@jackice/pi-ui";

import type { ApprovalRequest, PromptChoice, PromptHandle } from "./gate.ts";

export interface ApprovalPromptOptions {
  armMs: number;
  maxCommandLines?: number;
}

export function createApprovalPrompt(
  request: ApprovalRequest,
  ctx: ExtensionContext,
  options: ApprovalPromptOptions,
): PromptHandle {
  if (ctx.mode !== "tui" || !ctx.hasUI || process.env.PI_SUBAGENT_CHILD === "1") {
    return { promise: Promise.resolve("deny"), cancel: () => {} };
  }

  const { promise, resolve } = Promise.withResolvers<PromptChoice>();
  let finished = false;
  let doneFn: ((choice: PromptChoice) => void) | undefined;

  const finish = (choice: PromptChoice): void => {
    if (finished) return;
    finished = true;
    resolve(choice);
  };

  const custom = ctx.ui.custom<PromptChoice>(
    (tui, theme: Theme, keybindings, done) => {
      doneFn = done;
      const view = new ApprovalView(fromPiTheme(theme), {
        request: {
          toolName: request.toolName,
          command: request.command,
          cwd: request.cwd,
          reason: request.reason,
          risk: request.risk,
        },
        ...(options.maxCommandLines === undefined ? {} : { maxCommandLines: options.maxCommandLines }),
      });
      const started = Date.now();
      return {
        render: (width: number) => view.render(width),
        handleInput: (data: string) => {
          if (finished) return;
          const choice = view.handleInput(data, keybindings);
          if (choice === undefined) {
            tui.requestRender();
            return;
          }
          if (choice === "allow_once" && Date.now() - started < options.armMs) {
            tui.requestRender();
            return;
          }
          done(choice);
          finish(choice);
        },
        invalidate: () => view.invalidate(),
      };
    },
    { blocked: { kind: "permission", message: "bash approval" } },
  );

  custom.then(
    (choice) => finish(choice),
    () => finish("deny"),
  );

  return {
    promise,
    cancel: () => {
      if (finished) return;
      finish("deny");
      try {
        doneFn?.("deny");
      } catch {
        // 组件可能已因 reload/switch 被销毁。
      }
    },
  };
}

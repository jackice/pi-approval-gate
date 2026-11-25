import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { ApprovalView, fromPiTheme } from "@jackice/pi-ui";

import type { ApprovalRequest, PromptChoice, PromptHandle } from "./gate.ts";
import { createNativeApprovalView } from "./native-dialog.ts";

export interface ApprovalPromptOptions {
  armMs: number;
  maxCommandLines?: number;
  ui?: "native";
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
  let nativeView: ReturnType<typeof createNativeApprovalView> | undefined;

  const finish = (choice: PromptChoice): void => {
    if (finished) return;
    finished = true;
    resolve(choice);
  };

  const custom = ctx.ui.custom<PromptChoice>(
    (tui, theme: Theme, keybindings, done) => {
      doneFn = done;
      const view = options.ui === "native"
        ? (nativeView = createNativeApprovalView(request, tui, theme, options.maxCommandLines))
        : new ApprovalView(fromPiTheme(theme), {
            selected: "allow_once",
            request: {
              toolName: request.toolName,
              command: request.command,
              cwd: request.cwd,
              reason: request.reason,
              risk: request.risk,
            },
            ...(options.maxCommandLines === undefined ? {} : { maxCommandLines: options.maxCommandLines }),
          });
      const started = performance.now();
      return {
        capturesViewportInput: true,
        render: (width: number) => view.render(width),
        handleInput: (data: string) => {
          if (finished) return;
          const choice = view.handleInput(data, keybindings);
          if (choice === undefined) {
            tui.requestRender();
            return;
          }
          if (choice === "allow_once" && performance.now() - started < options.armMs) {
            tui.requestRender();
            return;
          }
          done(choice);
          finish(choice);
        },
        invalidate: () => view.invalidate(),
      };
    },
    {
      blocked: { kind: "permission", message: "bash approval" },
      ...(options.ui === "native" ? {
        overlay: true,
        overlayOptions: { width: "100%", maxHeight: "90%", anchor: "bottom-center", margin: { top: 1, bottom: 1 } },
        onHandle: (handle) => nativeView?.setOverlayHandle(handle),
      } : {}),
    },
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
        // The host component may already be gone after a reload or session switch.
      }
    },
  };
}

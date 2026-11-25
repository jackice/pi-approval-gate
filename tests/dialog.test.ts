import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApprovalPrompt } from "../src/dialog.ts";
import type { ApprovalRequest } from "../src/gate.ts";

const request: ApprovalRequest = {
  id: "req",
  toolName: "bash",
  command: "rm -rf /tmp/x",
  cwd: "/tmp/work",
  reason: "removal",
  risk: "high",
  fingerprint: "abc",
};

const theme = {
  fg: (_token: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const tui = { requestRender: vi.fn(), terminal: { rows: 24 } } as unknown as TUI;
const keybindings = {
  matches(data: string, binding: string) {
    return (
      (binding === "tui.select.up" && data === "\x1b[A") ||
      (binding === "tui.select.down" && data === "\x1b[B") ||
      (binding === "tui.select.pageDown" && data === "\x1b[6~") ||
      (binding === "tui.select.confirm" && data === "\r") ||
      (binding === "tui.select.cancel" && data === "\x1b")
    );
  },
};

class FakeUi {
  custom = vi.fn((factory: (tui: TUI, theme: Theme, kb: unknown, done: (choice: string) => void) => unknown) => {
    const { promise, resolve } = Promise.withResolvers<string>();
    this.factory = factory;
    this.resolve = resolve;
    return promise;
  });
  factory: ((tui: TUI, theme: Theme, kb: unknown, done: (choice: string) => void) => unknown) | undefined;
  resolve: ((choice: string) => void) | undefined;
  notify = vi.fn();
  setWidget = vi.fn();
}

function context(mode: ExtensionContext["mode"], ui: FakeUi): ExtensionContext {
  return { mode, hasUI: true, ui } as unknown as ExtensionContext;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("createApprovalPrompt", () => {
  it("marks the component as capturing viewport input", () => {
    const ui = new FakeUi();
    const prompt = createApprovalPrompt(request, context("tui", ui), { armMs: 0 });
    if (ui.factory === undefined) throw new Error("factory not registered");
    const component = ui.factory(tui, theme, keybindings, ui.resolve ?? (() => {}));
    expect((component as { capturesViewportInput?: boolean }).capturesViewportInput).toBe(true);
    void prompt;
  });

  it("returns deny without opening UI in rpc/print or subagent", async () => {
    for (const mode of ["rpc", "print", "json"] as const) {
      const ui = new FakeUi();
      await expect(createApprovalPrompt(request, context(mode, ui), { armMs: 0 }).promise).resolves.toBe("deny");
      expect(ui.custom).not.toHaveBeenCalled();
    }
    vi.stubEnv("PI_SUBAGENT_CHILD", "1");
    const ui = new FakeUi();
    await expect(createApprovalPrompt(request, context("tui", ui), { armMs: 0 }).promise).resolves.toBe("deny");
  });

  it("enforces the arm delay before allowing", async () => {
    vi.useFakeTimers();
    const ui = new FakeUi();
    const prompt = createApprovalPrompt(request, context("tui", ui), { armMs: 500 });
    const done = vi.fn();
    if (ui.factory === undefined) throw new Error("factory not registered");
    const component = ui.factory(tui, theme, keybindings, done) as { handleInput(data: string): void };

    component.handleInput("\x1b[A");
    component.handleInput("\r");
    expect(done).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    component.handleInput("\r");
    expect(done).toHaveBeenCalledWith("allow_once");
    await expect(prompt.promise).resolves.toBe("allow_once");
  });

  it("uses the native selector with Deny selected by default", async () => {
    const ui = new FakeUi();
    const prompt = createApprovalPrompt(request, context("tui", ui), { armMs: 0, ui: "native" });
    if (ui.factory === undefined) throw new Error("factory not registered");
    const component = ui.factory(tui, theme, keybindings, ui.resolve!) as { render(width: number): string[]; handleInput(data: string): void };
    expect(component.render(60).join("\n")).toContain("Native approval");
    component.handleInput("\r");
    await expect(prompt.promise).resolves.toBe("deny");
  });

  it("keeps the native selector armed and lets long command text be inspected", async () => {
    vi.useFakeTimers();
    const ui = new FakeUi();
    const prompt = createApprovalPrompt({ ...request, command: "line one\nline two\n\x1b[2Jline three" }, context("tui", ui), {
      armMs: 500, maxCommandLines: 2, ui: "native",
    });
    if (ui.factory === undefined) throw new Error("factory not registered");
    const done = vi.fn();
    const component = ui.factory(tui, theme, keybindings, done) as { render(width: number): string[]; handleInput(data: string): void };
    expect(component.render(52).join("\n")).not.toContain("line three");
    for (let i = 0; i < 4; i++) component.handleInput("\x1b[6~");
    const page = component.render(52).join("\n");
    expect(page).toContain("\\u001b[2Jline three");
    expect(page).not.toContain("\x1b[2J");
    component.handleInput("\x1b[B");
    component.handleInput("\r");
    expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    component.handleInput("\r");
    await expect(prompt.promise).resolves.toBe("allow_once");
  });

  it("cancel settles once and is idempotent", async () => {
    const ui = new FakeUi();
    const prompt = createApprovalPrompt(request, context("tui", ui), { armMs: 0 });
    prompt.cancel();
    prompt.cancel();
    await expect(prompt.promise).resolves.toBe("deny");
  });
});

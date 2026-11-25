import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createNativeApprovalView } from "../src/native-dialog.ts";
import { createApprovalPrompt } from "../src/dialog.ts";
import type { ApprovalRequest } from "../src/gate.ts";

const request: ApprovalRequest = {
  id: "req",
  sessionId: "session-1",
  toolCallId: "call-1",
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

const tui = { requestRender: vi.fn(), terminal: { rows: 24, columns: 80 } } as unknown as TUI;
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
  custom = vi.fn((factory: (tui: TUI, theme: Theme, kb: unknown, done: (choice: string) => void) => unknown, options?: unknown) => {
    const { promise, resolve } = Promise.withResolvers<string>();
    this.factory = factory;
    this.resolve = resolve;
    this.options = options;
    return promise;
  });
  factory: ((tui: TUI, theme: Theme, kb: unknown, done: (choice: string) => void) => unknown) | undefined;
  resolve: ((choice: string) => void) | undefined;
  options: unknown;
  notify = vi.fn();
  setWidget = vi.fn();
}

function context(mode: ExtensionContext["mode"], ui: FakeUi): ExtensionContext {
  return { mode, hasUI: true, ui } as unknown as ExtensionContext;
}

function setNativeBounds(ui: FakeUi, width = 52, height = 24): void {
  const options = ui.options as { onHandle?: (handle: unknown) => void } | undefined;
  options?.onHandle?.({
    getBounds: () => ({ row: 0, col: 0, width, height }),
  });
}


describe("createNativeApprovalView", () => {
  it("preserves soft-wrap whitespace and visibly encodes command newlines", () => {
    const view = createNativeApprovalView({ ...request, command: "rm  target\nnext" }, tui, theme, 8);
    const lines = view.render(12);
    const output = lines.map((line) => line.slice(1)).join("").replaceAll(">", "");

    expect(output).toContain("rm  target\\nnext");
    expect(lines.every((line) => visibleWidth(line) <= 12)).toBe(true);
    expect(lines.some((line) => line.endsWith(">"))).toBe(true);
  });

  it("escapes invisible Unicode code points including supplementary variation selectors", () => {
    const command = "a\u00adb\u2066c\u{e0100}de\u0301\ud800";
    const view = createNativeApprovalView({ ...request, command }, tui, theme, 8);
    const output = view.render(60).join("\n");

    expect(output).not.toContain(command);
    expect(output).toContain("\\u{ad}");
    expect(output).toContain("\\u{2066}");
    expect(output).toContain("\\u{e0100}");
    expect(output).toContain("e\u0301");
    expect(output).toContain("\\u{d800}");
  });

  it("requires a current overlay bound containing every approval row", () => {
    const nativeTui = {
      requestRender: vi.fn(),
      mode: "regular",
      terminal: { rows: 24, columns: 80 },
    } as unknown as TUI;
    const view = createNativeApprovalView(request, nativeTui, theme, 8);
    const bounds = { row: 0, col: 0, width: 52, height: 1 };
    view.setOverlayHandle({ getBounds: () => bounds } as never);
    const rows = view.render(52);
    view.handleInput("\x1b[B", keybindings as never);

    expect(view.handleInput("\r", keybindings as never)).toBe("deny");
    bounds.height = rows.length;
    view.render(52);
    expect(view.handleInput("\r", keybindings as never)).toBe("allow_once");
  });
  it("keeps risk and pagination status visible in a narrow approval view", () => {
    const view = createNativeApprovalView(request, tui, theme, 8);
    const rows = view.render(10).map((row) => row.trim());

    expect(rows).toContain("Risk: H");
    expect(rows).toContain("1-7/7");
  });

  it("fits the bottom border and both choices inside a short overlay", () => {
    const shortTui = { terminal: { rows: 12, columns: 80 } } as unknown as TUI;
    const view = createNativeApprovalView({ ...request, command: "long ".repeat(100) }, shortTui, theme, 8);
    const rows = view.render(60);

    expect(rows).toHaveLength(10);
    expect(rows.at(-1)).toBe(rows[0]);
    expect(rows).toContain(" → Deny");
    expect(rows).toContain("   Allow once");
  });
});

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
    const rows = component.render(60);
    expect(rows[0]).toBe("─".repeat(60));
    expect(rows.at(-1)).toBe(rows[0]);
    expect(rows).toContain(" Allow tool: bash");
    expect(rows).toContain(" → Deny");
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
    const component = ui.factory(tui, theme, keybindings, done) as { render(width: number): readonly string[]; handleInput(data: string): void };
    setNativeBounds(ui);
    expect(component.render(52).join("\n")).not.toContain("line three");
    for (let i = 0; i < 4; i++) component.handleInput("\x1b[6~");
    const page = component.render(52).join("\n");
    expect(page).toContain("\\u{1b}[2Jline three");
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

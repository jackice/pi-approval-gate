import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, SelectList, matchesKey, truncateToWidth, wrapTextWithAnsi, type TUI } from "@earendil-works/pi-tui";

import type { ApprovalRequest, PromptChoice } from "./gate.ts";

type ApprovalKeys = Parameters<Parameters<ExtensionUIContext["custom"]>[0]>[2];

export function createNativeApprovalView(
  request: ApprovalRequest,
  tui: TUI,
  theme: Theme,
  maxCommandLines: number | undefined,
) {
  const selection = new SelectList([
    { label: "Deny", value: "deny" },
    { label: "Allow once", value: "allow_once" },
  ], 2, {
    selectedPrefix: (text) => theme.fg("accent", text),
    selectedText: (text) => theme.fg("accent", text),
    description: (text) => theme.fg("muted", text),
    scrollInfo: (text) => theme.fg("muted", text),
    noMatch: (text) => theme.fg("muted", text),
  });
  const limit = maxCommandLines !== undefined && Number.isFinite(maxCommandLines) && maxCommandLines >= 1
    ? Math.floor(maxCommandLines) : 8;
  const title = theme.fg("warning", `Native approval · ${escapeControls(request.toolName)} · ${request.risk}`);
  const content = `cwd: ${escapeControls(request.cwd)}\nreason: ${escapeControls(request.reason)}\ncommand:\n${escapeControls(request.command, true)}`;
  let lines: string[] = [];
  let lastWidth = 0;
  let offset = 0;
  let pageRows = 1;
  let allowVisible = false;

  return {
    render(width: number): readonly string[] {
      if (width <= 0) {
        allowVisible = false;
        return [];
      }
      if (lastWidth !== width) {
        lastWidth = width;
        lines = wrapTextWithAnsi(content, width);
      }
      pageRows = Math.max(1, Math.min(limit, tui.terminal.rows - 8));
      offset = Math.min(offset, Math.max(0, lines.length - pageRows));
      const position = lines.length > pageRows ? ` · ${offset + 1}–${Math.min(lines.length, offset + pageRows)}/${lines.length}` : "";
      const hint = truncateToWidth(theme.fg("muted", `PgUp/PgDn: scroll · Esc: deny${position}`), width);
      const choices = selection.render(width);
      allowVisible = width >= 16 && tui.terminal.rows >= 9;
      return [truncateToWidth(title, width), ...lines.slice(offset, offset + pageRows), hint, ...choices];
    },
    invalidate() {
      lastWidth = 0;
      allowVisible = false;
    },
    handleInput(data: string, keys: ApprovalKeys): PromptChoice | undefined {
      if (keys.matches(data, "tui.select.cancel")) return "deny";
      if (keys.matches(data, "tui.select.confirm")) {
        return allowVisible && selection.getSelectedItem()?.value === "allow_once" ? "allow_once" : "deny";
      }
      if (keys.matches(data, "tui.select.up")) selection.setSelectedIndex(0);
      else if (keys.matches(data, "tui.select.down")) selection.setSelectedIndex(1);
      else if (matchesKey(data, Key.pageUp) || keys.matches(data, "tui.select.pageUp")) offset = Math.max(0, offset - pageRows);
      else if (matchesKey(data, Key.pageDown) || keys.matches(data, "tui.select.pageDown")) offset = Math.min(Math.max(0, lines.length - pageRows), offset + pageRows);
      return undefined;
    },
  };
}

function escapeControls(text: string, keepNewlines = false): string {
  return text.replace(/[\\\x00-\x1f\x7f-\x9f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, (char) => {
    if (char === "\n" && keepNewlines) return char;
    if (char === "\\") return "\\\\";
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

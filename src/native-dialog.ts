import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, SelectList, matchesKey, truncateToWidth, visibleWidth, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";

import type { ApprovalRequest, PromptChoice } from "./gate.ts";

type ApprovalKeys = Parameters<Parameters<ExtensionUIContext["custom"]>[0]>[2];

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

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
  const title = `Bash approval · ${escapeControls(request.toolName)}`;
  const risk = `Risk: ${request.risk.toUpperCase()}`;
  const fields = [
    `cwd: ${escapeControls(request.cwd)}`,
    `reason: ${escapeControls(request.reason)}`,
    `command: ${escapeControls(request.command)}`,
  ];
  let overlayHandle: OverlayHandle | undefined;
  let lines: string[] = [];
  let lastWidth = 0;
  let offset = 0;
  let pageRows = 1;
  let renderedWidth = 0;
  let renderedRows = 0;
  let renderedContextFits = false;

  const canAllow = (): boolean => {
    const bounds = overlayHandle?.getBounds();
    const columns = tui.terminal.columns;
    return renderedContextFits
      && bounds !== undefined
      && bounds.width === renderedWidth
      && bounds.height >= renderedRows
      && bounds.row + bounds.height <= tui.terminal.rows
      && (columns === undefined || bounds.col + bounds.width <= columns);
  };

  return {
    setOverlayHandle(handle: OverlayHandle | undefined): void {
      overlayHandle = handle;
    },
    render(width: number): readonly string[] {
      if (width <= 0) {
        renderedContextFits = false;
        return [];
      }
      if (lastWidth !== width) {
        lastWidth = width;
        lines = fields.flatMap((field) => wrapCodeText(field, width));
      }
      pageRows = Math.max(1, Math.min(limit, Math.floor(tui.terminal.rows * 0.75) - 6));
      offset = Math.min(offset, Math.max(0, lines.length - pageRows));
      const end = Math.min(lines.length, offset + pageRows);
      const fullPage = `Page ${offset + 1}-${end}/${lines.length}`;
      const compactRange = `${offset + 1}-${end}/${lines.length}`;
      const currentPage = `${offset + 1}/${lines.length}`;
      const page = visibleWidth(fullPage) <= width
        ? fullPage
        : visibleWidth(compactRange) <= width
          ? compactRange
          : visibleWidth(currentPage) <= width
            ? currentPage
            : String(offset + 1);
      const riskLabel = visibleWidth(risk) <= width
        ? risk
        : visibleWidth(`Risk: ${request.risk[0]!.toUpperCase()}`) <= width
          ? `Risk: ${request.risk[0]!.toUpperCase()}`
          : request.risk[0]!.toUpperCase();
      const hint = "PgUp/PgDn: scroll · Esc: deny";
      const choices = selection.render(width);
      const output = [
        truncateToWidth(theme.fg("warning", title), width),
        truncateToWidth(theme.fg("warning", riskLabel), width),
        truncateToWidth(theme.fg("muted", page), width),
        ...lines.slice(offset, end),
        truncateToWidth(theme.fg("muted", hint), width),
        ...choices,
      ];
      renderedWidth = width;
      renderedRows = output.length;
      renderedContextFits = [title, riskLabel, page, hint].every((line) => visibleWidth(line) <= width)
        && choices.length > 0
        && choices.every((line) => visibleWidth(line) <= width)
        && choices.some((line) => line.includes("Allow once"));
      return output;
    },
    invalidate(): void {
      lastWidth = 0;
      renderedContextFits = false;
    },
    handleInput(data: string, keys: ApprovalKeys): PromptChoice | undefined {
      if (keys.matches(data, "tui.select.cancel")) return "deny";
      if (keys.matches(data, "tui.select.confirm")) {
        return canAllow() && selection.getSelectedItem()?.value === "allow_once" ? "allow_once" : "deny";
      }
      if (keys.matches(data, "tui.select.up")) selection.setSelectedIndex(0);
      else if (keys.matches(data, "tui.select.down")) selection.setSelectedIndex(1);
      else if (matchesKey(data, Key.pageUp) || keys.matches(data, "tui.select.pageUp")) offset = Math.max(0, offset - pageRows);
      else if (matchesKey(data, Key.pageDown) || keys.matches(data, "tui.select.pageDown")) offset = Math.min(Math.max(0, lines.length - pageRows), offset + pageRows);
      return undefined;
    },
  };
}

function wrapCodeText(text: string, width: number): string[] {
  const segments = Array.from(segmenter.segment(text), ({ segment }) => segment);
  if (segments.length === 0) return [""];

  const lines: string[] = [];
  let index = 0;
  while (index < segments.length) {
    let line = "";
    let usedWidth = 0;
    const first = index;
    while (index < segments.length) {
      const segment = segments[index]!;
      const segmentWidth = visibleWidth(segment);
      const continuation = index + 1 < segments.length;
      const maxWidth = continuation ? Math.max(1, width - 1) : width;
      if (usedWidth + segmentWidth > maxWidth && index > first) break;
      line += segment;
      usedWidth += segmentWidth;
      index++;
      if (usedWidth > maxWidth) break;
    }
    lines.push(index < segments.length ? `${line}>` : line);
  }
  return lines;
}

function escapeControls(text: string): string {
  return text.replace(/\\|[\p{Default_Ignorable_Code_Point}\p{Control}\p{Format}\p{Surrogate}]/gv, (char) => {
    if (char === "\\") return "\\\\";
    if (char === "\n") return "\\n";
    if (char === "\r") return "\\r";
    if (char === "\t") return "\\t";
    return `\\u{${char.codePointAt(0)!.toString(16)}}`;
  });
}

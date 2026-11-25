import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";

import type { ApprovalRequest, PromptChoice } from "./gate.ts";

type ApprovalKeys = Parameters<Parameters<ExtensionUIContext["custom"]>[0]>[2];

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function createNativeApprovalView(
  request: ApprovalRequest,
  tui: TUI,
  theme: Theme,
  maxCommandLines: number | undefined,
) {
  let selected: PromptChoice = "allow_once";
  const choices = [
    { label: "Allow once", value: "allow_once" },
    { label: "Deny", value: "deny" },
  ] as const;
  const limit = maxCommandLines !== undefined && Number.isFinite(maxCommandLines) && maxCommandLines >= 1
    ? Math.floor(maxCommandLines) : 8;
  const title = "⚠ Dangerous command";
  const risk = `Risk: ${request.risk.toUpperCase()}`;
  const fields = [
    `Reason: ${escapeControls(request.reason)}`,
    `Cwd: ${escapeControls(request.cwd)}`,
    `Command: ${escapeControls(request.command)}`,
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
      if (width < 3) {
        renderedContextFits = false;
        return [];
      }
      const inset = width >= 12 ? " " : "";
      const innerWidth = width - 2 - 2 * inset.length;
      if (lastWidth !== width) {
        lastWidth = width;
        lines = fields.flatMap((field) => wrapCodeText(field, innerWidth));
      }
      const terminalRows = tui.terminal.rows;
      // Match the overlay's height cap, including its top and bottom margins.
      const availableRows = Math.min(Math.floor(terminalRows * 0.9), terminalRows - 2);
      const spacer = availableRows >= 15 ? [""] : [];
      const previewRows = availableRows - 7 - 4 * spacer.length;
      const paginated = lines.length > Math.min(limit, previewRows);
      pageRows = Math.max(1, Math.min(limit, previewRows - Number(paginated)));
      offset = Math.min(offset, Math.max(0, lines.length - pageRows));
      const end = Math.min(lines.length, offset + pageRows);
      const fullPage = `Page ${offset + 1}-${end}/${lines.length}`;
      const compactRange = `${offset + 1}-${end}/${lines.length}`;
      const currentPage = `${offset + 1}/${lines.length}`;
      const page = visibleWidth(fullPage) <= innerWidth
        ? fullPage
        : visibleWidth(compactRange) <= innerWidth
          ? compactRange
          : visibleWidth(currentPage) <= innerWidth
            ? currentPage
            : String(offset + 1);
      const riskLabel = visibleWidth(risk) <= innerWidth
        ? risk
        : visibleWidth(`Risk: ${request.risk[0]!.toUpperCase()}`) <= innerWidth
          ? `Risk: ${request.risk[0]!.toUpperCase()}`
          : request.risk[0]!.toUpperCase();
      const controls = "↑/↓ navigate  ↵ select  Esc cancel";
      const fullHint = paginated ? controls + "  PgUp/PgDn scroll" : controls;
      const hint = visibleWidth(fullHint) <= innerWidth ? fullHint : paginated ? "↑/↓ ↵ Esc PgUp/PgDn" : "↑/↓ ↵ Esc";
      const optionRows = choices.map(({ label, value }) => {
        const active = value === selected;
        const row = `${active ? "❯" : " "} ${label}`;
        if (!active || visibleWidth(row) > innerWidth) return row;
        return theme.bg("selectedBg", theme.fg("warning", row) + " ".repeat(innerWidth - visibleWidth(row)));
      });
      const body = [
        ...spacer,
        theme.fg("warning", riskLabel),
        ...(paginated ? [theme.fg("muted", page)] : []),
        ...lines.slice(offset, end).map((line) => theme.fg("warning", line)),
        ...spacer,
        theme.fg("warning", "Allow?"),
        ...optionRows,
        ...spacer,
        theme.fg("dim", hint),
        ...spacer,
      ];
      const border = (text: string) => theme.fg("accent", text);
      const heading = truncateToWidth(` ${title} `, width - 3, "");
      const top = border("╭─") + theme.fg("warning", theme.bold(heading))
        + border("─".repeat(width - 3 - visibleWidth(heading)) + "╮");
      const side = border("│");
      const output = [top, ...body.map((line) => {
        const content = truncateToWidth(line, innerWidth);
        return side + inset + content + " ".repeat(innerWidth - visibleWidth(content)) + inset + side;
      }), border("╰" + "─".repeat(width - 2) + "╯")];
      renderedWidth = width;
      renderedRows = output.length;
      renderedContextFits = body.every((line) => visibleWidth(line) <= innerWidth)
        && visibleWidth(title) <= width - 3;
      return output;
    },
    invalidate(): void {
      lastWidth = 0;
      renderedContextFits = false;
    },
    handleInput(data: string, keys: ApprovalKeys): PromptChoice | undefined {
      if (keys.matches(data, "tui.select.cancel")) return "deny";
      if (keys.matches(data, "tui.select.confirm")) {
        return canAllow() && selected === "allow_once" ? "allow_once" : "deny";
      }
      if (keys.matches(data, "tui.select.up")) selected = "allow_once";
      else if (keys.matches(data, "tui.select.down")) selected = "deny";
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

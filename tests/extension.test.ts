import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";

import approvalGateExtension from "../index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function preflightBash(sourcePath: string): unknown {
  const handlers = new Map<string, Handler>();
  const api = {
    on(event: string, handler: Handler) { handlers.set(event, handler); },
    registerFlag: vi.fn(),
    registerTool: vi.fn(),
    getAllTools: () => [{ name: "bash", sourceInfo: { path: sourcePath } }],
  } as unknown as ExtensionAPI;
  const ctx = { hasUI: false } as ExtensionContext;
  approvalGateExtension(api);
  handlers.get("session_start")?.({}, ctx);
  return handlers.get("tool_call")?.({ toolName: "bash", input: { command: "printf ready" } }, ctx);
}

it("permits the same registered bash source through a symbolic link", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-gate-source-"));
  try {
    const sourcePath = join(dir, "index.ts");
    symlinkSync(fileURLToPath(new URL("../index.ts", import.meta.url)), sourcePath);
    expect(preflightBash(sourcePath)).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("blocks bash with a different or missing source file", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-gate-source-"));
  try {
    const sourcePath = join(dir, "index.ts");
    expect(preflightBash(sourcePath)).toMatchObject({ block: true });
    writeFileSync(sourcePath, "export default function () {}\n");
    expect(preflightBash(sourcePath)).toMatchObject({ block: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

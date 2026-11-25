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

it("blocks uv tooling when the uv guard is configured", async () => {
  const handlers = new Map<string, Handler>();
  const custom = vi.fn(() => new Promise<never>(() => {}));
  const api = {
    on(event: string, handler: Handler) { handlers.set(event, handler); },
    registerFlag: vi.fn(),
    registerTool: vi.fn(),
    getFlag: () => undefined,
    getSettings: () => ({ approvalGate: { guard: "uv" } }),
  } as unknown as ExtensionAPI;
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: "/tmp",
    sessionManager: { getSessionId: () => "session" },
    ui: { custom },
  } as unknown as ExtensionContext;

  approvalGateExtension(api);
  const result = await handlers.get("user_bash")?.({ command: "pip install requests", cwd: "/tmp" }, ctx);

  expect(custom).not.toHaveBeenCalled();
  expect(result).toMatchObject({ result: { exitCode: 1, cancelled: true } });
  expect((result as { result: { output: string } }).result.output).toContain("pip is disabled");
});

it("allows python tooling when no guard is configured", async () => {
  const handlers = new Map<string, Handler>();
  const api = {
    on(event: string, handler: Handler) { handlers.set(event, handler); },
    registerFlag: vi.fn(),
    registerTool: vi.fn(),
    getFlag: () => undefined,
    getSettings: () => ({}),
  } as unknown as ExtensionAPI;
  const ctx = { mode: "tui", hasUI: true, cwd: "/tmp", ui: {} } as unknown as ExtensionContext;

  approvalGateExtension(api);

  await expect(handlers.get("user_bash")?.({ command: "pip install requests", cwd: "/tmp" }, ctx))
    .resolves.toBeUndefined();
});

it("uses the native approval view by default", async () => {
  const handlers = new Map<string, Handler>();
  let customOptions: unknown;
  let settlePrompt: ((choice: "deny" | "allow_once") => void) | undefined;
  const api = {
    on(event: string, handler: Handler) { handlers.set(event, handler); },
    registerFlag: vi.fn(),
    registerTool: vi.fn(),
    getFlag: () => undefined,
    getSettings: () => ({}),
  } as unknown as ExtensionAPI;
  const ui = {
    custom: (_factory: unknown, options: unknown) => {
      customOptions = options;
      return new Promise<"deny" | "allow_once">((resolve) => { settlePrompt = resolve; });
    },
  };
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: "/tmp",
    sessionManager: { getSessionId: () => "session" },
    ui,
  } as unknown as ExtensionContext;

  approvalGateExtension(api);
  const result = handlers.get("user_bash")?.(
    { command: "rm -rf /tmp/fixture", cwd: "/tmp" },
    ctx,
  );

  expect(customOptions).toMatchObject({ overlay: true });
  settlePrompt?.("deny");
  await expect(result).resolves.toMatchObject({
    result: { exitCode: 1, cancelled: true },
  });
});

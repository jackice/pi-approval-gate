import { describe, expect, it } from "vitest";

import { compilePattern, normalizePattern, parsePolicyConfig } from "../src/policy-config.ts";

describe("parsePolicyConfig", () => {
  it("falls back to defaults for missing or malformed input", () => {
    for (const raw of [undefined, null, 3, "x", ["a"]]) {
      const { config, dropped } = parsePolicyConfig(raw);
      expect(config).toEqual({
        mode: "yolo",
        redirects: ["/dev/null"],
        extraDangerous: [],
        patterns: [],
      });
      expect(dropped).toBe(0);
    }
  });

  it("parses a full configuration", () => {
    const { config, dropped } = parsePolicyConfig({
      guard: "uv",
      mode: "strict",
      redirects: ["/dev/null", "/tmp/approval-gate.log"],
      extraDangerous: ["kubectl", "terraform"],
      patterns: [
        { match: "git *", approval: "allow" },
        { match: "  curl   *  ", approval: "PROMPT" },
        { match: "rm -rf *", approval: "deny" },
      ],
    });
    expect(dropped).toBe(0);
    expect(config.mode).toBe("strict");
    expect(config.redirects).toEqual(["/dev/null", "/tmp/approval-gate.log"]);
    expect(config.extraDangerous).toEqual(["kubectl", "terraform"]);
    expect(config.patterns).toEqual([
      { match: "git *", approval: "allow" },
      { match: "curl *", approval: "prompt" },
      { match: "rm -rf *", approval: "deny" },
    ]);
  });

  it("drops invalid entries instead of failing the whole configuration", () => {
    const { config, dropped } = parsePolicyConfig({
      redirects: ["/dev/null", "relative/path", 42],
      extraDangerous: ["kubectl", "", "bad/name"],
      patterns: [
        { match: "git *", approval: "allow" },
        { match: "", approval: "allow" },
        { match: "curl *", approval: "maybe" },
        { approval: "allow" },
        "nope",
      ],
    });
    expect(config.redirects).toEqual(["/dev/null"]);
    expect(config.extraDangerous).toEqual(["kubectl"]);
    expect(config.patterns).toEqual([{ match: "git *", approval: "allow" }]);
    expect(dropped).toBe(2 + 2 + 4);
  });

  it("defaults the mode to yolo and rejects unknown modes", () => {
    expect(parsePolicyConfig({}).config.mode).toBe("yolo");
    expect(parsePolicyConfig({ mode: " STRICT " }).config.mode).toBe("strict");
    expect(parsePolicyConfig({ mode: "yolo" }).dropped).toBe(0);

    const invalid = parsePolicyConfig({ mode: "write" });
    expect(invalid.config.mode).toBe("yolo");
    expect(invalid.dropped).toBe(1);
  });

  it("keeps an explicit empty redirect list", () => {
    const { config, dropped } = parsePolicyConfig({ redirects: [] });
    expect(config.redirects).toEqual([]);
    expect(dropped).toBe(0);
  });

  it("ignores non-array fields", () => {
    const { config, dropped } = parsePolicyConfig({ redirects: "/dev/null", patterns: {} });
    expect(config.redirects).toEqual(["/dev/null"]);
    expect(config.patterns).toEqual([]);
    expect(dropped).toBe(2);
  });
});

describe("compilePattern", () => {
  it("anchors the glob and treats only * as a wildcard", () => {
    expect(compilePattern("git *").test("git status")).toBe(true);
    expect(compilePattern("git *").test("gitx status")).toBe(false);
    expect(compilePattern("git *").test("sudo git status")).toBe(false);
    expect(compilePattern("rm -rf *").test("rm -rf /tmp/x")).toBe(true);
    expect(compilePattern("a.b").test("axb")).toBe(false);
  });

  it("normalizes whitespace on both sides", () => {
    expect(normalizePattern("  git   status  ")).toBe("git status");
    expect(compilePattern("git    status").test("git status")).toBe(true);
  });

  it("reuses compiled patterns", () => {
    expect(compilePattern("git *")).toBe(compilePattern(" git  * "));
  });
});

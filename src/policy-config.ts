export const DEFAULT_REDIRECT_TARGETS = ["/dev/null"];

/**
 * Posture, defaulting to OMP's:
 * - `yolo`: only the critical patterns apply, everything else runs.
 * - `strict`: the full static analysis (dangerous commands, git push, gh merge, ...).
 * - `always-ask`: every command needs approval.
 */
export type PolicyMode = "yolo" | "strict" | "always-ask";

export const DEFAULT_MODE: PolicyMode = "yolo";

const MODES = new Set<string>(["yolo", "strict", "always-ask"]);

/** One bash rule: a glob over the whole command or a single segment; the first match wins. */
export interface BashPatternRule {
  match: string;
  approval: "allow" | "deny" | "prompt";
}

export interface PolicyConfig {
  mode: PolicyMode;
  /** Write redirection targets dropped before analysis. */
  redirects: string[];
  /** Command names added to the built-in dangerous set. */
  extraDangerous: string[];
  patterns: BashPatternRule[];
}

export interface PolicyConfigResult {
  config: PolicyConfig;
  /** Number of discarded invalid entries, reported once at session start. */
  dropped: number;
}

interface ParsedList<T> {
  values: T[];
  dropped: number;
}

const APPROVALS = new Set(["allow", "deny", "prompt"]);

const globCache = new Map<string, RegExp>();

/** Normalizes whitespace the way OMP's `bash.patterns` does. */
export function normalizePattern(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

/** Only `*` is a wildcard; every other character is escaped literal text. */
export function compilePattern(pattern: string): RegExp {
  const normalized = normalizePattern(pattern);
  const cached = globCache.get(normalized);
  if (cached !== undefined) return cached;
  const escaped = normalized
    .split("*")
    .map((part) => part.replace(/[\\^$+?.()[\]{}|]/gu, "\\$&"))
    .join(".*");
  const compiled = new RegExp(`^${escaped}$`, "u");
  globCache.set(normalized, compiled);
  return compiled;
}

/** A non-array value is a configuration error: counted as dropped and replaced by the default. */
function parseField<T>(raw: unknown, parse: (value: unknown) => ParsedList<T>): ParsedList<T> {
  if (raw === undefined) return { values: [], dropped: 0 };
  if (!Array.isArray(raw)) return { values: [], dropped: 1 };
  return parse(raw);
}

function parseRedirects(raw: unknown): ParsedList<string> {
  const values: string[] = [];
  let dropped = 0;
  for (const item of Array.isArray(raw) ? raw : []) {
    if (typeof item === "string" && item.startsWith("/") && !/[\s\0\r\n]/u.test(item)) values.push(item);
    else dropped++;
  }
  return { values, dropped };
}

function parseExtraDangerous(raw: unknown): ParsedList<string> {
  const values: string[] = [];
  let dropped = 0;
  for (const item of Array.isArray(raw) ? raw : []) {
    if (typeof item === "string" && item.length > 0 && !/[\s/\0\r\n]/u.test(item)) values.push(item);
    else dropped++;
  }
  return { values, dropped };
}

function parsePatterns(raw: unknown): ParsedList<BashPatternRule> {
  const values: BashPatternRule[] = [];
  let dropped = 0;
  for (const item of Array.isArray(raw) ? raw : []) {
    const rule = parsePattern(item);
    if (rule === undefined) dropped++;
    else values.push(rule);
  }
  return { values, dropped };
}

function parsePattern(item: unknown): BashPatternRule | undefined {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;
  const record = item as Record<string, unknown>;
  if (typeof record.match !== "string") return undefined;
  const match = normalizePattern(record.match);
  if (match.length === 0) return undefined;
  const approval = typeof record.approval === "string" ? record.approval.trim().toLowerCase() : "";
  if (!APPROVALS.has(approval)) return undefined;
  return { match, approval: approval as BashPatternRule["approval"] };
}

function parseMode(raw: unknown): { mode: PolicyMode; dropped: number } {
  if (raw === undefined) return { mode: DEFAULT_MODE, dropped: 0 };
  const normalized = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!MODES.has(normalized)) return { mode: DEFAULT_MODE, dropped: 1 };
  return { mode: normalized as PolicyMode, dropped: 0 };
}

/**
 * Parses the `settings.approvalGate` section. Invalid entries are dropped and counted rather
 * than thrown: a typo should cost one rule, not the whole extension.
 */
export function parsePolicyConfig(raw: unknown): PolicyConfigResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      config: {
        mode: DEFAULT_MODE,
        redirects: [...DEFAULT_REDIRECT_TARGETS],
        extraDangerous: [],
        patterns: [],
      },
      dropped: 0,
    };
  }
  const record = raw as Record<string, unknown>;
  const mode = parseMode(record.mode);
  const redirects = parseField(record.redirects, parseRedirects);
  const extraDangerous = parseField(record.extraDangerous, parseExtraDangerous);
  const patterns = parseField(record.patterns, parsePatterns);

  return {
    config: {
      mode: mode.mode,
      // An explicit list wins; an empty array accepts no redirection at all.
      redirects: Array.isArray(record.redirects) ? redirects.values : [...DEFAULT_REDIRECT_TARGETS],
      extraDangerous: extraDangerous.values,
      patterns: patterns.values,
    },
    dropped: mode.dropped + redirects.dropped + extraDangerous.dropped + patterns.dropped,
  };
}

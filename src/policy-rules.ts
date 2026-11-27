import { criticalReason, dangerReason, extraDangerousReason } from "./policy.ts";
import {
  compilePattern,
  DEFAULT_MODE,
  DEFAULT_REDIRECT_TARGETS,
  normalizePattern,
  type BashPatternRule,
  type PolicyConfig,
} from "./policy-config.ts";

export type PolicyDecision = "allow" | "prompt" | "deny";

export interface PolicyVerdict {
  decision: PolicyDecision;
  reason?: string;
}

/**
 * Characters that take a command out of "single simple command" territory. Any of them
 * disables every `allow` rule; otherwise a narrow rule such as `git *` would ride along
 * `git status && rm -rf build`.
 */
const SHELL_CONTROL_CHARS: Record<string, true> = {
  "\n": true,
  "\r": true,
  ";": true,
  "&": true,
  "|": true,
  "<": true,
  ">": true,
  "`": true,
  $: true,
  "(": true,
  ")": true,
};

/** Options that turn quoted or escaped arguments back into code (`sh -c`, `git -c alias.x=!...`). */
const REINTERPRET_OPTION = /(?:^|[ \t])(?:-[^-]*[ce]|--(?:command|eval))(?:[= \t]|$)/u;

/**
 * Detects shell control semantics, mirroring OMP's `hasBashApprovalShellControl`: control
 * characters inside quotes or after escapes are literals, but an option such as `-c`/`--eval`
 * reinterprets them as code, so they count as control characters as well.
 */
export function hasShellControl(command: string): boolean {
  let quote: "'" | '"' | undefined;
  let reinterpretable = false;
  for (let index = 0; index < command.length; index++) {
    const char = command[index] ?? "";
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else if (Object.hasOwn(SHELL_CONTROL_CHARS, char)) reinterpretable = true;
      continue;
    }
    if (char === "\\") {
      const escaped = command[index + 1];
      if (escaped !== undefined && Object.hasOwn(SHELL_CONTROL_CHARS, escaped)) reinterpretable = true;
      index++;
      continue;
    }
    if (quote === '"') {
      // `$` and backticks still expand inside double quotes.
      if (char === '"') quote = undefined;
      else if (char === "$" || char === "`") return true;
      else if (Object.hasOwn(SHELL_CONTROL_CHARS, char)) reinterpretable = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (Object.hasOwn(SHELL_CONTROL_CHARS, char)) return true;
  }
  return reinterpretable && REINTERPRET_OPTION.test(command);
}

/**
 * Best-effort segmenter ported from OMP's `tokenizeShellSegments`: it never fails, splitting on
 * the visible shell operators instead of giving up on command substitution or heredocs. It
 * complements the fail-closed tokenizer in `policy.ts`: that one feeds static analysis, this one
 * lets `deny`/`prompt` rules see a dangerous segment inside a compound command.
 */
export function ruleSegments(command: string): string[] {
  const segments: string[][] = [];
  let current: string[] = [];
  let buffer = "";
  let inSingle = false;
  let inDouble = false;
  const pushBuffer = () => {
    if (buffer.length > 0) {
      current.push(buffer);
      buffer = "";
    }
  };
  const pushSegment = () => {
    pushBuffer();
    if (current.length > 0) segments.push(current);
    current = [];
  };

  for (let index = 0; index < command.length; index++) {
    const char = command[index] ?? "";
    if (inSingle) {
      if (char === "'") inSingle = false;
      else buffer += char;
      continue;
    }
    if (inDouble) {
      if (char === "\\" && index + 1 < command.length) {
        const next = command[index + 1] ?? "";
        if (next === '"' || next === "\\" || next === "$" || next === "`") {
          buffer += next;
          index++;
          continue;
        }
      }
      if (char === '"') inDouble = false;
      else buffer += char;
      continue;
    }
    if (char === "'") {
      inSingle = true;
      continue;
    }
    if (char === '"') {
      inDouble = true;
      continue;
    }
    if (char === "\\" && index + 1 < command.length) {
      buffer += command[index + 1] ?? "";
      index++;
      continue;
    }
    if (char === " " || char === "\t") {
      pushBuffer();
      continue;
    }
    if (char === "\n" || char === ";" || char === "&" || char === "|" || char === "(" || char === ")") {
      pushSegment();
      continue;
    }
    buffer += char;
  }
  pushSegment();
  return segments.map((tokens) => tokens.join(" ")).filter((segment) => segment.length > 0);
}

function matchesRule(command: string, rule: BashPatternRule): boolean {
  const compiled = compilePattern(rule.match);
  const normalized = normalizePattern(command);
  if (rule.approval === "allow") {
    if (hasShellControl(command)) return false;
    return normalized.length > 0 && compiled.test(normalized);
  }
  // deny / prompt must catch a dangerous segment buried in a compound command.
  if (normalized.length > 0 && compiled.test(normalized)) return true;
  return ruleSegments(command).some((segment) => compiled.test(normalizePattern(segment)));
}

/**
 * Single entry point for rules and modes, ordered like OMP's `BashTool.approval` plus
 * `resolveApproval`: the first matching rule decides (`deny` short-circuits), then the mode,
 * then `allow`, then `prompt`. Rule order is therefore policy: a narrow `deny` only wins when
 * it precedes a broader `allow`, exactly as in OMP.
 */
export function evaluatePolicy(command: string, config?: PolicyConfig): PolicyVerdict {
  const mode = config?.mode ?? DEFAULT_MODE;
  const patterns = config?.patterns ?? [];
  const redirects = config?.redirects ?? DEFAULT_REDIRECT_TARGETS;
  const rule = patterns.find((candidate) => matchesRule(command, candidate));

  if (rule?.approval === "deny") {
    return { decision: "deny", reason: `Blocked by bash pattern: ${rule.match}` };
  }

  const danger = modeReason(command, mode, config, redirects);
  if (danger !== undefined) return { decision: "prompt", reason: danger };

  // `allow` and `prompt` rules apply in every mode, matching OMP's "explicit policy beats mode".
  if (rule?.approval === "allow") return { decision: "allow" };
  if (rule?.approval === "prompt") {
    return { decision: "prompt", reason: `Prompt required by bash pattern: ${rule.match}` };
  }
  if (mode === "always-ask") return { decision: "prompt", reason: "always-ask mode" };
  return { decision: "allow" };
}

function modeReason(
  command: string,
  mode: PolicyConfig["mode"],
  config: PolicyConfig | undefined,
  redirects: readonly string[],
): string | undefined {
  // Critical patterns are the floor for every mode: `strict` may only be tighter, never looser.
  const critical = criticalReason(command);
  if (critical !== undefined) return critical;
  if (mode === "strict") return dangerReason(command, config);
  return extraDangerousReason(command, config?.extraDangerous, redirects);
}

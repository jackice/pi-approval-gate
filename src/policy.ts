import { DEFAULT_REDIRECT_TARGETS, type PolicyConfig } from "./policy-config.ts";

const MAX_COMMAND_LENGTH = 8192;

export type AnalysisOptions = Pick<Partial<PolicyConfig>, "redirects" | "extraDangerous">;

/**
 * Critical patterns identical to OMP's `CRITICAL_BASH_PATTERNS`.
 * `yolo` relies on these alone, matched against the raw command line, so no tokenizer runs.
 * The list stays narrow: a miss costs data or the host, while a false positive can be undone
 * with a `patterns` rule.
 */
export const CRITICAL_COMMAND_PATTERNS: readonly RegExp[] = [
  // Recursive destruction.
  /\brm\s+-[a-z]*[rRfF][a-z]*\s+\//i,
  /\bsudo\s+rm\b/i,
  /\bchmod\s+-R\s+[0-7]+\s+\//i,
  /\bchmod\s+-R\s+[ugoa+\-=rwxXst,]+\s+\//,
  /\bchown\s+-R\s+\S+\s+\//i,

  // fork bomb。
  /:\(\)\s*\{\s*:\s*\|\s*:/i,

  // Disk and filesystem destruction.
  />\s*\/dev\/sd[a-z]/i,
  /\bmkfs(\.|\b)/i,
  /\bdd\s+if=.+of=\/dev\//i,
  /\bshred\s+\/dev\//i,
  /\bcryptsetup\b/i,

  // System configuration destruction.
  />\s*\/etc\/(?:passwd|shadow|sudoers)\b/i,
  /\btee\s+(?:-a\s+)?\/etc\/(?:passwd|shadow|sudoers)\b/i,

  // Remote fetch and execute.
  /\b(?:curl|wget|fetch)\b[^|]*\|\s*(?:bash|sh|zsh|fish)\b/i,
  /(?:^|[\s;&|(])(?:bash|sh|zsh|source|\.)\s+<\(\s*(?:curl|wget|fetch)\b/i,
  /\beval\s+["'`]?\$\(\s*(?:curl|wget|fetch)\b|\beval\s+`\s*(?:curl|wget|fetch)\b/i,

  // Process and host control.
  /\bkill\s+-9\s+1\b/,
  /(?:^|[\s;&|(])(?:shutdown|poweroff|reboot|halt)(?:\s|$|[;|&])/i,
  /(?:^|[\s;&|(])init\s+0\b/i,

  // Network shell exfiltration.
  /\bnc\b[^|;]*\s-[a-zA-Z]*[ec][a-zA-Z]*\s/i,
];

/** `yolo`: any critical match on the raw line requires approval. */
export function criticalReason(command: string): string | undefined {
  if (command.length > MAX_COMMAND_LENGTH) return "command too long";
  return CRITICAL_COMMAND_PATTERNS.some((pattern) => pattern.test(command))
    ? "critical pattern detected"
    : undefined;
}

const DANGEROUS_COMMANDS = new Set([
  "rm",
  "rmdir",
  "sudo",
  "dd",
  "truncate",
  "kill",
  "killall",
  "pkill",
  "shutdown",
  "reboot",
  "mkfs",
  "fdisk",
  "parted",
  "chmod",
  "chown",
  "chroot",
]);

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const INTERPRETERS = new Set(["python", "python3", "node", "perl", "ruby", "php", "deno", "bun"]);
const WRAPPERS = new Set(["command", "exec", "nohup", "builtin"]);

const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]);
const GH_VALUE_OPTIONS = new Set(["-R", "--repo", "--hostname", "--config"]);

function basename(value: string): string {
  const parts = value.split("/");
  return parts[parts.length - 1] ?? value;
}

/**
 * Drops a write redirection to an allowed target (default `/dev/null`): it has no side effect yet
 * shows up in read-only commands. Returns the index after the redirection, or undefined when the
 * target is not allowed so callers fail closed.
 */
function matchRedirectTarget(
  command: string,
  start: number,
  targets: readonly string[],
): number | undefined {
  if (command[start] !== ">") return undefined;
  let targetStart = start + 1;
  if (command[targetStart] === ">") targetStart++;
  while (command[targetStart] === " " || command[targetStart] === "\t") targetStart++;

  for (const target of targets) {
    if (target.length === 0 || !command.startsWith(target, targetStart)) continue;
    const end = targetStart + target.length;
    const next = command[end];
    if (next !== undefined && !" \t\n;&|(){}".includes(next)) continue;
    return end;
  }
  return undefined;
}

/**
 * Linear, quote-aware tokenizer. Shell expansion, redirection to a target outside
 * `redirects`, or an unclosed quote returns undefined so callers fail closed and
 * treat the command as dangerous.
 */
function splitSegments(command: string, redirects: readonly string[]): string[][] | undefined {
  const segments: string[][] = [];
  let current: string[] = [];
  let token = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const flushToken = () => {
    if (!started) return;
    current.push(token);
    token = "";
    started = false;
  };
  const flushSegment = () => {
    flushToken();
    if (current.length > 0) segments.push(current);
    current = [];
  };

  for (let index = 0; index < command.length; index++) {
    const char = command[index] ?? "";
    if (escaped) {
      token += char;
      escaped = false;
      started = true;
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = null;
      else token += char;
      started = true;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === "\\") escaped = true;
      else if (char === "$" || char === "`") return undefined;
      else token += char;
      started = true;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (char === " " || char === "\t") {
      flushToken();
      continue;
    }
    const redirectStart = char === ">" ? index : char === "&" && command[index + 1] === ">" ? index + 1 : -1;
    if (redirectStart >= 0) {
      const redirectEnd = matchRedirectTarget(command, redirectStart, redirects);
      if (redirectEnd === undefined || (token !== "" && !/^\d+$/.test(token))) return undefined;
      token = "";
      started = false;
      index = redirectEnd - 1;
      continue;
    }
    if (char === "\n" || char === ";" || char === "&" || char === "|") {
      flushSegment();
      const next = command[index + 1];
      if (next === char || (char === "&" && next === "&") || (char === "|" && next === "|")) index++;
      continue;
    }
    if (char === "(" || char === ")" || char === "{" || char === "}") {
      flushSegment();
      continue;
    }
    if (char === "<" || char === "$" || char === "`" || char === "\0" || char === "\r") {
      return undefined;
    }
    token += char;
    started = true;
  }

  if (escaped || quote !== null) return undefined;
  flushSegment();
  return segments;
}

const dangerousSets = new Map<string, ReadonlySet<string>>();

/** Union of the built-in dangerous set and `extraDangerous`, cached by configuration content. */
function dangerousSet(extra: readonly string[] | undefined): ReadonlySet<string> {
  if (extra === undefined || extra.length === 0) return DANGEROUS_COMMANDS;
  const key = extra.join("\0");
  const cached = dangerousSets.get(key);
  if (cached !== undefined) return cached;
  const merged = new Set([...DANGEROUS_COMMANDS, ...extra.map((name) => name.toLowerCase())]);
  dangerousSets.set(key, merged);
  return merged;
}

/** Skips variable assignments, `env`, and wrapper prefixes to reach the command that actually runs. */
function resolveCommand(tokens: string[]): { command: string; args: string[] } | undefined {
  let index = 0;

  while (index < tokens.length) {
    const value = tokens[index] ?? "";
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
      index++;
      continue;
    }
    const current = basename(value).toLowerCase();
    if (current === "env") {
      index++;
      while (index < tokens.length) {
        const next = tokens[index] ?? "";
        if (next.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(next)) index++;
        else break;
      }
      continue;
    }
    if (WRAPPERS.has(current)) {
      index++;
      continue;
    }
    if (current === "time") {
      index++;
      while (index < tokens.length && (tokens[index] ?? "").startsWith("-")) index++;
      continue;
    }
    if (current === "nice" || current === "ionice" || current === "stdbuf" || current === "timeout") {
      index++;
      if (current === "timeout") index++;
      while (index < tokens.length && (tokens[index] ?? "").startsWith("-")) {
        const option = tokens[index] ?? "";
        index++;
        if (["-n", "-P", "-s", "-I", "-o", "-e"].includes(option)) index++;
      }
      continue;
    }
    break;
  }

  if (index >= tokens.length) return undefined;
  return { command: basename(tokens[index] ?? "").toLowerCase(), args: tokens.slice(index + 1) };
}

/** `yolo` extra names: only the user-supplied list, still resolved through wrappers. */
export function extraDangerousReason(
  command: string,
  extraDangerous: readonly string[] | undefined,
  redirects?: readonly string[],
): string | undefined {
  if (extraDangerous === undefined || extraDangerous.length === 0) return undefined;
  const names = new Set(extraDangerous.map((name) => name.toLowerCase()));
  const segments = splitSegments(command, redirects ?? DEFAULT_REDIRECT_TARGETS);
  if (segments === undefined) return undefined;
  for (const segment of segments) {
    const resolved = resolveCommand(segment);
    if (resolved !== undefined && names.has(resolved.command)) return `dangerous command: ${resolved.command}`;
  }
  return undefined;
}

function analyzeSegment(tokens: string[], options: AnalysisOptions): string | undefined {
  const resolved = resolveCommand(tokens);
  if (resolved === undefined) return undefined;
  const { command, args } = resolved;

  if (command === "rm" || command === "rmdir") return "recursive/forced file removal";
  if (command === "sudo") return "privilege escalation";
  if (command === "source") return "shell sourcing";
  if (dangerousSet(options.extraDangerous).has(command)) return `dangerous command: ${command}`;

  if (SHELLS.has(command)) {
    const codeFlag = args.findIndex((arg) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg));
    if (codeFlag >= 0 && args[codeFlag + 1] !== undefined) return analyzeCommand(args[codeFlag + 1] ?? "", options);
    return `shell execution: ${command}`;
  }
  if (command === "eval") return analyzeCommand(args.join(" "), options);
  if (command === "xargs") return "xargs execution";
  if (command === "find") {
    if (args.some((arg) => ["-delete", "-exec", "-execdir", "-ok", "-okdir"].includes(arg))) {
      return "find destructive action";
    }
    return undefined;
  }
  if (command === "git") return analyzeGit(args);
  if (command === "gh" || command === "glab") return analyzeGh(args);
  if (command === "npm" || command === "pnpm" || command === "yarn") {
    if (args.some((arg) => arg === "publish" || arg === "unpublish")) return "package publish";
    return undefined;
  }
  if (command === "kubectl" || command === "helm" || command === "terraform") {
    if (args.some((arg) => arg === "delete" || arg === "destroy" || arg === "uninstall")) {
      return "cluster destructive action";
    }
    return undefined;
  }
  if (command === "docker" || command === "podman") {
    if (args[0] === "rm" || args[0] === "prune" || args[0] === "system") return "container destructive action";
    return undefined;
  }
  if (command === "mv") {
    if (args.some((arg) => arg.startsWith("/dev/"))) return "overwrite device";
    return undefined;
  }
  if (INTERPRETERS.has(command)) return `interpreter execution: ${command}`;
  return undefined;
}

function analyzeGit(args: string[]): string | undefined {
  let index = 0;
  while (index < args.length) {
    const arg = args[index] ?? "";
    if (arg === "--") {
      index++;
      break;
    }
    if (GIT_VALUE_OPTIONS.has(arg)) {
      index += 2;
      continue;
    }
    if (arg.startsWith("-")) {
      index++;
      continue;
    }
    break;
  }
  const sub = (args[index] ?? "").toLowerCase();
  const rest = args.slice(index + 1);
  if (sub === "push") return "remote git write";
  if (sub === "reset" && (rest.includes("--hard") || rest.includes("--merge") || rest.includes("--keep"))) {
    return "git history reset";
  }
  if (sub === "clean" && rest.some((arg) => /^-[a-zA-Z]*f/.test(arg) || arg === "--force")) {
    return "git worktree clean";
  }
  if (sub === "branch" && rest.some((arg) => arg === "-D" || arg === "--delete" || arg === "-d")) {
    return "git branch delete";
  }
  if (sub === "stash" && (rest[0] === "drop" || rest[0] === "clear")) return "git stash delete";
  return undefined;
}

function analyzeGh(args: string[]): string | undefined {
  let index = 0;
  while (index < args.length) {
    const arg = args[index] ?? "";
    if (GH_VALUE_OPTIONS.has(arg)) {
      index += 2;
      continue;
    }
    if (arg.startsWith("-")) {
      index++;
      continue;
    }
    break;
  }
  const scope = (args[index] ?? "").toLowerCase();
  const action = (args[index + 1] ?? "").toLowerCase();
  if (scope === "repo" && ["create", "delete", "rename", "archive", "unarchive", "edit", "set-default", "deploy-key"].includes(action)) {
    return "remote repository write";
  }
  if ((scope === "pr" || scope === "mr") && ["merge", "close"].includes(action)) {
    return "remote pull request write";
  }
  if (scope === "issue" && ["close", "delete"].includes(action)) return "remote issue write";
  if (scope === "secret" && ["set", "delete", "remove"].includes(action)) return "remote secret write";
  if (scope === "variable" && ["set", "delete", "remove"].includes(action)) return "remote variable write";
  if (scope === "release" && ["create", "delete", "edit"].includes(action)) return "remote release write";
  return undefined;
}

function analyzeCommand(command: string, options: AnalysisOptions = {}): string | undefined {
  if (command.length > MAX_COMMAND_LENGTH) return "command too long";
  if (/:\(\)\s*\{/.test(command)) return "fork bomb";
  const segments = splitSegments(command, options.redirects ?? DEFAULT_REDIRECT_TARGETS);
  if (segments === undefined) return "unparseable command";
  for (const segment of segments) {
    const reason = analyzeSegment(segment, options);
    if (reason !== undefined) return reason;
  }
  return undefined;
}

export function hasRmInvocation(command: string): boolean {
  return analyzeCommand(command) === "recursive/forced file removal";
}

export function dangerReason(command: string, options?: AnalysisOptions): string | undefined {
  return analyzeCommand(command, options);
}

export function isDangerousBash(command: string, options?: AnalysisOptions): boolean {
  return analyzeCommand(command, options) !== undefined;
}

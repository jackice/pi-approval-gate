export function hasRmInvocation(command: string): boolean {
  return command
    .split(/(?:&&|\|\||\$\(|`|[;|&\n])/)
    .map((part) => part.trim())
    .filter(Boolean)
    .some((part) =>
      /^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+|env(?:\s+(?:-[^\s]+|[A-Za-z_][A-Za-z0-9_]*=\S+))*\s+|(?:command|exec)\s+|(?:\S+\/)?time(?:\s+-p)?(?:\s+--)?\s+)*(?:\S+\/)?rm(?:\s|$)/i.test(
        part,
      ),
    );
}

const DANGEROUS_PATTERNS: readonly RegExp[] = [
  /\brmdir\b/i,
  /\bsudo\b/i,
  /\b(chmod|chown)\b.*777/i,
  /\bgit\s+push\b/i,
  /\bgh\s+repo\s+(create|delete|rename|archive|unarchive|edit)\b/i,
  /\bgh\s+repo\s+set-default\b/i,
  /\bgh\s+repo\s+deploy-key\s+(add|delete)\b/i,
  /\bgh\s+secret\s+(set|delete|remove)\b/i,
  /\bgh\s+variable\s+(set|delete|remove)\b/i,
  /\bgh\s+release\s+(create|delete|edit)\b/i,
  /\bgh\s+pr\s+merge\b/i,
  /\bgh\s+pr\s+close\b/i,
  /\bgh\s+issue\s+close\b/i,
  /\bgh\s+issue\s+delete\b/i,
  /\bglab\s+repo\s+(create|delete|archive|unarchive)\b/i,
  /\bglab\s+mr\s+merge\b/i,
  /\bglab\s+mr\s+close\b/i,
  /\bglab\s+issue\s+close\b/i,
  /\bglab\s+issue\s+delete\b/i,
  /\bglab\s+release\s+(create|delete)\b/i,
  /\bglab\s+variable\s+(set|delete|update)\b/i,
];

export function isDangerousBash(command: string): boolean {
  return hasRmInvocation(command) || DANGEROUS_PATTERNS.some((pattern) => pattern.test(command));
}

export function dangerReason(command: string): string {
  if (hasRmInvocation(command)) return "recursive/forced file removal";
  if (/\bsudo\b/i.test(command)) return "privilege escalation";
  if (/\bgit\s+push\b/i.test(command)) return "remote git write";
  return "dangerous bash command";
}

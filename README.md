# @jackice/pi-approval-gate

An approval extension for Pi's supported Bash execution paths. It binds user approval to the final command and working directory, after `tool_call` handlers have run.

- Verified with Pi `1.6.0` and `@jackice/pi-ui` `0.4.2`. The native selection list is the default approval UI.
- Commands that require approval are denied when no supported interactive UI is available, in subagents, or on timeout, abort, reload, or shutdown.
- Registers a replacement `bash` tool through Pi's extension API. No Pi source changes are required.
- Only critical patterns prompt by default (`approvalGate.mode: "yolo"`, matching OMP). Unparseable commands no longer require approval; set `mode: "strict"` to restore the old full-analysis behavior.
- Honors `shellCommandPrefix` and `shellPath` settings and shows the final command before execution.
- Known limit: Pi `1.6.0` has no synchronous pre-spawn hook, so a cancellation in the gap between authorization and `spawn()` can still start the command. See the [review notes](docs/security-review.md). This is not a sandbox.

## How it works

1. The extension creates a Bash tool with `createBashToolDefinition` and a `spawnHook`.
2. When the policy requires approval, the tool waits for the user after all `tool_call` changes.
3. Approval authorizes one execution of the exact command in the exact working directory. The spawn hook consumes it before Bash starts.
4. A mismatch stops execution before the command runs.
5. Commands not flagged by the policy do not prompt.
6. Pi's `user_bash` (`!`) uses the same approval and parameter binding for flagged commands.
7. The extension checks the active `bash` registration against its own file's real path and blocks the tool if the source cannot be verified. Pi `1.6.0` rejects duplicate `bash` registrations.

## Configuration

```text
--approval-timeout-ms <ms>   # Default: 120000; includes time spent in the queue.
--approval-arm-ms <ms>       # Default: 500; minimum delay before allowing.
--approval-ui panel         # Use the styled panel instead of the native selection list.
--approval-guard uv         # Block pip/pip3/poetry/venv/py_compile and suggest uv.
PI_APPROVAL_TIMEOUT_MS
PI_APPROVAL_ARM_MS
```

Pi parses extension flags after loading the extension. Settings are read when each request is created.

The native-list view is the default. Both views start on **Allow once** and require Enter after the confirmation delay. Press Down to select **Deny**, or Esc to deny immediately. Use Page Up and Page Down to inspect long commands.

### Optional uv guard

`--approval-guard uv`, or the same value in settings, blocks Python package-manager commands before any approval dialog and prints the uv equivalent:

```json
{ "approvalGate": { "guard": "uv" } }
```

It is off by default. The guard is separate from approval: it runs first for both the tool and `user_bash`, and a returned message stops the command.

### Configurable policy

`approvalGate` sets the default posture and extends the built-in policy without a new release. It is read on every command, so edits apply to the next command with no restart. Unreadable entries are ignored and reported once at session start.

```json
{
  "approvalGate": {
    "mode": "yolo",
    "redirects": ["/dev/null"],
    "extraDangerous": ["kubectl", "terraform"],
    "patterns": [
      { "match": "git *", "approval": "allow" },
      { "match": "curl *", "approval": "prompt" },
      { "match": "deploy *", "approval": "deny" }
    ]
  }
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `mode` | `"yolo"` | Default posture. See the table below. |
| `redirects` | `["/dev/null"]` | Redirection targets dropped before tokenizing. |
| `extraDangerous` | `[]` | Command names that always prompt; matched at command position, including through wrappers and `sh -c`. |
| `patterns` | `[]` | Ordered glob rules (`*` only); the first matching rule wins. |

Modes:

| Mode | Prompts for | Notes |
| --- | --- | --- |
| `yolo` (default) | Critical patterns only | OMP's `yolo` also auto-approves critical commands (its bare critical override is ignored outside non-yolo modes). This extension deliberately keeps the critical floor, so `rm -rf /` still prompts. Full-analysis checks such as `rm -rf build`, `git push`, `gh pr merge`, `npm publish`, and unparseable commands (loops, `"$var"`) do not prompt. |
| `strict` | The full built-in analysis plus critical patterns | Dangerous commands, remote writes, interpreters, `rm`/`sudo`, unparseable commands. This was the pre-0.1.7 behavior. |
| `always-ask` | Every command | Only `deny` and `allow` rules can change the outcome. |

`yolo` relies on the same critical set as OMP's `CRITICAL_BASH_PATTERNS`, matched against the raw command line: recursive `rm` on `/`, `sudo rm`, `chmod`/`chown -R` on `/`, fork bombs, writes to `/dev/sd*`, `mkfs`, `dd`/`shred` on devices, `cryptsetup`, writes to `/etc/passwd|shadow|sudoers`, `curl|sh`, process substitution from `curl`, `eval "$(curl ...)"`, `kill -9 1`, `shutdown`/`reboot`/`init 0`, and `nc -e`.

`approval` values (all modes):

- `deny` rejects the command without a dialog; the model sees `Blocked by bash pattern: <match>`.
- `prompt` shows the approval dialog.
- `allow` skips the dialog, but only for a command the tokenizer can read as a single simple command. Any `;`, `&&`, `||`, `|`, `&`, `<`, `>`, `$(`, backtick, or `-c`/`--eval` option disables the rule, so `match: "git *"` never approves `git status && rm -rf build`.

Rule evaluation follows OMP's `bash.patterns`: the first matching rule wins, so put a narrow `deny` before a broader `allow` (`git push *` deny must precede `git *` allow). Order of checks: the matched rule's `deny`, then the mode's checks (critical patterns run first), then its `allow`, then its `prompt`, then the mode default. `deny` and `prompt` match the whole command and every shell segment, including segments built from expansions (`cd /tmp && rm -rf "$dir"`). A configured `allow` cannot approve `rm -rf /` in any mode.

## Verification

Verified with Pi `1.6.0` in a real TUI, using a test provider and a disposable fixture:

| Scenario | Result |
|---|---|
| Esc / Deny | The command does not run. |
| Allow once | The command runs after the arming delay. |
| Timeout after 1000 ms | The dialog closes without executing the command. |
| Headless `-p` | The command is denied by default. |
| RPC `--mode rpc` | The command is denied by default with `Blocked by approval gate`. |
| Subagent environment | `PI_SUBAGENT_CHILD=1` denies the command without a dialog. |
| Long command in fullscreen | Page Down reveals lines below the initial viewport. |
| `user_bash` | The `!` command prompts and executes only if allowed. |
| `shellCommandPrefix` | The configured prefix is applied. |
| Duplicate Bash registration | Pi reports a tool conflict rather than silently replacing the approval tool. |

Unit tests:

```bash
pnpm install
pnpm typecheck
pnpm test
```

## Limitations

- RPC has no verified external approval channel. Commands that require approval are denied by default.
- Subagent requests are denied, not escalated to the parent session.
- This is not a sandbox. It covers only the supported Bash paths, not `pi.exec`, `write`, `edit`, MCP, or `powershell`.
- The dialog does not show an arming countdown. Pressing Enter before the delay expires provides no feedback.
- Approval decisions are not stored in an audit log.
- The [review notes](docs/security-review.md) list the unresolved execution-boundary and release blockers.

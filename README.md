# @jackice/pi-approval-gate

An approval extension for Pi's supported Bash execution paths. It binds user approval to the final command and working directory, after `tool_call` handlers have run.

- Verified with Pi `1.6.0` and `@jackice/pi-ui` `0.4.2`. The native selection list is the default approval UI.
- Commands that require approval are denied when no supported interactive UI is available, in subagents, or on timeout, abort, reload, or shutdown.
- Registers a replacement `bash` tool through Pi's extension API. No Pi source changes are required.
- Commands the policy cannot parse require approval.
- Honors `shellCommandPrefix` and `shellPath` settings and shows the final command before execution.
- Unreleased. The independent review found execution-boundary blockers; do not install this candidate as a daily approval gate.

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
PI_APPROVAL_TIMEOUT_MS
PI_APPROVAL_ARM_MS
```

Pi parses extension flags after loading the extension. Settings are read when each request is created.

The native-list view is the default. It starts on **Deny** and supports Page Up and Page Down for long commands. It uses the same approval gate, confirmation delay, and cancellation rules as the styled panel.

## Reuse from another extension

Pi `1.6.0` allows only one `bash` registration per session. When another extension must own that registration (for example a host that already wraps `bash`), pass its options instead of loading this extension twice:

```ts
import approvalGateExtension from "./pi-approval-gate/index.ts";

export default function (pi) {
  approvalGateExtension(pi, {
    guard: (command) => (command.startsWith("pip ") ? "use uv instead" : undefined),
    sourcePath: fileURLToPath(import.meta.url),
  });
}
```

- `guard` runs before the approval dialog for both the tool and `user_bash`; a returned message blocks the command.
- `sourcePath` must be the file that registers the tool, otherwise the source check blocks `bash`.

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

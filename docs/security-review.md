# Security Review and Fix Log

- Date: 2026-11-24
- Scope: `pi-approval-gate`, `pi-ui/src/views/approval.ts`, `pi-ui/src/core/ansi.ts`
- Baseline: Pi `1.6.0`
- Method: independent read-only security review, local regression tests, and real TUI/RPC/headless probes

## Fixed

| ID | Severity | Issue | Fix |
|---|---|---|---|
| C1 | Critical | `sh -c`, `bash -lc`, `eval`, `xargs`, `find -exec`, quote splicing, and `${IFS}` could bypass the `rm` check | Rewrote as a linear quote-aware tokenizer plus recursive wrapper parsing; expansion, redirection, and unclosed quotes fail closed |
| H1 | High | `git -C … push`, `--no-pager`, `-c …` bypassed the check | Parse git global options before the subcommand |
| H2 | High | Uncovered `git reset --hard`, `clean`, `branch -D`, `find -delete`, `dd`, `truncate`, `chmod`, `kill`, `curl \| sh`, interpreters, `npm publish`, `docker rm`, `mv /dev` | Extended the danger set; interpreters, `source`, and `xargs` fail closed |
| H3 | High | In fullscreen, PgUp/PgDn went to the transcript and the tail of a long command stayed hidden | The component declares `capturesViewportInput` and honors `tui.select.pageUp/pageDown`; the tail was verified in a real session |
| M1 | Medium | The `hasRmInvocation` regex backtracked superlinearly; 5KB of input could stall the main thread | Removed the nested quantifiers, switched to linear tokenizing, capped input at 8KB, and kept the perf regression under 50ms |
| M2 | Medium | `shellCommandPrefix`/`shellPath` were silently dropped | Read `pi.getSettings()` and pass it to the inner bash; the dialog shows prefix+command and the fingerprint binds the final string |
| M3 | Medium | `user_bash` (`!`) bypassed approval | Intercept `user_bash` through the same Gate and per-operation fingerprint; deny/allow verified in a real session |
| M4 | Medium | Bidi and zero-width characters could disguise a command | `sanitizeText` strips U+200B–200F, U+202A–202E, U+2060, U+2066–2069, U+FEFF |
| M5 | Medium | Another extension registering `bash` first caused a silent bypass | Pi rejects duplicate `bash` registrations; the Gate also self-checks on `session_start` and blocks in `tool_call` |
| M6 | Medium | Harmless commands were flagged, causing approval fatigue | Match only in command position; `grep/echo/man` arguments do not trigger |
| L1 | Low | `cancelAll` did not clear fingerprints | A closed gate rejects new requests and clears tokens |
| L3 | Low | A non-finite `maxCommandLines` could hide the command | `Number.isFinite` fallback |
| L4 | Low | Paging keys ignored keybindings | Also match `tui.select.pageUp/pageDown` |
| L6 | Low | Huge or zero timeouts rejected immediately | Clamp to `[1, 2^31-1]` |

## Open

| ID | Severity | Notes |
|---|---|---|
| L2 | Low | The dialog shows no arming countdown; Enter during the arm window gives no feedback |
| L8 | Low | Approval decisions are not stored in a persistent audit entry |
| — | — | No trusted RPC approval channel; dangerous RPC commands are denied by default |
| — | — | `pi.exec` and the other tool surfaces (write/edit/MCP/powershell) are outside the bash Gate |
| R2 | High | Binding covers request/session/tool-call/command/cwd, single consumption, the original deadline, and revocation, but the SDK operations layer still checks `cwd` asynchronously after consumption, so authorization and process start are not provably atomic. |
| R3 | High | Pi 1.6.0 `createLocalShellOperations` checks `signal.aborted`, then `await fsAccess(cwd)`, and only then calls `spawn`; a cancellation inside that gap can still start the command. Manual Bash waiting on the Gate also has no AbortSignal to pass into the `user_bash` handler. |
| R4 | Medium | The styled panel still lacks the native list's full cwd rendering and control-character escaping. |
| R5 | High | The native list's auto-wrap dropped boundary whitespace, so soft wraps were indistinguishable from real newlines; the preview must preserve both. |
| R6 | High | The fullscreen input area can shrink independently of the terminal, so the component tail can be clipped; terminal rows and columns cannot prove the options and preview are visible. |
| R7 | High | Control-character escaping missed some invisible Unicode classes; the raw content must be shown visibly instead of silently dropped or hidden. |
| R8 | Medium | Narrow screens could clip risk and paging status; when key information is invisible the only correct answer is denial. |
| — | Release blocker (superseded) | The independent execution-boundary and interface reviews both failed at the time; see the 2026-11-25 update. |
| — | Pending acceptance | The basic native-list PTY probe passes but does not cover narrow windows or dock clipping; real session switches, reloads, and the final execution boundary were not covered. |

## Regression

- `pi-approval-gate`: 84 tests pass, including exact request binding, refusal of unsafe rewrites, and expiry/cancel revocation regressions.
- The new candidate was installed in isolation with `npm install --omit=peer` and started on Pi 1.6.0; `pi-ui@0.4.2` resolved from the runtime dependency and Pi supplied the TUI. No Bash command was executed.
- Side-effect-free PTY probe of the native `confirm()`: `Yes` is selected by default and an immediate Enter returns approval; an `AbortSignal` closes the dialog and returns denial. Cancellation cannot replace default-deny and arm protection.
- PTY probe of the new candidate on real Pi 1.6.0 with the real Gate and lazy text: default Enter denies, allow works once after arming, Page Down reaches the last line after a width change, and Esc, AbortSignal, and timeout all pass with waiters back to zero; no command ran.

Additional check: Pi 1.6.0 `wrapTextWithAnsi` trims whitespace, a 16-column title can lose the risk level, supplementary-plane variation selectors consume zero columns, and fullscreen `chat-viewport.js` places the confirmation component inside a shrinkable input container. The next step was to verify that the host can supply the actual visible range and focus, then regress lossless previews and shrink-time denial; without confirmed visibility, approval stays closed.

- Real session:
  - dangerous command deny / allow / timeout
  - a 20-line command in fullscreen shows `rm -rf target` after PgDn
  - `!rm -rf target` approval deny/allow
  - `shellCommandPrefix` applied
  - duplicate bash registration reported by the host
  - RPC/headless/subagent deny by default

## 2026-11-25 update

| ID | Status | Evidence |
|---|---|---|
| R5 | Fixed | Wrapping keeps boundary spaces and marks soft wraps with a trailing `>`; `tests/dialog.test.ts` asserts width and marker. |
| R6 | Partial | Approval requires the current overlay bounds to cover every rendered row, the column range, and the terminal; otherwise only denial is accepted. Bounds after a fullscreen shrink are still proven only by unit tests. |
| R7 | Fixed | Escapes `Default_Ignorable`, `Control`, `Format`, and `Surrogate` while keeping combining marks; invisible code points are shown visibly. |
| R8 | Fixed | Narrow screens fall back to a compact page label and a risk letter; only when nothing fits does approval stay closed. |
| R4 | Open | The styled panel still does not match the native list on full cwd rendering and control-character escaping. |
| R2 / R3 | Open | The execution-boundary race remains and needs a synchronous pre-spawn hook from Pi. |

Integration (2026-11-25): the optional `uv` guard now lives in this package (`--approval-guard uv` or `approvalGate.guard: "uv"`), the native list is the default UI, and this package is the only `bash` registrant. Verified on real Pi 1.6.0: `!pip install` is blocked with the uv hint, `!rm -rf` denies by default and keeps the file, and Down+Enter executes after approval. The model's Bash tool was not blocked by the source self-check.

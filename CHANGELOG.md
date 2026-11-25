# Changelog

## 0.1.5

- Add OMP-style borders, spacing, and keyboard hints to the default approval dialog. Adapt the command preview to fit the choices and bottom border in short terminals.

## 0.1.4

- English code comments, changelog, and review notes. No behavior change.

## 0.1.3

- Built-in optional uv command guard (`--approval-guard uv` or `approvalGate.guard: "uv"`), off by default.
- Removed the `guard`/`sourcePath` host options: the package registers `bash` itself, so no second extension is needed.

## 0.1.2

- Hardened the native approval view: keeps soft-wrap spaces, escapes invisible characters, shows risk and page status on narrow screens, and refuses approval when the view is clipped.
- The native selection list is now the default approval UI; `--approval-ui panel` switches back to the styled panel.
- Added `guard` and `sourcePath` options so a host extension can own the single `bash` registration and reuse approval; `guard` ran before the dialog.
- `glab mr merge/close` now counts as a remote write.

## 0.1.1

- Added `--approval-ui native`: the Pi native selection list replaces the styled panel while keeping default-deny, the arming delay, and Gate decisions.
- Pinned `@jackice/pi-ui` as a runtime dependency so the candidate extension still loads when Pi omits peer installs.
- Verify the `bash` registration source by real file path so symlinked installs do not block their own tool; refuse when the source cannot be confirmed.
- Security review C1/H1/H2/H3: linear quote-aware policy, recursive wrapper parsing, fail-closed behavior, git/gh global options, fullscreen paging.
- M1/M2/M3/M4/M5: removed the superlinear regex, inherited the shell prefix, intercepted `user_bash`, bidi cleanup, shadow-registration self-check.
- L1/L3/L4/L6: fingerprint cleanup on close, `maxCommandLines` fallback, paging keys, config clamp.
- 66 tests; real TUI/fullscreen/user_bash/RPC/subagent verification.

## 0.1.0

- Added ApprovalGate: FIFO queue, 120s timeout, idempotent abort/shutdown cancellation, up to 16 pending requests.
- Replaced the `bash` execution boundary: after approval a one-shot command+cwd fingerprint is written and consumed by the spawn hook.
- Added the `ApprovalView` dialog: full command, cwd, reason, risk, Allow once/Deny, scrolling, 500ms arm.
- RPC/headless/subagent requests are denied by default.
- Verified default denial on real Pi RPC and with `PI_SUBAGENT_CHILD=1`.

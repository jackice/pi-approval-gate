# @jackice/pi-approval-gate

Pi 的危险 bash 审批 Gate。通过替换受支持的 `bash` 执行边界，把审批绑定到最终 `command`/`cwd`，避免 `tool_call` 之后参数被改写。

- 基线：Pi `1.6.0`、`@jackice/pi-ui` `0.4.1`
- 默认拒绝：TUI 以外、无 UI、子代理、超时、abort、reload/shutdown
- 不修改原生 Pi 源码；使用 `registerTool` 覆盖 `bash`
- 策略使用线性 quote-aware 分词与递归解析；无法解析时 fail-closed
- 继承 `shellCommandPrefix` / `shellPath`，审批展示并绑定最终执行字符串

## 工作方式

1. `createBashToolDefinition(cwd, { commandPrefix, shellPath, spawnHook })` 创建受控 bash。
2. 危险命令在 `execute` 中先 `await gate.request(...)`。审批发生在所有 `tool_call` 修改之后。
3. 允许后写入一次性指纹（`command + cwd`）；真正 spawn 前 `spawnHook` 消费指纹。
4. 指纹不匹配（命令或 cwd 被改写）→ 抛错，零副作用。
5. 安全命令直接透传，无需审批。
6. `user_bash`（`!`）危险命令走同一审批；操作 exec 前消费指纹。
7. 其他扩展先注册 `bash` 时，宿主直接报冲突；Gate 也会在 `session_start` 自检并阻断。

## 配置

```text
--approval-timeout-ms <ms>   # 默认 120000，排队与等待都计时
--approval-arm-ms <ms>       # 默认 500，允许操作的确认保护
PI_APPROVAL_TIMEOUT_MS
PI_APPROVAL_ARM_MS
```

CLI flag 在扩展加载后才解析；Gate 在每次请求时读取，支持运行时配置。

## 已验证

真实 Pi 1.6.0 TUI + fake provider，命令 `rm -rf target`：

| 场景 | 结果 |
|---|---|
| Esc / Deny | 命令未执行，target 保留 |
| Allow once | 等待 arm 后执行，target 删除 |
| 1000ms 超时 | 对话框关闭，命令未执行 |
| headless `-p` | 默认拒绝，target 保留 |
| RPC `--mode rpc` | 默认拒绝，事件中返回 `Blocked by approval gate`，target 保留 |
| 子代理环境 | `PI_SUBAGENT_CHILD=1` 默认拒绝，无对话框，target 保留 |
| fullscreen 长命令 | PgDn 后显示第 19 行 `rm -rf target` |
| `user_bash` | `!rm -rf target` 弹出审批；deny 保留、allow 删除 |
| `shellCommandPrefix` | 安全命令执行时包含配置前缀 |
| 重复 bash 注册 | 宿主报 tool conflict，Gate 不会静默旁路 |

单元测试：

```bash
pnpm install
pnpm typecheck
pnpm test
```

## 限制

- RPC 暂无已验证的可信外部审批通道，危险命令默认拒绝。
- 子代理危险命令默认拒绝；父 Session 审批覆盖范围尚未接入。
- `pi.exec`、`write`/`edit`、MCP、`powershell` 等其他工具面不在 bash Gate 范围。
- arm 倒计时未在对话框显示；arm 内 Enter 无反馈。
- 审批未持久化审计 entry。
- 尚有 Low 级安全改进项；复审未执行。详见 `docs/security-review.md`。

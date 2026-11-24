# @jackice/pi-approval-gate

Pi 的危险 bash 审批 Gate。通过替换受支持的 `bash` 执行边界，把审批绑定到最终 `command`/`cwd`，避免 `tool_call` 之后参数被改写。

- 基线：Pi `1.6.0`、`@jackice/pi-ui` `0.4.0`
- 默认拒绝：TUI 以外、无 UI、子代理、超时、abort、reload/shutdown
- 不修改原生 Pi 源码；使用 `registerTool` 覆盖 `bash`
- 仅支持默认 CLI bash；嵌入式 SDK 的自定义 `commandPrefix`/`spawnHook` 不在支持范围

## 工作方式

1. `createBashToolDefinition(cwd, { spawnHook })` 创建受控 bash。
2. 危险命令在 `execute` 中先 `await gate.request(...)`。审批发生在所有 `tool_call` 修改之后。
3. 允许后写入一次性指纹（`command + cwd`）；真正 spawn 前 `spawnHook` 消费指纹。
4. 指纹不匹配（命令或 cwd 被改写）→ 抛错，零副作用。
5. 安全命令直接透传，无需审批。

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
| 最终指纹 | 精确 command/cwd 消费一次；改写 command/cwd 抛错 |
| 安全命令 | 无需审批直接执行 |
| 子代理 | `PI_SUBAGENT_CHILD=1` 默认拒绝 |
| reload/shutdown | Gate 独立取消等待者，不依赖 `custom<T>` Promise |

单元测试：

```bash
pnpm install
pnpm typecheck
pnpm test
```

## 限制

- 替换 `bash` 工具意味着不再继承宿主 SDK 的自定义 `commandPrefix`/`spawnHook`；这些配置不在审批支持范围。
- RPC 暂无已验证的可信外部审批通道，危险命令默认拒绝。
- 子代理危险命令默认拒绝；父 Session 审批覆盖范围尚未接入。
- 仅覆盖 `bash`；其他工具与 `user_bash` 不在首版范围。
- 未做独立安全 Reviewer 复核。

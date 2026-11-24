# 安全评审与修复记录

- 日期：2026-11-24
- 范围：`pi-approval-gate`、`pi-ui/src/views/approval.ts`、`pi-ui/src/core/ansi.ts`
- 基线：Pi `1.6.0`
- 评审方式：独立只读安全评审 + 本地回归测试 + 真实 TUI/RPC/headless 探针

## 已修复

| 编号 | 级别 | 问题 | 修复 |
|---|---|---|---|
| C1 | Critical | `sh -c`、`bash -lc`、`eval`、`xargs`、`find -exec`、引号拼接、`${IFS}` 可绕过 `rm` 判定 | 重写为线性 quote-aware 分词 + 递归解析包装命令；展开/重定向/未闭合引号 fail-closed |
| H1 | High | `git -C … push`、`--no-pager`、`-c …` 绕过 | 解析 git 全局选项后取子命令 |
| H2 | High | `git reset --hard`、`clean`、`branch -D`、`find -delete`、`dd`、`truncate`、`chmod`、`kill`、`curl \| sh`、解释器、`npm publish`、`docker rm`、`mv /dev` 等未覆盖 | 扩充危险动作；解释器、`source`、`xargs` 等 fail-closed |
| H3 | High | fullscreen 下 PgUp/PgDn 被 transcript 抢占，长命令尾部不可查看 | 组件声明 `capturesViewportInput`；支持 `tui.select.pageUp/pageDown`；真机验证尾部可见 |
| M1 | Medium | `hasRmInvocation` 正则超线性回溯，5KB 输入可卡住主线程 | 删除嵌套量词正则，改线性分词；8KB 上限；性能回归 <50ms |
| M2 | Medium | 静默丢失 `shellCommandPrefix`/`shellPath` | 读取 `pi.getSettings()` 并传给内层 bash；审批展示 prefix+command，指纹绑定最终字符串 |
| M3 | Medium | `user_bash`（`!`）绕过审批 | 拦截 `user_bash`，走同一 Gate + 操作级指纹；deny/allow 真机验证 |
| M4 | Medium | bidi/零宽字符可伪装命令 | `sanitizeText` 移除 U+200B–200F、U+202A–202E、U+2060、U+2066–2069、U+FEFF |
| M5 | Medium | 其他扩展先注册 `bash` 导致静默旁路 | 宿主对重复 `bash` 注册直接报错；Gate 另有 session_start 自检与 `tool_call` 阻断 |
| M6 | Medium | 无害命令误报（审批疲劳） | 只在命令位置匹配；`grep/echo/man` 参数不触发 |
| L1 | Low | `cancelAll` 不清指纹 | 关闭状态拒绝新请求并清空 tokens |
| L3 | Low | `maxCommandLines` 非有限值导致命令不可见 | `Number.isFinite` 兜底 |
| L4 | Low | 分页键不尊重 keybinding | 同时匹配 `tui.select.pageUp/pageDown` |
| L6 | Low | 超大/0 超时导致立即拒绝 | clamp 到 `[1, 2^31-1]` |

## 仍未处理

| 编号 | 级别 | 说明 |
|---|---|---|
| L2 | Low | arm 倒计时未在对话框显示；arm 内 Enter 静默无反馈 |
| L8 | Low | 审批无持久审计 entry |
| — | — | 可信 RPC 审批通道未接入，RPC 危险命令默认拒绝 |
| — | — | `pi.exec`、其他工具面（write/edit/MCP/powershell）不在 bash Gate 范围 |
| — | — | 已发起独立复审，未产出结论；G4 不视为通过 |

## 回归

- `pi-approval-gate`：66 个测试（新增两项注册来源检查）。
- 候选 tarball 在 Pi 1.6.0 隔离共装验证：加载路径和工具来源路径指向同一文件时允许使用；缺失或不同来源仍阻断。启动探针没有执行审批，不能替代最终绑定与取消验证。
- 真机：
  - 危险命令 deny / allow / timeout
  - fullscreen 20 行命令 PgDn 后可见 `rm -rf target`
  - `!rm -rf target` 审批 deny/allow
  - `shellCommandPrefix` 生效
  - 重复 bash 注册宿主报错
  - RPC/headless/子代理默认拒绝

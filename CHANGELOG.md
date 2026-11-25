# Changelog

## Unreleased

- 加固原生审批视图：保留软换行空格、转义不可见字符，并在窄屏显示风险与分页状态；视图内容被裁切时拒绝批准。
- 原生选择列表成为默认审批 UI，`--approval-ui panel` 可切回面板。
- 新增 `guard` 与 `sourcePath` 选项，允许宿主扩展持有唯一的 `bash` 注册并复用审批；`guard` 在对话框之前拦截。
- 将 `glab mr merge/close` 纳入远端写入审批。

## 0.1.1

- 新增 `--approval-ui native`：用 Pi 原生选择列表回滚新版面板，保留默认拒绝、确认延迟和 Gate 决策。
- 将 `@jackice/pi-ui` 固定为运行时依赖；Pi 省略 peer 安装时仍能加载候选扩展。
- 按真实文件路径验证 `bash` 注册来源，避免符号链接安装误阻断自身工具；无法确认来源时仍拒绝。
- 安全评审 C1/H1/H2/H3 修复：线性 quote-aware 策略、包装命令递归、fail-closed、git/gh 全局选项、fullscreen 分页
- M1/M2/M3/M4/M5 修复：移除超线性正则、继承 shell 前缀、拦截 user_bash、bidi 清洗、影子注册自检
- L1/L3/L4/L6 修复：关闭清理指纹、maxCommandLines 兜底、分页键位、配置 clamp
- 66 个测试；真实 TUI/fullscreen/user_bash/RPC/子代理验证

## 0.1.0

- 新增 ApprovalGate：FIFO 队列、120s 超时、abort/shutdown 幂等取消、最多 16 个待请求
- 新增 `bash` 执行边界替换：审批后写入一次性 command+cwd 指纹，spawnHook 消费
- 新增 `ApprovalView` 对话框：完整命令、cwd、reason、风险、Allow once/Deny、滚动、500ms arm
- RPC/headless/子代理默认拒绝
- 真实 Pi RPC 与 `PI_SUBAGENT_CHILD=1` 验证默认拒绝

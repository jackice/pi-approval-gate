# Changelog

## 0.1.0

- 新增 ApprovalGate：FIFO 队列、120s 超时、abort/shutdown 幂等取消、最多 16 个待请求
- 新增 `bash` 执行边界替换：审批后写入一次性 command+cwd 指纹，spawnHook 消费
- 新增 `ApprovalView` 对话框：完整命令、cwd、reason、风险、Allow once/Deny、滚动、500ms arm
- RPC/headless/子代理默认拒绝
- 12 个测试；真实 TUI 验证 deny/allow/timeout/headless 与最终参数绑定

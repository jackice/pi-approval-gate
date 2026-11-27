# policy 可配置化设计

日期：2026-11-27
状态：已实现（2026-11-27）

## 目标

危险命令判定目前硬编码在 `src/policy.ts`（`DANGEROUS_COMMANDS`、`DEV_NULL`）。每调整一次判定都要改代码并发版。改为可在 `settings.json` 配置，且改完即时生效。

非目标：

- 不引入 OMP 的 approval tier（read/write/exec）与 approvalMode。
- 不支持正则或 `?` 通配；规则语法与 OMP 的 `bash.patterns` 一致，仅字面文本 + `*`。
- 不做沙箱，不覆盖 `pi.exec`、`write`、`edit`、MCP。

## 参考实现：OMP

来源：`oh-my-pi/packages/coding-agent/src/tools/bash.ts`（`BashTool.approval`）、`docs/tools/bash.md`、`docs/settings.md`。

| 设计点 | OMP 做法 | 我们是否采用 |
| --- | --- | --- |
| 规则形式 | `bash.patterns: [{match, approval: allow\|deny\|prompt}]`，有序，首个匹配生效 | 采用 |
| glob 匹配 | 字面文本 + `*` → `^...$` 正则，先压缩空白 | 采用 |
| `allow` 的边界 | 含 shell 控制字符时**永不生效**，且必须匹配整条命令 | 采用 |
| `deny`/`prompt` 的边界 | 匹配整条命令 **和** 每个 shell 段（`&&`、`;`、`\|`、`&`、换行、子 shell） | 采用 |
| 内置危险模式优先级 | `deny 规则 → CRITICAL_BASH_PATTERNS → allow 规则 → prompt 规则`，allow 不能豁免 critical | 采用（把 critical 扩成现有完整静态分析） |
| 非法配置 | 解析失败的单条规则直接丢弃 | 采用，并在会话启动时提示一次 |
| 配置来源 | 全局 + 项目 config，运行期读取 | 采用 `pi.getSettings()`（已是 per-call 读取） |

OMP 的 `hasBashApprovalShellControl` 判定细节（我们复用同等逻辑）：

- 未转义、未引用的 `; & | < > \` $ ( )` 或换行 → 有控制字符。
- 双引号内出现 `$` 或反引号 → 有控制字符（展开仍然生效）。
- 单引号内或转义后的控制字符本身是字面量，但若命令行带 `-c` / `--eval` 这类会重解释参数的选项，则视为有控制字符。
- 命令被外部程序重新解释（`git -c alias.x='!...'`、`sh -c "..."`）同样视为有控制字符。

## 配置结构

```json
{
  "approvalGate": {
    "guard": "uv",
    "redirects": ["/dev/null"],
    "extraDangerous": ["kubectl", "terraform"],
    "patterns": [
      { "match": "git *", "approval": "allow" },
      { "match": "curl *", "approval": "prompt" },
      { "match": "rm -rf *", "approval": "deny" }
    ]
  }
}
```

| 字段 | 类型 | 默认 | 语义 |
| --- | --- | --- | --- |
| `guard` | `"uv"` | 关闭 | 现有行为，不变 |
| `redirects` | `string[]` | `["/dev/null"]` | 允许在解析前丢弃的写入重定向目标（当前硬编码的 `DEV_NULL`） |
| `extraDangerous` | `string[]` | `[]` | 追加到 `DANGEROUS_COMMANDS` 的命令名，按命令位置匹配，穿透 wrapper 与 `sh -c` |
| `patterns` | 规则数组 | `[]` | glob 规则，见下 |

三项都与内置判定是**并集**关系：内置能力不因配置而减少，`extraDangerous` / `redirects` 只增不减，`patterns` 是额外一层。

`approval` 取值：

- `deny`：直接拒绝，不弹窗，模型收到原因。
- `prompt`：走现有审批弹窗。
- `allow`：不弹窗直接执行，但受上面的 allow 边界约束。

## 判定顺序

`src/policy.ts` 对外提供 `evaluatePolicy(command, config)`，返回 `{ decision: "allow" | "prompt" | "deny", reason?: string }`：

1. `deny` 规则（整条命令 + 各段）命中 → `deny`，reason = `Blocked by bash pattern: <match>`。
2. 现有静态分析：`DANGEROUS_COMMANDS`（含 `extraDangerous`）、fork bomb、超长、不可解析 → `prompt`，reason 沿用现有文案。
3. `allow` 规则命中（无 shell 控制字符 + 整条匹配）→ `allow`。
4. `prompt` 规则命中 → `prompt`，reason = `Prompt required by bash pattern: <match>`。
5. 其余 → `allow`。

顺序即安全边界：`allow` 永远不可能豁免内置危险判定，也不可能搭乘复合命令。

配置里的重定向目标在静态分析阶段前被丢弃（`redirects` 取代 `DEV_NULL`），所以 `ls 2>/dev/null` 不会被 2 步判为不可解析。

## 生效与容错

- 每次 bash / `user_bash` 调用读取 `pi.getSettings()`，改 `settings.json` 后新命令立即生效，无需重启、无需发版。
- 编译后的 glob 正则按配置指纹缓存，避免逐条命令重复编译。
- 非法配置（非对象、`match` 非字符串、`approval` 非三种取值之一）单条丢弃；`session_start` 时若有丢弃项，用 `ctx.ui.notify` 提示一次，不阻断会话。

## 风险

- `allow` 写宽（例如 `{"match": "*", "approval": "allow"}`）等于关闭闸门。缓解：内置分析优先 + 控制字符禁令 + README 显式警告；不提供"整体替换内置危险命令集"这一项。
- `deny` 规则误配会挡住日常工作，但可即时改配置纠正，不需要发版。

## 验收标准

1. `approvalGate.patterns` 支持 allow / prompt / deny，有序，首个匹配生效。
2. allow 不生效的场景全部被覆盖：`&&`、`;`、`|`、`&`、换行、`$(...)`、反引号、`<`/`>` 重定向、`-c` 重解释、`FOO=1 git status`、`/usr/bin/git status`、`"git" status`。
3. deny / prompt 能捕获复合命令中的危险段（含子 shell、背景 `&`）。
4. `extraDangerous` 追加的命令名在 wrapper 与 `sh -c` 下仍触发审批。
5. `redirects` 可配置，默认行为与当前 `/dev/null` 实现一致。
6. 改配置后无需重启即生效（文档说明 + 单测覆盖 per-call 读取）。
7. `pnpm test` 与 `pnpm typecheck` 通过。

## 追加：mode 档位（2026-11-27，对齐 OMP）

原设计默认沿用内置静态分析。实际使用中误报过多，改为可配置档位，默认与 OMP 一致。

`approvalGate.mode`：

| 值 | 判定方式 | 说明 |
| --- | --- | --- |
| `yolo`（默认） | 只跑 `CRITICAL_COMMAND_PATTERNS`（照搬 OMP 的 `CRITICAL_BASH_PATTERNS`，20 条），在原始命令行上正则匹配 | 不做 tokenize，因此含 `$`、反引号、循环、重定向的命令都不再弹窗 |
| `strict` | critical 正则 + 现有 `analyzeCommand` 全量静态分析 | 0.1.6 行为，外加 critical 地板（只会更严） |
| `always-ask` | 所有命令都弹窗 | 只有 `deny` / `allow` 规则能改变结果 |

判定顺序（与 OMP `BashTool.approval` + `resolveApproval` 一致）：`首个命中规则 → deny 短路 → 档位判定 → allow → prompt → 档位默认（always-ask 弹窗，其余放行）`。

细节：

- 规则顺序由配置决定：窄 `deny` 必须写在宽 `allow` 之前才会生效，与 OMP 的 "first matching rule wins" 一致。
- `deny` / `prompt` 匹配整条命令与每个 shell 段；分段器移植自 OMP 的 `tokenizeShellSegments`，永不失败，因此 `cd /tmp && rm -rf "$dir"` 这类含展开的段也能命中。
- `criticalReason` 是所有档位的地板（`strict` 只会更严）。这一条是**有意偏离 OMP**：OMP 的 `resolveApproval` 在 `yolo` 下忽略裸 critical override，`rm -rf /` 会被直接放行；本扩展保留该地板。

### 与 OMP 的差异清单

| 项 | OMP | 本扩展 | 原因 |
| --- | --- | --- | --- |
| `yolo` 下的 critical | 忽略（allow） | 弹审批 | 用户选定“只弹 critical 类”，避免默认放行 `rm -rf /` |
| `redirects` | 无 | 可配置，默认 `/dev/null` | 减少只读命令误报 |
| `extraDangerous` | 无 | 可追加命令名 | 承接原有 `DANGEROUS_COMMANDS` 的扩展需求 |
| `strict` 档 | 无 | 完整静态分析 | 保留 0.1.6 行为供更严格场景 |
| 命令长度上限 | 无 | >8192 弹窗 | 既有保护，保留 |

其余（glob 编译、空白归一化、`hasShellControl`、allow 不搭复合命令、规则优先级、分段匹配）与 OMP 逐行等价，已用差分脚本覆盖 34 条命令 × 8 组配置 × 2 档验证，非 critical 差异为 0。

`extraDangerous` 在两档都生效，语义为"命令位置命中即弹窗"（穿透 wrapper、`sh -c`、变量赋值前缀）。`yolo` 下它只叠加用户名单，不叠加内置 `DANGEROUS_COMMANDS`——否则 `rm -rf build` 会继续弹窗，与 OMP 不一致。

已知取舍：`yolo` 下 `rm -rf build`、`git push`、`gh pr merge`、`npm publish` 都不弹窗，这是 OMP 的默认姿态；需要这些保护时设 `mode: "strict"` 或用 `patterns` 补 `prompt` 规则。

验收：

1. 无配置时 `rm -rf /`、`curl | sh`、`sudo rm`、`dd of=/dev/*` 弹窗，其余常见命令放行。
2. `mode: "strict"` 恢复 0.1.6 的全部拦截项，并额外包含 critical 地板。
3. `mode: "always-ask"` 下所有命令弹窗，`allow` 规则仍可放行。
4. `pnpm test` 与 `pnpm typecheck` 通过。

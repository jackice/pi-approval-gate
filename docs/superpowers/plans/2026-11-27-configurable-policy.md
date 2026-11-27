# policy 可配置化实施计划

对应设计：`docs/superpowers/specs/2026-11-27-configurable-policy-design.md`

## 步骤 1：配置解析（新增 `src/policy-config.ts`）

- `PolicyConfig` 类型：`{ redirects: string[]; extraDangerous: string[]; patterns: BashPatternRule[] }`。
- `parsePolicyConfig(raw: unknown): { config: PolicyConfig; dropped: number }`：逐字段校验，非法项丢弃并计数。
- `match` 归一化：trim + 连续空白压缩为单个空格。
- glob → 正则：`*` → `.*`，其余字符正则转义，两端锚定，带 `u` 标志；非空缓存。
- 单测：`tests/policy-config.test.ts`，覆盖合法、非法、空配置、空白归一化。

验收：`parsePolicyConfig(undefined)` 返回默认值且 `dropped === 0`。

## 步骤 2：静态分析参数化（`src/policy.ts`）

- `DANGEROUS_COMMANDS` 保持为内置常量。
- `analyzeCommand(command, options)` 接受 `{ redirects, extraDangerous }`；重定向与危险命令集由参数提供，默认值等价当前行为。
- `matchDevNullRedirect` 改为 `matchRedirectTarget(command, start, targets)`。
- 单测保持既有 88 条全绿（默认参数路径不变）。

验收：不传 options 时行为与当前完全一致。

## 步骤 3：规则评估（`src/policy-rules.ts`）

- `hasShellControl(command): boolean`：移植 OMP 的 `hasBashApprovalShellControl` 语义（控制字符、引号内 `$`/反引号、`-c`/`--eval` 重解释）。
- `splitForRules(command)`：用现有 `splitSegments` 结果拼回各段字符串，用于 deny/prompt 的逐段匹配。
- `evaluatePolicy(command, config)`：按设计的五步顺序返回 `{ decision, reason }`。
- 单测：`tests/policy-rules.test.ts`，覆盖设计的验收标准 1–4。

验收：`evaluatePolicy("*", allow)` 对 `git status && rm file.txt` 返回 `prompt`，对 `git status` 返回 `allow`。

## 步骤 4：接入扩展（`index.ts`）

- 新增 `policyConfig()` 帮助函数，per-call 读取 `pi.getSettings().approvalGate`，走 `parsePolicyConfig`。
- bash 工具与 `user_bash` 两处：
  - `decision === "deny"` → 直接返回错误结果，不弹窗。
  - `decision === "prompt"` → 现有 `gate.request` 路径。
  - `decision === "allow"` → 现有直通路径。
- `session_start` 提示丢弃的非法规则（一次）。
- 单测：`tests/extension.test.ts` 增加 deny 直通、allow 直通的用例。

验收：配置 `deny` 时命令不执行且无弹窗；配置 `allow` 时无弹窗。

## 步骤 5：文档与版本

- README：新增“可配置 policy”小节，含 JSON 示例、allow 边界警告、生效方式（改完即时生效）。
- CHANGELOG：Unreleased 条目。
- `pnpm test` + `pnpm typecheck` 全绿。

验收：README 示例配置可直接粘贴生效。

## 回滚

每步独立提交；删除 `approvalGate.patterns` 配置即回到内置判定；代码侧 `evaluatePolicy` 在无配置时等价于当前逻辑。

## 追加步骤：mode 档位

1. `src/policy-config.ts`：`PolicyMode` + `DEFAULT_MODE = "yolo"`，`parseMode` 非法值丢弃并回退默认。
2. `src/policy.ts`：导出 `CRITICAL_COMMAND_PATTERNS`（照搬 OMP）与 `criticalReason`、`extraDangerousReason`；从 `analyzeSegment` 拆出 `resolveCommand`，供两档共用命令位置解析。
3. `src/policy-rules.ts`：`evaluatePolicy` 按 `mode` 分派（`strict` 走 `dangerReason`，`yolo` 走 critical + extra，`always-ask` 兜底弹窗）。
4. 测试：新增三档用例；原依赖内置分析的用例显式传 `mode: "strict"`。
5. 文档：README 模式表、CHANGELOG、spec 追加节。

## 与 OMP 对齐校准（复核轮）

1. 规则顺序回到 OMP 语义：首个命中规则生效；窄 `deny` 必须写在宽 `allow` 之前。撤销上一版“deny 跨全部规则优先”。
2. `deny`/`prompt` 的分段匹配改用移植自 OMP `tokenizeShellSegments` 的 `ruleSegments`（永不失败），替换原先复用 fail-closed tokenizer 的实现；`cd /tmp && rm -rf "$dir"`、`echo $(rm -rf x)` 现在能被 deny 规则捕获。`policy.ts` 的 `commandSegments` 随之删除。
3. 差分验证：34 条命令 × 8 组规则 × 2 档，与 OMP 的 `BashTool.approval` + `resolveApproval` 仿真结果比对，非 critical 差异 0；`CRITICAL_COMMAND_PATTERNS` 20 条与 OMP 逐条相同；`hasShellControl` 与 `ruleSegments` 逐条相同。
4. 保留的差异：`yolo` 下 critical 仍弹窗（OMP 会放行），见 spec 差异清单。

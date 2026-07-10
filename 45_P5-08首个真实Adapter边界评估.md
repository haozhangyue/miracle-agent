# P5-08 首个真实 Adapter 边界评估

> 文档状态：CURRENT
>
> 阶段结论：P5-08 已完成；首个真实 Adapter 推荐选择 Codex CLI Adapter，官方
> Responses API Adapter 作为第二条 Provider Adapter 路线。
>
> 评估日期：2026-07-10

## 1. 结论

Miracle 的首个真实 Adapter 推荐采用：

```text
Codex CLI Adapter
-> 本地隔离 attempt workspace
-> codex exec --json --ephemeral
-> AdapterResult
-> Orchestrator 单写入运行事实
```

官方 API Adapter 不被否定，但放在第二顺位：

```text
Official API Adapter
-> Responses API
-> text/image/tool 等模型节点
-> Provider 路由、成本和规模化能力
```

选择 Codex CLI 先行的原因：

1. 当前真实“热点工具更新”工作流依赖本地文件、项目 Skill、命令和产物目录。
2. Miracle 当前是本地 Web + Local Sidecar，Codex CLI 与部署形态天然一致。
3. `codex exec` 支持非交互执行、JSONL 事件、结构化输出、显式 sandbox 和超时控制。
4. 当前机器已安装 `codex-cli 0.142.1`，可作为首轮实现和验收环境。
5. 官方 API 更适合单个模型能力节点；若要替代完整本地 Agent，还需额外建设工具执行、
   文件系统、MCP、产物提交和审批 harness。

本结论不代表 Miracle 绑定 Codex。Codex CLI 只是第一个 `kind: codex` 的真实实现，
Hermes、OpenClaw 和官方 API 继续共享 `AdapterInvocation / AdapterResult` 边界。

## 2. 评估依据

### 2.1 当前工程依据

Miracle 已具备：

- `AdapterManifest`、Adapter Registry 和凭证状态。
- `AdapterInvocation`、`AdapterResult` 和 Artifact descriptor。
- `dispatched -> received -> committed` 三段运行事件。
- `mock-local`、Codex mock-compatible 和官方 API shell manifest。
- Orchestrator 单写入 NodeAttempt、ArtifactManifest、GateInstance 和 TraceEvent。

当前缺口：

- `codex-cli` 和 `external-api` executor 尚未实现。
- 当前 Codex manifest 仍指向 `mock-runner`。
- AdapterInvocation 尚未携带 attempt workspace、deadline、prompt、output schema 和取消句柄。
- 当前 TypeScript `AdapterResult` 尚未包含 P3 文档要求的 `attempt_id`。
- keychain/workspace-secret、真实成本和跨 Run capacity 尚未实现。

### 2.2 官方能力依据

- Codex 官方说明 `codex exec` 面向 CI、脚本和管道式非交互执行；`--json` 输出 JSONL
  事件，`--output-schema` 支持结构化最终结果，sandbox 可显式设置。见
  [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive)。
- 官方建议自动化使用最小权限，并避免把 API Key 暴露给不可信的仓库脚本或依赖过程。
- OpenAI 对新 API 项目推荐 Responses API；它支持工具、结构化输出、状态和多模态。
  见 [Migrate to the Responses API](https://developers.openai.com/api/docs/guides/migrate-to-responses)。
- Responses background mode 支持轮询和幂等取消，但要求存储响应；本地 Sidecar 可先轮询，
  无需公开 webhook。见
  [Background mode](https://developers.openai.com/api/docs/guides/background)。
- Webhook 需要公网端点、验签和去重，当前本地 MVP 不应把它作为前置依赖。见
  [Webhooks](https://developers.openai.com/api/docs/guides/webhooks)。

## 3. Codex CLI 与官方 API 对比

| 维度 | Codex CLI Adapter | Official API Adapter | P5 结论 |
|---|---|---|---|
| 本地 workspace | 原生适配 | 需要自建文件/工具 harness | Codex 优先 |
| 项目 Skill/AGENTS | 可复用项目上下文 | 需转成 prompt、tool 或 hosted skill | Codex 优先 |
| 命令和文件修改 | CLI Agent 内建 | 需 function/shell/MCP 承接 | Codex 优先 |
| 结构化事件 | `--json` JSONL | Responses typed Items/events | 都可映射 |
| 结构化最终输出 | `--output-schema` | Structured Outputs | 都可用 |
| 凭证 | 本地 Codex 登录或单次 Key | Provider API Key | 分开治理 |
| 取消 | 终止进程组 | Responses cancel | 都需幂等 |
| 长任务恢复 | 本地进程与事件游标 | background polling/stream | API 更成熟 |
| 成本回执 | 从 usage 事件推导，未必有金额 | usage + Provider 计价 | API 更适合成本路由 |
| 多模型路由 | 受 CLI/provider 配置影响 | ProviderPolicy 可直接选择 | API 更适合规模化 |
| 本地优先 | 强 | 中 | Codex 优先 |
| 云端商业化 | 中 | 强 | API 后续优先 |

## 4. 首接范围

### 4.1 第一批能力

Codex CLI Adapter 第一批只承接“输入已准备、输出可校验”的节点：

- `fact.verify`
- `content.longform_draft`
- `fact.safe_writing`
- `script.write`
- `storyboard.plan`
- `publish.package`
- `retro.collect`

首轮不承接：

- 需要不受限公网访问的全量采集。
- TTS、视频渲染等专用媒体 executor。
- 需要桌面 UI 操作的 Pencil 或 Computer Use。
- 跨 Run 长期会话和无人值守连续自治。
- `danger-full-access` 或绕过审批与 sandbox 的执行。

### 4.2 首个验收节点

推荐首个真实执行节点为 `C_md_master`：

```text
已验证 clean_events + topic_strategy
-> Codex CLI Adapter
-> md_master_draft
-> ArtifactManifest
-> 内容审核 Gate
```

原因：输入和输出都是可验证的文档资产，不依赖 TTS、视频或公网采集，失败时不会造成外部
副作用，并能验证 Skill、结构化输出、Artifact、Gate 和 Trace 的完整链路。

## 5. CodexCliAdapterManifest v0

新建真实 manifest，不覆盖 mock-compatible manifest：

```yaml
id: codex-cli-local-v0
kind: codex
display_name: Codex CLI Local Adapter
version: 0.1.0
status: experimental
execution_mode: shell
capabilities:
  - fact.verify
  - content.longform_draft
  - fact.safe_writing
  - script.write
  - storyboard.plan
  - publish.package
  - retro.collect
supported_providers:
  - codex-local
default_provider: codex-local
required_credentials:
  - key: CODEX_CLI_AUTH
    label: Codex CLI 登录状态
    source: keychain
    required: true
runtime:
  local_executor: codex-cli
  can_execute: true
  entrypoint: codex
```

`CODEX_CLI_AUTH` 是逻辑凭证引用，不是环境变量名。Sidecar 只执行只读健康检查，不读取、
复制或记录 `~/.codex/auth.json`。

## 6. AdapterInvocation 扩展

沿用现有字段，并增加运行控制信息：

```yaml
operation_id: op_run001_C_md_master_001
attempt_id: attempt_run001_C_md_master_001
run_id: run_001
node_run_id: nr_C_md_master
node_id: C_md_master
adapter_kind: codex
adapter_id: codex-cli-local-v0
provider: codex-local
capability_requirements: [content.longform_draft, fact.safe_writing]
input_artifacts:
  - artifacts/clean_events_v1.json
  - artifacts/topic_strategy_v1.md
expected_outputs:
  - output_id: md_master_draft
    artifact_type: markdown
    artifact_spec_ref: artifact_md_master
    required: true
runtime_control:
  workspace_handle: runtime/run_001/nr_C_md_master/attempt_001
  prompt_handle: runtime/run_001/nr_C_md_master/attempt_001/prompt.md
  output_schema_handle: runtime/schemas/codex-node-result-v0.json
  deadline_at: 2026-07-10T11:00:00+08:00
  timeout_seconds: 1800
  sandbox: workspace-write
  network_policy: inherited_restricted
  idempotency_key: run_001:nr_C_md_master:attempt_001
```

约束：

1. Adapter 只能访问 `workspace_handle` 和显式只读输入。
2. 绝对路径只在 Sidecar 内部解析，不进入 UI、prompt 或 TraceEvent。
3. `attempt_id` 在 dispatched 前生成，Invocation 和 Result 必须一致。
4. timeout、sandbox 和 network policy 必须由 Orchestrator 固化，Adapter 不能自行放宽。

## 7. Codex 子进程协议

### 7.1 推荐命令形态

```bash
codex exec \
  --cd <attempt-workspace> \
  --sandbox workspace-write \
  -c 'approval_policy="never"' \
  --ephemeral \
  --json \
  --output-schema <codex-node-result-schema.json> \
  --output-last-message <final-result.json> \
  -
```

prompt 通过 stdin 传入，不通过 shell 字符串拼接。Sidecar 应使用参数数组启动进程，避免
命令注入。新进程使用独立进程组，以支持超时和取消时终止整组子进程。

### 7.2 为什么使用这些参数

| 参数 | 目的 |
|---|---|
| `--cd` | 把 Codex 限定在 attempt workspace。 |
| `--sandbox workspace-write` | 允许写本次产物，不开放全机写权限。 |
| `approval_policy="never"` | 非交互任务不弹出审批；超出权限的操作直接失败并返回 AdapterResult。 |
| `--ephemeral` | 不让 Codex rollout 成为第二套持久运行真相。 |
| `--json` | 捕获 thread、turn、command、file change、usage 和错误事件。 |
| `--output-schema` | 约束最终回执字段。 |
| `--output-last-message` | 独立保存最终结构化结果，避免从事件流猜测最终答案。 |

禁止使用：

- `--dangerously-bypass-approvals-and-sandbox`
- `--sandbox danger-full-access`
- 把密钥写入 prompt、命令参数、日志或产物。
- 直接把 Codex 生成的文件登记为 ArtifactManifest，绕过 Sidecar 校验。

### 7.3 配置可重复性

第一版采用“显式运行参数 + 项目上下文”模式：

- sandbox、workspace、output schema、timeout 由 Sidecar 固化。
- 项目级 `AGENTS.md` 和 `.codex/skills` 可被节点使用。
- 用户级模型、provider 或 MCP 配置不能被默认为 WorkflowSpec 真相；实际解析结果必须写入
  `provider_receipt`。
- 后续如需完全可重复执行，再引入 Miracle 专用 Codex profile 和允许列表 MCP。

## 8. JSONL 事件与审计映射

Codex stdout JSONL 只作为 Adapter 原始事件流，不能直接写 Run Event Journal。

| Codex 事件 | Miracle 处理 |
|---|---|
| `thread.started` | 记录脱敏 `thread_id` 到 provider receipt。 |
| `turn.started` | 更新 Adapter operation projection。 |
| command execution | 记录命令类别、退出状态和耗时摘要；不默认保存完整敏感输出。 |
| file change | 记录候选变更路径，Sidecar 再做 workspace 边界检查。 |
| agent message | 只读取最终结构化结果或用户可见摘要。 |
| `turn.completed` | 记录 token usage，并进入结果校验。 |
| `turn.failed` / `error` | 映射为失败 AdapterResult。 |

不记录：

- 隐藏推理链。
- API Key、认证 token、Cookie、环境变量值。
- 不在允许目录内的本地绝对路径。
- 未经大小和敏感信息过滤的 stdout/stderr 全量内容。

原始 JSONL 可按保留策略写入 attempt 私有目录；Run Trace 只保存结构化摘要和引用。

## 9. AdapterResult v0

```yaml
operation_id: op_run001_C_md_master_001
attempt_id: attempt_run001_C_md_master_001
node_run_id: nr_C_md_master
status: succeeded
provider_receipt:
  provider: codex-local
  adapter_kind: codex
  adapter_id: codex-cli-local-v0
  codex_version: 0.142.1
  thread_id: redacted-or-hashed
  model: resolved-model-id
  usage:
    input_tokens: 0
    cached_input_tokens: 0
    output_tokens: 0
  latency_ms: 0
  exit_code: 0
artifact_descriptors:
  - artifact_id: art_run001_md_master_v1
    output_id: md_master_draft
    artifact_spec_ref: artifact_md_master
    type: markdown
    path: artifacts/art_run001_md_master_v1.md
    hash: sha256:example
    status: created
    review_status: pending_review
received_at: 2026-07-10T10:30:00+08:00
```

Sidecar 在提交前必须重新计算 hash、检查路径、校验 output schema、验证必选产物存在，并将
临时文件原子移动到 run artifact 目录。只有通过校验的 descriptor 才能生成
ArtifactManifest。

## 10. 状态、取消与恢复

### 10.1 正常执行

```text
NodeRun queued
-> runner_operation_dispatched
-> Codex process started
-> AdapterResult received
-> output validation
-> Orchestrator committed
-> NodeRun done / reviewing
```

### 10.2 取消

1. Orchestrator 将 operation 标记为 `cancel_requested`。
2. Sidecar 向进程组发送温和终止信号。
3. 在 grace period 内未退出则强制终止。
4. Adapter 返回 `cancelled`，保留已验证前的临时文件但不登记 ArtifactManifest。
5. 重复取消返回同一终态，不创建新 Attempt。

### 10.3 超时

- 到达 `deadline_at` 后终止进程组。
- 返回 `timed_out` 和 `recoverable: true`。
- 重试必须创建新 `attempt_id` 和新 workspace，不能复用可能污染的临时目录。

### 10.4 Sidecar 崩溃恢复

Sidecar 启动时扫描非终态 operation receipt：

- 进程仍在且身份匹配：恢复监控。
- 进程已消失但 final result 完整：进入 received/validation。
- 只有 dispatched、无可验证结果：标记 `unknown`，交由人工选择 retry/abort。
- 不根据孤立产物文件推断 succeeded。

## 11. 错误映射

| 场景 | AdapterResult | recoverable | 建议动作 |
|---|---|---:|---|
| Codex 未安装 | failed / `runtime_not_found` | 是 | 安装或切换 Adapter |
| 未登录 | failed / `credential_missing` | 是 | 完成 Codex 登录 |
| 非零退出 | failed / `process_exit_nonzero` | 视错误 | 查看摘要、重试 |
| 超时 | timed_out | 是 | 增加时限或拆分节点 |
| 用户取消 | cancelled | 否 | 保留审计，不自动重试 |
| 输出 schema 不合法 | failed / `invalid_adapter_output` | 是 | 修复 prompt/schema |
| 必选产物缺失 | failed / `required_artifact_missing` | 是 | 重试或人工补充 |
| 路径越界 | aborted / `workspace_escape_detected` | 否 | 安全审计 |
| Sidecar 崩溃后无法对账 | unknown | 是 | 人工 retry/abort |

## 12. 凭证与权限边界

### 12.1 Codex CLI

- 健康检查只确认二进制、版本和登录状态，不读取认证文件内容。
- 本地人工 MVP 可以复用当前用户的 Codex 登录。
- CI 或未来 Worker 应使用短生命周期、单进程注入的凭证；不把 Key 作为 job 级全局环境
  暴露给仓库构建脚本。
- Adapter 日志只记录逻辑凭证状态：`configured / missing / expired / unknown`。

### 12.2 官方 API

- 使用 Provider 专属引用，例如 `OPENAI_API_KEY_REF`，不使用模糊的
  `PROVIDER_API_KEY` 共享不同厂商。
- Key 存放在环境、keychain 或未来 secret manager，WorkflowSpec 只记录引用。
- Webhook secret 与 API Key 分开治理。
- Provider receipt 保存 response id、model、usage、latency 和服务层，不保存请求密钥。

## 13. Official API Adapter 第二阶段边界

官方 API Adapter 推荐使用 Responses API，能力定位为：

- 结构化文本生成和分析。
- 图像等 Provider 原生能力。
- built-in tool、function tool 或远程 MCP 节点。
- 明确的模型、成本、usage 和 fallback 路由。

本地 P5/P6 优先使用同步或 background polling：

```text
POST /v1/responses
-> 保存 response_id
-> queued / in_progress 轮询
-> completed / failed / cancelled
-> AdapterResult
```

暂不使用 webhook 作为本地 MVP 必需链路，因为 webhook 需要公网 URL、签名验证、去重和
后台消费。未来 Cloud Control Plane 可使用 webhook，并以 webhook id 做幂等去重。

官方 API Adapter 仍不能直接写 Miracle 运行事实；API Response 必须先转换成
AdapterResult，再由 Orchestrator 单写入。

## 14. Provider 与 Adapter 分工

| 层级 | 负责什么 | 不负责什么 |
|---|---|---|
| WorkflowSpec | 节点能力、输入输出、Gate、失败策略 | 不绑定 CLI 命令和 API Key |
| ProviderPolicy | 模型/provider 候选、成本质量和 fallback | 不启动本地进程 |
| AdapterManifest | 能力、执行器、凭证引用、运行支持 | 不保存 Run 状态 |
| Adapter executor | 调用 CLI/API，返回 AdapterResult | 不写 Trace/Artifact/Gate |
| Orchestrator | 状态机、事件、产物提交、审核和恢复 | 不泄漏 provider 私有细节 |

因此同一个 NodeSpec 可以在未来由 Codex、官方 API、Hermes 或 OpenClaw 执行，而无需修改
核心工作流语义。

## 15. 实现任务拆分建议

P5-08 只完成边界评估，不实现真实调用。后续实现建议拆为：

| ID | 任务 | 依赖 |
|---|---|---|
| ADP-01 | 补齐 Invocation/Result 的 attempt、runtime control 和 receipt schema | 无 |
| ADP-02 | 新增 codex-cli real manifest 和健康检查 | ADP-01 |
| ADP-03 | 建立 attempt workspace、输入 staging 和输出校验 | ADP-01 |
| ADP-04 | 实现 Codex 子进程、JSONL parser、timeout/cancel | ADP-02/03 |
| ADP-05 | 接入 `C_md_master` 单节点真实执行 | ADP-04 |
| ADP-06 | 完成崩溃对账、重试和安全测试 | ADP-05 |
| ADP-07 | 设计并实现 Responses API Adapter | ADP-01，可后续并行 |

## 16. 验收场景

### 16.1 Codex 健康检查

- 能检测 CLI 路径和版本。
- 未登录时 Adapter 为 blocked，不暴露认证文件。
- mock-compatible manifest 仍可回退，不被真实 manifest 覆盖。

### 16.2 单节点成功

- 从只读输入创建隔离 attempt workspace。
- JSONL 能映射 dispatched/received/committed。
- MD 产物经 hash、路径和 schema 校验后进入 ArtifactManifest。
- 内容 Gate 创建为 pending_review。

### 16.3 失败和取消

- 超时返回 timed_out，不提交临时产物。
- 用户取消返回 cancelled，重复取消幂等。
- 路径越界返回 aborted 并产生安全 Attention。
- Sidecar 崩溃后不把孤立文件推断为成功。

### 16.4 多 Adapter 扩展

- 同一 `content.longform_draft` NodeSpec 可路由到 Codex 或官方 API。
- 切换 Adapter 不改变 WorkflowSnapshot 中的节点语义。
- provider receipt 能区分 adapter、provider、model 和 operation。

## 17. P5-08 验收结论

| 验收项 | 结果 |
|---|---|
| Codex 与官方 API 首接价值完成比较 | 通过 |
| 首个真实 Adapter 推荐结论明确 | 通过：Codex CLI |
| 子进程、workspace、输出和安全边界明确 | 通过 |
| 凭证、取消、超时、崩溃对账明确 | 通过 |
| AdapterResult 与 Orchestrator 单写入保持一致 | 通过 |
| Official API 第二阶段边界明确 | 通过 |
| 未把 Flow A-G 硬编码进通用 Adapter 契约 | 通过 |

下一步进入 `P5-09 P5 回归验收`，收口 P5 文档、task-baseline、API/页面现状、版本记录
和后续真实 Adapter 实现 backlog。

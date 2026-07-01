# 26_P4第三轮_集成测试与Runner协议交付说明

> 文档状态：P4 第三轮 MVP 交付说明。
> 交付范围：Sidecar API 集成测试、最小 Runner/Adapter 协议、Mock Runner 执行闭环。
> 非交付范围：真实 Codex/Hermes/OpenClaw Adapter、云端调度、多租户、账号、计费。

## 1. 本轮目标

P4 第三轮把系统从“可运行和可演示”推进到“关键 API 可回归测试、节点执行协议可闭环”：

| 能力 | 状态 | 说明 |
|---|---|---|
| Sidecar API 集成测试 | 已实现 | 使用临时 workspace 启动真实 Sidecar，覆盖 DAG、Artifact、Gate、Canvas 和 Run 执行。 |
| Runner/Adapter 最小协议 | 已实现 | `AdapterInvocation`、`AdapterResult`、`AdapterArtifactDescriptor`、`NodeAttempt` 转换已进入 `packages/core`。 |
| Mock Runner 执行闭环 | 已实现 | Sidecar 新增节点执行接口，执行结果由 Orchestrator 写入 NodeRun、Attempt、Artifact、Gate 和 Event Journal。 |
| Orchestrator 单写入边界 | 保持 | Runner 只返回结果；运行事实仍只由 Sidecar 写入。 |
| selector-aware 下游推进 | 已实现 | 下游节点只有在 edge selector 匹配到 `created` 且审核状态满足要求的 ArtifactManifest 后才会推进。 |
| NodeRun 执行锁 | 已实现 | 同一 NodeRun 执行前创建本地 lock，防止并发 POST 重复提交 attempt、artifact 和 event。 |

本轮没有接入真实外部平台。`mock-local` 只用于验证协议、状态写入、事件审计和回归测试。

## 2. 新增接口

```text
POST /api/v0/runs/:runId/nodes/:nodeRunId/execute
```

行为：

1. 只允许执行 `queued` 或 `running` 的 `NodeRun`。
2. Sidecar 创建 `AdapterInvocation` 并派发给 `mock-local`。
3. Mock Runner 返回 `AdapterResult`，状态枚举固定为：

```text
succeeded | failed | timed_out | cancelled | aborted | unknown
```

4. Sidecar Orchestrator 将结果提交为：

- `NodeAttempt`
- `ArtifactManifest`
- `GateInstance`，仅当产物需要人工审核
- `TraceEvent`
- 更新后的 `NodeRun`

5. 如果节点成功且没有审核门，状态提交为 `done`；如果产物触发人工审核，状态提交为 `reviewing`。
6. 下游基础推进规则：已完成节点的下游只有在触发 edge 与全部 required edge 的
   `artifact_selector` 均匹配合格产物后，才会从 `waiting` 变为 `queued`。
7. 同一 `NodeRun` 执行期间会创建本地 lock；重复触发返回 `409 operation_in_progress`。

## 3. 新增核心类型

新增在 `packages/core/src/types.ts`：

```text
AdapterStatus
AdapterInvocation
AdapterArtifactDescriptor
AdapterResult
```

新增在 `packages/core/src/runner.ts`：

```text
createAdapterInvocation
executeMockAdapter
createNodeAttemptFromAdapterResult
createArtifactManifestsFromAdapterResult
createRunnerTraceEvents
```

设计边界：

- `AdapterResult` 必须带 `operation_id`、`node_run_id`、`provider_receipt` 和
  `artifact_descriptors`，支撑 dispatched / received / committed 对账。
- `NodeAttempt` 从 `AdapterResult` 转换生成。
- Artifact 文件内容由 Mock Runner 生成，但实际写入 workspace 由 Sidecar 完成。
- Event Journal 只由 Sidecar 追加写入。

## 4. 集成测试覆盖

新增测试文件：

```text
apps/sidecar/test/api.test.ts
```

测试方式：

- 复制 `fixtures/mvp-workspace/.miracle` 到系统临时目录。
- 使用独立端口启动真实 Sidecar。
- 测试结束后删除临时 workspace。
- 不修改仓库内 fixture。

覆盖场景：

| 场景 | 验证点 |
|---|---|
| DAG 投影 | `/runs/run-demo-001/dag` 返回 required / optional 边和 blocked 节点。 |
| Artifact 预览 | `/artifacts/:id` 返回 markdown 预览。 |
| Gate 决策 | 第一次审核写入成功，重复决策返回 `409`。 |
| Canvas 草稿 | draft 可保存并再次读取。 |
| Mock Runner | `POST /runs` 后执行首个 queued node，生成 attempt、artifact 和事件。 |
| selector 校验 | TTS 生成 `pending` audio 时，视频下游保持 `waiting`，不会错误进入 `queued`。 |
| 重复执行保护 | 同一 NodeRun 完成后重复执行返回 `409`。 |

## 5. 当前边界

- Runner 仍是 `mock-local`，不调用真实模型、CLI 或 MCP。
- 节点执行只支持单节点手动触发，不做后台调度循环。
- 下游推进只实现最小 required 边规则，不处理复杂分支、取消、重试和并发资源池。
- Gate 通过后的真实下游推进已在 P4 第四轮实现，本轮文档只保留第三轮交付边界。
- Canvas 草稿发布 Workflow draft 已在 P4 第四轮实现，本轮文档只保留第三轮交付边界。

## 6. 后续建议

下一轮建议已在 P4 第四轮处理：

1. 将 Canvas 草稿发布为 `Workflow draft`，保存前执行 validate。
2. 实现 Gate 决策后的实际 Orchestrator 推进。
3. 增加 `GET /runs/:id/nodes/:nodeRunId/attempts` 或在 Node Detail 中完善 attempts UI。
4. 定义真实 Adapter 插件目录和第一个 Codex/Hermes/OpenClaw mock-compatible adapter。
5. 补充 Run 工作区的“执行当前节点”按钮，但仍保持人工触发。

# 27_P4第四轮_Gate推进Canvas发布与执行UI交付说明

> 文档状态：P4 第四轮 MVP 交付说明。
> 交付范围：Gate 决策真实推进、Run 页面执行 UI、Canvas 草稿发布 Workflow draft、Adapter 插件壳。
> 非交付范围：真实 Codex/Hermes/OpenClaw 调用、后台调度循环、复杂重试/回滚、完整 Visual/Spec 冲突合并。

## 1. 本轮目标

P4 第四轮把第三轮的“可执行协议”继续推进为“可操作闭环”：

| 能力 | 状态 | 说明 |
|---|---|---|
| Gate 决策真实推进 | 已实现 | `approve/reject/request_changes` 会更新 Gate、Artifact review_status、NodeRun 和 Attention。 |
| selector-aware 下游恢复 | 已实现 | Gate approve 后，生产目标产物的 NodeRun 变为 `done`，再按 Edge selector 推进下游。 |
| Run 页面执行操作 | 已实现 | Run 工作区节点详情展示 NodeAttempt，并可人工触发当前节点执行。 |
| Canvas 发布 Workflow draft | 已实现 | 保存 Canvas 草稿后可发布为新的 draft WorkflowSpec，写入前执行 validate。 |
| Adapter 插件壳 | 已实现 | `packages/core` 暴露 mock-local、Codex、Hermes、OpenClaw、Official API adapter shell。 |

## 2. Gate 决策提交规则

`POST /api/v0/gates/:id/decision` 现在不再只是 projection：

1. GateInstance 从 `pending_review` 变为 `decided`。
2. 目标 ArtifactManifest 的 `review_status` 变为：
   - `approve` -> `approved`
   - `reject/request_changes` -> `rejected`
3. `approve` 时，目标产物的生产 NodeRun 从 `reviewing` 变为 `done`。
4. Orchestrator 重新执行 downstream selector 判断，只有满足 `artifact_type`、`review_status` 和 `status=created` 的产物才会推进下游。
5. `reject/request_changes` 时，Gate `required_before` 声明的未完成下游 NodeRun 会进入 `blocked`。
6. 相关 Attention Item 会从 open 转为 resolved 或 acknowledged。

边界：

- Gate 决策只更新审核状态和运行状态，不覆盖 Artifact 文件内容。
- 返工仍应通过新 Attempt / 新 Artifact version 表达，本轮不实现完整返工编辑器。

## 3. Run 页面执行 UI

Run 工作区右侧节点上下文新增：

- 当前 NodeRun 摘要。
- `执行当前节点` 按钮。
- NodeAttempt 列表。
- 执行结果 receipt。

按钮只允许操作 `queued/running` 节点；其他状态由 sidecar 返回 `409`，UI 展示错误消息。

## 4. Canvas 发布 Workflow draft

新增接口：

```text
POST /api/v0/workflows/:id/canvas-draft/publish
```

行为：

1. 读取当前 `drafts/canvas-<workflowId>.json`，没有草稿时使用 WorkflowSpec 生成默认 CanvasLayout。
2. 根据 zone/card 的 `ref_id` 和 `zone_id` 生成新的 `layouts.canvas.zones`。
3. 创建新 WorkflowSpec：
   - `id = <sourceWorkflowId>-canvas-draft-<timestamp>`
   - `registry_meta.status = draft`
4. 写入前执行 `validateWorkflowSpec`。
5. 校验通过后写入 `workflows/<draftId>.json`。

边界：

- 本轮只发布 layout 层面的 draft，不从 Canvas 新增/删除 NodeSpec。
- stable WorkflowSpec 不被原地覆盖。

## 5. Adapter 插件壳

新增：

```text
packages/core/src/adapters.ts
GET /api/v0/adapters
```

内置 adapter shell：

| ID | kind | 作用 |
|---|---|---|
| `mock-local-adapter` | `mock-local` | MVP 协议验证和本地测试。 |
| `codex-adapter-shell` | `codex` | 后续对接 Codex CLI/任务执行。 |
| `hermes-adapter-shell` | `hermes` | 后续对接 Hermes Agent。 |
| `openclaw-adapter-shell` | `openclaw` | 后续对接 OpenClaw。 |
| `official-api-adapter-shell` | `official-api` | 后续对接官方模型/API provider。 |

当前 shell 只定义 metadata、capability 和 credential requirement，不执行真实外部调用。

## 6. 集成测试新增覆盖

`apps/sidecar/test/api.test.ts` 新增覆盖：

| 场景 | 验证点 |
|---|---|
| Gate approve 推进 | B 节点审核通过后变为 done，C/G 下游进入 queued，目标 markdown 产物变为 approved。 |
| Canvas draft 发布 | Canvas 草稿发布为新的 draft WorkflowSpec，并可通过 workflow detail 读取。 |
| Adapter shell 列表 | `/api/v0/adapters` 返回 mock-local、Codex、Hermes、OpenClaw、Official API 壳。 |

## 7. 当前边界

- 仍没有真实外部 Adapter。
- 仍没有后台 scheduler；节点执行由用户在 UI 或 API 中手动触发。
- Canvas 发布只覆盖 layout zones，不支持从画布创建新 NodeSpec。
- Gate reject 后只阻塞下游，完整返工 Attempt 和新版本创建流程进入后续轮次。

## 8. 后续建议

下一轮建议进入 P4 第五轮：

1. Gate reject -> rework attempt -> new Artifact version 的完整返工链路。
2. 最小 scheduler：自动执行 queued 节点，但高风险 Gate 仍停在人审。
3. Adapter 插件目录实体化，先接一个 Codex mock-compatible adapter。
4. Canvas 新增节点生成 NodeSpec draft，并进入 validate-before-save。
5. Web 增加 run refresh/polling 和更明确的执行反馈。

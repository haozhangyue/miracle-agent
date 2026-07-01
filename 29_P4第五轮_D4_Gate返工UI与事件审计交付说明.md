# 29_P4第五轮_D4_Gate返工UI与事件审计交付说明

## 1. 本轮目标

本轮承接 D3 Gate reject 返工模型，把后端 `POST /api/v0/gates/:gateId/rework`
接入 Web 工作台，形成可操作的人工返工闭环：

```text
Attention 发现待审核/驳回问题
-> 进入 Gate Review
-> 写入 GateDecision
-> 对 reject / request_changes 的 Gate 创建返工版本
-> 生成新 ArtifactManifest、新 GateInstance、新 NodeAttempt
-> Run 事件流展示返工审计事件
```

## 2. 新增能力

### 2.1 Attention 到审核抽屉联动

- Attention 详情页读取 `related_objects` 中的 `GateInstance`。
- 用户点击 gate 类安全动作时，会自动选中对应 Gate 并进入审核页。
- 非 gate 类动作在当前 MVP 中保持禁用，避免误导为已实现的恢复动作。

### 2.2 Gate Review 返工 UI

审核页新增：

- Run 内 Gate 列表，可切换查看不同 GateInstance。
- Gate 当前状态、目标 Artifact、最新决策、阻塞下游数量和目标版本。
- `approve / reject / request_changes` 三类 GateDecision 操作。
- 当 Gate 已被 `reject` 或 `request_changes` 决定后，显示“创建返工版本”动作。
- 返工创建后展示 receipt：`rework_attempt_id`、新 Artifact、New Gate 和写入事件。

### 2.3 事件审计增强

Run 工作区的事件与审计区域新增事件语义映射和高亮：

| 事件类型 | 页面标签 | 说明 |
|---|---|---|
| `rework_attempt_created` | 返工 attempt | 返工动作创建了新的 NodeAttempt。 |
| `artifact_manifest_created` | 产物版本创建 | 新 ArtifactManifest version 已写入。 |
| `gate_pending_review` | Gate 待审核 | 新 GateInstance 等待人工审核。 |
| `gate_decision_created` | Gate 决策 | 审核决策已由 Orchestrator 写入。 |
| `runner_operation_dispatched` | Runner 派发 | 后续真实 Runner 派发审计入口。 |
| `adapter_result_received` | Adapter 回执 | AdapterResult 已回到 Sidecar。 |
| `node_run_committed` | NodeRun 提交 | Orchestrator 已提交运行事实。 |

事件行同时展示 `subject.type` 和 `subject.id`，便于从审计流反查 NodeRun、GateInstance
或 ArtifactManifest。

## 3. 涉及文件

| 文件 | 变更 |
|---|---|
| `apps/web/src/App.tsx` | 新增 Attention -> Gate Review 联动、Gate 列表、返工按钮、返工 receipt、决策历史和事件语义映射。 |
| `apps/web/src/styles.css` | 新增 Gate 列表、返工回执、决策历史、事件审计高亮样式。 |
| `plans/mvp-task-baseline/roadmap.json` | D4 标记完成，D5 切为当前主线。 |
| `README.md` | 增加 D4 交付入口和当前阶段描述。 |
| `07_后续对接路线图与任务拆解.md` | 同步 P4 第五轮状态。 |
| `17_文档资产关联与AI阅读导航.md` | 增加 29 文档依赖和最小读取路径。 |
| `VERSION_HISTORY.md` | 记录 D4 未发布变更。 |

## 4. 当前边界

- D4 只实现人工可操作的返工入口和审计可见性。
- 不实现自动 scheduler；queued 节点的自动扫描和执行进入 D5/D6。
- 不实现真实多平台 Adapter；返工 attempt 仍由 D3 的本地 mock-local 返工模型生成。
- 不覆盖旧 Artifact，也不删除旧 GateDecision；新产物、新 Gate 和新事件都追加写入。
- 审核页当前使用当前 Run 上下文，不做跨 Run 批量审核。

## 5. 验收要点

1. Attention 中 gate 类安全动作能进入审核页并选中相关 Gate。
2. pending_review Gate 能执行 approve、reject 和 request_changes。
3. reject / request_changes 后，审核页能创建返工版本。
4. 创建返工后能看到新 attempt、新 Artifact version、新 Gate 和 created events。
5. Run 事件与审计中能识别返工 attempt、产物创建、Gate 待审核和 Gate 决策事件。
6. `npm run typecheck`、`npm run test`、`npm run build` 通过。

## 6. 下一步建议

D4 完成后，P4 第五轮主线建议切到 D5 最小 scheduler 设计：

```text
扫描 queued NodeRun
-> 遇到 pending_review Gate 停在人审
-> 复用 operation lock 防止重复执行
-> 失败进入 Attention
```

D7 Adapter 目录、D8 Canvas NodeSpec draft、D9 Web run refresh 可以与 D5 设计并行准备。

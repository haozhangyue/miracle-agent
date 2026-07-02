# 34_P4第五轮_D8_D9_Canvas节点草稿与Run刷新交付说明

> 文档状态：P4 第五轮 D8/D9 工程交付说明。
>
> 适用范围：Canvas 新增节点生成 `NodeSpec draft`，以及 Run 工作区轻量刷新和执行反馈。
>
> 重要边界：D8/D9 不改变稳定 `WorkflowSpec` 的原地内容；Canvas 发布只生成新的 draft Workflow。Run 页面刷新只读取投影和事件，不写运行事实。

## 1. 本轮目标

D8 的目标是让 Infinite Canvas 不再只是 layout 草稿，而是可以从画布对象生成结构化 `NodeSpec draft`：

```text
+ 新增 node card
-> 生成 node_spec_draft
-> validate-before-save
-> spec diff preview
-> 发布为新的 draft WorkflowSpec
```

D9 的目标是让 Run 工作区在 scheduler、Gate、Adapter 执行过程中能更及时地反映状态变化：

```text
Run detail / DAG / Node detail / Events / Attention
-> 轻量 polling
-> 状态计数
-> failed / blocked / queued / running 恢复提示
```

## 2. D8 Canvas NodeSpec Draft

### 2.1 新增核心对象

`packages/core/src/types.ts` 新增：

```ts
CanvasNodeSpecDraft
```

字段：

| 字段 | 含义 |
|---|---|
| `draft_id` | 画布节点草稿 ID。 |
| `status` | `draft / ready / invalid`。 |
| `created_from` | 当前固定为 `canvas`。 |
| `node_spec` | 完整 `NodeSpec` 草稿。 |
| `validation` | 保存或读取时的候选 Workflow 校验结果。 |

`CanvasLayout.objects[]` 增加可选 `node_spec_draft`，因此同一个画布对象可以既是视觉节点卡，也能承载待发布的执行节点草稿。

### 2.2 Sidecar API

新增：

```text
POST /api/v0/workflows/:workflowId/canvas-draft/nodes
```

请求示例：

```json
{
  "title": "Pencil 原型设计",
  "capability": "prototype.pencil",
  "zone_id": "content"
}
```

返回内容：

- `node_object`：新增的 canvas node card。
- `node_object.node_spec_draft.node_spec`：生成的 `NodeSpec`。
- `validation`：候选 WorkflowSpec 的校验结果。
- `spec_diff_preview`：包含 `add /nodes/-` 和 layout 更新操作。

### 2.3 保存前校验

`POST /api/v0/workflows/:workflowId/canvas-draft` 不再只保存任意 layout 对象，而是会：

1. 把当前稳定 Workflow 和 Canvas draft 合成为候选 Workflow。
2. 将所有 `node_spec_draft` 临时并入候选 Workflow 的 `nodes`。
3. 执行 `validateWorkflowSpec`。
4. 校验失败时返回 `422`，不写入草稿文件。
5. 校验通过后写入 draft，并把草稿节点状态标为 `ready`。

### 2.4 发布策略

`POST /api/v0/workflows/:workflowId/canvas-draft/publish` 会生成新的 draft Workflow：

```text
workflows/{workflowId}-canvas-draft-{timestamp}-{suffix}.json
```

发布不会覆盖原始 stable Workflow。新增节点只进入新的 draft Workflow，符合 P3 约定的稳定模板保护规则。

## 3. D9 Run Refresh / Polling

### 3.1 刷新范围

Run 工作区新增轻量 polling，只在 Run 页面挂载时生效，切换 Run 或离开页面时清理 interval。

刷新对象包括：

- Run detail。
- DAG projection。
- Event Drawer。
- Attention。
- 当前 selected node detail。

### 3.2 执行反馈

Run Header 增加：

- 自动刷新状态。
- 最近刷新时间。
- 暂停 / 开启自动刷新。
- 立即刷新。

Run 页面增加状态计数条：

- `running`
- `queued`
- `blocked`
- `failed`
- `done / succeeded`

Node Detail 增加执行反馈卡：

| 状态 | 反馈 |
|---|---|
| `running` | 等待 AdapterResult。 |
| `queued` | 建议运行 Scheduler 或执行当前节点。 |
| `blocked / failed` | 提供查看 Attention、检查 Attempt、切换 Provider、补凭证、返工等恢复提示。 |
| `done / succeeded` | 建议查看下游节点或产物。 |

### 3.3 写入边界

D9 只刷新 Web 投影，不写入运行事实。运行事实仍由 Sidecar Orchestrator 通过 Runner、Scheduler、Gate、Rework API 单写入。

## 4. 变更文件

代码：

- `packages/core/src/types.ts`
- `packages/core/src/schemas.ts`
- `apps/sidecar/src/server.ts`
- `apps/sidecar/test/api.test.ts`
- `apps/web/src/App.tsx`
- `apps/web/src/styles.css`

文档与任务基线：

- `33_P4_MVP回归验收预备清单.md`
- `34_P4第五轮_D8_D9_Canvas节点草稿与Run刷新交付说明.md`
- `README.md`
- `07_后续对接路线图与任务拆解.md`
- `17_文档资产关联与AI阅读导航.md`
- `VERSION_HISTORY.md`
- `plans/mvp-task-baseline/README.md`
- `plans/mvp-task-baseline/roadmap.json`

## 5. 验收场景

### 5.1 Canvas

1. 打开 Web 工作台的“画布草稿”。
2. 输入节点标题、能力需求和画布区域。
3. 点击“生成节点草稿”。
4. 画布出现新 node card。
5. 卡片显示 `NodeSpec · ready`。
6. Spec Diff Preview 显示 `add /nodes/-`。
7. 点击“发布 Workflow draft”后生成新的 draft Workflow。

### 5.2 Run

1. 打开 Run 工作区。
2. 执行节点或运行 scheduler。
3. 页面自动刷新 Run detail、DAG、事件和 Attention。
4. `blocked / failed` 节点展示恢复提示。
5. 离开 Run 页面后不继续启动多重轮询。

## 6. 当前边界

- D8 只生成最小可用 `NodeSpec draft`，不做完整无限画布拖拽编辑器。
- 新增节点默认不自动生成 Edge、ArtifactSpec 和 GateSpec；后续 D10 或 P5 再扩展“节点插入上下游关系”和“子工作流草稿”。
- D9 使用 polling，不引入 WebSocket 或后台推送。
- D9 不改变 Sidecar 的运行写入边界。

## 7. 下一步

D8/D9 完成后，主线进入 D10：

```text
D10 MVP 回归验收与版本收口
```

D10 重点使用 `33_P4_MVP回归验收预备清单.md` 执行：

- `npm run typecheck`
- `npm run test`
- `npm run build`
- API smoke check
- 页面 smoke check
- 截图证据
- task-baseline 同步确认

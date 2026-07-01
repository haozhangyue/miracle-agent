# 30_P4第五轮_D5_最小Scheduler设计与Tick接口交付说明

## 1. 本轮目标

D5 的目标是补齐最小 scheduler 设计，并给 D6 自动执行闭环提供可复用的执行切口。
本轮不做常驻后台循环，不做定时器，也不绕过人工审核门。

```text
扫描 Run 中的 NodeRun
-> 找出 queued 节点
-> 检查 pending_review Gate 的 required_before
-> 可执行节点调用 Orchestrator 单节点提交逻辑
-> Gate 相关节点只 pause，不自动越过人审
-> 写入 scheduler tick 审计事件
```

## 2. 新增能力

### 2.1 统一执行 helper

Sidecar 抽出 `executeNodeRunOnce(runId, nodeRunId)`，手动执行和 scheduler tick 共用同一套
Orchestrator 写入逻辑：

- NodeRun operation lock。
- AdapterInvocation 创建。
- Mock Adapter 执行。
- NodeAttempt 写入。
- ArtifactManifest 写入。
- GateInstance 创建。
- TraceEvent 追加。
- Edge selector 下游推进。

这样避免手动执行和 scheduler 执行变成两套事实写入路径。

### 2.2 Scheduler tick API

新增接口：

```text
POST /api/v0/runs/:runId/scheduler/tick
```

请求参数：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `dry_run` | boolean | `false` | 为 `true` 时只返回调度计划，不写事件、不执行节点。 |
| `max_nodes` | number | `1` | 单次 tick 最多执行节点数，当前限制为 1-5。 |

返回内容：

| 字段 | 说明 |
|---|---|
| `mode` | `dry_run` 或 `commit`。 |
| `decisions` | dry-run 时返回完整扫描决策。 |
| `executed` | commit 时返回已执行节点和执行结果。 |
| `paused` | 因 pending_review Gate 暂停的节点。 |
| `skipped` | 非 queued 状态，scheduler 不执行的节点。 |
| `created_events` | commit tick 写入的 scheduler 事件。 |
| `next_suggested_actions` | 下一步建议，例如审核 Gate、刷新 Run、等待 queued 节点。 |

### 2.3 Gate 人审暂停规则

如果存在 `pending_review` 的 GateInstance，且当前 NodeRun 的 `node_id` 在该 Gate 的
`required_before` 中：

- scheduler 决策为 `pause_for_gate`。
- 不执行该 NodeRun。
- 不把 blocked/waiting 节点强行变成 queued。
- 用户必须先通过 Gate Review 处理对应 Gate。

### 2.4 Run 工作区入口

Run 工作区新增“调度一次”按钮：

- 调用 `POST /api/v0/runs/:runId/scheduler/tick`。
- 默认 `max_nodes=1`。
- 展示本次 tick 的 executed / paused 摘要。
- Run 事件审计新增 `scheduler_tick_started` 和 `scheduler_tick_completed` 中文标签。

## 3. 涉及文件

| 文件 | 变更 |
|---|---|
| `apps/sidecar/src/server.ts` | 新增 `executeNodeRunOnce`、scheduler decisions、`POST /runs/:runId/scheduler/tick`。 |
| `apps/sidecar/test/api.test.ts` | 新增 dry-run、commit tick、pending Gate pause 三个集成测试。 |
| `apps/web/src/App.tsx` | Run 页面新增“调度一次”入口和 scheduler 审计事件标签。 |
| `apps/web/src/styles.css` | 调整 Run header 按钮布局。 |
| `plans/mvp-task-baseline/roadmap.json` | D5 标记完成，D6 切为当前主线。 |

## 4. 当前边界

- D5 只做手动触发的单次 tick，不做后台常驻 scheduler。
- D5 不实现失败自动 Attention 聚合；D6 执行闭环补齐。
- D5 不实现跨 Run 扫描；当前 tick 只作用于指定 Run。
- D5 不实现多 Agent 容量和并发池；当前只复用 NodeRun operation lock。
- D5 不绕过人工 Gate，不自动处理 pending_review。

## 5. 验收要点

1. `dry_run=true` 返回 scheduler decisions，且不写入 scheduler 事件。
2. commit tick 能执行 1 个 queued NodeRun，并写入 started/completed 事件。
3. pending_review Gate 的 required_before 节点进入 `pause_for_gate`，不会被执行。
4. 手动节点执行和 scheduler tick 使用同一套 Orchestrator 写入路径。
5. Run 页面可以触发“调度一次”，并看到 executed / paused 摘要。
6. `npm run typecheck`、`npm run test`、`npm run build` 通过。

## 6. 下一步建议

D6 建议在 D5 tick 的基础上实现最小执行闭环：

```text
用户点击“自动推进”
-> scheduler 连续 tick
-> 每轮重新读取 Run 状态
-> 遇到 Gate pending_review 停止
-> 执行失败写 Attention
-> Run 页面轮询刷新或主动刷新
```

D7 Adapter 插件目录实体化、D8 Canvas NodeSpec draft、D9 Web run refresh 可以继续并行准备。

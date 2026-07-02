# 31_P4第五轮_D6_Scheduler连续执行闭环交付说明

## 1. 目标

D6 在 D5 单次 tick 的基础上补齐最小 scheduler 执行闭环：

```text
用户点击“自动推进”
-> Sidecar 连续规划和执行 tick
-> 每轮重新读取 Run 状态
-> 有 queued NodeRun 就执行
-> 遇到 pending_review Gate 且没有可执行节点时停止
-> 执行失败时写入 Attention 并停止
```

D6 仍不是后台常驻调度器，也不引入队列或多 Worker。它是 Local Sidecar 内可显式触发的
连续推进 API，为后续 D7 Adapter 目录和真实 Runner 接入保留边界。

## 2. 新增接口

### 2.1 连续推进

```http
POST /api/v0/runs/:runId/scheduler/run
```

请求体：

```json
{
  "max_ticks": 8,
  "max_nodes_per_tick": 1
}
```

返回核心字段：

| 字段 | 含义 |
|---|---|
| `scheduler_run_id` | 本次连续推进操作 ID。 |
| `stop_reason` | `paused_for_gate / execution_failed / no_executable_nodes / max_ticks_reached`。 |
| `ticks` | 每次 tick 的执行记录或 dry stop 记录。 |
| `summary.nodes_executed` | 本次连续推进实际提交的 NodeRun 数量。 |
| `summary.failures` | 执行失败数量。 |
| `summary.attention_items_created` | 因失败创建或刷新 Attention 的数量。 |
| `next_suggested_actions` | 下一步建议，例如审核 Gate、处理 Attention 或继续刷新 Run。 |

### 2.2 单次 tick 复用

`POST /api/v0/runs/:runId/scheduler/tick` 保持兼容，但 commit 分支改为复用
`commitSchedulerTick()`。这样单次调度和连续推进不会变成两套事实写入路径。

## 3. Stop Reason

| stop_reason | 触发条件 | 用户下一步 |
|---|---|---|
| `paused_for_gate` | 当前没有可执行节点，且存在 pending_review Gate 阻塞下游。 | 进入 Gate Review。 |
| `execution_failed` | 某个 NodeRun 执行失败或执行过程异常。 | 查看 Attention，重试或切换 Provider。 |
| `no_executable_nodes` | 没有 queued 节点，也没有 Gate 暂停。 | 刷新 Run 或检查是否已完成。 |
| `max_ticks_reached` | 达到本次请求的 `max_ticks` 上限。 | 再次触发或提高上限。 |

## 4. 失败 Attention

D6 新增通用失败根因聚合：

```text
root_cause_key = node:{node_run_id}:execution_failed
```

失败 Attention 的关联对象：

- `NodeRun`
- `SchedulerDecision`

安全动作：

- `inspect_node_attempt`
- `retry_node`
- `switch_provider`

当前实现会在 `mock-failure` provider 返回 failed AdapterResult 时打开 Attention。该 provider
仅用于 MVP 本地失败链路验证，D7 会把真实 Adapter manifest、credential check 和 provider
fallback 进一步实体化。

## 5. Web 工作台变化

Run 工作区新增：

- `调度一次`：调用 D5 tick。
- `自动推进`：调用 D6 run。
- Scheduler 连续推进完成后显示 `stop_reason`、执行节点数和 Attention 创建数。
- 事件审计新增中文标签：
  - `scheduler_run_started`
  - `scheduler_run_completed`
  - `attention_item_created`

## 6. 代码变更

| 文件 | 变化 |
|---|---|
| `apps/sidecar/src/server.ts` | 新增 `scheduler/run`、`commitSchedulerTick()`、`runSchedulerUntilStop()`、失败 Attention 聚合。 |
| `apps/sidecar/test/api.test.ts` | 增加连续推进到 Gate 暂停、执行失败进入 Attention 两个集成测试。 |
| `apps/web/src/App.tsx` | Run 页面新增“自动推进”按钮和事件审计标签。 |
| `apps/web/src/styles.css` | Run header 适配新增按钮。 |
| `plans/mvp-task-baseline/roadmap.json` | D6 标记完成，D7 切为当前焦点。 |

## 7. 验收结果

已验证：

1. `scheduler/run` 能连续执行 `A_collect -> B_md_master`。
2. `B_md_master` 产出 pending_review Gate 后，连续推进在下游 `C_script / G_distribution`
   前停止，`stop_reason = paused_for_gate`。
3. `mock-failure` provider 会使 NodeRun 进入 `failed`，scheduler 停止为
   `execution_failed`。
4. 执行失败会创建 `AttentionItem`，并写入 `attention_item_created` 事件。
5. Run 页面可手动触发“自动推进”，并刷新 Run/DAG/Event Drawer。
6. `npm run typecheck` 和 `npm run test -w apps/sidecar` 已通过。

## 8. 当前边界

- 不做后台常驻 scheduler。
- 不做跨 Run 扫描。
- 不做 Agent capacity pool。
- 不做真实 provider retry/fallback。
- 不做 credential check 前置路由。
- 不自动越过人工 Gate。

## 9. 下一步建议

D7 建议实现 Adapter 插件目录实体化：

```text
adapter manifest
-> capability / credential 声明
-> mock-local / mock-failure / codex shell 统一注册
-> dry-run 展示 credential check
-> scheduler 使用 adapter registry 决定可执行性和失败恢复建议
```

D8 Canvas NodeSpec draft 和 D9 Web refresh 仍可并行推进。

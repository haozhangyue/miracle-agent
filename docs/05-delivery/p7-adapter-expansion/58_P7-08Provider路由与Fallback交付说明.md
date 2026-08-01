# P7-08 Provider 路由与 Fallback 交付说明

> 文档状态：`CURRENT / P7-08 工程交付说明`
>
> 前置基线：`55_P7多节点真实执行与模型Adapter扩展总体设计.md`、`56_P7工程实施计划与任务拆解.md`、`57_P7-07模型Provider接入交付说明.md`
>
> 任务状态：P7-08 已完成；当前任务推进到 P7-09 多运行时 UI 与可观测性。

## 1. 交付结论

本轮完成确定性 `ProviderRouter`、同类 Model API Profile fallback、跨 Adapter kind 人工确认和
Run 级路由审计。Router 只产生 `ProviderRoutingDecision`，不调用外部 Provider，也不写
Run truth；Sidecar Orchestrator 在 Run mutation lock 内持久化 Decision、Confirmation、
NodeAttempt 和 TraceEvent。

P7-08 不改变 P7-07 的真实连通结论。内置 DeepSeek、Kimi、MiniMax Profile 仍为
`configured_unverified`，不会被 Router 当作 healthy 候选。本轮只通过本地 fake Provider
验证 DeepSeek 429 后切换 Kimi 的执行闭环，没有发送真实外部请求。

## 2. 确定性路由规则

候选按以下固定规则处理：

```text
capability complete
  -> executable
  -> credential available
  -> health = healthy
  -> user priority
  -> cost tier
  -> profile id
```

每个未选候选都写入 `rejected_candidates[].reason_code`。Provider Catalog 可声明定性的
`routing.user_priority` 和 `routing.cost_tier`，价格或单次成本估算仍是可更新投影，不进入
WorkflowSpec 硬编码。

## 3. Fallback 规则

- 自动 fallback 只发生在 `model-api -> model-api`，且只接受明确的 429、临时 5xx、网络错误
  和已确认终止的超时。
- Provider 原始错误会先归一为 `rate_limit / provider_temporary_5xx / network_error /
  adapter_timeout`，RetryPolicy 与 Router 读取同一套持久化错误语义。
- 401/403、内容策略、输入错误、`unknown`、`cancelled`、`aborted` 不自动 fallback。
- fallback 新建递增 NodeAttempt，复用原 `operation_id`，继续受 attempt/time/cost 预算约束。
- Orchestrator 记录 `provider_fallback_started` 和 `provider_fallback_completed`，并在
  `routing_decisions.json` 保存可审计决策。
- `codex -> model-api` 永不自动执行；只有 NodeSpec 显式允许两类 Adapter 且用户确认当前
  operation、当前 kind 和目标 Profile 后才可继续。

## 4. API

### 4.1 查询路由历史

```http
GET /api/v0/runs/:runId/routing-decisions
```

返回 Run 的 `routing_decisions` 和 `fallback_confirmations`。Decision 以不可变 `decision_id +
revision` 追加保存，包含候选、拒绝原因、预计成本、是否需要确认和决策时间，不包含凭证或输入正文。

### 4.2 确认跨 kind fallback

```http
POST /api/v0/runs/:runId/nodes/:nodeRunId/fallback-confirmation
Content-Type: application/json

{
  "decision_id": "route_...",
  "operation_id": "op_...",
  "expected_current_adapter_kind": "codex",
  "target_provider_profile_id": "kimi-default",
  "actor": "operator"
}
```

Sidecar 会重新核对当前 NodeAttempt、当前 Decision revision、活动 RetrySchedule、Adapter kind
和目标 Profile。不存在当前决策、schedule 已消费、kind 不一致、目标变化或 operation 已变化时返回
`409 routing_decision_not_current`，不会让旧确认覆盖新决策。重复提交同一有效确认返回已有记录。

## 5. 验收证据

- Core Router 覆盖能力、可执行性、凭证、健康、优先级、成本、预算和稳定 ID 排序。
- Sidecar fake Provider 覆盖 DeepSeek 429 -> Kimi 成功，两个 Attempt 使用同一 operation ID。
- 跨 kind 场景覆盖 Codex 失败、确认 Kimi 目标、第二次 Attempt 实际由 `model-api` 执行。
- 路由历史包含 Kimi 目标 Profile，事件包含 fallback started/completed。
- 人工确认覆盖无当前决策、错误 kind、错误目标、有效确认和幂等重复确认。
- 已持久化的 fallback dispatch intent 在 Sidecar 恢复后保留精确 `provider_profile_id`。尚未派发
  的 `prepared` intent 若当前路由目标已变化，会在锁内原子更新路由身份；
  `dispatched_unknown` 保留原派发身份并继续阻止自动重派。
- 早期开发阶段缺少 `decision_id/revision` 的 routing history 会按追加顺序确定性迁移，迁移后
  仍可参与当前决策复用与人工确认。
- 同一 Provider 存在多个 Profile 时，优先按失败 Attempt receipt 中的
  `provider_profile_id` 排除精确失败项，不会误排除同 Provider 的其他可用 Profile。旧 Attempt
  若缺失 Profile ID，则拒绝该 Provider 的全部 Profile 自动 fallback，不猜测 catalog 首项。
- 定向回归覆盖 Provider fallback、Model API 错误归一和 P7-05 retry recovery。

## 6. 当前限制与最终验收

- DeepSeek 已在 P7-10 完成一次经授权的真实 completion smoke；Kimi、MiniMax 未验证。
- P7-09 已在 Run、Node Detail、Attention 和 Attempt 历史中展示 runtime、Provider、成本、
  fallback 关系与确认动作。
- P7-10 已完成全量 API、页面、安全、文档和版本收口，发布 `v0.9.0`；最终结论见 60 号报告。

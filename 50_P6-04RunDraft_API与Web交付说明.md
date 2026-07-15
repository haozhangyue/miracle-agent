# P6-04 RunDraft API 与 Web 交付说明

> 文档状态：TRACK DELIVERY
>
> 范围：P6-04 Core、Sidecar API、Web 操作流与审计闭环的最终交付记录。

## 已交付

### Core

- `packages/core/src/run-drafts.ts` 定义启动前 `RunDraft`、`WorkflowSnapshotDraft`、`RunDraftDryRunPlan` 和 `LaunchConfirmation`。
- `canonicalPlanHash` 对 canonical JSON 计算 `sha256:` 哈希；时间戳与临时 plan id 不参与语义 plan hash。
- 草案修改或 Workflow source hash 改变会使已确认的 `LaunchConfirmation` 变为 `superseded`，并要求重新 Dry-run。
- Dry-run 始终从 Workflow 生成全部 Gate 计划；草案更新接口没有关闭或移除 required Gate 的能力。
- 凭证 scope 可声明为 `required_path` 或 `optional_branch`。缺失可选视频凭证会阻塞完整工作流，但不会阻塞必选 Markdown 主链确认。
- 相同计划的确认调用返回既有 confirmation，不重复生成确认事实。
- 只有用户启用的可选分支参与阻塞判断；未选择的视频分支显示 `not_selected`。
- Dry-run 返回分支、Provider、成本、预计时长、Gate、凭证与 startability。

### Sidecar Store

- `RunDraftStore` 提供 `create`、`read`、`update`、`dryRun`、`confirm`、`revise`、`cancel` 和 `requestLaunch`。
- 每份草案只写入 `.miracle/run-drafts/{draft_id}/`：`run_draft.json`、`workflow_snapshot_draft.json`、`run_draft_dry_run_plan.json`、`launch_confirmation.json`、`draft_audit.jsonl`。
- `expected_revision` 是乐观锁条件；revision 不一致返回 `revision_conflict`。
- 每个成功的 create/update/dry-run/confirm 命令只追加一条 `draft_audit.jsonl` 记录，包含 draft、actor、时间、前后 hash、变更字段和 correlation id。
- Store 不创建 `runs/`、`RunSpec`、`NodeRun` 或 TraceEvent。
- 启动前交叉校验 plan、confirmation、snapshot/source hash；Adapter 未就绪返回 `adapter_not_ready` 并保持 `confirmed`。
- 锁记录 owner 并可回收崩溃遗留锁；读取会拒绝缺文件或跨文件引用不一致的损坏状态。

### HTTP 与 Web

- Sidecar 已接通 create/read/PATCH/dry-run/confirmation API，并由唯一 `POST /runs` 接收启动交接。
- Web 已接通“新任务 -> RunDraft -> Dry-run -> 修改/重算 -> 确认/撤回/取消 -> 启动条件检查”。
- 页面明确 RunDraft 不属于正式运行事实；本阶段不创建 RunSpec、NodeRun 或 TraceEvent。

## 后续 P6-07 接线约束

1. 在 `server.ts` 仅做 HTTP 解析、错误映射和 `RunDraftStore` 调用；不得复制 Core 状态机或直接写草案 JSONL。
2. `PATCH`、Dry-run、confirmation 请求必须传递 `expected_revision`；将 `revision_conflict` 映射为 409。
3. `POST /runs` 必须先读取 confirmed draft，重新校验 `latest_plan_hash` 和 workflow source hash，再复用唯一 `startRun` 事务。Adapter 未就绪时返回 409 `adapter_not_ready`，不得把草案改为 `launch_pending`。
4. Web 只展示草案审计，不将其混入正式 Run 事件时间线；required Gate 应显示为执行后仍须处理的 Gate，而不是可被草案确认关闭的开关。
5. Sidecar 测试依赖 `@miracle/core` 的 `dist`，运行 Store 测试前需要先执行 `npm run build -w packages/core`。

## 本轨未包含

- 未创建正式 Run 或接入 Adapter；该工作在 P6-07 的统一启动事务完成。

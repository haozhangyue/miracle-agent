# P6-07 Codex 单节点真实执行交付说明

> 文档状态：ACTIVE
>
> 任务状态：P6-07 completed
>
> 后续任务：P7-01 多节点真实执行与 Adapter 扩展规划；P6 最终结论见 54 号报告

## 1. 交付结论

P6-07 已打通第一条真实执行闭环：已确认的 RunDraft 可原子转换为正式 Run，Scheduler
将 `C_md_master` 调度到本机 Codex CLI，在仓库外隔离 attempt workspace 中生成结构化
最终输出。Sidecar 完成路径、普通文件、大小、UTF-8、类型、内容和 SHA-256 校验后，
由 Orchestrator 单写入 NodeAttempt、ArtifactManifest、GateInstance 和 TraceEvent。

本轮新增 `codex-md-master-v0` 单节点实验模板。它用于验证通用 Adapter/Runner 协议，
不是把 Miracle 核心模型固化为内容生产流程。

## 2. 用户可用链路

```text
新任务
-> Codex 单节点 Markdown 母稿
-> RunDraft
-> Dry-run
-> 人工确认
-> 启动正式 Run
-> Scheduler
-> Codex CLI
-> Markdown ArtifactManifest
-> C_md_master_gate pending_review
```

Run 工作区现在展示：

- 真实 Adapter ID、Provider、operation ID、耗时和 Attempt 状态。
- 活跃 operation 的取消入口。
- 关联 Gate 和目标 Artifact。
- 隔离工作区的非敏感 attempt 元数据，不显示外部 runtime 绝对路径。
- `runner_operation_dispatched -> adapter_result_received -> node_run_committed` 审计链。

## 3. 启动与安全开关

真实 Codex 执行必须显式 opt-in：

```bash
MIRACLE_ENABLE_REAL_CODEX=1 npm run dev
```

启动前要求：

```bash
codex --version
codex login status
```

默认 runtime 位于 `~/.miracle-agent`。也可通过 `MIRACLE_RUNTIME_WORKSPACE_DIR` 指向其他
仓库外真实目录。Sidecar 拒绝仓库内 runtime 和 symlink，且不会将 Codex 登录文件、
凭证值、隐藏推理或完整环境变量写入 TraceEvent。

## 4. 原子启动与幂等

- 只有 `confirmed` 且 plan、plan hash、confirmation、snapshot、workflow source hash 全部
  一致的草案可以启动。
- 正式 Run 先写入 `.launching` 临时目录，完整后再原子 rename。
- Run ID 由 `draft_id + plan_hash` 稳定生成；若 Sidecar 在 Run 发布后、草案提交前崩溃，
  重试会核验并复用同一完整 Run，不会生成重复 Run。
- 草案在同一锁内标记为 `converted` 并记录 `converted_run_id`。
- 同一确认重复启动返回原 Run；引用不一致的重试返回冲突。
- Run 发布后若草案提交失败，正式 Run 回滚，草案恢复为 `confirmed`。
- Adapter 未启用或 health 非 healthy 时，草案保持 `confirmed`，不留下半成品 Run。

## 5. Codex 输出约束

执行命令使用参数数组、stdin prompt 和受控环境：

```text
codex exec --json --ephemeral --sandbox workspace-write
--cd <attempt>/work --skip-git-repo-check
--output-schema <attempt>/meta/output.schema.json
--output-last-message <attempt>/output/final.json -
```

最终 JSON 只允许 `artifact_type=markdown` 和非空 `content`。Sidecar 将内容转换为
`md_master.md` 后再次验证单链接普通文件、边界、UTF-8、大小和 SHA-256。无效 schema、
越界、symlink、hardlink、缺失 required output 或非法编码均不会创建 Artifact/Gate。

## 6. API 变化

```text
POST /api/v0/runs
GET  /api/v0/operations?run_id=:runId
POST /api/v0/operations/:operationId/cancel
```

`POST /runs` 现在支持 confirmed RunDraft 的统一启动事务。普通非草案 Run 创建接口保持
兼容。Run detail 额外返回 attempts 投影，方便 Web 在同一请求中展示执行回执。

## 7. 验证结果

- `npm run typecheck`：通过。
- Sidecar：76 tests passed，其中 P6-07 fake-codex 端到端 2 tests passed。
- Web：7 tests passed。
- fake-codex 覆盖成功输出、无效输出、幂等启动、崩溃窗口恢复、引用冲突和事务回滚。
- 本机真实 Codex CLI `0.144.2`、ChatGPT 登录状态下，脱敏小样本执行成功。
- 真实验收结果：NodeRun `reviewing`、NodeAttempt `succeeded`、1 个 Markdown Artifact、
  1 个 `pending_review` Gate，Artifact hash 为真实 SHA-256。
- Web 截图：[codex-single-node-run.png](../../../assets/reviews/p6-07/codex-single-node-run.png)。

## 8. 当前边界

- P6-07 只开放一个由 Codex CLI 支持的单节点 Workflow；多节点真实连续执行留待后续。
- 真实执行默认关闭，必须显式设置 `MIRACLE_ENABLE_REAL_CODEX=1`。
- W23/W24 历史 Run 保持只读，本轮真实执行使用 Miracle 自有 RunDraft 和脱敏输入。
- Hermes、OpenClaw、官方 API Adapter 尚未进入真实执行。
- P6-08 全量回归已通过并发布 `v0.8.0`；最终结论见 54 号报告。

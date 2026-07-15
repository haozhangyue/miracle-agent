# P6-06 Codex CLI 健康检查与工作区交付说明

> 状态：完成
>
> 日期：2026-07-13

## 交付范围

P6-06 新增 `CodexCliAdapter`，负责本机 Codex CLI 的只读健康检查、隔离 attempt workspace、输入 staging、fake CLI 进程生命周期、取消和孤立 operation 收敛。它不创建正式 `NodeRun`、`NodeAttempt`、`ArtifactManifest`、`GateInstance` 或 `TraceEvent`；这些运行事实仍由 P6-07 在 Orchestrator 单写入。

Sidecar 使用独立的 `MIRACLE_RUNTIME_WORKSPACE_DIR`；默认值为 `~/.miracle-agent`，不得与仓库内 fixture 数据目录混用。

## Health API

- `GET /api/v0/adapters/codex-cli/health` 返回缓存或首次检测结果。
- `POST /api/v0/adapters/codex-cli/health/refresh` 重新依次调用 `codex --version` 和 `codex login status`。
- 登录状态以 `codex login status` 的退出码判断；不持久化或返回该命令的 stdout/stderr。
- 检测通过参数数组启动子进程，不经 shell；健康响应只返回状态、版本、认证布尔值、原因和可执行文件名，不返回认证文件、token、原始 stdout/stderr 或环境变量值。
- `codex-cli-real` 的 manifest 不在此阶段被改写为可执行；health 只是本机能力观测，不改变 P6-05 注册表的路由语义。
- `GET /api/v0/adapters` 为 `codex-cli-real` 增加无秘密的 `health.ready/status/authenticated/reasons` 投影，同时保留 `executable: false`。因此 UI 和后续人工决策可以看到本机 readiness，但 P6-06 不会提前让 scheduler 路由到真实 CLI。

## Attempt Workspace

每个 attempt 固定写入：

```text
.miracle/runtime/attempts/{attempt_id}/
  input/   # allowlist 文件复制后 chmod 0444
  work/    # Codex 进程 cwd
  output/  # 仅允许解析、提交候选输出的目录
  meta/    # output schema、attempt 状态
```

- `attempt_id` 只接受字母、数字、下划线和连字符；重复 ID 直接返回 `attempt_workspace_conflict`，不会复用旧目录。
- runtime root 必须提供 repository root、位于 repository realpath 之外，并且 runtime root 本身不能是 symlink；测试只使用系统 temp 目录作为 runtime root。
- canonical root 只能从 `attempt_id` 派生为 `.miracle/runtime/attempts/{attempt_id}`。启动前同时校验传入 workspace 与 `AdapterInvocation.runtime_control.attempt_workspace` 都严格等于该 canonical root。
- 输入源必须 realpath 后仍落在显式 allowlist 根目录中，且只允许普通文件；staging 目标或 output 目标越界返回 `workspace_escape_detected`。
- output 只接受 `output/` 根内的单链接普通文件。traversal、symlink、目录和 hardlink 都会被拒绝；P6-07 必须把这类安全违规映射为 `aborted`，再决定是否提交产物。
- 终态 attempt 默认保留并在 `meta/attempt.json` 标记为 `retained`，用于排障和审计；不会从孤立文件推断成功，也不会自动删除取消或超时留下的临时文件。

## Operation 控制

- `CodexCliAdapter.startOperation` 仅用于 P6-06 fake CLI 生命周期验证，返回统一的 `AdapterResult`，不提交任何正式运行事实。可执行文件和所有参数通过参数数组及 `shell: false` 启动，prompt 只经 stdin 传入。
- registry 在任何异步 workspace 检查前预留 `operation_id`，同 ID 只允许一个 owner。timeout 或取消先发送 `SIGTERM`，grace period 后发送 `SIGKILL`；重复取消返回 `already_finished`。
- stdout 与 stderr 各自受限，且不保存原始 stderr。成功仅接受 object JSONL；非零退出为 `failed`、非法 JSONL 为 `failed`、stdio 超限等安全违规为 `aborted`、超时为 `timed_out`、取消为 `cancelled`。
- operation receipt 位于 `.miracle/runtime/operations/{operation_id}.json`。Sidecar 启动会将无法重新监控的非终态 receipt 标记 `unknown`，不据此推断 output 成功。
- 完整的 PID 身份验证与跨重启重新附着仍超出 P6-06。恢复逻辑绝不向孤立 receipt 中未经验证的 PID 发信号，只安全落为 `unknown`，由人工 retry/abort。
- `POST /api/v0/operations/:operationId/cancel` 只控制已注册 operation；未知 ID 返回 `404 operation_not_found`。

## 验证

- `apps/sidecar/test/codex-cli-adapter.test.ts`：14 项，覆盖 CLI 不存在、version/login、仓库外且非 symlink runtime root、canonical workspace、路径越界、只读 staging、regular-only output、attempt/operation 冲突、成功 JSONL、非零、非法 JSONL、stdout/stderr 超限、timeout、取消幂等和孤立 operation 恢复。
- `apps/sidecar/test/api.test.ts`：health/refresh/cancel 路由验证，并确认没有生成正式 Run attempt 文件。
- 本机 smoke 只执行 `codex --version` 与 `codex login status`；不执行任何内容任务。

## P6-07 接线

P6-07 应在已确认 RunDraft 后创建新的 attempt workspace，将经校验的 prompt、output schema 和 allowlist 输入交给 `CodexCliAdapter`，并在拿到 Result 后使用现有 `parseAdapterResultForInvocation`。只有完成 output 路径、UTF-8、大小、SHA-256 和 schema 校验后，Orchestrator 才可单写 `NodeAttempt`、Artifact、Gate 与 Trace。

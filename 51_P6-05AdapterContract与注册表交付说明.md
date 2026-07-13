# P6-05 Adapter Contract 与注册表交付说明

> 状态：完成
>
> 日期：2026-07-13

## 交付范围

P6-05 固化了 Adapter 调用与回执之间的可审计边界，但不启动 Codex CLI、不探测本机安装状态，也不读取任何凭证。健康检查、attempt workspace 和进程生命周期仍归 P6-06。

## 契约

- `AdapterInvocation` 现在固定包含 `attempt_id`、`adapter_id`、`runtime_control`、`prompt_path` 和 `output_schema_path`。
- `AdapterResult` 通过 `adapterResultSchema` 要求 `attempt_id`、`operation_id`、`node_run_id`、Provider receipt 和完整 artifact descriptors。状态保留 `succeeded`、`failed`、`timed_out`、`cancelled`、`aborted`、`unknown`。
- `ProviderReceipt` 记录 `provider`、`adapter_kind`、`adapter_id`、`operation_id`，并可记录 model、external session、cost 和 latency。
- `parseAdapterResultForInvocation` 校验 Result 的 operation、attempt、node run、adapter 与 Invocation 一致；receipt operation 必须与 Result operation 一致。

## 兼容与注册表

- `createAdapterInvocation` 为旧 Mock 调用填入稳定默认值：`mock-local-adapter`、30 分钟 timeout、取消 token、attempt workspace、prompt path 和 result schema path。
- Mock runner 回执同时写入 attempt 与 Provider receipt 关联字段；既有 scheduler/runner 路径仍走 `codex-mock-compatible-adapter`。
- `codex-cli-real` 已作为 shell manifest 注册，并在 `runtime.can_execute=false` 时投影为不可执行。它声明 `CODEX_CLI_AUTH` 为逻辑 keychain 凭证引用，但本阶段不会读取认证文件或环境变量。
- `codex-mock-compatible-adapter` 的 ID、mock runner、可执行状态未变化。

## P6-06 接线注意事项

1. health 通过前不得把 `codex-cli-real.runtime.can_execute` 改为 true。
2. P6-06 应在 Sidecar 内解析 `runtime_control.attempt_workspace`，不能把绝对路径、认证信息或原始 stdout 写入 UI/prompt/Trace。
3. 真实执行器返回 Result 前应调用 `parseAdapterResultForInvocation`，并在 timeout、cancel、异常退出和无法判定状态下返回同一 Result 契约。
4. 真实 manifest 已经在 `defaultAdapterManifests` 注册；主 Agent 只需在统一接线时导出 `codex-cli.ts` 的公共 API，避免复制 manifest。

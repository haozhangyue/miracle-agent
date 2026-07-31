# Task 6B 实施报告

## 交付范围

- 新增 DeepSeek、Kimi、MiniMax 三个 Provider Driver，并注册到各自 provider id。
- 新增三份 Provider Catalog Profile，并将同一 Profile 投影到 `model-api.json` manifest。
- 新增 loopback fake-server 契约测试，覆盖请求、响应、错误、取消、超时、响应大小和凭证边界。

## 实现决定

- 三个 Driver 都复用本地 `openai-compatible` 的原生 `fetch`、Bearer header、非流式 JSON、URL 安全和响应归一化边界；没有引入 OpenAI SDK 或调用 OpenAI API。
- 请求模型只来自 `input.profile.model`。默认配置分别为 `deepseek-v4-flash`、`kimi-k2.6`、`MiniMax-M2.7`；Driver 源码没有模型默认值或模型 allowlist。
- DeepSeek 强制 `/chat/completions` 并显式发送 `stream: false`；Kimi 和 MiniMax 使用 `/v1/chat/completions`，不添加其专有参数。
- MiniMax 仅在 `base_resp.status_code` 为整数 `0` 时接受 HTTP 200 响应。缺失、非整数或非零值均抛出解析错误，当前共享 Adapter 稳定映射为 `provider_response_invalid`，且不会暴露 `status_msg`。
- 三份 Catalog Profile 和 manifest 投影均为 `configured_unverified`，并使用 `2026-07-31T00:00:00.000Z` 与相应官方文档 URL。未写入真实凭证或健康状态。

## 契约验证

- Driver 请求：精确 URL、POST、Bearer header、Profile 驱动 model、DeepSeek 非流式字段和 Profile 无 secret。
- Loopback fake server：success、缺 usage、401、429、500、timeout、cancel、invalid JSON、超大响应；所有请求仅指向 `127.0.0.1`。
- MiniMax：`base_resp.status_code` 为 `1004`、`1002`、`1039`、`1026`、`2013`、缺失和非整数时，HTTP 200 均不会返回 succeeded。
- Server：`GET /api/v0/providers` 显示三个 `driver_registered: true`；缺少 MiniMax 凭证时，执行计划在发起 fetch 前失败，fake server 没有收到请求。
- Catalog：schema 解析成功，manifest Profile 和 scoped credential requirement 与 Catalog Profile 逐项一致。

## 验收命令

`npm run test -w apps/sidecar -- provider-drivers.test.ts model-api-adapter.test.ts model-api-server.test.ts provider-catalog.test.ts provider-driver-registry.test.ts`

`npm run test -w packages/core -- provider-catalog.test.ts`

`npm run typecheck`

`npm run build`

`git diff --check`

## 已知限制

MiniMax 的 HTTP 200 业务错误当前受共享 `ProviderDriver.parseResponse` 异常通道限制，统一呈现为 `provider_response_invalid`，不保留可分类的厂商业务码；这是本任务选择的最小兼容映射。没有执行真实 Provider smoke、DNS 或凭证验证，所有 Profile 保持未验证状态。

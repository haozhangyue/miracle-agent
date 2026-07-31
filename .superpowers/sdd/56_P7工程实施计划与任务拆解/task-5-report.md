# P7-06 通用 Model API Adapter 实施报告

## 结论

P7-06 已完成。功能提交：`dc4195d7f91721f44f11a12e4f4de0b5f2d281b3`（`建立通用模型API Adapter`）。

## TDD 证据

### RED

1. `npm run test -w packages/core -- model-api.test.ts`
   - 结果：失败，`adapter_kind` 与 AdapterManifest `kind` 均拒绝 `model-api`。
2. `npm run test -w apps/sidecar -- model-api-adapter.test.ts`
   - 结果：失败，`ModelApiAdapter` 与 `openai-compatible` Driver 模块不存在；6 个行为用例均失败。

首次 Sidecar RED 在受限 sandbox 中无法绑定本地 loopback port；按环境要求以受批准的本地端口权限重跑后，确认失败原因为缺失实现，而非 fixture 启动错误。

### GREEN

1. `npm run test -w packages/core -- model-api.test.ts && npm run test -w apps/sidecar -- model-api-adapter.test.ts`
   - 结果：通过，core 3/3、sidecar 6/6。
2. `npm run typecheck -w packages/core && npm run typecheck -w apps/sidecar`
   - 结果：通过。
3. `npm run test -w packages/core`
   - 结果：通过，8 files、117 tests。
4. `npm run test -w apps/sidecar`
   - 结果：通过，11 files、195 tests。
5. `npm run test -w apps/sidecar -- api.test.ts`
   - 结果：通过，30 tests；确认 task-baseline 当前阶段仍为 P7，`p7-06` completed、`p7-07` current。
6. `git diff --check`
   - 结果：通过。

## 文件清单

- 新增 `packages/core/src/model-api.ts`、`packages/core/test/model-api.test.ts`。
- 新增 `apps/sidecar/src/model-api-adapter.ts`、`apps/sidecar/src/provider-drivers/openai-compatible.ts`。
- 新增 `apps/sidecar/test/model-api-adapter.test.ts`、`apps/sidecar/test/fixtures/provider-server.mjs`。
- 新增 `fixtures/mvp-workspace/.miracle/adapters/model-api.json`。
- 修改 `packages/core/src/types.ts`、`schemas.ts`、`runner.ts`、`index.ts`。
- 修改 `apps/sidecar/src/server.ts`、`plans/mvp-task-baseline/roadmap.json`、`README.md`、`VERSION_HISTORY.md` 和操作使用说明书。

## 接口说明

- `ProviderProfile` 仅保存 `credential_ref`；schema 严格拒绝额外字段，并拒绝在 `base_url` 内携带用户名或密码。
- `ProviderDriver` 定义 `buildRequest`、`parseResponse`、`mapError`，为 P7-07 三个厂商 Driver 提供同一契约。
- `ModelApiAdapter.execute` 使用 Node.js 原生 `fetch`，接收外部 `AbortSignal`，统一 timeout、响应大小、JSON、usage、receipt 和错误映射。
- `model-api` 是新的可执行 Adapter kind；旧 `official-api` manifest 保持兼容。Adapter 仅生成 `AdapterResult`，NodeAttempt、Artifact、Gate、Trace 等运行事实仍由既有编排链路写入。
- `openai-compatible` 仅表示 HTTP 请求/响应兼容格式，不引入 OpenAI SDK，也不调用 OpenAI 官方服务。

## 安全核对

- credential 仅在执行时从 `process.env[credential_ref]` 读取并交给 Authorization header。
- AdapterResult、provider receipt、错误和测试断言均验证不含 credential 明文；未新增日志输出。
- fake provider 覆盖 success、401、429、500、慢响应、无效 JSON、usage 缺失与超大响应。

## 已知限制

- 本任务不实现 DeepSeek、Kimi、MiniMax 的真实 Driver；该工作属于 P7-07。
- 不实现 ProviderRouter 或 fallback；该工作属于 P7-08。
- Model API 成功结果当前只归一化为 AdapterResult/receipt；真实厂商的提示词、输出 Artifact 约定与验证将在后续 Driver 接入中完成。

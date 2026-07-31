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

## 审查修复（2026-07-31）

修复提交：`c8cd62fc20a8c78e8d943f24ab100bb8398104e4`（`修复Model API安全与取消边界`）。

### RED

1. `npm run test -w packages/core -- model-api.test.ts`
   - 结果：失败；`//provider.example/v1/chat` 与 `//user@provider.example/v1/chat` 被 schema 错误接受。
2. `npm run test -w apps/sidecar -- model-api-adapter.test.ts`
   - 结果：失败；401 的超大 body 覆盖为 `provider_response_too_large`，429 的无效 body 覆盖为 `provider_network_error`，500 的挂起 body 覆盖为超时；credential echo 被写入 `raw_receipt_id`；非法 UTF-8 被误映射为 network error；三种危险 `api_path` 未被 Driver 拒绝。
3. `npm run test -w apps/sidecar -- model-api-server.test.ts`
   - 结果：失败；credential 同时出现在执行 API 返回和持久化 attempt；Model API operation 未被 `/api/v0/operations` 列出，取消集成测试超时。
4. `npm run test -w apps/sidecar -- model-api-adapter.test.ts`
   - 结果：失败；补充自审用例证明 `driver.mapError({ error })` 的异常分支仍可回显 credential。

### GREEN

1. `npm run test -w packages/core -- model-api.test.ts`
   - 结果：通过，7 tests。
2. `npm run test -w apps/sidecar -- model-api-adapter.test.ts model-api-server.test.ts`
   - 结果：通过，2 files、14 tests。
3. `npm run typecheck -w packages/core` 与 `npm run typecheck -w apps/sidecar`
   - 结果：均通过。
4. `npm run test -w packages/core`
   - 结果：通过，8 files、121 tests。
5. `npm run test -w apps/sidecar`
   - 结果：通过，12 files、203 tests。
6. `git diff --check`
   - 结果：通过。

### 修复文件

- 修改 `packages/core/src/model-api.ts`、`packages/core/src/schemas.ts`、`packages/core/test/model-api.test.ts`：`api_path` 仅接受单斜杠 origin-relative path，拒绝 scheme-relative、userinfo、绝对 URL 和无前导斜杠。
- 修改 `apps/sidecar/src/provider-drivers/openai-compatible.ts`：Driver 再次校验 path 和解析后的 origin，避免绕过 schema 的调用改变目标主机。
- 修改 `apps/sidecar/src/model-api-adapter.ts`：非 2xx 在 headers 到达后立刻稳定映射并取消 body；非法 UTF-8 固定映射为 `provider_response_invalid`；超大响应保持专用错误；所有进入 `AdapterResult` 的 Driver receipt/error 字符串均做 credential 检测并删除或替换为固定脱敏错误。
- 修改 `apps/sidecar/src/server.ts`：维护 Model API `operation_id -> AbortController` 注册表，执行前注册、`finally` 清理；操作列表可见 active Model API operation，既有取消端点可中止它。
- 修改 `apps/sidecar/test/fixtures/provider-server.mjs`、`apps/sidecar/test/model-api-adapter.test.ts`，新增 `apps/sidecar/test/model-api-server.test.ts`：覆盖 credential echo、日志/持久化/API 无明文、external abort、API cancel、挂起/损坏/超大非 2xx body、非法 UTF-8 与危险路径。

### 接口与安全结论

- `ProviderProfile` 仍只持久化 `credential_ref`，执行期 credential 不进入 `AdapterResult`、receipt、错误、事务、API 返回或 Sidecar 日志；fake provider 的 `credential-echo` 场景已由 Adapter 与 API 集成测试证明。
- Model API 使用 Node.js 原生 `fetch`；`AbortController` 同时承接 timeout、直接外部 abort 与按 `operation_id` 的 API cancel。Adapter 不写 NodeAttempt 或其他运行事实。
- 保持 `official-api` 兼容，并保留 `model-api` 可执行 kind。未引入 OpenAI SDK 或 OpenAI 官方服务，也未实现真实厂商 Driver、ProviderRouter 或 fallback。

## 全局审查修复（2026-07-31）

修复提交：`203d2c3c46e63754249daec31a2fc9089c394bd8`（`加固Model API凭据与操作契约`）。

### RED

1. `npm run test -w packages/core -- model-api.test.ts`
   - 结果：失败；`ProviderProfile.credential_ref` 即使未出现在 `required_credentials` 中仍被 manifest schema 接受。
2. `npm run test -w apps/sidecar -- model-api-adapter.test.ts`
   - 结果：失败；恶意自定义 Driver 的跨源 URL 被交给 `fetch` 并映射为 network error；302 跨源 redirect 被默认 `fetch` 跟随后同样退化为 network error。
3. `npm run test -w apps/sidecar -- model-api-server.test.ts`
   - 结果：失败；空 `required_credentials` 的 profile 可以读取未声明环境变量并将其作为 Authorization header 发到 fake provider；operation 列表缺少 `attempt_id`，首次取消返回 `cancel_requested`。

### GREEN

1. `npm run test -w packages/core -- model-api.test.ts`
   - 结果：通过，8 tests。
2. `npm run test -w apps/sidecar -- model-api-adapter.test.ts`
   - 结果：通过，14 tests。
3. `npm run test -w apps/sidecar -- model-api-server.test.ts`
   - 结果：通过，3 tests。验证未授权 credential 不会到达 fake provider、operation list 含 `attempt_id`、首次取消为 `cancelled`、完成后重复取消为 `already_finished`。
4. `npm run typecheck -w packages/core` 与 `npm run typecheck -w apps/sidecar`
   - 结果：均通过。
5. `npm run test -w packages/core`
   - 结果：通过，8 files、122 tests。
6. `npm run test -w apps/sidecar`
   - 结果：通过，12 files、206 tests。
7. `git diff --check`
   - 结果：通过。

### 修复说明

- `adapterManifestSchema` 增加跨字段校验：每个 ProviderProfile 的 `credential_ref` 必须出现在所属 manifest 的 `required_credentials` 中。Sidecar 在读取环境变量前再次要求匹配的 credential requirement，且只使用当前已实现的 `env` source。
- `ModelApiAdapter` 在 Driver 返回 request 后统一校验 URL：仅允许 http/https、无 userinfo、且与 `profile.base_url` 的 origin 完全一致；`fetch` 固定使用 `redirect: "manual"`，使跨源 redirect 作为原始 3xx 稳定处理。
- Model API 活跃 operation 现在含 `attempt_id`。取消端点与 Codex CLI 一致，首次返回 `cancelled`；执行结束后将最小 terminal receipt 放入最多 128 条的内存 tombstone，重复取消返回 `already_finished`，不会落入 `operation_not_found`。
- 已同步 `docs/README.md`、`docs/00-navigation/asset-index/17_文档资产关联与AI阅读导航.md`、`docs/01-strategy/roadmap/07_后续对接路线图与任务拆解.md`：P7-06 completed，P7-07 current。

### 范围确认

- 保留先前的 credential 回显脱敏、外部 abort、`api_path`、非 2xx、非法 UTF-8 安全修复。
- 未实现 DeepSeek、Kimi、MiniMax 的真实 Driver，未实现 ProviderRouter 或 fallback，未引入 OpenAI SDK 或 OpenAI 官方服务。

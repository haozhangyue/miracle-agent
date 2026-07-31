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

## 全局审查第三轮修复（2026-07-31）

功能修复提交：`ba16b0aeff81268b28b08e8e54cfb2fea5cc0f15`（`完善Model API授权与持久化收据`）。报告提交：待提交。

### RED

1. `npm run test -w packages/core -- model-api.test.ts`
   - 结果：失败，3 个新增用例失败；已声明但仅授权 `provider-a` 的 credential 被 `provider-b` profile 接受，且 `blob:`、`ftp:` base_url 被接受。
2. `npm run test -w apps/sidecar -- model-api-adapter.test.ts`
   - 结果：失败；profile base_url 含 userinfo 时，即使恶意 Driver 给出同源 request，Adapter 仍返回 `succeeded`，而不是 `provider_request_invalid`。
3. `npm run test -w apps/sidecar -- model-api-server.test.ts`
   - 结果：失败；provider scope 不匹配时 fake provider 收到 `Authorization: Bearer fixture-secret`，并且终态后不存在 `model-api-operations/<operation_id>.json`。

### GREEN 与验证

1. `npm run test -w packages/core -- model-api.test.ts`
   - 结果：通过，11 tests。
2. `npm run test -w apps/sidecar -- model-api-adapter.test.ts`
   - 结果：通过，17 tests。
3. `npm run test -w apps/sidecar -- model-api-server.test.ts`
   - 结果：通过，4 tests；包括 Sidecar 重启后的重复取消。
4. `npm run typecheck -w packages/core` 与 `npm run typecheck -w apps/sidecar`
   - 结果：均通过。
5. `npm run build -w packages/core` 与 `npm run build -w apps/sidecar`
   - 结果：均通过。
6. `npm run test -w packages/core`
   - 结果：通过，8 files、125 tests。
7. `npm run test -w apps/sidecar`
   - 结果：通过，12 files、210 tests。
8. `git diff --check`
   - 结果：通过。

### 修复文件

- 修改 `packages/core/src/schemas.ts`、`packages/core/test/model-api.test.ts`：ProviderProfile 的 credential_ref 必须声明，且 required_credentials.providers 存在时必须包含 profile.provider；base_url 仅允许无 userinfo 的 HTTP(S)。
- 修改 `apps/sidecar/src/model-api-adapter.ts`、`apps/sidecar/test/model-api-adapter.test.ts`：Adapter 在 Driver buildRequest 后再次校验 profile base_url 为无 userinfo 的 HTTP(S)，再验证 request 的 scheme、userinfo 和完全相同的 origin；覆盖 `blob:`、`ftp:` 和 userinfo 恶意 Driver 探针。
- 修改 `apps/sidecar/src/server.ts`、`apps/sidecar/test/model-api-server.test.ts`：执行前防御 provider scope，未授权时稳定返回 `credential_not_authorized` 且不读取/外发 credential；为每个终态 Model API operation 写入最小化、原子持久化 receipt，取消端点先查询它并在 Sidecar 重启后仍返回 `already_finished`。

### 接口与安全结论

- 终态 receipt 位于 workspace 的 `model-api-operations/<operation_id>.json`，operation_id 仅接受 `[A-Za-z0-9_-]+`；内容只含 operation、attempt、run、node、adapter、provider、status 与完成时间，不含 credential。现有最多 128 条的内存 tombstone 只作读取加速。
- provider scope 集成测试使用已声明的 key、仅授权 `provider-a`、profile 使用 `provider-b`。精确断言 `credential_not_authorized`，fake provider 没有收到 authorization 记录，API、持久化 attempt、事件和 Sidecar/provider 日志均不含 secret。
- 没有引入 OpenAI SDK 或 OpenAI 官方服务；`openai-compatible` 仍只表示传输协议。没有实现真实厂商 Driver、ProviderRouter 或 fallback。

### 已知限制

- 终态 receipt 保留策略沿用 workspace receipt 机制；本任务不新增清理器。其路径受 operation_id 白名单约束，写入使用既有原子 JSON 写入流程。

## 全局审查第四轮修复（2026-07-31）

功能修复提交：`42374b222e594f1433a61f53b10c87c7e7d9279b`（`加固Model API收据安全与终态取消`）。报告提交：待提交。

### RED

`npm run test -w apps/sidecar -- model-api-server.test.ts`

- 结果：失败，新增 3 个用例均复现问题。
- schema 合法的 `source: "keychain"` Model API credential 被通用 adapter 选择提前筛掉，API 返回 `no_executable_adapter`，没有进入执行层的稳定 `credential_not_authorized` 防御。
- receipt writer 延迟期间，AdapterResult 已产生但 execution 已完成；说明 active operation 直到 `await` 完成后才被移除，无法定义终态取消语义。
- 预置 `model-api-operations` 为指向 workspace 外目录的 symlink 后，Model API 仍成功执行并会经该 symlink 写入 receipt。

### GREEN 与验证

1. `npm run test -w apps/sidecar -- model-api-server.test.ts`
   - 结果：通过，7 tests。覆盖非 env credential source、完成到取消的确定性延迟窗口，以及预置 receipt root symlink 不发起 provider 请求且外部目录为空。
2. `npm run typecheck -w apps/sidecar`
   - 结果：通过。
3. `npm run test`
   - 结果：通过；Sidecar 12 files、213 tests，Web 3 files、9 tests，Core 8 files、125 tests。
4. `npm run typecheck`
   - 结果：通过；Core、Sidecar、Web 均通过。
5. `npm run build`
   - 结果：通过；Core、Sidecar、Web production build 均通过。
6. `git diff --check`
   - 结果：通过。

### 修复说明

- `apps/sidecar/src/server.ts`：Model API receipt root 固定为 canonical workspace 下的 `model-api-operations`。每次读写前均检查 root 是目录、不是 symlink、canonical path 未逃离 workspace；目录 handle 使用 `O_DIRECTORY | O_NOFOLLOW` 验证，写入前再复核 root。receipt 文件本身也用 `O_NOFOLLOW` 打开，写入仍保持原子临时文件 rename。
- `apps/sidecar/src/server.ts`：AdapterResult 返回后的 `finally` 先同步从 active operation 移除并写入有界 terminal tombstone，之后才 await durable receipt 写入；取消端点在该窗口立即返回 `already_finished`。
- `apps/sidecar/src/server.ts`：当正常选择没有 executable adapter 时，仅允许匹配 provider/capability 的 `model-api` manifest 进入其自身授权防御。非 `env` credential source 在读取环境变量和任何 provider 请求前固定返回 `credential_not_authorized`；其他 adapter 的选择保持原样。
- `apps/sidecar/test/model-api-server.test.ts`：新增上述 API 集成测试，测试 fixture 断言 provider 无请求、API/持久化/events/log 不含 secret，并验证 symlink 外部目标没有生成文件。

### 接口与范围

- `MIRACLE_MODEL_API_RECEIPT_WRITE_DELAY_MS` 仅作为集成测试使用的可控 receipt 写入延迟，以稳定覆盖完成-取消窗口；默认 `0`，不改变正常运行。
- Node.js 不提供跨平台 `openat` dirfd 写入 API；实现以 canonical path、`lstat`/`realpath`、目录 `O_NOFOLLOW` 打开和写入前复核来拒绝预置或检测到的替换。P7-06 未扩展到真实厂商 Driver、ProviderRouter 或 fallback，未引入 OpenAI SDK/官方服务。

## 全局审查第五轮修复（2026-07-31）

功能修复提交：`fbed3a4914c76b50aeec92b2357505c15b04751e`（`收紧Model API路由与授权测试`）。报告提交：待提交。

### RED

1. `npm run test -w apps/sidecar -- model-api-authorization.test.ts`
   - 结果：失败，模块不存在；说明授权规则尚未可独立验证。
2. `npm run test -w apps/sidecar -- api.test.ts`
   - 结果：失败；`source: "keychain"` 的不可执行 Model API manifest 在 dry-run 中仍被标记为 `executable: true` 并被选中。
3. `npm run test -w apps/sidecar -- model-api-server.test.ts`
   - 结果：失败；初版 root 替换用例使用快速 fixture，operation 在轮询前结束而超时。改为既有 `slow` fixture 后，通过 receipt write delay 稳定覆盖 terminal 后、写盘前的窗口。

### GREEN 与验证

1. `npm run test -w apps/sidecar -- api.test.ts model-api-authorization.test.ts model-api-server.test.ts`
   - 结果：通过，3 files、44 tests。dry-run 分别覆盖 keychain、缺失 env credential 与 blocked adapter；纯函数覆盖 missing key、非 env source、provider scope 拒绝和合法 env scope。
2. `npm run test`
   - 结果：通过；Sidecar 13 files、220 tests，Web 3 files、9 tests，Core 8 files、125 tests。
3. `npm run typecheck`
   - 结果：通过；Core、Sidecar、Web 均通过。
4. `npm run build`
   - 结果：通过；Core、Sidecar、Web production build 均通过。
5. `git diff --check`
   - 结果：通过。

### 修复说明

- `selectAdapterForNode` 撤回 `executable: false` 的 Model API 兜底，正式执行和 workflow dry-run 重新仅使用 `selectAdapterManifest` 返回的真正 executable adapter。不可执行的 keychain、缺凭证或 blocked manifest 不会误报路由可执行。
- 新增 `apps/sidecar/src/model-api-authorization.ts` 的纯函数 `authorizeProviderCredential(manifest, profile)`。它只授权已声明、`env` source 且 provider scope（若存在）包含 profile.provider 的 credential；`executeSidecarAdapter` 使用它作为环境读取前的第二道防御。
- receipt write delay 集成测试在 terminal tombstone 已可见、execution 尚未结束时将安全 root 替换为外部 symlink；二次 root 校验使执行安全失败，外部目录保持为空。预置 root symlink 测试继续保留。

### 范围确认

- 本轮没有重新放宽 adapter 选择，也未实现真实厂商 Driver、ProviderRouter/fallback、OpenAI SDK 或 OpenAI 官方服务。

# 32_P4第五轮_D7_Adapter插件目录实体化交付说明

## 1. 目标

D7 将第四轮的 Adapter 插件壳升级为可读取、可校验、可路由的本地插件目录：

```text
.miracle/adapters/*.json
-> AdapterManifest
-> credential check
-> /api/v0/adapters
-> dry-run adapter routing
-> NodeRun 执行选择 adapter
-> AdapterResult 对账
```

本轮仍不接真实 Codex CLI、Hermes、OpenClaw 或官方 API。Codex 先以
`mock-compatible` 方式进入执行链路，确保多平台扩展模型不阻断本地 MVP 主链路。

## 2. 新增 AdapterManifest

Adapter 目录新增 5 个 manifest：

| 文件 | kind | execution_mode | MVP 可执行 | 说明 |
|---|---|---|---|---|
| `fixtures/mvp-workspace/.miracle/adapters/mock-local.json` | `mock-local` | `mock-compatible` | 是 | 本地 Mock Runner。 |
| `fixtures/mvp-workspace/.miracle/adapters/codex-mock-compatible.json` | `codex` | `mock-compatible` | 是 | Codex mock-compatible adapter。 |
| `fixtures/mvp-workspace/.miracle/adapters/hermes-shell.json` | `hermes` | `shell` | 否 | Hermes 占位。 |
| `fixtures/mvp-workspace/.miracle/adapters/openclaw-shell.json` | `openclaw` | `shell` | 否 | OpenClaw 占位。 |
| `fixtures/mvp-workspace/.miracle/adapters/official-api-shell.json` | `official-api` | `external` | 否 | 官方 API 占位，包含 env 凭证声明。 |

核心字段：

| 字段 | 含义 |
|---|---|
| `kind` | Runtime adapter 平台类型。 |
| `execution_mode` | `mock-compatible / external / shell`。 |
| `capabilities` | 可满足的 NodeSpec capability。 |
| `supported_providers` | 可承接的 provider 名称。 |
| `required_credentials` | env/keychain/workspace-secret 凭证声明。 |
| `runtime.can_execute` | 当前 Local Sidecar 是否允许执行。 |

## 3. Sidecar API 变化

### 3.1 Adapter 目录

```http
GET /api/v0/adapters
```

返回：

| 字段 | 含义 |
|---|---|
| `adapters[]` | AdapterManifest 加 credential status 后的 registry entry。 |
| `adapters[].credential_status[]` | 每个凭证是否已配置。 |
| `adapters[].executable` | 当前是否可被 Local Sidecar 执行。 |
| `adapters[].unavailable_reasons[]` | 不可执行原因，例如 `runtime_not_executable` 或 `missing_credential:*`。 |
| `summary` | 总数、可执行数、缺失凭证清单。 |

### 3.2 Dry-run 路由预览

`POST /api/v0/workflows/:id/dry-run` 增加：

```json
{
  "adapter_routing": [
    {
      "node_id": "B_md_master",
      "selected_adapter_id": "codex-mock-compatible-adapter",
      "selected_adapter_kind": "codex",
      "executable": true,
      "missing_capabilities": []
    }
  ]
}
```

这让用户在启动 Run 前看到每个节点是否能被本地 adapter 目录承接。

## 4. 执行链路变化

`executeNodeRunOnce()` 不再默认写死 `mock-local`：

1. 读取 `.miracle/adapters/*.json`。
2. 根据 NodeSpec capability、provider 和 preferred kind 选择 adapter。
3. 找不到 provider 精确匹配时，降级到同能力可执行 adapter。
4. 仍找不到时，提交 `no_executable_adapter` failed AdapterResult。
5. AdapterResult 仍由 Orchestrator 提交为 NodeAttempt、ArtifactManifest、GateInstance 和 TraceEvent。

示例：

| 场景 | 结果 |
|---|---|
| `content-production-v0` 默认 `codex-local` 主链路 | 选择 `codex-mock-compatible-adapter`。 |
| `mock-failure` provider | 返回 failed AdapterResult，用于失败 Attention 验证。 |
| 官方 API 缺凭证或 runtime 未实现 | 目录可见，但本轮不可执行。 |

## 5. 代码变更

| 文件 | 变化 |
|---|---|
| `packages/core/src/types.ts` | 新增 `AdapterManifest`、`AdapterCredentialRequirement`、`AdapterRegistryEntry`。 |
| `packages/core/src/schemas.ts` | 新增 Adapter manifest Zod schema。 |
| `packages/core/src/adapters.ts` | 新增默认 manifest、registry 构建、credential check、adapter 选择函数。 |
| `packages/core/src/runner.ts` | `AdapterInvocation` 支持记录 `adapter_id`。 |
| `apps/sidecar/src/server.ts` | 读取本地 adapter manifest，接入 `/api/v0/adapters`、dry-run routing 和执行选择。 |
| `fixtures/mvp-workspace/.miracle/adapters/` | 新增 5 个 Adapter manifest。 |
| `apps/sidecar/test/api.test.ts` | 覆盖 Adapter 目录、凭证状态和 Codex mock-compatible 执行回执。 |
| `packages/core/test/validation.test.ts` | 覆盖 registry credential status 和 adapter selection。 |

## 6. 当前边界

- 不接真实 Codex CLI。
- 不接真实官方 API。
- 不实现 keychain/workspace-secret 读取。
- 不做 provider 成本路由。
- 不做跨 Run adapter capacity。
- 不做远程 Worker。

## 7. 下一步建议

D8 建议实现 Canvas 新增节点生成 NodeSpec draft：

```text
Canvas node card
-> NodeSpec draft
-> capability / inputs / outputs 表单
-> validate-before-save
-> publish draft WorkflowSpec
```

D9 Web run refresh/polling 仍可并行推进，建议在 D8 后做一次体验整合。

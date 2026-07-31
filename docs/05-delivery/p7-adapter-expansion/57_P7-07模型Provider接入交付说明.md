# P7-07 模型 Provider 接入交付说明

> 文档状态：`CURRENT / P7-07 工程接入交付说明`
>
> 前置基线：`55_P7多节点真实执行与模型Adapter扩展总体设计.md`、`56_P7工程实施计划与任务拆解.md`
>
> 任务状态：P7-07 工程接入完成；P7-08 Provider fallback 与灵活路由为当前任务。

## 1. 交付结论与边界

本轮完成 DeepSeek、Kimi、MiniMax 三个 Provider Driver、无凭证 Provider 投影、
`GET /api/v0/providers`、显式 opt-in 的 Provider smoke 命令，以及 fake-server 契约验收。
远程调用仍由 `ModelApiAdapter -> ProviderDriver -> ProviderProfile` 处理；Driver 不硬编码模型
字符串，Profile 仅保存凭证引用。

这是一项工程接入交付，不是三家服务的真实连通结论。当前环境中
`DEEPSEEK_API_KEY`、`MOONSHOT_API_KEY`、`MINIMAX_API_KEY` 均未配置，本轮未运行真实外部调用。
因此三家 Provider 均保持 `configured_unverified`，不得表述为 `healthy`。用户提供凭证后，
需完成真实 health probe 和脱敏 completion，才可将对应 Provider 标记为 `healthy`。

P7 不接 OpenAI 官方 API 或 SDK；P7-08 前不提供 Provider fallback，也不会把凭证存在等同于
真实健康状态。

## 2. Provider Profile

| Provider | Driver ID | Base URL | Path | Credential ref | 默认模型 | 官方文档 | Verification status |
|---|---|---|---|---|---|---|---|
| DeepSeek | `deepseek` | `https://api.deepseek.com` | `/chat/completions` | `DEEPSEEK_API_KEY` | `deepseek-v4-flash` | <https://api-docs.deepseek.com/api/create-chat-completion> | `configured_unverified` |
| Kimi | `kimi` | `https://api.moonshot.cn` | `/v1/chat/completions` | `MOONSHOT_API_KEY` | `kimi-k2.6` | <https://platform.kimi.com/docs/api/overview> | `configured_unverified` |
| MiniMax | `minimax` | `https://api.minimaxi.com` | `/v1/chat/completions` | `MINIMAX_API_KEY` | `MiniMax-M2.7` | <https://platform.minimaxi.com/docs/guides/text-generation>、<https://platform.minimaxi.com/docs/api-reference/text-chat-openai> | `configured_unverified` |

模型字符串是当前 Profile 的默认值，不是 Driver 的硬编码行为；部署方可在受控 Profile 中调整。

## 3. 调用链与验收范围

```text
ModelApiAdapter
  -> ProviderDriver
  -> ProviderProfile
  -> approved provider endpoint
```

`ModelApiAdapter` 统一处理原生 `fetch`、timeout、AbortSignal、响应大小、JSON、usage、receipt 和
稳定错误映射。ProviderDriver 只处理厂商请求/响应差异：DeepSeek 强制非流式
`/chat/completions` 路径，Kimi 使用兼容协议，MiniMax 额外要求 `base_resp.status_code === 0`。
MiniMax 的 `base_resp` 检查只是最小兼容限制，不表示其所有业务错误、流式能力或功能参数都已被
Miracle 覆盖。

fake-server 契约验收覆盖三家 Driver 的请求差异、success/error/usage/timeout 和错误合同。未知
Driver、Driver ID 与 Provider 错配一律拒绝，不会 fallback 到其他 Driver；单个 Catalog 缺失时
按 Provider 解析专用 Driver，不使用 manifest `runtime.entrypoint` 绕过厂商校验。真实 Provider
smoke 不在本轮验收范围内。

## 4. 配置与检查模型 Provider

1. 在运行 Sidecar 的环境中配置需要验证的 Key，切勿把 Key 写入 Profile、Git、RunSpec、
   WorkflowSnapshot、回执、日志或截图：

   ```bash
   export DEEPSEEK_API_KEY='...'
   export MOONSHOT_API_KEY='...'
   export MINIMAX_API_KEY='...'
   ```

2. 启动 Sidecar 后检查 Provider 投影：

   ```bash
   curl http://127.0.0.1:4317/api/v0/providers
   ```

   无凭证时返回 `missing_credential`，且不会发送网络请求；凭证已配置但尚未真实验证时返回
   `configured_unverified`。

3. 仅在用户明确允许、已配置目标 Provider 凭证时，执行真实 smoke：

   ```bash
   MIRACLE_ENABLE_MODEL_API=1 MIRACLE_SMOKE_PROVIDER=deepseek npm run smoke:provider
   ```

   将 `deepseek` 替换为 `kimi` 或 `minimax` 可验证对应 Provider。smoke 会严格解析 workspace
   中唯一的 Model API manifest，并在构造 Driver request 前复用 Sidecar 的
   `credential_ref -> manifest requirement -> provider scope` 授权。Catalog 凭证只允许合法 env
   引用；跨 Provider 引用、非 env source、未知或错配 Driver 均在网络请求前 fail closed。

   设置 `MIRACLE_WORKSPACE_DIR` 时，Artifact 写入该 workspace 的 `smoke-artifacts/`。未设置时，
   Provider/Catalog 配置从内置 fixture workspace 读取，Artifact 则写入操作系统临时目录下由
   `mkdtemp` 安全创建的独立 `miracle-provider-smoke-*` workspace，返回值包含完整路径，不污染
   Git 工作树。两种模式都要求 canonical 非 symlink 目录，并以单次安全创建写入脱敏 Markdown。

## 5. 状态语义与本轮真实 smoke 结果

| 状态 | 语义 | 是否可发送远程请求 |
|---|---|---:|
| `missing_credential` | 对应环境变量未配置 | 否 |
| `configured_unverified` | 凭证可被运行时引用，但没有完成真实健康/脱敏 completion 验证 | 仅在显式 opt-in 下可尝试 |
| `healthy` | 已完成真实 health probe 和脱敏 completion，并有脱敏证据 | 是 |

本轮记录：

- `DEEPSEEK_API_KEY`、`MOONSHOT_API_KEY`、`MINIMAX_API_KEY` 均未配置。
- 未运行任何真实外部 Provider 调用，也没有伪造 smoke Artifact 或 receipt。
- 三家 Provider 保持 `configured_unverified` 作为 Profile 配置状态；运行时无凭证投影为
  `missing_credential`。
- P7-07 工程接入完成。真实连通验证将在用户提供凭证并明确 opt-in 后补做。

## 6. 安全与后续边界

- Catalog Key 仅支持合法环境变量引用；`keychain`、`workspace-secret` 和疑似明文密钥解析失败，
  不持久化、不写入 API、回执、日志、错误、测试快照或 Git。
- Provider 路由尚未实现；P7-08 才处理同类 Provider fallback、成本/capability 策略和
  Codex/Model API 的人工确认边界。
- Provider health 不能由凭证存在、fake-server 通过或 HTTP transport 初始化推断。
- smoke 路径有 canonical 目录、symlink、文件名和单次写入保护；默认 Artifact 位于仓库外的
  系统临时 workspace；若 `TMPDIR` 等环境配置使临时目录解析到仓库内，系统会清理并在联网前
  拒绝。显式选择只按 `profile.provider` 匹配，不接受 Catalog ID 跨 Provider 别名，从而避免
  路径逃逸、跨 Provider 凭证发送、覆盖既有文件和 Git 污染。

## 7. 验收与下一步

工程验收命令：

```bash
npm run test -w apps/sidecar -- provider-drivers.test.ts model-api-adapter.test.ts
npm run typecheck
npm run test
```

本轮 fake-server 契约验收已运行 2 个测试文件、104 项测试通过；该数量仅覆盖
`provider-drivers.test.ts` 和 `model-api-adapter.test.ts` 的本地契约，不替代真实外部 smoke。
下一步 `P7-08` 只处理 Provider Router 与 fallback，不应倒推把任何未验证 Provider 标记为健康。

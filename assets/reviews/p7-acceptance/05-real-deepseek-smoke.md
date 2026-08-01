# P7 DeepSeek 真实 Provider Smoke 证据

> 执行日期：2026-08-01
>
> 证据性质：经用户明确授权的单 Provider 脱敏 completion smoke

## 结果

| 项目 | 值 |
|---|---|
| Provider | `deepseek` |
| Model | `deepseek-v4-flash` |
| Adapter | `model-api-compatible-adapter` |
| Status | `succeeded` |
| Input tokens | 93 |
| Output tokens | 207 |
| Total tokens | 300 |
| Latency | 2884 ms |

归一化输出：

```text
Acknowledged, Miracle Provider. Your smoke signal is received. All clear.
```

## 安全边界

- Key 仅通过一次性进程环境注入，没有写入仓库、Artifact、receipt、日志或截图。
- 原始 smoke Artifact 写入仓库外的系统临时 workspace，本文件只保留脱敏结果摘要。
- 本次结果只证明 DeepSeek 在该次受控验收环境中连通，不把内置 fixture 永久标记为全局
  `healthy`；新环境或新凭证仍需重新验证。
- Kimi 与 MiniMax 未执行真实调用，继续保持 `configured_unverified`。

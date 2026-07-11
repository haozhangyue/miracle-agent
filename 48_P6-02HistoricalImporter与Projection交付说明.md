# P6-02 Historical Importer 与 Projection 交付说明

> 文档状态：CURRENT
>
> 任务结论：P6-02 已完成，当前主线进入 P6-03 真实 Run API 与 Web 展示。
>
> 适用版本：运行版本仍为 `v0.7.0`；本轮新增 Sidecar API 和 Core historical projection，尚未完成真实 Run Web 展示。

## 1. 本轮交付

P6-02 已把 P5 的 historical importer 方案落成可运行工程能力：

```text
允许读取的 W24/W23 源目录
-> Sidecar 只读扫描与证据标准化
-> Core historical projection
-> preview（零写入）
-> commit（staging + 原子 rename）
-> .miracle/runs/run-real-*/
```

新增能力：

- W24 高证据导入：保留 source event、historical attempt、GateDecision 和 F pending review。
- W23 降级导入：只生成 inferred Artifact/Node projection 和缺口 Attention。
- `MIRACLE_IMPORT_ROOTS` 白名单和 `realpath` 越界检查。
- `workflow_id` 安全字符校验，禁止路径逃逸 registry 目录。
- 基于文件相对路径、大小和流式内容 SHA-256 的 `source_fingerprint` 幂等导入；大小和
  mtime 不变但内容变化时仍会生成新 Run。
- import 级目录锁串行化同源并发提交；Run 已落盘但 receipt 缺失时，重试会自动补写回执。
- commit 强制使用 Miracle 仓库外的 runtime workspace，避免真实路径和运行事实进入 Git。
- workspace 边界同时校验词法路径与 `realpath`，仓库外 symlink 不能绕过限制。
- Artifact 审核状态只从明确 phase status 或有效 GateDecision 推导；缺少证据时保持
  `none`，不会制造 `approved`。GateInstance 只从真实待审状态或真实决策生成。
- import lock 带 owner 与租期，进程异常退出留下的过期锁可自动回收。
- 控制 JSON/JSONL 损坏或 schema 版本不支持返回 `422 invalid_source_data`；不存在的
  import receipt 返回 `404 historical_import_not_found`。
- 大媒体只记录源路径、SHA-256 和 metadata，不复制进 Miracle workspace。
- Historical run 的 scheduler、node execute、Gate decision 和 rework 写命令返回
  `409 historical_run_read_only`。

## 2. 核心对象调整

`RunSpec` 现在使用 discriminated union：

| 类型 | run_mode | execution_policy | 是否可执行 |
|---|---|---|---:|
| ExecutableRunSpec | `executable` | `auto/manual/hybrid` | 是 |
| HistoricalRunSpec | `historical_readonly` | `null` | 否 |

这修复了 P5-03 示例中把 `historical_readonly` 当作执行策略的语义冲突。旧原生 fixture
缺少 `run_mode` 时，schema 兼容投影为 `executable`；新落盘对象必须显式写入。

Historical projection 额外输出：

- `source_meta.json`：对象来源、confidence、source path、fingerprint 和 gaps。
- `attempts.json`：只从真实 `task_trace.json.steps` 生成。
- `events.jsonl`：镜像真实 source event，并追加一条 importer 审计事件。
- `attention.json`：observed pending Gate 为 P0，inferred pending Gate 和证据缺口降级为 P2。

## 3. API

| API | 用途 | 是否写入 |
|---|---|---:|
| `POST /api/v0/historical-imports/preview` | 扫描、校验并返回 projection 预览 | 否 |
| `POST /api/v0/historical-imports` | 将 projection 原子写入 Miracle workspace | 是 |
| `GET /api/v0/historical-imports/:importId` | 查询已提交 importer receipt | 否 |

请求示例：

```json
{
  "source_run_dir": "/allowed/runs/real/2026-W24_Codex_ClaudeCode_真实任务交付包",
  "workflow_id": "content-production-real-v0",
  "sample_kind": "w24"
}
```

## 4. 本地使用方式

真实导入不要写入仓库内 fixture。先准备仓库外 runtime workspace：

```bash
cd /Users/zhangyue/miracle-agent
mkdir -p "$HOME/.miracle-agent/workspace"
cp -R fixtures/mvp-workspace/.miracle "$HOME/.miracle-agent/workspace/"

MIRACLE_WORKSPACE_DIR="$HOME/.miracle-agent/workspace/.miracle" \
MIRACLE_IMPORT_ROOTS="/Users/zhangyue/Documents/Obsidian Vault/热点工具更新/runs/real" \
npm run dev:sidecar
```

先 preview：

```bash
curl -sS -X POST http://127.0.0.1:4317/api/v0/historical-imports/preview \
  -H 'content-type: application/json' \
  -d '{
    "source_run_dir": "/Users/zhangyue/Documents/Obsidian Vault/热点工具更新/runs/real/2026-W24_Codex_ClaudeCode_真实任务交付包",
    "workflow_id": "content-production-real-v0",
    "sample_kind": "w24"
  }'
```

确认 `valid`、gaps 和 projected counts 后，把 URL 改为
`/api/v0/historical-imports` 执行 commit。重复提交相同源 fingerprint 会返回
`reused: true`，不会生成第二份 Run。

## 5. 自动化验证

TDD 新增：

- Core historical projection：4 tests。
- Sidecar importer：11 tests。
- Sidecar API 总数由 22 增至 23 tests；全量 Sidecar 为 34 tests。
- Core 总数由 6 增至 10 tests。

覆盖场景：

- W24 observed/inferred 分层。
- W23 缺控制文件降级。
- HistoricalRunSpec schema。
- inferred Gate Attention 降级。
- preview 零写入。
- allowlist 越界拒绝。
- staging 原子提交。
- fingerprint 幂等。
- 内容不变/metadata 变化可复用，内容变化/metadata 不变不可复用。
- 同源并发提交串行化，缺失 receipt 可自愈。
- historical scheduler、node、Gate decision 和 Gate rework mutation 409，且事实不变。
- 仓库内 runtime workspace commit 返回 `409 runtime_workspace_required`。
- symlink workspace 绕过、stale/corrupt lock 恢复、损坏 JSON 和不支持 schema version。
- 不存在的 historical import receipt 返回 404。
- `.staging` 不进入 Run 列表，workflow 路径逃逸返回 400。

## 6. 真实 W24/W23 Smoke

真实 smoke 输出写入系统临时目录，没有写仓库 fixture：

| 指标 | W24 | W23 |
|---|---:|---:|
| NodeRun | 8 | 8 |
| ArtifactManifest | 16 | 7 |
| GateInstance | 3 | 0 |
| historical source event | 27 | 0 |
| historical attempt | 10 | 0 |
| F 状态 | reviewing | done / inferred |
| 重复导入 | reused | reused |

W24 `task_events.jsonl` smoke 前后 `mtime:size` 都是 `1781234991:5896`，确认 importer
未回写真实源文件。

## 7. 文件清单

核心实现：

- `packages/core/src/historical.ts`
- `packages/core/src/types.ts`
- `packages/core/src/schemas.ts`
- `apps/sidecar/src/historical-importer.ts`
- `apps/sidecar/src/server.ts`
- `fixtures/mvp-workspace/.miracle/workflows/content-production-real-v0.json`

测试资产：

- `packages/core/test/historical.test.ts`
- `apps/sidecar/test/historical-importer.test.ts`
- `apps/sidecar/test/fixtures/historical/w24-minimal/`
- `apps/sidecar/test/fixtures/historical/w23-minimal/`
- `apps/sidecar/test/api.test.ts`

## 8. 当前限制与 P6-03 输入

P6-02 已生成真实 historical run 文件，但当前 Web 仍默认打开 demo run。P6-03 继续完成：

1. `GET /runs` 和 `GET /runs/:id` 增加 origin/mode/confidence read model。
2. 首页和 Run 工作区增加 historical Run 选择入口。
3. Run、DAG、Attention、Artifact、Gate 和 Agent 展示 source confidence。
4. Historical 页面隐藏执行、调度、GateDecision 和 rework 写操作。
5. 生成 `assets/reviews/p6-real-run-ui/` 截图证据。

P6-02 不代表真实 Codex Adapter 已启用；真实执行仍在 P6-05 至 P6-07。

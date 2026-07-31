# Miracle 系统操作使用说明书

> 文档状态：CURRENT
>
> 文档性质：用户操作真相源、版本感知入口和手册同步规范
>
> 适用对象：系统使用者、产品评审者、AI 协作执行者和后续工程实现者
>
> AI 阅读建议：需要启动系统、理解菜单、核对用户可感知变化、检查迭代影响时优先读取本文；技术协议仍以 `19-23`、`24-35` 和后续实现文档为准。

## 1. 本手册解决什么问题

Miracle 已经从规划、架构、原型进入可运行 MVP 和真实工作流接入阶段。项目中已有大量
设计文档、交付说明和版本记录，但这些材料更偏向工程和评审，不适合作为日常使用入口。

本文固定承担三类职责：

1. 告诉用户如何启动本地系统、访问页面和确认服务状态。
2. 说明当前系统菜单、功能边界、典型操作流程和常见故障恢复方式。
3. 每次重要迭代后同步记录“用户能感知到什么变化”，避免只靠 Git 提交文字追溯。

本文不替代：

- `VERSION_HISTORY.md`：版本历史和里程碑真相。
- `17_文档资产关联与AI阅读导航.md`：文档依赖和 AI 阅读路由真相。
- `plans/mvp-task-baseline/roadmap.json`：机器可读任务进度真相。
- 代码和 fixture：当前可运行行为的最终实现真相。

## 2. 当前版本快照

| 项目 | 当前值 |
|---|---|
| 当前产品版本 | `v0.8.0` |
| 当前工程形态 | React Web + Node.js Local Sidecar + packages/core + fixture workspace |
| 当前阶段 | P7-02 至 P7-07 已完成，已接入三家 Provider Driver；真实连通尚未验证 |
| 当前任务焦点 | `P7-08` Provider fallback 与灵活路由 |
| 已完成 P5 任务 | `P5-01` 至 `P5-09`，P5 设计与接入边界验收通过 |
| P6 验收基线 | `54_P6回归验收与版本收口报告.md` |
| 本地 workspace 默认目录 | `fixtures/mvp-workspace/.miracle` |
| 任务基线数据 | `plans/mvp-task-baseline/roadmap.json` |

当前阶段要点：

- 新任务现在先创建 RunDraft，可修改主题和可选分支后重新 Dry-run。
- Dry-run 展示 required/optional 分支、Provider、成本、时长、Gate、凭证和启动条件。
- 已确认草案可在 Codex health healthy 且显式开启真实执行后原子转换为正式 Run。
- Adapter 回执在提交 Attempt、Artifact 和 Trace 前执行 operation/node/attempt/provider 关联校验。
- Codex CLI 健康检查已支持版本与登录状态检测；只返回状态、版本和原因码，不展示凭证值。
- 真实 CLI attempt 使用仓库外隔离目录，输入只读 staging，输出、超时和取消均受 Sidecar 边界控制。
- Codex 已支持按 ExecutionPlan 将上游 Artifact 的指定版本和 SHA-256 校验后交给下游节点。
- 下游 Attempt 会冻结 `resolved_inputs`、输出 schema，并把受控输入复制到
  `input/artifacts/`；任何 hash、media type 或路径校验失败都不会启动 Codex。
- Scheduler 每个 commit tick 都从完整 Run bundle 重算 ExecutionPlan，只执行 `execute` 决策；
  `execution_plan_calculated` 与 `node_inputs_resolved` 审计只记录 ID、数量和 reason code。
- Model API Adapter 使用 Node.js 原生 `fetch` 处理兼容协议；用户只配置 ProviderProfile
  的 `credential_ref`，不会在 Adapter 回执、错误或运行界面看到凭证值。
- DeepSeek、Kimi、MiniMax Driver 与 `GET /api/v0/providers` 已接入；本轮三家 Key 均未配置，
  未执行真实 smoke，三家 Profile 均为 `configured_unverified`，不代表 healthy。

```text
GET  /api/v0/adapters/codex-cli/health
POST /api/v0/adapters/codex-cli/health/refresh
GET  /api/v0/operations?run_id=:runId
POST /api/v0/operations/:operationId/cancel
```

P6-07 已把 CLI 生命周期接入正式 NodeRun、Artifact、Gate 和 Trace；真实执行默认关闭。

运行态目录默认使用 `~/.miracle-agent`，与仓库内 fixture 数据目录隔离。可通过
`MIRACLE_RUNTIME_WORKSPACE_DIR` 指定其他仓库外目录；Sidecar 会拒绝仓库内路径和 symlink。

- P4 已形成本地 MVP 验收基线，核心页面和 Sidecar API 可运行。
- P6 已把 historical importer、RunDraft 和 Codex 单节点 Adapter 变成可运行能力，并
  通过工程、46 项 API、页面和安全真实性验收。
- Flow A-G 只是第一个真实样本，不代表 Miracle 被固化为内容生产系统。
- Node.js Local Sidecar 是 MVP 本地服务，不是商业化云端主后端的最终限定。

## 3. 本地启动方式

### 3.1 首次安装依赖

在仓库根目录执行：

```bash
cd /Users/zhangyue/miracle-agent
npm_config_cache=.npm-cache npm install
```

### 3.2 同时启动 Web 和 Sidecar

```bash
npm run dev
```

根级 `dev`、`test` 和 `build` 命令会先构建 `packages/core`，再启动或验证依赖它的
Sidecar/Web。切换分支或拉取新版本后无需手工清理、预构建 `dist`；请优先使用这些根级
命令，避免工作区包读取旧构建产物。

默认服务：

| 服务 | 默认地址 | 说明 |
|---|---|---|
| Web 工作台 | `http://127.0.0.1:5174/` | React/Vite 页面入口 |
| Sidecar health | `http://127.0.0.1:4317/api/v0/health` | 本地服务健康检查 |
| 任务基线页面 | `http://127.0.0.1:4317/task-baseline` | 独立任务进度看板 |
| 任务基线 API | `http://127.0.0.1:4317/api/v0/project/roadmap` | 机器可读计划和 Git 同步状态 |

如果终端显示端口不同，以终端输出为准；当前验收基线固定使用 Web `5174` 和 Sidecar
`4317`。

### 3.3 只启动 Sidecar

只查看 API 或任务基线页面时，可以只启动 Sidecar：

```bash
npm run dev:sidecar
```

适用场景：

- 查看 `http://127.0.0.1:4317/task-baseline`。
- 检查 `/api/v0/project/roadmap` 是否同步 Git HEAD 和证据文件。
- 不需要打开 Web 工作台。

### 3.4 只启动 Web

```bash
npm run dev:web
```

注意：Web 页面依赖 Sidecar API。只启动 Web 时，页面可打开，但数据请求会失败。

### 3.5 可选环境变量

| 环境变量 | 默认值 | 用途 |
|---|---|---|
| `MIRACLE_WORKSPACE_DIR` | `fixtures/mvp-workspace/.miracle` | 指定本地 Miracle workspace |
| `MIRACLE_SIDECAR_PORT` | `4317` | 指定 Sidecar 端口 |
| `MIRACLE_RUNTIME_WORKSPACE_DIR` | `~/.miracle-agent` | 指定仓库外 attempt runtime |
| `MIRACLE_ENABLE_REAL_CODEX` | 未设置 | 设为 `1` 时允许已确认草案调用真实 Codex CLI |
| `MIRACLE_CODEX_CLI_PATH` | `codex` | 可选，覆盖 Codex CLI 可执行文件 |
| `DEEPSEEK_API_KEY` | 未设置 | DeepSeek 运行时凭证，仅用于显式 opt-in 的真实调用 |
| `MOONSHOT_API_KEY` | 未设置 | Kimi 运行时凭证，仅用于显式 opt-in 的真实调用 |
| `MINIMAX_API_KEY` | 未设置 | MiniMax 运行时凭证，仅用于显式 opt-in 的真实调用 |

示例：

```bash
MIRACLE_WORKSPACE_DIR=/path/to/.miracle MIRACLE_SIDECAR_PORT=4318 npm run dev:sidecar
```

如果调整 Sidecar 端口，需要同步 Web 代理或直接访问对应 API；当前 MVP 默认按 `4317`
使用。

## 4. 当前菜单和功能说明

### 4.1 Web 工作台菜单

| 菜单 | 主要用途 | 当前状态 |
|---|---|---|
| 首页 | 查看 Attention、继续运行、快速启动、最近交付和系统风险 | 可用 |
| 新任务 | 选择领域、模板和执行策略，进入启动前检查 | 可用 |
| Dry-run | 校验 Workflow、查看风险、凭证、成本和启动 Run | 可用 |
| 任务运行 | 查看 Run、DAG、NodeRun、Attempt、事件审计和调度动作 | 可用 |
| Attention | 按根因聚合异常，查看关联 Agent、Node、Artifact、Gate 和恢复动作 | 可用 |
| 智能体 | 查看多 Agent 协同态势、健康、等待对象和交接对象 | 可用 |
| 产物 | 查看 ArtifactManifest、版本、审核状态和本地预览 | 可用 |
| 审核 | 查看 Gate、提交 GateDecision、创建返工版本 | 可用 |
| 画布草稿 | 创建 Canvas node card、生成 NodeSpec draft、预览 spec diff、发布 Workflow draft | 可用 |
| Spec Sync | Visual/Spec 双向同步入口 | 占位 |
| 进化占位 | EvolutionCandidate 和进化建议入口 | 占位 |

### 4.2 独立任务基线页面

入口：

```text
http://127.0.0.1:4317/task-baseline
```

用途：

1. 查看当前阶段红点、已完成绿点和计划灰点。
2. 查看 P4/P5 任务拆解、依赖和并行关系。
3. 查看最近 Git commit、工作区是否有未提交修改。
4. 查看证据文件是否存在、是否被 Git 跟踪、最后关联 commit。

任务基线页面不进入 Web 工作台侧边栏，它是项目管理和交付审计页面。

## 5. 典型操作流程

### 5.1 快速确认系统是否正常

1. 在仓库根目录执行 `npm run dev`。
2. 打开 `http://127.0.0.1:4317/api/v0/health`。
3. 打开 `http://127.0.0.1:4317/task-baseline`，确认当前红点与本文“当前任务焦点”一致。
4. 打开 `http://127.0.0.1:5174/`，确认首页能显示 Attention、Run、Artifact 和模板。

### 5.2 启动一个示例 Run

1. 进入 Web 工作台首页。
2. 点击侧边栏“新任务”。
3. 选择当前示例模板，进入“Dry-run”。
4. 检查风险、凭证和启动摘要。
5. 点击“启动 Run”。
6. 系统进入“任务运行”，展示 RunSpec、WorkflowSnapshot、Node DAG 和节点详情。

当前 MVP 启动的是 fixture 示例 Run，不会调用真实外部 Runner。

### 5.3 查看任务执行情况

1. 进入“任务运行”。
2. 查看顶部运行状态、Attention 数量和系统成本摘要。
3. 在 DAG 中点击节点，右侧查看 NodeRun、Attempt 和恢复建议。
4. 查看底部事件审计，确认 scheduler、runner、gate、artifact 等事件。
5. 点击“调度一次”执行一个 tick，或点击“自动推进”连续推进到 Gate、失败或完成边界。

### 5.4 处理阻塞和异常

1. 进入“Attention”。
2. 选择一个根因项，例如凭证缺失、Gate 待审核或节点失败。
3. 查看关联对象：Agent、NodeRun、ArtifactManifest、GateInstance。
4. 按恢复动作进入“审核”或回到“任务运行”。
5. 处理后刷新 Run 或等待 polling 更新。

Attention 的原则是“一个根因对应一个主 Attention Item”，避免多个对象重复报警。

### 5.5 提交 Gate 审核决策

1. 进入“审核”。
2. 在 Gate 列表中选择待审核 Gate。
3. 查看目标 Artifact、阻塞下游、历史决策和决策投影。
4. 选择 `approve`、`reject` 或 `request_changes`。
5. 提交后 Sidecar 写入 GateDecision 和 TraceEvent。

审核通过会推动符合条件的下游节点；驳回或要求修改会保留旧产物和旧决策。

### 5.6 创建返工版本

返工只适用于已经 `reject` 或 `request_changes` 的 Gate。

1. 在“审核”中打开已驳回或要求修改的 Gate。
2. 点击创建返工。
3. 系统生成新的 rework NodeAttempt、新 ArtifactManifest version 和新的 GateInstance。
4. 新 Gate 进入 `pending_review`，旧 Artifact 和旧 GateDecision 保留。
5. 审核新 Gate 后，下游节点按 Edge selector 重新判断是否可恢复。

### 5.7 查看产物预览

1. 进入“产物”。
2. 选择 ArtifactManifest。
3. 查看类型、版本、hash、review_status、producer 和本地预览。

当前支持 markdown、json、text 等本地预览；二进制文件或缺失文件会显示不可预览原因。

### 5.8 在画布草稿中新增节点

1. 进入“画布草稿”。
2. 新增 node card 或编辑 canvas objects。
3. 点击生成 NodeSpec draft。
4. 查看 Spec Diff Preview。
5. 发布为新的 draft WorkflowSpec。

画布草稿不会直接修改 stable Workflow，也不会改变已启动 Run 的 WorkflowSnapshot。

### 5.9 查看本次迭代完成了什么

推荐顺序：

1. 先看本文“当前版本新增能力”和“相比上一版本的用户变化”。
2. 再看 `VERSION_HISTORY.md` 的未发布变更或当前版本记录。
3. 需要工程证据时看 `plans/mvp-task-baseline/roadmap.json` 和 `/task-baseline` 页面。
4. 需要具体技术细节时再读对应交付说明文档。

### 5.10 Preview 和导入历史 Run

P6-03 已将 historical Run 接入 Web。真实导入必须使用仓库外 runtime workspace，并显式设置
允许读取的根目录：

```bash
cd /Users/zhangyue/miracle-agent
mkdir -p "$HOME/.miracle-agent/workspace"
cp -R fixtures/mvp-workspace/.miracle "$HOME/.miracle-agent/workspace/"

MIRACLE_WORKSPACE_DIR="$HOME/.miracle-agent/workspace/.miracle" \
MIRACLE_IMPORT_ROOTS="/Users/zhangyue/Documents/Obsidian Vault/热点工具更新/runs/real" \
npm run dev:sidecar
```

先调用 `POST /api/v0/historical-imports/preview` 查看 valid、gaps 和 projected counts，确认后
再调用 `POST /api/v0/historical-imports`。详细请求示例见
`48_P6-02HistoricalImporter与Projection交付说明.md` 和
`49_P6-03真实Run_API与Web展示交付说明.md`。

Historical run 是只读对象：不能调度、执行节点、提交 GateDecision 或创建返工版本。
Sidecar 会强制要求仓库外 runtime workspace；若 `MIRACLE_WORKSPACE_DIR` 位于 Miracle
仓库内，commit 返回 `409 runtime_workspace_required`。导入按源文件内容 SHA-256 识别，
同一导入的并发请求会串行处理；Run 已存在但 import receipt 丢失时，重试会自动修复回执。
真实路径检查会解析 symlink；进程异常退出留下的过期 import lock 会自动恢复。历史审批
缺少状态或决策证据时不会显示为已批准。控制文件损坏返回 422，查询不存在的导入回执返回 404。

### 5.11 执行 Codex 单节点真实 Run

1. 先执行 `codex --version` 和 `codex login status`，确认 CLI 已安装且登录。
2. 使用 `MIRACLE_ENABLE_REAL_CODEX=1 npm run dev` 启动系统。
3. 进入“新任务”，选择“Codex 单节点 Markdown 母稿”。
4. 填写脱敏主题，创建 RunDraft 并完成 Dry-run。
5. 确认 required path、Gate 和确认项后，点击“确认当前计划”。
6. 点击“启动正式 Run”，草案会转换为正式 Run。
7. 在“任务运行”中点击“自动推进”或“调度一次”。
8. 查看真实 Adapter、operation、耗时、Markdown Artifact 和 `pending_review` Gate。
9. 进入“审核”完成人工 GateDecision。

真实执行只读取 RunDraft 中的公开输入，不会读取 W23/W24 历史交付包。执行中可通过
Run 节点详情取消活跃 operation。Attempt 页面只显示非敏感元数据，不显示凭证、隐藏推理
或外部 runtime 绝对路径。

### 5.12 连续验证 Codex 多节点 Artifact 交接与 Gate 恢复

1. 使用 `MIRACLE_ENABLE_REAL_CODEX=1 npm run dev` 启动系统。
2. 创建并确认一个包含至少两个 Codex 节点、且下游输入引用上游 Artifact 的 RunDraft。
3. 调用 `POST /api/v0/runs/:runId/scheduler/run` 并设置 `max_ticks` 与 `max_nodes_per_tick`，系统会连续执行可就绪节点，直到 Gate、失败或终止。
4. 在 Run 节点详情中确认上游 Artifact 的版本、hash、producer 和输出端口；Scheduler 响应中的
   `execution_plan` 只用于本次计划展示，不作为可变事实持久化。
5. 当下游被 Gate 暂停时，提交 approve GateDecision 后再次调用 Scheduler；系统会重算 ExecutionPlan 并恢复下游。
6. 在下游 Attempt workspace 中，输入只会出现在 `input/artifacts/`，解析快照写入
   `input/resolved-inputs.json`；运行界面只展示非敏感摘要。
7. 查看下游 NodeAttempt、ArtifactManifest 和事件审计，确认交接使用的是精确版本和 hash。

reject GateDecision 不会推进下游；Scheduler 返回 `paused_for_gate`，直到人工创建并审核返工产物。
Provider fallback 仍属于 P7-08，当前 Scheduler 不会自动切换 Provider。

### 5.13 查看和处置 Retry

1. 当 Adapter 返回明确 `failed`，或返回由 `process_timeout` 确认终止的 `timed_out`，
   且归一化 error code 在节点 RetryPolicy 允许列表内时，查看节点详情中的“Retry 决策”。
2. 真实 Codex 进程退出/启动失败归一为 `adapter_process_error`，确认超时归一为
   `adapter_timeout`，无效 JSONL 输出归一为 `adapter_output_invalid`。节点模板可在
   `failure_policy.retry_policy` 完整配置退避、code、attempt timeout、总时间、成本和
   人工确认阈值；legacy `retry` 仍映射为有限默认策略。
3. 投影状态 `waiting_for_retry` 表示尚未到期，按钮保持禁用；`due` 表示可直接执行；
   `exhausted` / `blocked` 表示必须处理 Attention。界面同时显示 attempts、elapsed time
   和 cost 的 used/limit。
4. `schedule_retry` 表示已排期。未到 `scheduled_for` 时再次运行 Scheduler 不会派发；
   到期后运行“调度一次”或“自动推进”会创建递增 `attempt_number` 的新 NodeAttempt。
5. 自动 retry 复用原 `operation_id`，每次 Attempt 都追加保留。可在 Attempt 列表和
   `retry_scheduled` / `retry_exhausted` 事件中核对完整历史。
6. Sidecar 重启后无需手工重建 schedule；Scheduler 会从 `retry_schedule.json`、
   durable retry state 和 `attempts.json` 恢复，到期 Attempt 已提交时不会重复 dispatch。
7. `require_attention` 表示 attempt、time 或 cost 预算耗尽。进入 Attention，按
   `inspect_node_attempt`、`fix_root_cause`、`increase_retry_budget` 或 `retry_manually`
   处理；同一 root cause 只保留一张卡，新 Attempt 会合并关联并重新打开已解决卡。
8. 凭证、权限、必需输入或 Artifact 缺失直接进入 `blocked` + Attention。若状态是
   `cancelled`、`aborted`、`unknown`、`dispatched_unknown` 或 `invalid_result`，系统也
   不会自动重派；先检查 dispatch intent 和外部回执，再决定人工恢复。
9. Gate 驳回和其他 P0 blocker 同时存在时，以全局 Attention 根因为主恢复路径；
   Scheduler 不会只显示 Gate 返工而隐藏凭证、输入或运行故障。进入具体 Gate 的 Node detail
   后仍可查看 `inspect_gate` / `create_rework`。
10. 旧版本 RetryState 首次读取时会迁移。若同一 Run 正在写入，接口返回
    `409 operation_in_progress`，等待当前写入完成后重试；不要手工修改 `retry_state.json`。
    旧 retry intent 缺少总预算 deadline 时由系统按首个 Attempt 自动补齐，unknown 状态仍需
    人工核对且不会再次派发。

默认自动 Attempt 总数不超过 3。策略只允许 fixed/exponential 退避，并拒绝负数、NaN、
Infinity 和无上限配置；默认和 legacy 节点的有限成本预算为 5，模板可显式覆盖。
当前版本不实现 Provider fallback。P7-07 已完成三家 Driver 工程接入，但三家凭证均缺失、
真实 smoke 未执行，保持 `configured_unverified`；本阶段不使用 OpenAI SDK 或 OpenAI 官方 API。

### 5.14 配置与检查模型 Provider

1. 仅在需要真实验证的机器上配置目标环境变量，例如：

   ```bash
   export DEEPSEEK_API_KEY='...'
   export MOONSHOT_API_KEY='...'
   export MINIMAX_API_KEY='...'
   ```

2. 启动 Sidecar 后访问 `GET http://127.0.0.1:4317/api/v0/providers`。未配置 Key 时为
   `missing_credential`，不会发送网络请求；配置 Key 但尚未完成真实验证时为
   `configured_unverified`。
3. 取得用户明确授权后，可对一个目标 Provider 执行脱敏 smoke：

   ```bash
   MIRACLE_ENABLE_MODEL_API=1 MIRACLE_SMOKE_PROVIDER=deepseek npm run smoke:provider
   ```

   可将 `deepseek` 替换为 `kimi` 或 `minimax`。Catalog 只接受合法 env 引用；smoke 在构造
   请求前严格解析 workspace 的 Model API manifest，并按 credential requirement 与 Provider
   scope 授权，跨 Provider 引用和 Driver 错配均零请求失败。

   显式设置 `MIRACLE_WORKSPACE_DIR` 时，Artifact 写入该目录的 `smoke-artifacts/`；未设置时，
   配置从内置 fixture workspace 读取，Artifact 写入系统临时目录安全创建的
   `miracle-provider-smoke-*` workspace，命令返回完整路径且不会污染 Git。如果 `TMPDIR`
   等环境配置把临时目录导向仓库内，系统会清理临时目录并在联网前拒绝。目标 Provider 只按
   `profile.provider` 匹配，不接受 Catalog ID 别名。目录、文件名和单次写入均有安全校验；
   输出、日志和回执不得含 API Key 或敏感正文。
4. 只有完成真实 health probe 与脱敏 completion 后，对应 Provider 才可标记 `healthy`。
   凭证存在、Profile 已配置或 fake-server 测试通过都不能替代该验证。Provider fallback 尚未
   实现，属于 P7-08。

## 6. 当前版本新增能力

| 范围 | 新增或优化 | 用户可感知变化 |
|---|---|---|
| P4 本地 MVP | Web、Sidecar、core、fixture workspace 形成可运行基线 | 用户可以本地启动并走通首页、Dry-run、Run、Attention、Agent、Artifact、Gate、Canvas |
| Run 工作区 | DAG、Node Detail、Attempt、Scheduler、事件审计 | 用户能看清任务执行到哪个节点、为何暂停、如何继续 |
| Retry 与恢复 | 到期排期、重启幂等、Attempt 历史、三类预算和根因 Attention | 用户能确认何时自动重试、预算为何停止，以及如何安全恢复 |
| P7-06 通用 Model API Adapter | 兼容协议 transport、ProviderProfile、usage/receipt、timeout/取消/大小/JSON 错误边界和 fake provider 契约 | 为三家已接入 Driver 提供共享调用层；不使用 OpenAI SDK 或官方 API |
| P7-07 Provider 接入 | DeepSeek/Kimi/MiniMax Driver、`GET /api/v0/providers`、显式 smoke 与安全路径 | 用户可检查凭证与验证状态；三家凭证均缺失、真实 smoke 未执行，均为 `configured_unverified`，不是 healthy |
| Gate 审核 | approve/reject/request_changes、返工版本、决策投影 | 用户能处理审核、创建返工版本，并保留审计证据 |
| Attention | 根因聚合和关联对象展开 | 用户能从异常直接定位 Agent、Node、Artifact、Gate |
| Artifact Board | Artifact detail 和本地预览 | 用户能查看产物版本、审核状态和预览内容 |
| Canvas 草稿 | Canvas node card 到 NodeSpec draft | 用户能把画布草稿发布为 draft WorkflowSpec |
| Task Baseline | 独立任务基线页面和 Git 同步状态 | 用户能看当前任务计划、证据文件和提交同步状态 |
| P5 真实工作流接入 | W24/W23 真实样本盘点、对象映射、历史 Run 只读导入方案 | 用户能知道真实工作流接入正在从历史 Run 只读展示开始 |
| 半自动新 Run 草案 | RunDraft、RunDraftDryRunPlan、LaunchConfirmation 和草案审计边界 | 用户后续可在不调用真实 Runner 的情况下准备、检查并确认一次新 Run |
| Codex 单节点真实执行 | confirmed RunDraft 原子转换、真实 CLI、Markdown 校验、Artifact、Gate、Trace 和取消 | 用户可通过实验模板执行第一条真实单节点链路；真实执行默认关闭并需显式 opt-in |
| P7-04 Codex Scheduler 连续执行 | 每 tick 重算 ExecutionPlan，只执行 `execute` 决策；Gate approve 后恢复下游，reject 不推进；计划和输入审计不含 Artifact 正文 | 用户可一次调用连续运行多个就绪节点，在 Gate 后审核并再次调度恢复 |
| P5 回归验收 | 工程测试、20 项 API smoke、真实样本复核和页面截图通过 | 当前运行版本仍是 v0.7.0；真实 importer、RunDraft 和 Adapter 留待 P6 实现 |
| P6 工程实施计划 | P6-02 至 P6-08 已拆成 historical importer、真实 Run UI、RunDraft、Adapter Contract、Codex CLI 和验收任务 | 用户可按任务基线查看实现顺序；该计划本身不代表功能上线 |
| P6-02 Historical Importer | 新增 W24/W23 preview/commit、事实型审核投影、内容指纹、可恢复并发锁、回执自愈、source_meta 和只读保护 | 用户可以通过 Sidecar API 在仓库外 runtime workspace 导入历史 Run；缺失审批证据不再显示为 approved，Web 展示和真实 Codex 调用尚未开放 |
| P6-08 / `v0.8.0` | historical importer、真实 Run UI、RunDraft、Codex 单节点执行全部通过统一验收 | 用户可从真实历史数据观察进入半自动新 Run 和人工 Gate；P6 最终边界见 54 号报告 |
| 操作手册 | 新增本文 | 用户不再只依赖提交文字，可以按手册启动、操作和理解版本变化 |

## 7. 相比上一版本的用户变化

本文建立后，Miracle 的版本感知方式从“只看提交说明”升级为“三层说明”：

| 层级 | 以前 | 现在 |
|---|---|---|
| 操作入口 | 分散在 README、交付说明和聊天记录中 | 统一进入本文 |
| 版本变化 | 主要看 Git commit 和 `VERSION_HISTORY.md` | 本文增加用户可感知变化和操作影响 |
| 任务进度 | 依靠路线图文字或聊天上下文 | `/task-baseline` 展示当前红点、Git 状态和证据文件 |
| 技术细节 | 需要阅读多份交付文档 | 手册先给操作路径，再指向对应文档 |
| 后续迭代 | 是否更新手册不固定 | 重要迭代必须同步手册或声明无操作变化 |

## 8. 版本对比和手册同步规则

### 8.1 每次重要更新必须回答的问题

| 问题 | 写入位置 |
|---|---|
| 本次升级新增了什么用户功能？ | 本文“当前版本新增能力”或对应版本小节 |
| 修复了什么用户可感知 bug？ | 本文“相比上一版本的用户变化”和 `VERSION_HISTORY.md` |
| 用户操作路径是否变化？ | 本文菜单、典型流程或故障恢复章节 |
| 启动命令、端口、环境变量是否变化？ | 本文“本地启动方式” |
| 是否影响 task-baseline 当前任务？ | `plans/mvp-task-baseline/roadmap.json` 和 `/task-baseline` |
| 是否只是内部实现变化？ | `VERSION_HISTORY.md` 说明“无操作变化”，本文可不扩写功能流程 |

### 8.2 版本对比矩阵模板

后续发布正式版本或阶段收口时，按下表补充：

| 版本或阶段 | 新增功能 | 优化点 | 修复问题 | 用户操作变化 | 是否影响启动 |
|---|---|---|---|---|---|
| `v0.7.0` | 本地 MVP 可运行闭环 | Run/Gate/Attention/Artifact/Canvas 可观察 | Dry-run、Canvas 草稿链路等问题已修复 | 需要通过 `npm run dev` 启动 Web + Sidecar | 否 |
| P5-01 至 P5-03 | 真实工作流接入计划、盘点、映射和历史导入方案 | 明确 W24/W23 样本边界 | 暂无用户界面 bug 修复 | 暂不新增 UI 操作，只影响后续真实导入理解 | 否 |
| 本手册创建 | 新增统一操作说明书 | 版本变化更易感知 | 解决“提交说明分散、用户不知道系统怎么用”的文档缺口 | 用户优先阅读本文 | 否 |
| P5-04 | 审核策略映射设计 | 明确 approval policy 到 Gate 模型和 F_final_render 待审边界 | 无用户界面 bug 修复 | 暂不新增 UI 操作，后续 P5-06 展示验收会使用该规则 | 否 |
| P5-05 | Trace 映射设计 | 明确 task_trace 到 NodeAttempt、task_events 到 TraceEvent 和 W23 缺 trace 降级规则 | 无用户界面 bug 修复 | 暂不新增 UI 操作，后续 P5-06 展示验收会使用该规则 | 否 |
| P5-06 | UI 展示验收方案 | 明确真实历史 Run 在 Run、DAG、Agent、Artifact、Gate、Attention 中的展示口径 | 无用户界面 bug 修复 | 暂不新增 UI 操作，作为后续 importer 和截图验收标准 | 否 |
| P6-02 | Historical Importer 与 Projection | 增加 allowlist、preview/commit、事实型审核投影、内容哈希幂等、可恢复并发锁、回执自愈、只读保护和 source confidence | 修复伪造 approved/decided、historical mutation、symlink 绕过、残留锁、错误 500、并发冲突、缺失回执、仓库污染和路径逃逸风险 | 新增 Sidecar API 操作及稳定 404/409/422 错误；P6-03 已补充 Web historical 展示 | 是，真实导入需设置仓库外 `MIRACLE_WORKSPACE_DIR` 和 `MIRACLE_IMPORT_ROOTS` |
| P6-03 | 真实 Run API 与 Web 展示 | Run 列表/详情增加 historical read-only、证据等级和来源缺口；Attention、Agent、Artifact、Gate 跟随选中 Run | 修复跨 Run 切换时旧 NodeRun/Artifact/Gate 请求、非 ASCII 产物路径导致 Artifact ID 重复 | 首页选择 W24/W23 后进入 Run、Attention、智能体、产物和审核页面；历史 Run 隐藏执行、调度、审核和返工操作 | 否，仍需使用仓库外 runtime workspace；截图证据见 `assets/reviews/p6-real-run-ui/` |
| P6-07 | Codex 单节点真实执行 | confirmed RunDraft 原子启动、受控 Codex 输出、真实 SHA-256、Operation 取消和 Gate 审计 | 修复非 Git attempt workspace 被 CLI 拒绝、结构化 schema 缺少类型导致真实执行失败、启动事务半成品及发布后崩溃重试产生重复 Run 的风险 | 新增“Codex 单节点 Markdown 母稿”模板和“启动正式 Run”；Run 页面展示真实 Adapter、operation、耗时与 Gate | 是，真实调用需设置 `MIRACLE_ENABLE_REAL_CODEX=1`，runtime 必须位于仓库外 |
| `v0.8.0` / P6-08 | 真实工作流工程接入基线 | W24/W23 historical、RunDraft、真实 Codex、46 项 API 和多 Domain 完整验收 | 修复长 Run/Node/Artifact ID 导致事件审计文本重叠 | 用户可导入真实历史 Run、创建并确认草案、执行 Codex 单节点并进入人工 Gate；下一步为 P7-01 | 启动命令不变；真实导入和执行仍需显式环境变量 |
| P7-02 / P7-03 / P7-04 | 多节点计划、Artifact 真实交接与连续调度 | 按端口、版本、hash 和 media type 解析输入；每 tick 重算 ExecutionPlan；Gate 暂停、批准恢复与拒绝阻断均有审计 | 修复路径逃逸、符号链接/硬链接、身份碰撞、部分提交、事件覆盖、运行锁抢占和 Gate 响应后锁残留风险 | 使用一次 Scheduler run 连续推进就绪节点，审核 Gate 后再次调度；审计不显示 Artifact 正文 | 启动命令不变；真实 Codex 仍需显式 opt-in |
| P7-05 | Retry 与故障恢复 | 错误分类、fixed/exponential 退避、attempt/time/cost 预算、NodeAttempt 历史、重启恢复和 Attention 动作 | 修复混合 Gate/P0 blocker 被 Gate 动作遮蔽、legacy RetryState 锁竞争 500、旧 retry intent 重复 unknown 不稳定，以及并发读取 NodeRun 时偶发空 JSON | 在 Node detail 查看 retry 状态和预算；全局混合阻塞先处理 Attention，Gate 返工仍在节点详情可达 | 启动命令不变；`dispatched_unknown` 不会自动重派 |
| P7-06 | 通用 Model API Adapter | `model-api` kind、兼容协议 transport、ProviderProfile、usage/receipt、稳定错误和 fake provider 测试契约 | 凭证仅通过运行时引用传递，不会进入 profile、回执或错误 | 暂无新增 UI；后续 Provider Driver 可复用此契约 | 启动命令不变；不使用 OpenAI SDK 或官方 API |
| P7-07 | DeepSeek/Kimi/MiniMax Provider Driver | 三家 Driver、Profile、`GET /api/v0/providers`、错误合同和安全 smoke 路径 | MiniMax `base_resp` 最小兼容检查、未知 Driver 拒绝且无 fallback | 新增 Provider 配置、状态检查与显式 smoke 操作 | 需设置对应 Key 且显式 `MIRACLE_ENABLE_MODEL_API=1`；本轮三家凭证均缺失、真实 smoke 未执行，均非 healthy |

### 8.3 提交前同步检查

重要迭代提交前至少检查：

1. `VERSION_HISTORY.md` 是否记录本次重要变化。
2. 本文是否需要更新启动、菜单、操作流程、故障恢复或版本对比。
3. `README.md` 是否有新文档入口。
4. `17_文档资产关联与AI阅读导航.md` 是否登记新文档状态和阅读路径。
5. `plans/mvp-task-baseline/roadmap.json` 是否同步当前任务节点和证据文件。
6. 如果启动过 Sidecar，刷新 `/task-baseline` 确认 Git HEAD 和证据文件状态。

## 9. 常见问题与恢复动作

| 问题 | 现象 | 处理方式 |
|---|---|---|
| Sidecar 未启动 | Web 页面报 API 请求失败，`/api/v0/health` 无响应 | 执行 `npm run dev:sidecar` 或 `npm run dev` |
| Sidecar 提示 workspace 已被占用 | 启动日志显示 active 或 stale `sidecar.instance.lock` | 先确认没有其他 Sidecar 使用该 workspace；仅在确认 owner PID 已退出后，人工删除 `<workspace>/locks/sidecar.instance.lock` 再启动 |
| Web 端口被占用 | Vite 终端提示端口变化 | 优先释放端口并使用 `5174`；如端口变化，需确认 API proxy 和 Sidecar CORS |
| task-baseline 没更新 | 页面仍显示旧 Git HEAD 或旧任务红点 | 刷新页面；确认 `plans/mvp-task-baseline/roadmap.json` 已保存并提交 |
| 工作区有未提交修改 | task-baseline 显示 dirty | 执行 `git status --short`，确认是否为本轮预期变更 |
| Dry-run 提示凭证缺失 | 风险或 adapter routing 显示 missing credential | 设置对应环境变量，或在当前 MVP 中保留为 blocked/风险演示 |
| Scheduler 不继续推进 | Run 停在 pending_review Gate 或失败节点 | 先处理 Gate 审核或 Attention 根因，再重新调度 |
| Retry 未立即执行 | Node detail 显示 `schedule_retry` 且 `scheduled_for` 尚未到期 | 等待到期后再次调度；不要删除 Attempt 或重复创建 operation |
| Retry 停止并出现 Attention | Node detail 显示 attempt/time/cost budget exhausted | 检查失败 Attempt 和根因，按安全动作调整预算或人工重试 |
| RetryState 读取返回 409 | 同一 Run 正在写入，旧 RetryState 等待迁移 | 等待当前操作完成后重试；不要删除 lock 或手工改状态文件 |
| 派发状态未知 | dispatch intent 为 `dispatched_unknown` 或 `invalid_result` | 先核对外部回执和 intent；系统按设计不会自动重派 |
| Gate 不能创建返工 | 按钮不可用或接口返回冲突 | 只有已 `reject` 或 `request_changes` 的 Gate 可以创建返工 |
| Artifact 不可预览 | 预览区域显示 missing、binary 或路径拒绝 | 检查 ArtifactManifest 路径、文件是否存在、是否在 workspace 内 |
| 真实工作流没有进入 UI | 检查首页“继续运行”是否出现 `content-production-real-v0` | 确认 Sidecar 使用同一个包含 historical Run 的 runtime workspace，并刷新页面；W24/W23 页面应显示 `Historical · Read-only` |
| 启动正式 Run 返回 adapter_not_ready | RunDraft 保持 confirmed，没有创建正式 Run | 确认设置 `MIRACLE_ENABLE_REAL_CODEX=1`，再检查 `/api/v0/adapters/codex-cli/health`、`codex --version` 和 `codex login status` |
| Codex Run 执行失败但没有 Artifact | NodeAttempt 为 failed/aborted，Attention 出现执行失败 | 查看 Attempt error code 和事件审计；修复 CLI、schema 或输出问题后创建新草案重试，系统不会提交未校验产物 |
| Provider 显示 `missing_credential` | `GET /api/v0/providers` 未发现对应 Key | 在运行 Sidecar 的环境设置对应 API Key 后重启或刷新；不要把 Key 写入 Profile、日志或 Git |
| Provider 显示 `configured_unverified` | Key 已配置但尚未完成真实验证 | 取得明确授权后运行单 Provider 脱敏 smoke；未完成真实 health/completion 前不得改为 healthy |

## 10. 当前限制

当前版本仍有明确边界：

1. 真实“热点工具更新”历史 Run importer 已实现 Sidecar API，Web 已支持 W24/W23 historical Run
   只读展示，但仍需使用仓库外 runtime workspace 才能看到真实导入数据。
2. Codex CLI 已开放按 ExecutionPlan 的多节点连续调度、Gate 暂停/批准恢复和显式 failed
   的限次 retry；DeepSeek/Kimi/MiniMax Driver 已开放工程接入，但本轮三家凭证缺失、真实
   smoke 未执行，均为 `configured_unverified`。Provider fallback、Hermes 和 OpenClaw 尚未实现。
3. 没有云端控制平面、多租户、账号、权限、计费和团队协作。
4. 没有移动端或 APP 适配，本阶段只面向 Web 工作台。
5. Infinite Canvas 仍是草稿态，不是完整自由画布产品。
6. Spec Sync 和 Evolution Board 目前是入口占位。
7. Miracle 仓库只管理 `/Users/zhangyue/miracle-agent`；其他项目或 Gitee 仓库不属于本文提交范围。

## 11. 后续手册维护策略

从本文建立后，后续重要迭代按以下规则维护：

| 变更类型 | 是否必须更新本文 | 说明 |
|---|---|---|
| 新增或删除菜单 | 必须 | 更新“当前菜单和功能说明” |
| 页面操作路径变化 | 必须 | 更新“典型操作流程” |
| 启动命令、端口、环境变量变化 | 必须 | 更新“本地启动方式” |
| 用户可感知 bug 修复 | 必须 | 更新“相比上一版本的用户变化” |
| 新增重要能力但暂不暴露 UI | 建议 | 写清“当前不可操作，后续进入 UI” |
| 纯内部重构且无操作影响 | 可不扩写 | 但 `VERSION_HISTORY.md` 应说明“无操作变化” |
| 任务计划推进 | 视情况 | task-baseline 必须更新，本文只在影响用户理解时更新 |

## 12. 相关入口

| 入口 | 用途 |
|---|---|
| `README.md` | 项目总入口和文档目录 |
| `17_文档资产关联与AI阅读导航.md` | 判断哪些文档该读，哪些历史文档可跳过 |
| `VERSION_HISTORY.md` | 系统版本演进记录 |
| `07_后续对接路线图与任务拆解.md` | 阶段路线图和任务拆解 |
| `plans/mvp-task-baseline/README.md` | 任务基线页面说明 |
| `plans/mvp-task-baseline/roadmap.json` | 任务基线机器数据 |
| `http://127.0.0.1:4317/task-baseline` | 本地任务基线页面 |
| `http://127.0.0.1:5174/` | 本地 Web 工作台 |

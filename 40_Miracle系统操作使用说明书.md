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
| 当前产品版本 | `v0.7.0` |
| 当前工程形态 | React Web + Node.js Local Sidecar + packages/core + fixture workspace |
| 当前阶段 | P5 真实工作流接入 |
| 当前任务焦点 | `P5-07` 半自动新 Run 草案 |
| 已完成 P5 任务 | `P5-01` 真实工作区盘点、`P5-02` Flow A-G 对象映射、`P5-03` 历史 Run 只读导入方案、`P5-04` 审核策略映射、`P5-05` Trace 映射、`P5-06` UI 展示验收方案 |
| 本地 workspace 默认目录 | `fixtures/mvp-workspace/.miracle` |
| 任务基线数据 | `plans/mvp-task-baseline/roadmap.json` |

当前阶段要点：

- P4 已形成本地 MVP 验收基线，核心页面和 Sidecar API 可运行。
- P5 正在把真实“热点工具更新”工作流接入 Miracle。
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
3. 打开 `http://127.0.0.1:4317/task-baseline`，确认当前红点为 P5 当前任务。
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

## 6. 当前版本新增能力

| 范围 | 新增或优化 | 用户可感知变化 |
|---|---|---|
| P4 本地 MVP | Web、Sidecar、core、fixture workspace 形成可运行基线 | 用户可以本地启动并走通首页、Dry-run、Run、Attention、Agent、Artifact、Gate、Canvas |
| Run 工作区 | DAG、Node Detail、Attempt、Scheduler、事件审计 | 用户能看清任务执行到哪个节点、为何暂停、如何继续 |
| Gate 审核 | approve/reject/request_changes、返工版本、决策投影 | 用户能处理审核、创建返工版本，并保留审计证据 |
| Attention | 根因聚合和关联对象展开 | 用户能从异常直接定位 Agent、Node、Artifact、Gate |
| Artifact Board | Artifact detail 和本地预览 | 用户能查看产物版本、审核状态和预览内容 |
| Canvas 草稿 | Canvas node card 到 NodeSpec draft | 用户能把画布草稿发布为 draft WorkflowSpec |
| Task Baseline | 独立任务基线页面和 Git 同步状态 | 用户能看当前任务计划、证据文件和提交同步状态 |
| P5 真实工作流接入 | W24/W23 真实样本盘点、对象映射、历史 Run 只读导入方案 | 用户能知道真实工作流接入正在从历史 Run 只读展示开始 |
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
| Web 端口被占用 | Vite 终端提示端口变化 | 优先释放端口并使用 `5174`；如端口变化，需确认 API proxy 和 Sidecar CORS |
| task-baseline 没更新 | 页面仍显示旧 Git HEAD 或旧任务红点 | 刷新页面；确认 `plans/mvp-task-baseline/roadmap.json` 已保存并提交 |
| 工作区有未提交修改 | task-baseline 显示 dirty | 执行 `git status --short`，确认是否为本轮预期变更 |
| Dry-run 提示凭证缺失 | 风险或 adapter routing 显示 missing credential | 设置对应环境变量，或在当前 MVP 中保留为 blocked/风险演示 |
| Scheduler 不继续推进 | Run 停在 pending_review Gate 或失败节点 | 先处理 Gate 审核或 Attention 根因，再重新调度 |
| Gate 不能创建返工 | 按钮不可用或接口返回冲突 | 只有已 `reject` 或 `request_changes` 的 Gate 可以创建返工 |
| Artifact 不可预览 | 预览区域显示 missing、binary 或路径拒绝 | 检查 ArtifactManifest 路径、文件是否存在、是否在 workspace 内 |
| 真实工作流没有进入 UI | P5 当前仍是计划、导入方案和展示验收口径阶段 | 等 P5 importer 实现后再进行真实历史 Run 的页面截图验收 |

## 10. 当前限制

当前版本仍有明确边界：

1. 真实“热点工具更新”历史 Run importer 尚未实现，P5-03 只是只读导入方案。
2. 当前 Runner 仍以 mock/local 协议为主，不调用真实 Codex/Hermes/OpenClaw 执行链路。
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

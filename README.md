# Miracle 奇迹系统

> 项目定位：Miracle 是一套“超级智能体控制平面 + 工作流操作系统”，用于统一管理多 Agent 协同、工作流编排、组件库、AI 能力来源、任务执行链路、产物资产和智能进化闭环。

## 当前阶段

P0/P1.5 和四轮架构评审已经完成；P2 产品信息架构、Web 工作台原型和
`P2F-07 Agent Collaboration` 已完成评审。当前结论是 P2 原型完全通过，P3 已完成
Run 冻结对象、审核真相、AdapterResult、EdgeSpec join_policy、启动 Run API 和
Gate Detail API 的一致性修订。P4 第一轮已落地可运行 MVP 主链路，第二轮已补充
React Flow DAG、Artifact Detail 预览、Gate 决策投影和 Infinite Canvas 草稿态，第三轮已补充
Sidecar API 集成测试、Runner/Adapter 最小协议和 Mock Runner 单节点执行闭环，第四轮已补充
Gate 决策真实推进、Run 页面执行 UI、Canvas 发布 Workflow draft 和 Adapter 插件壳。
P4 第五轮已开始执行能力补齐，D3 Gate reject 返工模型已落地，支持返工 attempt、
新 Artifact version、新 GateInstance 和下游恢复规则；D4 Gate 返工 UI 与事件审计已接入
Web 工作台；D5 最小 scheduler 设计与 tick 接口、D6 scheduler 连续推进、Gate 暂停和
失败 Attention、D7 Adapter 插件目录实体化已完成。D8 Canvas 新增节点生成 NodeSpec
draft 与 D9 Web run refresh/polling 已落地，D10 MVP 回归验收与版本收口已通过，
当前形成 `v0.7.0` 本地 MVP 验收基线。P5 真实工作流接入设计与阶段验收已完成，
`P5-01` 真实工作区盘点、`P5-02` Flow A-G 对象映射、`P5-03` 历史 Run
只读导入方案、`P5-04` 审核策略映射、`P5-05` Trace 映射和 `P5-06`
UI 展示验收方案、`P5-07` 半自动新 Run 草案设计、`P5-08` 首个真实 Adapter
边界评估和 `P5-09` 回归验收均已完成。P5 形成真实工作流接入设计基线，首接推荐
Codex CLI Adapter。`P6-01` 工程实施计划、`P6-02` Historical Importer 与 Projection 和
`P6-04` 至 `P6-06` 已完成；当前主线进入 `P6-07` C_md_master 单节点真实执行。
当前工程入口为 `apps/web`、`apps/sidecar`、`packages/core` 和
`fixtures/mvp-workspace/.miracle`。

P3 的核心原则：Miracle 是通用 Agent OS，不绑定资讯内容生产；`content-production`
只是第一个样本 Domain。Node.js 本地服务只作为 MVP Local Sidecar，不是商业化云端主
后端的最终限定。

1. 多 Agent 协同可视化。
2. 工作流流程节点编排。
3. 类 Lovart 的无限画布式编排。

## 文档导航

先阅读 [17_文档资产关联与AI阅读导航.md](docs/00-navigation/asset-index/17_文档资产关联与AI阅读导航.md)，再按任务选择
最小必要文档集。该文件标记了文档依赖、当前有效结果、历史过程资产和 AI 可跳过内容。

默认规则：

- `16_融合` 是当前产品方案。
- `15` 系列是历史架构评审过程，采纳项已回写，AI 默认跳过。
- 原始 `16` 与 `16_abtest` 是已被融合的候选过程，AI 默认跳过。
- 需要追溯决策过程时，再按依赖顺序补读历史文档。

## 文档目录

详细目录、中文目录对照、每类文档的概念设计和设计原因，统一见 [docs/README.md](docs/README.md)。

常用入口：

- [17_文档资产关联与AI阅读导航.md](docs/00-navigation/asset-index/17_文档资产关联与AI阅读导航.md)：当前有效产物、历史过程产物和 AI 最小阅读路径。
- [07_后续对接路线图与任务拆解.md](docs/01-strategy/roadmap/07_后续对接路线图与任务拆解.md)：阶段路线和任务基线对应关系。
- [14_技术架构选型与系统架构图.md](docs/02-architecture/system/14_技术架构选型与系统架构图.md)：技术选型和系统架构基线。
- [16_融合_产品信息架构与设计图规划.md](docs/03-product/information-architecture/16_融合_产品信息架构与设计图规划.md)：当前产品信息架构和 Web 交互基线。
- [47_P6真实工作流工程实施计划与任务拆解.md](docs/05-delivery/p6-engineering/47_P6真实工作流工程实施计划与任务拆解.md)：当前工程实施计划。
- [40_Miracle系统操作使用说明书.md](docs/06-operations/user-guide/40_Miracle系统操作使用说明书.md)：启动、菜单操作、版本变化和常见问题。

目录约定：

- `01-strategy` 到 `06-operations`：当前有效的战略、架构、产品、工程、交付和运维资料。
- `90-reference`：外部研究和参考输入，不替代当前架构真相。
- `99-archive`：历史评审和候选方案，默认可跳过。

`00-52` 编号继续保留在文件名中，用于阶段追溯；目录只负责按内容领域组织，不替代文档状态。

`prototypes/`、`assets/`、`fixtures/`、`apps/`、`packages/` 和 `plans/` 保持为工程或资产目录，不与设计说明 Markdown 混放。

## 原型资产目录说明

- `prototypes/p2/`：P2 原型说明、评审表、对比结论和 Pencil 可编辑源文件。
- `prototypes/p2/product-design/README.md`：Product Design 三个视觉方向说明。
- `prototypes/p2/pencil/README.md`：Pencil 六页低保真原型说明和源文件入口。
- `prototypes/p2/fusion-clickable/`：P2 Web 工作台代码级可点击原型。
- `assets/prototypes/product-design/`：Product Design A/B/C 三张视觉候选图片。
- `assets/prototypes/pencil/`：Pencil `P2F-01` 到 `P2F-06` 六页导出图片。
- `assets/prototypes/fusion-clickable/`：融合版 Web 工作台原型桌面截图。
- `assets/reviews/p2-prototype-audit/`：P2 Web 原型评审截图证据。
- `assets/reviews/p4-mvp/`：P4 D10 MVP 回归验收截图证据。

当前 Product Design A/B/C 固定映射：

- A 用于首页：[assets/prototypes/fusion-clickable/home-desktop.png](assets/prototypes/fusion-clickable/home-desktop.png)
- B 用于 Run 工作区：[assets/prototypes/fusion-clickable/run-desktop.png](assets/prototypes/fusion-clickable/run-desktop.png)
- C 的根因联动用于 Attention：[assets/prototypes/fusion-clickable/attention-desktop.png](assets/prototypes/fusion-clickable/attention-desktop.png)
- P2F-07 Agent Collaboration 用于多 Agent 协同补充：[assets/prototypes/fusion-clickable/agent-collaboration-desktop.png](assets/prototypes/fusion-clickable/agent-collaboration-desktop.png)

快速评审 Web 工作台原型时，优先阅读
[prototypes/p2/03_融合版原型决策与验收说明.md](prototypes/p2/03_融合版原型决策与验收说明.md)，
再阅读 [18_P2原型评审纪要与修订清单.md](docs/05-delivery/p2-prototype/18_P2原型评审纪要与修订清单.md)，
并运行 [prototypes/p2/fusion-clickable/](prototypes/p2/fusion-clickable/)。

进入 P3 技术详细设计时，优先阅读：

1. [19_P3技术详细设计总纲与扩展性原则.md](docs/04-engineering/p3-detailed-design/19_P3技术详细设计总纲与扩展性原则.md)
2. [20_P3核心数据模型与领域扩展设计.md](docs/04-engineering/data-model/20_P3核心数据模型与领域扩展设计.md)
3. [21_P3本地服务API与后端演进设计.md](docs/04-engineering/api/21_P3本地服务API与后端演进设计.md)
4. [22_P3前端架构与工作台状态设计.md](docs/04-engineering/p3-detailed-design/22_P3前端架构与工作台状态设计.md)
5. [23_P3MVP任务拆解与验收计划.md](docs/04-engineering/p3-detailed-design/23_P3MVP任务拆解与验收计划.md)

当前融合原则：Product Design 主导最终界面的视觉方向、布局体验和交互重心；Pencil
用于校验六页任务闭环、对象语义、状态归属和审核安全边界，不作为最终视觉主方案。
当前阶段只验证 Web 工作台交互，APP/移动端兼容模式后续单独设计。

## P4 MVP 启动

完整操作说明优先阅读
[40_Miracle系统操作使用说明书.md](docs/06-operations/user-guide/40_Miracle系统操作使用说明书.md)。README 只保留最短启动入口。

```bash
npm_config_cache=.npm-cache npm install
npm run dev
```

如只需要访问独立任务基线看板，可只启动 Sidecar：

```bash
npm run dev:sidecar
```

默认地址：

```text
Web:     http://127.0.0.1:5174/
Sidecar: http://127.0.0.1:4317/api/v0/health
```

独立任务基线看板：

```text
页面:    http://127.0.0.1:4317/task-baseline
数据:    plans/mvp-task-baseline/roadmap.json
API:     http://127.0.0.1:4317/api/v0/project/roadmap
```

## 版本记录要求

项目统一通过 `VERSION_HISTORY.md` 维护系统演进历史。完成重要阶段、完整模块、核心协议
调整或兼容性变化时，必须同步记录版本号、变更文件数量、详细内容、验证结果和里程碑；
普通修订可归并到当前版本的修订记录，不单独制造大版本。

用户可感知的菜单、启动方式、操作流程、功能变化和 bug 修复，必须同步更新
`docs/06-operations/user-guide/40_Miracle系统操作使用说明书.md`；如果本次更新没有用户操作影响，应在
`VERSION_HISTORY.md` 中说明“无操作变化”。

## 文档治理要求

新增重要 Markdown 时必须同步更新：

1. `README.md`。
2. `docs/00-navigation/asset-index/17_文档资产关联与AI阅读导航.md`。
3. 影响阶段时更新 `docs/01-strategy/roadmap/07_后续对接路线图与任务拆解.md`。
4. 构成重要更新时更新 `VERSION_HISTORY.md`。
5. 影响用户操作或版本感知时更新 `docs/06-operations/user-guide/40_Miracle系统操作使用说明书.md`。

评审或候选文档完成收口后，应标记为历史过程资产，并明确当前有效结果，避免 AI 重复
读取旧文档。

## 第一条落地样本

Miracle 的第一条真实工作流样本是现有“热点工具更新”内容生产系统：

```text
Flow A 情报采集与事实核验
-> Flow B 内容 MD 母稿
-> Flow C0 脚本池生成与评审
-> Flow C PPT/分镜
-> Flow D TTS/字幕
-> Flow E HyperFrames 视觉视频
-> Flow F 音画整合与最终渲染
-> Flow G 分发复盘
```

该样本用于验证 Miracle 对真实内容生产、多 Agent 协同、审核门、任务 trace、媒体产物和复盘进化的抽象能力。

## 参考架构方向

- OpenClaw：gateway、session、routing、channel、control UI。
- Hermes Agent：长期记忆、技能进化、MCP、跨平台消息入口。
- Claude Code：subagents、skills、dynamic workflows、hooks、agent teams。
- Codex：CLI、MCP、subagents、approval、hosted tools、multi-agent 元数据。

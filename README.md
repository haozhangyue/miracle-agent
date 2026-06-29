# Miracle 奇迹系统

> 项目定位：Miracle 是一套“超级智能体控制平面 + 工作流操作系统”，用于统一管理多 Agent 协同、工作流编排、组件库、AI 能力来源、任务执行链路、产物资产和智能进化闭环。

## 当前阶段

P0/P1.5 和四轮架构评审已经完成；P2 产品信息架构、Web 工作台原型和
`P2F-07 Agent Collaboration` 已完成评审。当前结论是 P2 原型完全通过，P3 已完成
Run 冻结对象、审核真相、AdapterResult、EdgeSpec join_policy、启动 Run API 和
Gate Detail API 的一致性修订。P4 第一轮已落地可运行 MVP 主链路，新增
`apps/web`、`apps/sidecar`、`packages/core` 和 `fixtures/mvp-workspace/.miracle`。

P3 的核心原则：Miracle 是通用 Agent OS，不绑定资讯内容生产；`content-production`
只是第一个样本 Domain。Node.js 本地服务只作为 MVP Local Sidecar，不是商业化云端主
后端的最终限定。

1. 多 Agent 协同可视化。
2. 工作流流程节点编排。
3. 类 Lovart 的无限画布式编排。

## 文档导航

先阅读 [17_文档资产关联与AI阅读导航.md](17_文档资产关联与AI阅读导航.md)，再按任务选择
最小必要文档集。该文件标记了文档依赖、当前有效结果、历史过程资产和 AI 可跳过内容。

默认规则：

- `16_融合` 是当前产品方案。
- `15` 系列是历史架构评审过程，采纳项已回写，AI 默认跳过。
- 原始 `16` 与 `16_abtest` 是已被融合的候选过程，AI 默认跳过。
- 需要追溯决策过程时，再按依赖顺序补读历史文档。

## 文档目录

| 状态 | 文档 | 用途 |
|---|---|---|
| `CURRENT` | [17_文档资产关联与AI阅读导航.md](17_文档资产关联与AI阅读导航.md) | 文档依赖、有效性、取代关系和 AI 阅读路由 |
| `ACTIVE` | [00_Miracle奇迹系统总体规划设计.md](00_Miracle奇迹系统总体规划设计.md) | 完整总纲、系统定位和分层架构 |
| `ACTIVE` | [01_核心架构与对象模型.md](01_核心架构与对象模型.md) | Workflow、Node、Agent、Provider、Trace 类型 |
| `ACTIVE` | [02_组件库与插件体系设计.md](02_组件库与插件体系设计.md) | tool、skill、MCP、provider 和 API 组合 |
| `ACTIVE` | [03_智能路由与工作流编排设计.md](03_智能路由与工作流编排设计.md) | 路由、子工作流、DAG 和执行策略 |
| `ACTIVE` | [04_多Agent协同与可视化设计.md](04_多Agent协同与可视化设计.md) | Agent Map、时间线和依赖图 |
| `ACTIVE` | [05_双模式工作流可视化编排设计.md](05_双模式工作流可视化编排设计.md) | 无限画布、节点模式和双视图同步 |
| `ACTIVE` | [06_智能进化体系设计.md](06_智能进化体系设计.md) | 记忆、复盘、评估和进化建议 |
| `REFERENCE` | [07_后续对接路线图与任务拆解.md](07_后续对接路线图与任务拆解.md) | 当前阶段、后续路线和任务拆解 |
| `REFERENCE` | [08_Miracle竞品分析与架构借鉴报告.md](08_Miracle竞品分析与架构借鉴报告.md) | 竞品输入，默认可跳过 |
| `ACTIVE` | [09_WorkflowSpec与Registry技术草案.md](09_WorkflowSpec与Registry技术草案.md) | WorkflowSpec、Registry、validate 和 dry-run |
| `ACTIVE` | [10_AgentHealth与多Agent状态机设计.md](10_AgentHealth与多Agent状态机设计.md) | AgentHealth、权限和状态机 |
| `ACTIVE` | [11_VisualBuilder与Spec双向同步设计.md](11_VisualBuilder与Spec双向同步设计.md) | Visual/Spec 双向同步 |
| `ACTIVE` | [12_MVP原型功能清单与界面草图.md](12_MVP原型功能清单与界面草图.md) | MVP 功能和原型验收 |
| `ACTIVE` | [13_P0架构评审纪要与决策清单.md](13_P0架构评审纪要与决策清单.md) | P0 决策和阶段边界 |
| `ACTIVE` | [14_技术架构选型与系统架构图.md](14_技术架构选型与系统架构图.md) | 当前技术架构基线 |
| `HISTORICAL` | [15_架构方案评审意见.md](15_架构方案评审意见.md) | 第一次架构评审过程，默认跳过 |
| `HISTORICAL` | [15-2_架构方案二次评审意见.md](15-2_架构方案二次评审意见.md) | 第二次架构评审过程，默认跳过 |
| `HISTORICAL` | [15-3_架构方案第三次评审意见.md](15-3_架构方案第三次评审意见.md) | 第三次架构评审过程，默认跳过 |
| `HISTORICAL` | [15-4_架构方案第四次评审意见.md](15-4_架构方案第四次评审意见.md) | 第四次架构评审过程，默认跳过 |
| `HISTORICAL` | [16_产品信息架构与设计图规划.md](16_产品信息架构与设计图规划.md) | 产品 IA 初版，已被融合版取代 |
| `HISTORICAL` | [16_abtest_产品信息架构与设计图规划.md](16_abtest_产品信息架构与设计图规划.md) | A/B 候选方案，已被融合版吸收 |
| `CURRENT` | [16_融合_产品信息架构与设计图规划.md](16_融合_产品信息架构与设计图规划.md) | 当前有效的 P2 产品方案 |
| `CURRENT` | [prototypes/p2/00_双轨原型共同设计简报.md](prototypes/p2/00_双轨原型共同设计简报.md) | Product Design 与 Pencil 的共同原型输入 |
| `CURRENT` | [prototypes/p2/product-design/README.md](prototypes/p2/product-design/README.md) | 三个 Product Design 视觉候选 |
| `CURRENT` | [prototypes/p2/pencil/README.md](prototypes/p2/pencil/README.md) | 六页 Pencil 原型、源文件和导出图 |
| `CURRENT` | [prototypes/p2/01_双轨原型评审表.md](prototypes/p2/01_双轨原型评审表.md) | 人工评审评分与任务走查模板 |
| `CURRENT` | [prototypes/p2/02_双轨原型初步对比结论.md](prototypes/p2/02_双轨原型初步对比结论.md) | 人工选择结果和融合建议 |
| `CURRENT` | [prototypes/p2/03_融合版原型决策与验收说明.md](prototypes/p2/03_融合版原型决策与验收说明.md) | Product Design A/B/C Web-only 决策和验收口径 |
| `CURRENT` | [prototypes/p2/fusion-clickable/README.md](prototypes/p2/fusion-clickable/README.md) | P2 Web 工作台可点击原型入口 |
| `CURRENT` | [18_P2原型评审纪要与修订清单.md](18_P2原型评审纪要与修订清单.md) | P2 Web 原型评审结论、修订清单和 P2/P3 分界 |
| `CURRENT` | [19_P3技术详细设计总纲与扩展性原则.md](19_P3技术详细设计总纲与扩展性原则.md) | P3 总纲、通用 Agent OS 和扩展性原则 |
| `CURRENT` | [20_P3核心数据模型与领域扩展设计.md](20_P3核心数据模型与领域扩展设计.md) | DomainPack、RoleProfile、Workflow、Run、Artifact、Attention 通用模型 |
| `CURRENT` | [21_P3本地服务API与后端演进设计.md](21_P3本地服务API与后端演进设计.md) | Local Sidecar API、Cloud Control Plane 和 Worker 演进 |
| `CURRENT` | [22_P3前端架构与工作台状态设计.md](22_P3前端架构与工作台状态设计.md) | 前端路由、页面状态、RoleProfile 和 DomainPack UI 扩展 |
| `CURRENT` | [23_P3MVP任务拆解与验收计划.md](23_P3MVP任务拆解与验收计划.md) | MVPS01-MVPS10 工程任务、验收和测试计划 |
| `CURRENT` | [24_P4_MVP可运行主链路交付说明.md](24_P4_MVP可运行主链路交付说明.md) | P4 第一轮 MVP 工程、启动方式、验证结果和后续建议 |
| `REFERENCE` | [VERSION_HISTORY.md](VERSION_HISTORY.md) | 系统版本和里程碑历史 |

## 原型资产目录说明

- `prototypes/p2/`：P2 原型说明、评审表、对比结论和 Pencil 可编辑源文件。
- `prototypes/p2/product-design/README.md`：Product Design 三个视觉方向说明。
- `prototypes/p2/pencil/README.md`：Pencil 六页低保真原型说明和源文件入口。
- `prototypes/p2/fusion-clickable/`：P2 Web 工作台代码级可点击原型。
- `assets/prototypes/product-design/`：Product Design A/B/C 三张视觉候选图片。
- `assets/prototypes/pencil/`：Pencil `P2F-01` 到 `P2F-06` 六页导出图片。
- `assets/prototypes/fusion-clickable/`：融合版 Web 工作台原型桌面截图。
- `assets/reviews/p2-prototype-audit/`：P2 Web 原型评审截图证据。

当前 Product Design A/B/C 固定映射：

- A 用于首页：[assets/prototypes/fusion-clickable/home-desktop.png](assets/prototypes/fusion-clickable/home-desktop.png)
- B 用于 Run 工作区：[assets/prototypes/fusion-clickable/run-desktop.png](assets/prototypes/fusion-clickable/run-desktop.png)
- C 的根因联动用于 Attention：[assets/prototypes/fusion-clickable/attention-desktop.png](assets/prototypes/fusion-clickable/attention-desktop.png)
- P2F-07 Agent Collaboration 用于多 Agent 协同补充：[assets/prototypes/fusion-clickable/agent-collaboration-desktop.png](assets/prototypes/fusion-clickable/agent-collaboration-desktop.png)

快速评审 Web 工作台原型时，优先阅读
[prototypes/p2/03_融合版原型决策与验收说明.md](prototypes/p2/03_融合版原型决策与验收说明.md)，
再阅读 [18_P2原型评审纪要与修订清单.md](18_P2原型评审纪要与修订清单.md)，
并运行 [prototypes/p2/fusion-clickable/](prototypes/p2/fusion-clickable/)。

进入 P3 技术详细设计时，优先阅读：

1. [19_P3技术详细设计总纲与扩展性原则.md](19_P3技术详细设计总纲与扩展性原则.md)
2. [20_P3核心数据模型与领域扩展设计.md](20_P3核心数据模型与领域扩展设计.md)
3. [21_P3本地服务API与后端演进设计.md](21_P3本地服务API与后端演进设计.md)
4. [22_P3前端架构与工作台状态设计.md](22_P3前端架构与工作台状态设计.md)
5. [23_P3MVP任务拆解与验收计划.md](23_P3MVP任务拆解与验收计划.md)

当前融合原则：Product Design 主导最终界面的视觉方向、布局体验和交互重心；Pencil
用于校验六页任务闭环、对象语义、状态归属和审核安全边界，不作为最终视觉主方案。
当前阶段只验证 Web 工作台交互，APP/移动端兼容模式后续单独设计。

## P4 MVP 启动

```bash
npm_config_cache=.npm-cache npm install
npm run dev
```

默认地址：

```text
Web:     http://127.0.0.1:5174/
Sidecar: http://127.0.0.1:4317/api/v0/health
```

## 版本记录要求

项目统一通过 `VERSION_HISTORY.md` 维护系统演进历史。完成重要阶段、完整模块、核心协议
调整或兼容性变化时，必须同步记录版本号、变更文件数量、详细内容、验证结果和里程碑；
普通修订可归并到当前版本的修订记录，不单独制造大版本。

## 文档治理要求

新增重要 Markdown 时必须同步更新：

1. `README.md`。
2. `17_文档资产关联与AI阅读导航.md`。
3. 影响阶段时更新 `07_后续对接路线图与任务拆解.md`。
4. 构成重要更新时更新 `VERSION_HISTORY.md`。

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

# Miracle 文档目录设计与迁移映射

> 文档状态：已落地目录索引。
>
> 本文件定义 Miracle 文档的目录、中文显示名称、文档职责和迁移映射。00-57 文档已按
> 内容领域完成迁移，链接、阅读导航和版本记录已同步；文档有效性仍由 17 号导航维护。

## 1. 设计目标

Miracle 文档从“按生成时间连续编号”升级为“按内容领域组织、按阶段编号追溯、按状态
导航”的三层结构：

1. 内容领域决定文档放在哪里，解决用户找不到资料的问题。
2. 原有 `00-57` 编号保留在文件名中，解决阶段顺序和 Git 历史追溯问题。
3. `17_文档资产关联与AI阅读导航.md` 继续维护 `CURRENT / ACTIVE / REFERENCE /
   HISTORICAL` 状态，目录位置不再承担全部状态语义。
4. 根目录只保留仓库级入口、工程目录、任务基线和版本历史，不再堆放业务文档。
5. 括号中的中文是目录显示名称，真实目录使用稳定的 ASCII slug，降低脚本、链接和
   跨平台工具处理中文路径的成本。

示例：

```text
docs/02-architecture（架构与协议）/workflow（工作流与执行）/
```

实际路径为：

```text
docs/02-architecture/workflow/
```

## 2. 推荐目录树

```text
docs/
├── README.md（文档目录设计、职责边界和迁移映射）
├── 00-navigation（导航与治理）/
│   ├── asset-index（资产索引）/
│   └── maintenance（维护规则）/
├── 01-strategy（战略与总体规划）/
│   ├── overall（总体规划）/
│   ├── competitive-research（竞品与外部研究）/
│   └── roadmap（路线图与任务计划）/
├── 02-architecture（架构与协议）/
│   ├── system（系统架构）/
│   ├── workflow（工作流、Spec 与编排）/
│   ├── agents（Agent 与协同）/
│   ├── components（组件、插件与 Provider）/
│   ├── visual-builder（可视化编排）/
│   └── decisions（有效架构决策）/
├── 03-product（产品与交互设计）/
│   ├── information-architecture（产品信息架构）/
│   ├── interaction-design（交互与页面设计）/
│   └── prototype-reviews（原型评审与验收）/
├── 04-engineering（工程详细设计）/
│   ├── p3-detailed-design（P3 技术详细设计）/
│   ├── api（API 与服务边界）/
│   ├── data-model（数据模型与运行事实）/
│   └── runtime-adapters（Runtime Adapter 与执行边界）/
├── 05-delivery（阶段交付与验收）/
│   ├── p2-prototype（P2 原型交付）/
│   ├── p4-mvp（P4 MVP 交付）/
│   ├── p5-real-workflow（P5 真实工作流接入）/
│   └── p6-engineering（P6 真实工程实施）/
├── 06-operations（操作、测试与发布）/
│   ├── user-guide（用户操作手册）/
│   ├── testing（测试与回归）/
│   └── release（版本与阶段收口）/
├── 90-reference（参考资料）/
│   └── external-research（外部研究和竞品输入）/
└── 99-archive（历史过程资产）/
    ├── architecture-reviews（架构评审过程）
    ├── product-candidates（产品候选方案）
    └── superseded-plans（已取代计划）
```

## 3. 各目录的概念与设计原因

| 目录 | 概念设计 | 设计原因 |
|---|---|---|
| `00-navigation`（导航与治理） | 维护文档状态、依赖、阅读路径和维护规则 | 把“如何读文档”从具体设计文档中独立出来，降低 AI 读取成本 |
| `01-strategy`（战略与总体规划） | 回答 Miracle 为什么存在、服务什么对象、未来怎么扩展 | 战略资料变化频率低，应与工程实现和过程评审分开 |
| `02-architecture`（架构与协议） | 定义系统、Workflow、Agent、Component、Provider 和可视化的有效架构规则 | 这是长期稳定的设计真相源，不应混入每轮交付报告 |
| `03-product`（产品与交互设计） | 定义用户入口、页面职责、交互行为和原型评审 | 产品设计与技术架构存在依赖，但生命周期和维护者不同 |
| `04-engineering`（工程详细设计） | 将架构原则转为 API、数据模型、服务边界和 Adapter 合同 | P3 之后的工程实现需要精确接口，不应和总体架构混在一起 |
| `05-delivery`（阶段交付与验收） | 记录 P2-P6 每轮实际完成了什么、验证了什么、还缺什么 | 交付文档按阶段聚合，便于版本复盘和下一阶段接续 |
| `06-operations`（操作、测试与发布） | 面向使用者和维护者，记录启动、测试、版本变化和故障处理 | 用户手册、回归报告和版本收口属于运行维护，不属于产品设计 |
| `90-reference`（参考资料） | 保存竞品、外部研究和非核心输入 | 参考资料可被需要时读取，但不能覆盖当前系统真相 |
| `99-archive`（历史过程资产） | 保存评审意见、候选稿和被取代的计划 | 保留决策证据，但默认不参与 AI 当前任务读取 |

## 4. 00-57 文档精确迁移映射

状态说明：`CURRENT` 是当前阶段有效结果，`ACTIVE` 是仍有效的基础设计，`REFERENCE`
是辅助输入，`HISTORICAL` 是默认可跳过的过程资产。

### 4.1 战略、导航和参考资料

| 原文件 | 目标目录（中文对照） | 状态 | 概念设计与原因 |
|---|---|---|---|
| `00_Miracle奇迹系统总体规划设计.md` | `01-strategy/overall/`（战略/总体规划） | ACTIVE | 定义系统定位、产品边界和总体分层，是所有后续设计的战略起点。 |
| `07_后续对接路线图与任务拆解.md` | `01-strategy/roadmap/`（战略/路线图） | REFERENCE | 维护阶段顺序、任务依赖和未来路线，属于规划索引而非执行代码说明。 |
| `08_Miracle竞品分析与架构借鉴报告.md` | `90-reference/external-research/`（参考/外部研究） | REFERENCE | 记录竞品吸收和借鉴依据，影响设计但不直接定义 Miracle 真相。 |
| `17_文档资产关联与AI阅读导航.md` | `00-navigation/asset-index/`（导航/资产索引） | CURRENT | 定义文档有效性、依赖关系和最小读取路径，是 AI 与人工的阅读入口。 |

### 4.2 有效架构与协议

| 原文件 | 目标目录（中文对照） | 状态 | 概念设计与原因 |
|---|---|---|---|
| `01_核心架构与对象模型.md` | `02-architecture/system/`（架构/系统对象） | ACTIVE | 统一 Workflow、Node、Run、Agent、Artifact、Gate 等核心对象，属于系统级稳定模型。 |
| `02_组件库与插件体系设计.md` | `02-architecture/components/`（架构/组件插件） | ACTIVE | 定义 skill、tool、MCP、Provider、插件和组件库如何组合，独立于具体业务。 |
| `03_智能路由与工作流编排设计.md` | `02-architecture/workflow/`（架构/工作流编排） | ACTIVE | 定义路由、DAG、子工作流、分支、审核门和执行策略，是工作流运行规则。 |
| `04_多Agent协同与可视化设计.md` | `02-architecture/agents/`（架构/Agent 协同） | ACTIVE | 定义 Agent 状态、交接、依赖和协同视图，聚焦多 Agent 的系统语义。 |
| `05_双模式工作流可视化编排设计.md` | `02-architecture/visual-builder/`（架构/可视化编排） | ACTIVE | 定义无限画布、DAG 和统一 WorkflowSpec 的关系，属于编辑器底层规则。 |
| `06_智能进化体系设计.md` | `02-architecture/workflow/`（架构/工作流进化） | ACTIVE | 定义复盘、记忆、评估和工作流改进闭环，仍属于执行系统长期能力。 |
| `09_WorkflowSpec与Registry技术草案.md` | `02-architecture/workflow/`（架构/Spec 与 Registry） | ACTIVE | 定义 WorkflowSpec、Registry、validate 和 dry-run，是编排系统的协议草案。 |
| `10_AgentHealth与多Agent状态机设计.md` | `02-architecture/agents/`（架构/Agent 健康） | ACTIVE | 定义 AgentHealth、权限矩阵和合法状态流转，支撑监控与协同实现。 |
| `11_VisualBuilder与Spec双向同步设计.md` | `02-architecture/visual-builder/`（架构/Visual-Spec 同步） | ACTIVE | 定义 UI、YAML/JSON 和 Spec diff 的同步真相，避免画布成为第二套模型。 |
| `13_P0架构评审纪要与决策清单.md` | `02-architecture/decisions/`（架构/有效决策） | ACTIVE | 记录 P0 已确认的边界和决策，作为架构落地时的决策索引。 |
| `14_技术架构选型与系统架构图.md` | `02-architecture/system/`（架构/技术选型） | ACTIVE | 定义 MVP Local Sidecar、未来商业化后端和系统图，是当前技术架构基线。 |

### 4.3 产品与原型

| 原文件 | 目标目录（中文对照） | 状态 | 概念设计与原因 |
|---|---|---|---|
| `12_MVP原型功能清单与界面草图.md` | `03-product/interaction-design/`（产品/原型范围） | ACTIVE | 定义首页、Run、Attention、Agent 等 MVP 交互范围，属于产品验收输入。 |
| `16_融合_产品信息架构与设计图规划.md` | `03-product/information-architecture/`（产品/当前 IA） | CURRENT | 融合了初版和 A/B 方案，是当前产品信息架构的唯一有效结果。 |
| `18_P2原型评审纪要与修订清单.md` | `05-delivery/p2-prototype/`（交付/P2 原型评审） | CURRENT | 记录 P2 原型通过结论和后续备忘，属于阶段交付验收证据。 |
| `16_产品信息架构与设计图规划.md` | `99-archive/product-candidates/`（归档/产品候选） | HISTORICAL | 产品 IA 第一版，已被融合版取代，保留用于追溯原始设计。 |
| `16_abtest_产品信息架构与设计图规划.md` | `99-archive/product-candidates/`（归档/产品候选） | HISTORICAL | A/B 对照方案，设计结论已被融合版吸收，不作为当前产品真相。 |

### 4.4 架构评审过程

| 原文件 | 目标目录（中文对照） | 状态 | 概念设计与原因 |
|---|---|---|---|
| `15_架构方案评审意见.md` | `99-archive/architecture-reviews/`（归档/架构评审） | HISTORICAL | 第一轮架构评审意见，采纳项已回写有效架构文档。 |
| `15-2_架构方案二次评审意见.md` | `99-archive/architecture-reviews/`（归档/架构评审） | HISTORICAL | 第二轮评审过程，依赖第一轮，默认跳过。 |
| `15-3_架构方案第三次评审意见.md` | `99-archive/architecture-reviews/`（归档/架构评审） | HISTORICAL | 第三轮评审过程，补充扩展性和一致性问题。 |
| `15-4_架构方案第四次评审意见.md` | `99-archive/architecture-reviews/`（归档/架构评审） | HISTORICAL | 第四轮收口评审，结论已回写 `14` 等有效文档。 |

### 4.5 P3 工程详细设计

| 原文件 | 目标目录（中文对照） | 状态 | 概念设计与原因 |
|---|---|---|---|
| `19_P3技术详细设计总纲与扩展性原则.md` | `04-engineering/p3-detailed-design/`（工程/P3 总纲） | CURRENT | 把通用 Agent OS、Local Sidecar 和商业化演进边界转为工程原则。 |
| `20_P3核心数据模型与领域扩展设计.md` | `04-engineering/data-model/`（工程/数据模型） | CURRENT | 定义 DomainPack、RoleProfile、RunSpec、Artifact 和 Gate 等领域无关模型。 |
| `21_P3本地服务API与后端演进设计.md` | `04-engineering/api/`（工程/API） | CURRENT | 定义 Local Sidecar API、Cloud Control Plane 边界和 Worker 合同。 |
| `22_P3前端架构与工作台状态设计.md` | `04-engineering/p3-detailed-design/`（工程/前端状态） | CURRENT | 将首页、Run、Attention、Agent Collaboration 映射为前端状态和接口。 |
| `23_P3MVP任务拆解与验收计划.md` | `04-engineering/p3-detailed-design/`（工程/P3 任务） | CURRENT | 把 P3 设计拆成可执行 MVP 任务和验收场景，属于工程计划。 |

### 4.6 P4 阶段交付

| 原文件 | 目标目录（中文对照） | 状态 | 概念设计与原因 |
|---|---|---|---|
| `24_P4_MVP可运行主链路交付说明.md` | `05-delivery/p4-mvp/`（交付/P4 MVP） | CURRENT | 记录 P4 首轮可运行主链路、工程结构和验收结果。 |
| `25_P4第二轮_DAG预览Gate投影与Canvas草稿交付说明.md` | `05-delivery/p4-mvp/`（交付/P4 DAG/Canvas） | CURRENT | 记录 React Flow、Artifact 预览、Gate 投影和 Canvas 草稿能力。 |
| `26_P4第三轮_集成测试与Runner协议交付说明.md` | `05-delivery/p4-mvp/`（交付/P4 Runner） | CURRENT | 记录 Sidecar 集成测试、Runner/Adapter 协议和 Mock 执行闭环。 |
| `27_P4第四轮_Gate推进Canvas发布与执行UI交付说明.md` | `05-delivery/p4-mvp/`（交付/P4 Gate/执行 UI） | CURRENT | 记录 Gate 推进、Canvas 发布和节点执行 UI。 |
| `28_P4第五轮_D3_Gate返工模型交付说明.md` | `05-delivery/p4-mvp/`（交付/P4 D3 返工模型） | CURRENT | 记录 reject 返工、Artifact 版本和下游恢复规则。 |
| `29_P4第五轮_D4_Gate返工UI与事件审计交付说明.md` | `05-delivery/p4-mvp/`（交付/P4 D4 返工 UI） | CURRENT | 记录返工操作、事件审计和用户反馈。 |
| `30_P4第五轮_D5_最小Scheduler设计与Tick接口交付说明.md` | `05-delivery/p4-mvp/`（交付/P4 D5 Scheduler） | CURRENT | 记录最小 Scheduler、Tick 接口和 Gate 暂停。 |
| `31_P4第五轮_D6_Scheduler连续执行闭环交付说明.md` | `05-delivery/p4-mvp/`（交付/P4 D6 Scheduler） | CURRENT | 记录连续调度、失败 Attention 和运行推进。 |
| `32_P4第五轮_D7_Adapter插件目录实体化交付说明.md` | `05-delivery/p4-mvp/`（交付/P4 D7 Adapter） | CURRENT | 记录 Adapter manifest、目录实体化和凭证检查。 |
| `33_P4_MVP回归验收预备清单.md` | `05-delivery/p4-mvp/`（交付/P4 D10 预备） | CURRENT | 记录 D10 验收前清单，作为执行验收的准备材料。 |
| `34_P4第五轮_D8_D9_Canvas节点草稿与Run刷新交付说明.md` | `05-delivery/p4-mvp/`（交付/P4 D8/D9） | CURRENT | 记录 Canvas NodeSpec draft、Run polling 和执行反馈。 |
| `35_P4_MVP回归验收与版本收口报告.md` | `06-operations/release/`（运维/P4 版本收口） | CURRENT | 记录 P4 MVP 全量验收、截图、API smoke 和版本基线。 |

### 4.7 P5 真实工作流接入

| 原文件 | 目标目录（中文对照） | 状态 | 概念设计与原因 |
|---|---|---|---|
| `36_P5真实工作流接入详细计划与任务拆解.md` | `05-delivery/p5-real-workflow/`（交付/P5 总计划） | CURRENT | 定义真实 Flow A-G 接入的任务、边界、依赖和验收顺序。 |
| `37_P5-01真实工作区盘点报告.md` | `05-delivery/p5-real-workflow/`（交付/P5-01 盘点） | CURRENT | 盘点 W23/W24 真实工作区及文件缺口，为映射提供证据。 |
| `38_P5-02FlowAG对象映射设计.md` | `05-delivery/p5-real-workflow/`（交付/P5-02 映射） | CURRENT | 将 Flow A-G 映射到 WorkflowSpec、Agent、Artifact、Gate 和 Trace。 |
| `39_P5-03历史Run只读导入方案.md` | `05-delivery/p5-real-workflow/`（交付/P5-03 导入） | CURRENT | 定义历史 Run 的只读 importer、projection 和真实性边界。 |
| `41_P5-04审核策略映射设计.md` | `05-delivery/p5-real-workflow/`（交付/P5-04 审核） | CURRENT | 定义 approval policy 到 Gate 对象和审核证据的映射。 |
| `42_P5-05Trace映射设计.md` | `05-delivery/p5-real-workflow/`（交付/P5-05 Trace） | CURRENT | 定义 task trace/events 到运行对象的映射和缺失时的降级规则。 |
| `43_P5-06真实历史Run_UI展示验收方案.md` | `05-delivery/p5-real-workflow/`（交付/P5-06 UI） | CURRENT | 定义真实历史 Run 在各个工作台视图中的展示验收口径。 |
| `44_P5-07半自动新Run草案设计.md` | `05-delivery/p5-real-workflow/`（交付/P5-07 RunDraft） | CURRENT | 定义半自动新 Run 的草案、Dry-run 和确认边界。 |
| `45_P5-08首个真实Adapter边界评估.md` | `05-delivery/p5-real-workflow/`（交付/P5-08 Adapter） | CURRENT | 评估 Codex CLI 首接方案、隔离、审计和后续 Provider 边界。 |
| `46_P5回归验收与阶段收口报告.md` | `06-operations/release/`（运维/P5 阶段收口） | CURRENT | 记录 P5 回归验收、真实范围核验和 P6 入口。 |

### 4.8 P6 真实工程实施

| 原文件 | 目标目录（中文对照） | 状态 | 概念设计与原因 |
|---|---|---|---|
| `47_P6真实工作流工程实施计划与任务拆解.md` | `05-delivery/p6-engineering/`（交付/P6 总计划） | ACTIVE | 定义 P6 三轨并行、P6-02 至 P6-08 依赖和验收。 |
| `48_P6-02HistoricalImporter与Projection交付说明.md` | `05-delivery/p6-engineering/`（交付/P6-02 导入） | ACTIVE | 记录 Historical Importer、Projection 和只读保护的实现结果。 |
| `49_P6-03真实Run_API与Web展示交付说明.md` | `05-delivery/p6-engineering/`（交付/P6-03 Run） | ACTIVE | 记录真实 Run API、Web 展示和历史运行态验收。 |
| `50_P6-04RunDraft_API与Web交付说明.md` | `05-delivery/p6-engineering/`（交付/P6-04 RunDraft） | ACTIVE | 记录 RunDraft、Dry-run、确认、撤回和取消能力。 |
| `51_P6-05AdapterContract与注册表交付说明.md` | `05-delivery/p6-engineering/`（交付/P6-05 Adapter） | ACTIVE | 记录 Adapter Invocation/Result/Receipt 和注册表边界。 |
| `52_P6-06CodexCLI健康检查与工作区交付说明.md` | `05-delivery/p6-engineering/`（交付/P6-06 Codex） | ACTIVE | 记录 Codex CLI 健康检查、隔离工作区、进程控制和安全审查。 |
| `53_P6-07Codex单节点真实执行交付说明.md` | `05-delivery/p6-engineering/`（交付/P6-07 真实执行） | ACTIVE | 记录 confirmed RunDraft 到真实 Codex CLI、Markdown Artifact、pending Gate 和 Trace 的完整闭环。 |
| `54_P6回归验收与版本收口报告.md` | `06-operations/release/`（运维/P6 版本收口） | CURRENT | 记录 P6 工程、API、页面、安全真实性验收和 `v0.8.0` 发布结论。 |

### 4.9 P7 多节点执行与模型 Adapter 扩展

| 原文件 | 目标目录（中文对照） | 状态 | 概念设计与原因 |
|---|---|---|---|
| `55_P7多节点真实执行与模型Adapter扩展总体设计.md` | `05-delivery/p7-adapter-expansion/`（交付/P7 Adapter 扩展） | ACTIVE | 已评审的 P7 总体设计：先定义 Codex 多节点纵向闭环、Artifact 交接和 retry/fallback，再以通用 Model API Adapter 接入 DeepSeek、Kimi 和 MiniMax。 |
| `56_P7工程实施计划与任务拆解.md` | `05-delivery/p7-adapter-expansion/`（交付/P7 实施计划） | ACTIVE | P7-02 至 P7-10 的逐文件 TDD 实施计划；P7-08 已完成并移交 P7-09。 |
| `57_P7-07模型Provider接入交付说明.md` | `05-delivery/p7-adapter-expansion/`（交付/P7 Provider） | ACTIVE | 记录三家 Provider Driver、Profile、Provider API、错误与安全边界；凭证缺失、真实 smoke 未执行，三家仍为 `configured_unverified`。 |
| `58_P7-08Provider路由与Fallback交付说明.md` | `05-delivery/p7-adapter-expansion/`（交付/P7 路由） | CURRENT | 记录确定性 Provider Router、同类 fallback、跨 kind 人工确认、Run 级决策审计和未验证 Provider 禁止执行边界。 |

### 4.10 操作、发布和仓库级资产

| 原文件 | 目标目录（中文对照） | 状态 | 概念设计与原因 |
|---|---|---|---|
| `40_Miracle系统操作使用说明书.md` | `06-operations/user-guide/`（运维/用户手册） | CURRENT | 面向使用者说明启动、本地菜单、功能操作、版本变化和故障处理。 |
| `VERSION_HISTORY.md` | 仓库根目录（版本历史） | REFERENCE | 作为仓库级版本入口，保持根目录便于 Git、发布和用户快速查看。 |

## 5. 迁移边界和链接策略

### 5.1 已执行记录

```text
建立 docs 目录
-> 使用 git mv 移动文档并保留原文件名和 Git 历史
-> 按源文件位置重写 Markdown 相对链接
-> 更新 README 和 17 文档导航
-> 更新 VERSION_HISTORY 和 task-baseline 的路径说明
-> 完成全文链接检查和工程回归检查
-> 保留根目录仓库级入口，删除根目录业务文档副本
```

### 5.2 需要特别保护的内容

- `README.md`、`VERSION_HISTORY.md`、`package.json`、`package-lock.json`、`plans/`、
  `apps/`、`packages/`、`fixtures/` 不迁入 `docs/`。
- `prototypes/` 和 `assets/` 继续保持工程资源目录，不与设计说明 Markdown 混合。
- 所有历史文档保留在 Git 中，但从默认 AI 阅读路径移除。
- 迁移只改变文件路径，不改正文内容；正文内容调整应单独形成可审阅提交。
- 迁移完成后，`README.md` 只展示入口和目录索引，详细文档清单放在 `docs/README.md`。

### 5.3 AI 阅读规则

```text
全局了解       -> README.md -> docs/00-navigation/asset-index/17_文档资产关联与AI阅读导航.md
系统架构任务   -> 02-architecture/ + 对应 04-engineering/
产品设计任务   -> 03-product/ + prototypes/
P4/P5/P6 实现  -> 05-delivery/ 当前阶段计划 + 对应工程代码
启动和使用     -> 06-operations/user-guide/
历史追溯       -> 99-archive/，按导航中的依赖顺序读取
```

默认跳过 `99-archive/`；任何历史文档只有在用户明确要求复盘、比对或追溯决策时才读取。

## 6. 已落地边界

本次迁移已执行以下边界：

1. 只调整文档归档位置、链接和导航，不修改文档正文中的架构结论。
2. 保留 `00-57` 编号和文件名，不用目录名称替代文档状态。
3. 不改变 task-baseline 的目录和数据结构，只同步其中的证据路径。
4. `prototypes/`、`assets/`、`fixtures/`、`apps/`、`packages/` 和 `plans/` 保持原位置。
5. 历史评审和候选方案进入 `99-archive/`，默认不参与 AI 当前任务读取。

## 7. 执行结果与阅读入口

- 00-57 文档已全部进入 `docs/` 对应领域目录，历史评审和候选方案进入 `99-archive/`。
- 根目录 README 只保留仓库入口、工程目录、任务基线和版本历史；详细文档目录以本文件为准。
- AI 阅读顺序与 CURRENT 结果以 [`17_文档资产关联与AI阅读导航.md`](00-navigation/asset-index/17_文档资产关联与AI阅读导航.md) 为准。
- 当前阶段路线与任务拆解见 [`07_后续对接路线图与任务拆解.md`](01-strategy/roadmap/07_后续对接路线图与任务拆解.md)。
- 验证范围：目录存在性、Markdown 本地链接、`git diff --check`、工程 typecheck/test/build。

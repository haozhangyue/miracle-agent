# Miracle 奇迹系统

> 项目定位：Miracle 是一套“超级智能体控制平面 + 工作流操作系统”，用于统一管理多 Agent 协同、工作流编排、组件库、AI 能力来源、任务执行链路、产物资产和智能进化闭环。

## 当前阶段

第一版只交付方案文档，不创建代码工程。P0 评审后，技术架构选型已作为 `P1.5 技术架构选型与系统架构图` 独立阶段前置处理，并在 `14_技术架构选型与系统架构图.md` 中给出 MVP 推荐选型；四轮架构评审已完成运行快照、NodeRun/NodeAttempt、operation 生命周期、外部调用提交协议、可选分支 join、产物版本、GateInstance、输入 selector、Event Journal 和本地安全规则的收口。产品设计图会在 `P2 产品信息架构与原型设计` 中处理。后续进入原型阶段时，再验证三块核心 UI：

1. 多 Agent 协同可视化。
2. 工作流流程节点编排。
3. 类 Lovart 的无限画布式编排。

## 阅读顺序

| 顺序 | 文档 | 用途 |
|---:|---|---|
| 1 | [00_Miracle奇迹系统总体规划设计.md](00_Miracle奇迹系统总体规划设计.md) | 完整总纲、系统定位、分层架构和验收场景 |
| 2 | [01_核心架构与对象模型.md](01_核心架构与对象模型.md) | Workflow、Node、Component、Agent、Provider、Trace 类型设计 |
| 3 | [02_组件库与插件体系设计.md](02_组件库与插件体系设计.md) | tools、skills、MCP、prompts、provider、API 的组合规则 |
| 4 | [03_智能路由与工作流编排设计.md](03_智能路由与工作流编排设计.md) | auto/manual/hybrid、默认模板、子工作流、DAG |
| 5 | [04_多Agent协同与可视化设计.md](04_多Agent协同与可视化设计.md) | Agent Map、执行时间线、依赖图、产物板 |
| 6 | [05_双模式工作流可视化编排设计.md](05_双模式工作流可视化编排设计.md) | 无限画布模式、流程节点模式、双视图同步机制 |
| 7 | [06_智能进化体系设计.md](06_智能进化体系设计.md) | 记忆、复盘、评估、推荐、版本升级 |
| 8 | [07_后续对接路线图与任务拆解.md](07_后续对接路线图与任务拆解.md) | 架构评审、原型设计、技术设计、功能点拆解 |
| 9 | [08_Miracle竞品分析与架构借鉴报告.md](08_Miracle竞品分析与架构借鉴报告.md) | GitHub 竞品清单、重点项目深读、Miracle 可吸收设计 |
| 10 | [09_WorkflowSpec与Registry技术草案.md](09_WorkflowSpec与Registry技术草案.md) | WorkflowSpec YAML v0、Registry、validate、dry-run、estimate |
| 11 | [10_AgentHealth与多Agent状态机设计.md](10_AgentHealth与多Agent状态机设计.md) | AgentHealth、PermissionMatrix、状态机、健康看板 |
| 12 | [11_VisualBuilder与Spec双向同步设计.md](11_VisualBuilder与Spec双向同步设计.md) | 无限画布、DAG、YAML/JSON 配置的双向同步 |
| 13 | [12_MVP原型功能清单与界面草图.md](12_MVP原型功能清单与界面草图.md) | MVP 功能顺序、界面结构、验收标准 |
| 14 | [13_P0架构评审纪要与决策清单.md](13_P0架构评审纪要与决策清单.md) | P0 评审结论、决策清单、技术选型和产品设计图阶段安排 |
| 15 | [14_技术架构选型与系统架构图.md](14_技术架构选型与系统架构图.md) | P1.5 技术选型、系统架构图、部署图、运行态图、中英双语展示图和术语映射 |
| 16 | [15_架构方案评审意见.md](15_架构方案评审意见.md) | 历史架构评审与第一次修订过程记录 |
| 17 | [15-2_架构方案二次评审意见.md](15-2_架构方案二次评审意见.md) | 历史架构二次评审与模型收口过程记录 |
| 18 | [15-3_架构方案第三次评审意见.md](15-3_架构方案第三次评审意见.md) | 历史架构第三次评审与执行协议收口过程记录 |
| 19 | [15-4_架构方案第四次评审意见.md](15-4_架构方案第四次评审意见.md) | 历史架构第四次评审与外部副作用、operation、可选分支和 Journal 重建协议收口记录 |
| 20 | [VERSION_HISTORY.md](VERSION_HISTORY.md) | 系统大版本、文件变更统计、详细更新内容和里程碑演进历史 |

## 版本记录要求

项目统一通过 `VERSION_HISTORY.md` 维护系统演进历史。完成重要阶段、完整模块、核心协议
调整或兼容性变化时，必须同步记录版本号、变更文件数量、详细内容、验证结果和里程碑；
普通修订可归并到当前版本的修订记录，不单独制造大版本。

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

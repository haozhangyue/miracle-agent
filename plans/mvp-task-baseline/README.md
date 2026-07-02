# MVP 任务基线与长期系统路线图

> 文档状态：项目任务基线，不属于 Miracle 系统设计文档序列。
>
> 目标：把现有 P0-P4 进度、P4 第五轮 MVP 执行计划、P5 以后长期系统建设计划统一成可视化 Roadmap，并让页面随 Git 提交和证据文件更新动态刷新。

## 1. 当前阶段判断

当前项目已经不是纯文档或原型阶段，而是进入 P4 可运行 MVP 实现阶段。

已完成：

| 阶段 | 结论 | 证据 |
|---|---|---|
| P0 | 架构评审完成 | `13_P0架构评审纪要与决策清单.md` |
| P1 / P1.5 | Spec-first 和技术架构基线完成 | `09`、`10`、`11`、`14` |
| P2 | Web 原型和 Agent Collaboration 原型评审通过 | `18_P2原型评审纪要与修订清单.md` |
| P3 | 19-23 五份技术详细设计完成并修订一致性 | `19` 至 `23` |
| P4 第一轮 | Web、Sidecar、core、fixtures 和 MVPS01-MVPS07 主链路落地 | `24_P4_MVP可运行主链路交付说明.md` |
| P4 第二轮 | React Flow DAG、Artifact 预览、Gate projection、Canvas 草稿态落地 | `25_P4第二轮_DAG预览Gate投影与Canvas草稿交付说明.md` |
| P4 第三轮 | Sidecar 集成测试、Runner/Adapter 最小协议、Mock Runner 执行闭环落地 | `26_P4第三轮_集成测试与Runner协议交付说明.md` |
| P4 第四轮 | Gate 决策真实推进、Run 执行 UI、Canvas 发布 Workflow draft、Adapter 插件壳落地 | `27_P4第四轮_Gate推进Canvas发布与执行UI交付说明.md` |

当前红点：

```text
P4 第五轮 MVP 执行能力补齐：D6 已完成，D7 Adapter 插件目录实体化为当前主线
```

## 2. 可视化实现方式

Roadmap 不直接从 Markdown 实时解析。Markdown 保留为人读和评审证据，机器可视化读取结构化数据：

```text
Markdown 文档 / Git 提交 / 证据文件
-> plans/mvp-task-baseline/roadmap.json
-> GET /api/v0/project/roadmap
-> 独立任务基线页面 /task-baseline
```

Sidecar 在每次请求 `/api/v0/project/roadmap` 时动态补充：

1. 当前 Git branch。
2. 当前 Git HEAD。
3. 最近 5 条 commit。
4. 工作区是否存在未提交修改。
5. Roadmap 中登记的证据文件是否存在、是否已被 Git 跟踪、最后一次修改该证据的 commit。

这样每次 Git 提交后，只要刷新独立任务基线页面，就能看到最新提交和证据文件同步状态。

## 3. MVP 十日计划

| 天数 | 任务 | 串并行 | 推荐子 Agent | 交付物 |
|---|---|---|---|---|
| D1 | Roadmap 数据源与 Sidecar API | 可并行起点 | Agent A | `plans/mvp-task-baseline/roadmap.json`、`GET /api/v0/project/roadmap`、Git 同步状态 |
| D2 | 独立任务基线可视化页面 | 依赖 D1，可与文档补充并行 | Agent B | 红绿灰节点、Git 同步、证据文件列表、并行泳道 |
| D3 | Gate reject 返工模型 | 已完成，可作为 D4 前置 | Agent C | rework attempt、新 Artifact version、恢复规则 |
| D4 | Gate reject 返工 UI 与事件审计 | 已完成，依赖 D3 | Agent C | 返工动作、receipt、TraceEvent |
| D5 | 最小 scheduler 设计 | 已完成，可与 Adapter 目录并行 | Agent D | queued 节点扫描、Gate 人审暂停、operation lock 复用 |
| D6 | 最小 scheduler 执行闭环 | 已完成，依赖 D5 | Agent D | 自动执行 queued 节点、失败进入 Attention |
| D7 | Adapter 插件目录实体化 | 当前主线，可并行 | Agent D | adapter manifests、Codex mock-compatible adapter、credential check |
| D8 | Canvas 新增节点生成 NodeSpec draft | 可并行 | Agent B | 新增 node card、NodeSpec draft、validate-before-save |
| D9 | Web run refresh/polling 与执行反馈 | 可并行 | Agent B | run polling、执行中状态、错误恢复提示 |
| D10 | MVP 回归验收与版本收口 | 串行收口 | Lead | typecheck/test/build、截图证据、版本记录 |

## 4. 串行与并行边界

可以并行：

| 任务线 | 内容 |
|---|---|
| 计划与可视化 | Roadmap 数据、独立任务基线页面、证据列表 |
| 执行闭环 | Gate reject 返工模型、返工 UI、scheduler 设计 |
| 平台扩展 | Adapter 目录、Canvas NodeSpec draft、Web run refresh |

必须串行：

| 前置 | 后续 | 原因 |
|---|---|---|
| Roadmap API | 独立任务基线页面 | 页面需要稳定数据结构 |
| rework model | rework UI | UI 不能先于运行事实模型 |
| scheduler design | scheduler run | 自动执行必须先定义 Gate 停顿和锁语义 |
| P4 第五轮能力完成 | MVP 验收 | 验收必须基于真实实现和测试结果 |

暂不提前做：

1. 真实商业化云后端。
2. 多租户、账号、计费。
3. 全量真实 Adapter。
4. 移动端。

## 5. 长期系统构建计划

| 阶段 | 目标 | 判断标准 |
|---|---|---|
| L1 本地 MVP 完整闭环 | 本地 Web + Local Sidecar 打通 Run、Gate、Artifact、Agent、Canvas、scheduler | 能本地启动、执行、审核、返工、查看审计 |
| L2 真实工作流接入 | 接入真实“热点工具更新”流程 | 能导入历史 run，并启动一个半自动新 run |
| L3 真实 Adapter 接入 | 至少接入 Codex 或官方 API 的真实执行 | AdapterResult、ArtifactManifest、TraceEvent 可对账 |
| L4 稳定运行系统 | 队列、重试、失败恢复、资源池、凭证治理 | 长任务可恢复，失败不丢审计 |
| L5 商业化平台 | 云端控制平面、多租户、权限、计费、团队协作 | 可以支持团队和商业化部署 |

## 6. 任务基线页面验收

任务基线页面必须满足：

1. 通过 Sidecar 独立地址 `/task-baseline` 访问，不进入 `apps/web` 侧边栏。
2. 总体阶段用绿色、红色、灰色展示完成、当前和计划。
3. 当前红点指向 `P4 第五轮 MVP 执行能力补齐`。
4. D1-D10 能区分串行和可并行任务。
5. 能看到最近 Git 提交。
6. 能看到工作区是否有未提交修改。
7. 能看到证据文件是否存在、是否被 Git 跟踪、最后关联 commit。
8. 刷新页面能读取最新 `/api/v0/project/roadmap`，不需要重新构建前端。

本地访问前先启动 Sidecar：

```bash
npm run dev:sidecar
```

访问入口：

```text
页面: http://127.0.0.1:4317/task-baseline
API:  http://127.0.0.1:4317/api/v0/project/roadmap
```

当前截图证据：

```text
plans/mvp-task-baseline/roadmap-page.png
```

## 7. 后续维护规则

每次推进一个阶段或重要任务时，至少同步以下内容：

1. 更新 `plans/mvp-task-baseline/roadmap.json` 中对应任务状态。
2. 如果产生新的任务基线说明，继续放在 `plans/mvp-task-baseline/` 下。
3. 构成项目重要进度时，更新 `VERSION_HISTORY.md` 的未发布变更。
4. 若阶段变化影响系统阅读路径，再更新 `README.md` 和 `17_文档资产关联与AI阅读导航.md`。
5. 提交 Git 后刷新 `/task-baseline` 页面确认 Git HEAD 和证据文件状态已同步。

任务基线页面不是替代版本历史，而是把版本历史、任务计划和当前工程状态合并成可观察视图。

# 12_MVP 原型功能清单与界面草图

## 1. 目标

MVP 原型不追求完整产品，而是证明 Miracle 的差异化闭环：

```text
WorkflowSpec -> Importer -> Validate/Dry-run -> Node DAG -> Agent View -> Artifact Board -> Gate Review -> Infinite Canvas -> Visual/Spec Sync -> Evolution Board
```

本阶段不选具体前端框架，不创建代码工程，只定义功能、界面结构、输入输出和验收标准。

阶段边界说明：

- 技术架构选型、系统架构图、部署形态图和数据流图不在本文完成，统一放到后续 `14_技术架构选型与系统架构图.md`。
- 产品信息架构图、页面地图、核心交互流和产品设计图不在本文完成，统一放到后续 `16_产品信息架构与设计图规划.md`。
- 本文只作为 MVP 原型功能范围和低保真界面结构说明。

编号说明：本文件使用 `MVPS01-MVPS10` 表示“竞品分析后重新排序的 MVP 顺序”，避免和 `07_后续对接路线图与任务拆解.md` 中的原始 M001-M020 任务编号混淆。

## 2. MVPS01 WorkflowSpec YAML v0

用户场景：

- 用户希望 Miracle 的工作流可以进入 Git、可 diff、可回滚。

输入：

- `content-production-v0.workflow.yaml`
- 现有 Flow A-G 文档。

输出：

- WorkflowSpec。
- NodeSpec。
- EdgeSpec。
- GateSpec。
- ArtifactSpec。
- RunSpec snapshot 契约。

界面区域：

```text
左侧：工作流文件列表
中间：Spec 摘要
右侧：Validate 结果
```

验收：

- 能表达 Flow A-G。
- 能表达 Pencil 节点插入。
- 能表达 TTS blocked。

暂不做：

- 真实 schema 校验器。
- 在线编辑器。

## 3. MVPS02 Flow A-G Importer

用户场景：

- 用户把“热点工具更新”项目作为第一条真实样本导入 Miracle。

输入：

- 现有项目文档。
- `approval_policy.yaml`。
- 项目级 skills。
- 历史 run trace。

输出：

- `content-production-v0`。
- AgentSpec 草案。
- ComponentLibrary 草案。
- ArtifactSpec 草案。

界面区域：

```text
导入向导：
1. 选择项目路径
2. 识别 Flow
3. 识别 Agent
4. 识别组件库
5. 生成预览
```

验收：

- 能识别 A-G 节点。
- 能识别人工审核门。
- 能识别 TTS、HyperFrames、Pencil 组件。

暂不做：

- 自动迁移所有历史 run。

## 4. MVPS03 Validate / Dry-run

用户场景：

- 用户启动长任务前，想知道会跑什么、缺什么、风险在哪。

输入：

- WorkflowSpec。
- 任务变量。
- 当前环境。

输出：

- 执行计划。
- CredentialCheckResult 和缺失凭证。
- 审核门列表。
- 预计成本和耗时。
- 风险提示。

界面草图：

```text
[Dry-run Summary]
节点：8
Agent：10
人工审核门：4
缺失凭证：VOLC_TTS_API_KEY
高风险：最终渲染会生成大文件

[Execution Plan]
A -> B -> C0 -> C -> D(block risk) -> E -> F -> G
```

验收：

- 能在 TTS 凭证缺失时预警。
- 能显示人工审核门。
- 能显示 provider 和 fallback。

暂不做：

- 精确 token 计费。

## 5. MVPS04 Node DAG View

用户场景：

- 用户想用流程节点方式查看工作流状态。

输入：

- WorkflowSpec。
- RunSpec。
- NodeRun。
- ArtifactManifest。
- GateDecision。

输出：

- DAG 图。
- 节点状态。
- 节点详情面板。

界面草图：

```text
顶部：运行状态 / Dry-run / Validate / 开始任务
中间：DAG 画布
右侧：节点详情
下方：事件流
```

验收：

- 节点显示 NodeRun 状态、Agent、输入输出、ArtifactManifest、GateDecision 和错误。
- 支持子工作流折叠/展开说明。
- blocked 节点显示恢复动作。
- 支持 pause、resume、cancel；timed_out 和 aborted 显示 reconcile 提示。

暂不做：

- 复杂自由布局编辑。

## 6. MVPS05 Agent Collaboration View

用户场景：

- 用户想知道哪个 Agent 正在做什么、谁在等待、谁阻塞。

输入：

- AgentSpec。
- AgentHealth。
- TraceEvent。

输出：

- Agent Map。
- Agent 健康卡。
- 任务流转链。

界面草图：

```text
左侧：Agent 健康列表
中间：协作关系图
右侧：Agent 详情
下方：工具调用和审计事件
```

验收：

- 显示 running / waiting / blocked / reviewing。
- 显示当前节点和等待对象。
- 显示组件库装备和 provider。

暂不做：

- 真正自动心跳服务。

## 7. MVPS06 Artifact Board

用户场景：

- 用户想看产物从 raw item 到 MD、TTS、视频和发布包的流转。

列：

```text
事实底稿 -> 内容资产 -> 原型资产 -> 音频字幕 -> 视频资产 -> 分发资产 -> 复盘资产
```

验收：

- 每张运行产物卡绑定 ArtifactManifest，并反向显示 ArtifactSpec。
- 显示 run、node attempt、真实路径、hash、produced_by 和 consumed_by。
- 重试产生的新版本不覆盖旧产物卡。
- 大文件显示本地路径或外部链接。

暂不做：

- 文件预览器。
- 大文件托管。

## 8. MVPS07 Gate Review UI

用户场景：

- 用户审核 MD、分镜、TTS、最终视频。

界面草图：

```text
左侧：待审核产物
中间：产物内容/摘要
右侧：批准 / 驳回 / 评论 / 阻塞
下方：返工目标节点和审核记录
```

验收：

- 支持 approve / reject / comment / block。
- rejected 必须填写返工原因。
- 持久化 GateDecision，并同步更新 ArtifactManifest 状态。
- NodeRun 已经 `done` 时不因审核通过再变成 `approved`。
- GateDecision 或 ArtifactManifest 为 pending_review 时不允许进入下游。

暂不做：

- 在线协同批注。

## 9. MVPS08 Infinite Canvas Prototype

用户场景：

- 用户用空间方式组织主题、素材、原型、产物和分支。

区域：

```text
主题区 / 事实区 / 原型区 / 内容区 / 视频区 / 分发区 / 复盘区
```

验收：

- 能显示任务卡、Agent 卡、素材卡、产物卡、节点卡。
- 能把任务卡转为 NodeSpec。
- 能从 Canvas 切到 DAG。

暂不做：

- 高级绘图能力。
- 多人实时协作。

## 10. MVPS09 Visual/Spec Sync

用户场景：

- 用户希望 UI 改动和 YAML/JSON 配置保持一致。

验收：

- UI 新增节点能生成 spec diff。
- YAML 新增节点能出现在 DAG 和 Canvas。
- 冲突时提示用户，不自动覆盖 stable。

暂不做：

- 自动三方 merge。

## 11. MVPS10 Evolution Board v0

用户场景：

- 用户希望系统把失败、返工和重复修改变成进化建议。

列：

```text
新建议 -> 待验证 -> 实验中 -> 待批准 -> 已发布 -> 已拒绝
```

验收：

- 能从 blocked/failed/rejected 事件生成建议。
- 建议不能直接修改 stable 工作流。
- 支持发布为 experimental。

暂不做：

- 自动重写 workflow。
- 自动上线 stable。

## 12. MVP 总体验收

MVP 原型完成后，必须能演示：

1. 导入热点工具更新 Flow A-G。
2. 查看 WorkflowSpec YAML 摘要，并在启动 run 时冻结 snapshot。
3. 运行 dry-run，生成 CredentialCheckResult 并发现 TTS 凭证风险。
4. 在 DAG 中区分 NodeRun、ArtifactManifest 和 GateDecision。
5. 在 Agent View 中看到 Agent 健康和等待关系。
6. 在 Artifact Board 中看到具体 run 的产物实例与版本流转。
7. 在 Gate Review UI 中驳回 MD，保留原实例并创建新的 B 节点 attempt。
8. 在 Infinite Canvas 中新增 Pencil 原型卡并转为节点。
9. 通过 Visual/Spec Sync 看到 YAML 和 UI 一致。
10. 在 Evolution Board 中看到“增加 TTS 凭证预检”的建议。

页面状态来源约束：

| 页面 | 主要状态来源 |
|---|---|
| Node DAG | WorkflowSnapshot + NodeRun |
| Agent Collaboration | AgentSpec + AgentHealth + TraceEvent |
| Artifact Board | ArtifactManifest，反向引用 ArtifactSpec |
| Gate Review | GateDecision + ArtifactManifest |
| Timeline / Audit | TraceEvent；AuditEvent 为其受保护子类型 |

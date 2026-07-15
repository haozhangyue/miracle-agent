# 24_P4_MVP可运行主链路交付说明

> 文档状态：P4 第一轮 MVP 交付说明。  
> 交付范围：MVPS01-MVPS07 可运行闭环，MVPS08-MVPS10 入口占位。

## 1. 本轮交付内容

P4 第一轮已从纯文档和原型进入可运行工程：

```text
React Web 工作台
-> Node.js Local Sidecar
-> packages/core schema / validate / dry-run / projection
-> fixtures/mvp-workspace/.miracle 样本工作区
```

已覆盖：

| 范围 | 状态 |
|---|---|
| MVPS01 WorkflowSpec YAML/JSON v0 | 已实现 JSON fixture 与 schema 校验 |
| MVPS02 Flow A-G Importer | 已实现 `content-production-v0` 样本 |
| MVPS03 Validate / Dry-run / POST runs | 已实现 API 与临时 workspace 写入验证 |
| MVPS04 Node DAG View | 已实现 Run 工作区只读流程视图 |
| MVPS05 Agent Collaboration | 已实现 Agent 协同态势页面 |
| MVPS06 Artifact Board | 已实现 Artifact Manifest 表格 |
| MVPS07 Gate Review UI | 已实现 Gate Detail 与审核决策接口 |
| MVPS08 Infinite Canvas | 已提供入口占位 |
| MVPS09 Visual/Spec Sync | 已提供入口占位 |
| MVPS10 Evolution Board | 已提供入口占位 |

## 2. 工程结构

```text
apps/web
  React + Vite + TypeScript Web 工作台

apps/sidecar
  Node.js Local Sidecar API

packages/core
  共享类型、Zod schema、validate、dry-run、Run 创建和投影函数

fixtures/mvp-workspace/.miracle
  可提交的 MVP 本地样本工作区
```

P2 原型仍保留在 `prototypes/p2/fusion-clickable/`，不作为生产代码直接延续。

## 3. 启动方式

安装依赖：

```bash
npm_config_cache=.npm-cache npm install
```

启动 Web 和 Sidecar：

```bash
npm run dev
```

默认地址：

```text
Web:     http://127.0.0.1:5174/
Sidecar: http://127.0.0.1:4317/api/v0/health
```

独立任务基线看板只依赖 Sidecar，可单独启动：

```bash
npm run dev:sidecar
```

访问地址：

```text
页面:    http://127.0.0.1:4317/task-baseline
数据:    plans/mvp-task-baseline/roadmap.json
API:     http://127.0.0.1:4317/api/v0/project/roadmap
```

## 4. 验证结果

已通过：

```bash
npm run typecheck
npm run test
npm run build
```

API smoke test 已覆盖：

- `GET /api/v0/health`
- `GET /api/v0/domains`
- `POST /api/v0/workflows/content-production-v0/validate`
- `POST /api/v0/workflows/content-production-v0/dry-run`
- `GET /api/v0/runs/run-demo-001`
- `GET /api/v0/gates/gate-md-master-001`
- `POST /api/v0/runs` 使用临时 workspace 验证写入，未污染提交 fixture

截图证据：

| 页面 | 截图 |
|---|---|
| 首页 | `assets/reviews/p4-mvp/01-home.png` |
| Run 工作区 | `assets/reviews/p4-mvp/02-run.png` |
| Attention | `assets/reviews/p4-mvp/03-attention.png` |
| Agent Collaboration | `assets/reviews/p4-mvp/04-agents.png` |
| Artifact Board | `assets/reviews/p4-mvp/05-artifacts.png` |
| Gate Review | `assets/reviews/p4-mvp/06-review.png` |

## 5. 当前边界

- 不做真实后台调度器。
- 不做真实 Runtime Adapter 执行。
- 不做云端、多租户、账号、计费。
- 不做移动端 / APP。
- `MVPS08-MVPS10` 本轮只保留入口和占位。

## 6. 第二轮进展

以下建议已在 [25_P4第二轮_DAG预览Gate投影与Canvas草稿交付说明.md](25_P4第二轮_DAG预览Gate投影与Canvas草稿交付说明.md) 中落地：

1. 将 Run 工作区 DAG 从列表升级为 React Flow 只读图。
2. 为 Artifact Detail 增加 markdown/json/text 预览。
3. 将 Gate Review 决策后的下游状态投影补全。
4. 开始 MVPS08 Infinite Canvas 的可编辑草稿态。

以下建议已在 [26_P4第三轮_集成测试与Runner协议交付说明.md](26_P4第三轮_集成测试与Runner协议交付说明.md) 中落地：

1. 增加 Sidecar API 集成测试。
2. 接入 Runner/Adapter 最小协议和 Mock Runner 执行闭环。

尚未完成的后续项：

1. 将 Canvas 草稿发布为 Workflow draft。
2. Gate 决策后实际推进 Orchestrator 下游状态。
3. 将 NodeAttempt 和执行按钮补到 Run 工作区 UI。

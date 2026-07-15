# P6-03 真实 Run API 与 Web 展示交付说明

> 文档状态：CURRENT
>
> 依赖文档：`47_P6真实工作流工程实施计划与任务拆解.md`、`48_P6-02HistoricalImporter与Projection交付说明.md`
>
> 任务结论：P6-03 已完成，当前主线进入 P6-04 RunDraft API 与 Web。

## 1. 本轮交付

P6-03 将 P6-02 导入的 W24/W23 historical Run 接入现有 Miracle Web 工作台：

- Run 列表和 Run 详情增加 `view_meta`：`origin`、`mode`、`source_confidence`、`source_meta_available`。
- Run 详情返回 `source_meta`，展示来源目录、证据指纹和结构化缺口。
- W24 显示 `Historical · Read-only`、混合证据、F pending review 和 A/B/G 推断说明。
- W23 显示 `Historical · Read-only`、低证据和控制文件/trace/Gate 缺口。
- 历史 Run 隐藏节点执行、Scheduler tick、自动推进、GateDecision 和返工操作。
- Agent Collaboration 支持 `?run_id=`，展示当前 Run 的 Agent、current/queued NodeRun、等待产物和证据来源。
- Attention、Artifact、Review 页面沿用当前选中的 Run，不再固定读取 demo Run。
- Artifact 详情对历史源路径只提供元数据或源文件引用，不越过 workspace 读取真实源文件。
- 事件审计按最新事件在前排序；DAG/Canvas 保持列表和可读文本替代信息。
- Artifact ID 增加稳定路径哈希，避免非 ASCII 文件名归一化导致重复 ID。

## 2. Sidecar 接口变化

```text
GET /api/v0/runs
GET /api/v0/runs/:id
GET /api/v0/agents/collaboration?run_id=:id
GET /api/v0/attention?run_id=:id
GET /api/v0/artifacts?run_id=:id
GET /api/v0/artifacts/:id?run_id=:id
GET /api/v0/gates/:id?run_id=:id
```

`RunSpec` 仍是运行真相；`view_meta` 只属于展示投影，不改变执行模型。Historical Run 的写命令继续统一返回：

```json
{
  "status": 409,
  "error": { "code": "historical_run_read_only" }
}
```

## 3. Web 使用方式

1. 使用仓库外 `MIRACLE_WORKSPACE_DIR` 启动 Sidecar。
2. 通过 P6-02 API 导入 W24/W23，或直接打开已经包含 historical Run 的 runtime workspace。
3. 打开首页，在“继续运行”中选择 `content-production-real-v0`。
4. 在 Run 工作区切换 W24/W23，查看证据等级、DAG、节点详情和事件审计。
5. 使用左侧“Attention”“智能体”“产物”“审核”查看同一 Run 的关联投影。
6. 看到 `Historical · Read-only` 时，只能查看和追溯，不能执行节点、推进 Scheduler、审核或返工。

## 4. 截图证据

| 场景 | 文件 |
|---|---|
| W24 Run：混合证据、F 待审、只读操作 | `assets/reviews/p6-real-run-ui/w24-run-historical.png` |
| W23 Run：低证据、控制文件缺口、只读操作 | `assets/reviews/p6-real-run-ui/w23-run-historical.png` |
| W24 Attention：根因与 Gate/Artifact 关联 | `assets/reviews/p6-real-run-ui/w24-attention-historical.png` |
| W24 Artifact：真实产物清单、路径引用和详情预览占位 | `assets/reviews/p6-real-run-ui/w24-artifacts-historical.png` |

## 5. 验收结果

- Core 测试：10 项通过。
- Sidecar 测试：35 项通过，包含 Historical API、只读 mutation、W23/W24、证据投影和唯一 Artifact ID。
- Web 测试：3 项纯函数测试通过。
- TypeScript typecheck、全量构建通过。
- Playwright 验收通过：W24/W23 Run 页面、Attention、Agent Collaboration、Artifact 页面可读取真实历史 Run。
- 跨 Run 切换不会向旧 Run 的 NodeRun/Artifact/Gate 发起错误请求。
- 真实 W24/W23 smoke 通过，源工作区文件未被修改。

## 6. 当前限制与下一步

- Web 当前仍是本地 MVP，不提供账号、多租户和云同步。
- Historical Artifact 的视频/音频/图片只展示源引用和元数据，不复制大媒体。
- Attention 的 acknowledge/snooze 仍是本地视图动作，不改变历史事实。
- 下一步为 `P6-04 RunDraft API 与 Web`，继续保持与 P6-03 的页面和共享类型边界隔离。

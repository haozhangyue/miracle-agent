# 角色化说明书与 Web 帮助中心交付验收报告

> 文档状态：CURRENT
>
> 对应任务：`help-h1` 至 `help-h7`
>
> 适用产品版本：`v0.9.0`
>
> 验收日期：2026-08-10

## 1. 结论

角色化说明书与 Web 帮助中心通过交付验收。Miracle 现在同时提供仓库文档入口和 Web
“帮助与手册”入口，两者读取同一套 Markdown，不维护第二份帮助文案。

`40_Miracle系统操作使用说明书.md` 已收敛为兼容总入口，当前详细操作真相由 `61-65`
角色化分册共同组成。帮助功能不参与 Orchestrator 运行事实写入；帮助内容不可用时，
Run、Scheduler、Gate、Artifact 和 Provider 主链路不受影响。

## 2. 交付范围

| 范围 | 交付结果 |
|---|---|
| 使用者手册 | 新任务、RunDraft、Dry-run、Run、Attention、Agent、Artifact、Gate、Retry/Fallback、Canvas 和工作流扩展 |
| 管理员手册 | 安装、启动、真实执行开关、凭证、Provider、运行目录、备份、升级、安全和运行治理 |
| 开发维护手册 | 工程结构、核心对象、Sidecar/API、Workflow/Adapter/Provider 扩展、测试、发布和手册同步契约 |
| 公共手册 | 故障排查、用户可感知版本变化 |
| Help API | 索引、文章、全文搜索和 allowlist 图片读取 |
| Web Help | 一级菜单、角色筛选、搜索、文章导航、本页目录、Markdown/GFM、Mermaid、截图、版本标记和深链接 |
| 截图 | `assets/manual/v0.9.0/` 共 12 张当前界面截图 |

## 3. API 与安全边界

新增只读接口：

```text
GET /api/v0/help
GET /api/v0/help/search?q=...&role=...
GET /api/v0/help/articles/:articleId
GET /api/v0/help/assets/:assetId
```

安全约束：

- Manifest 是可读取文章和图片的唯一 allowlist。
- API 响应不暴露 Markdown 源路径。
- 拒绝绝对路径、路径穿越、越界 symlink、未知文章和未知图片。
- Markdown 禁用原始 HTML；外链只允许 `http` 和 `https`。
- Mermaid 使用 `securityLevel: strict`；图片只能映射到 Manifest 中的本地资产。
- Help API 只读，不允许 Agent 或浏览器写 Event Journal。

## 4. Web 验收

已验证：

1. 从左侧“帮助与手册”进入帮助中心。
2. 通过 `?page=help&article=user-guide#anchor` 打开可分享深链接。
3. 在全部、使用者、管理员和开发维护者之间筛选文章。
4. 搜索 `新任务`、`Gate`、`Provider`、`blocked` 等中英文对象词。
5. Markdown 表格、代码块、Mermaid、版本化截图和跨分册链接正常渲染。
6. 离开帮助页后清除帮助 URL 参数，刷新不会错误返回帮助中心。
7. 帮助中心加载失败时显示独立错误态，不影响其他菜单。

Playwright 使用 `1600 x 1000` 桌面视口完成截图，浏览器控制台为 0 error、0 warning。
当前阶段聚焦 Web，不把移动端/APP 响应式作为本次验收范围。

## 5. 回归结果

```text
npm run typecheck  通过
npm run test       通过
npm run build      通过
```

专项覆盖：

- Help Manifest schema、文章排序、搜索与标题目录。
- 路径穿越、未知 ID、源路径隐藏和越界 symlink。
- Web 深链接、文章回退、图片映射、外链协议和中文标题锚点。
- Sidecar API 集成读取、搜索和恶意 article ID。

## 6. 截图证据

| 编号 | 页面 |
|---|---|
| 01-03 | 首页、新任务、Dry-run |
| 04-05 | Run 工作区、Attention |
| 06-08 | Agent Collaboration、Artifact Board、Gate Review |
| 09-10 | Provider/Runtime 观测、Canvas 草稿 |
| 11-12 | Task Baseline、Web 帮助中心 |

截图目录：`assets/manual/v0.9.0/`。

## 7. 后续维护契约

用户可感知功能提交必须回答“是否影响说明书”：

- 影响操作路径：更新 `61`。
- 影响启动、凭证、Provider、备份或安全：更新 `62`。
- 影响扩展协议、API、测试或发布：更新 `63`。
- 影响故障和恢复动作：更新 `64`。
- 新增、优化、修复或兼容性变化：更新 `65`。
- 新增文章或截图：更新 `help-manifest.json`，截图写入新的版本目录，不覆盖历史版本。
- 总入口变化：同步更新 `40`、README、AI 阅读导航、VERSION_HISTORY 和 task-baseline。

## 8. Task Baseline

`help-h1` 至 `help-h7` 全部为 `completed`，`help-center` 阶段为 `completed`，当前不创建
新的 P8 占位任务。下一阶段仍需经过独立规划和评审。

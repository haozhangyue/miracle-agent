# Miracle 文档目录分层迁移实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将根目录的 00-52 文档迁移到按内容领域分层的 `docs/` 目录，并保持链接、AI 阅读导航、版本历史和工程目录可用。

**Architecture:** 内容领域是一级目录，阶段是二级语义，状态由导航元数据维护。原文件名和编号保持不变，迁移只改变路径；工程代码、原型资源、图片资产、fixtures 和 task-baseline 不进入文档目录。

**Tech Stack:** Markdown、Git、Node.js 工作区、ripgrep、JSON/YAML 校验。

## Global Constraints

- 所有现有 00-52 文件名保持不变，只移动路径。
- `README.md`、`VERSION_HISTORY.md`、`apps/`、`packages/`、`fixtures/`、`assets/`、`prototypes/`、`plans/` 保持根目录职责。
- 括号中的中文是目录显示名称，实际目录使用 ASCII slug。
- 不改变文档正文语义；只修正因路径变化产生的链接。
- `CURRENT / ACTIVE / REFERENCE / HISTORICAL` 状态继续由 17 导航维护。
- 提交前通过 `git diff --check`、路径存在性、Markdown 链接和工程测试。

## Task 1: 创建目录并迁移文档

**Files:** 创建 `docs/` 分层目录；移动 00-52 Markdown；保留 `docs/README.md`。

- [ ] 创建目标目录：`00-navigation`、`01-strategy`、`02-architecture`、`03-product`、`04-engineering`、`05-delivery`、`06-operations`、`90-reference`、`99-archive` 及其子目录。
- [ ] 按 `docs/README.md` 映射使用 `git mv`，不重命名文件。
- [ ] 确认根目录 Markdown 只剩 `README.md` 和 `VERSION_HISTORY.md`。
- [ ] 确认 `apps/`、`packages/`、`fixtures/`、`assets/`、`prototypes/`、`plans/` 未被迁移。

## Task 2: 重写相对链接

**Files:** 所有移动后的 Markdown、根 `README.md`、`docs/README.md`。

- [ ] 搜索所有旧根路径引用和编号文件名引用。
- [ ] 将内部文档链接改为从链接源文件所在目录出发的相对路径。
- [ ] 保留外部 URL、锚点、图片链接和代码块内容。
- [ ] 检查代码和配置中引用的文档路径。

## Task 3: 同步入口、导航和版本记录

**Files:** `README.md`、`docs/README.md`、迁移后的 17 导航、`VERSION_HISTORY.md`。

- [ ] 根 README 只保留项目定位、当前阶段、启动方式和文档入口。
- [ ] 17 导航保留所有状态、依赖和阅读规则，只更新路径并补充目录分层说明。
- [ ] 版本历史记录目录重构、历史资产归档、链接同步和回滚方式；不升级产品版本号。
- [ ] `docs/README.md` 从“规划稿”更新为“已落地目录索引”。

## Task 4: 完整性验收

- [ ] 检查 00-52 文件存在、无重复、无 Git 删除遗漏。
- [ ] 解析 Markdown 相对链接，确认每个本地目标存在。
- [ ] 执行 `npm run typecheck`、`npm run test`、`npm run build` 和 `git diff --check`。
- [ ] 审查迁移统计，确认没有代码、图片、fixture 和 task-baseline 逻辑变更。

## Task 5: 提交与回滚

- [ ] 记录迁移前后路径清单和验证结果。
- [ ] 执行 `git add README.md VERSION_HISTORY.md docs plans/docs-restructure`。
- [ ] 提交信息使用：`重构文档目录并同步阅读导航`。
- [ ] 回滚时只反向恢复本次路径和入口变更，不使用 `git reset --hard`。

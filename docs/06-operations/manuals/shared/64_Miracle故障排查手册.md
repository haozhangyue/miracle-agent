# Miracle 故障排查手册

> 适用角色：使用者、管理员、开发维护者
>
> 适用版本：`v0.9.0`
>
> 最后验证日期：2026-08-10

## 1. 排查原则

先确定问题属于哪个对象，不要把所有异常都笼统称为“任务失败”：

```text
服务 -> Run -> NodeRun -> NodeAttempt -> Adapter/Provider
     -> Artifact -> Gate -> AgentHealth -> Attention
```

建议顺序：

1. 记录版本、Git commit 和问题时间。
2. 检查 Sidecar health。
3. 确定 Run 和对象 ID。
4. 查看 Attention 根因和最新事件。
5. 查看 NodeAttempt/operation/receipt。
6. 只执行系统提供的恢复动作。
7. 恢复后确认新事件和下游状态。

不要通过删除 JSON、改状态字段、覆盖 Artifact 或重复点击外部执行来规避问题。

## 2. Web 无法访问

**现象：** `http://127.0.0.1:5174/` 无法打开。

**快速判断：** 查看运行 `npm run dev` 的终端是否存在 Vite 启动错误。

**诊断：**

```bash
cd /Users/zhangyue/miracle-agent
npm run dev:web
```

检查端口是否被占用、依赖是否安装、Core 是否能构建。

**恢复：** 停止占用端口的旧开发进程，重新执行根级 `npm run dev`。若 Vite 自动选择其他
端口，以终端输出为准。

**不要：** 不要同时启动多个不清楚 workspace 指向的 Sidecar/Web 组合。

## 3. Sidecar 无法启动

**现象：** health 无响应，Web 显示数据请求失败。

**诊断：**

```bash
npm run dev:sidecar
curl http://127.0.0.1:4317/api/v0/health
```

检查：Node 错误、端口占用、workspace 路径、JSON 文件损坏、权限和环境变量。

**恢复：** 使用默认 fixture workspace 验证服务本身，再逐步恢复自定义环境变量。

**不要：** 不要把 workspace 错误简单归因于 Web；Web 只是 API 消费者。

## 4. 页面能打开但没有数据

**影响：** 首页、Run 或 Artifact 区为空或显示刷新失败。

**快速判断：** health 正常后，直接请求对应 `/api/v0` 接口。

**检查：**

- Web 是否代理到同一个 `4317` Sidecar。
- Sidecar 使用的 `MIRACLE_WORKSPACE_DIR` 是否包含 fixture/runs。
- 当前 Run ID 是否存在。
- 页面是否保留上一次成功数据并提示刷新失败。

**恢复：** 统一 Web 与 Sidecar 地址，选择存在的 Run，重新加载页面。

## 5. 端口被占用

**现象：** 启动提示 address already in use。

**恢复选项：**

1. 停止旧进程，保持默认端口。
2. 使用 `MIRACLE_SIDECAR_PORT` 更换 Sidecar 端口，并同步 Web 代理配置。

当前 MVP 推荐固定 Web `5174`、Sidecar `4317`，减少文档、代理和截图漂移。

## 6. Workspace 路径被拒绝

**现象：** `runtime_workspace_required`、path not allowed、symlink 或 repository path 错误。

**原因：** 真实执行/导入要求仓库外 workspace，Sidecar 会解析 realpath 防止 symlink 逃逸。

**恢复：**

```bash
mkdir -p "$HOME/.miracle-agent/workspace"
MIRACLE_RUNTIME_WORKSPACE_DIR="$HOME/.miracle-agent" \
MIRACLE_WORKSPACE_DIR="$HOME/.miracle-agent/workspace/.miracle" \
npm run dev:sidecar
```

**不要：** 不要通过 symlink 把仓库内目录伪装成外部路径。

## 7. Codex CLI 不健康

**现象：** health 显示 missing、not logged in 或 unavailable。

**诊断：**

```bash
codex --version
codex login status
curl http://127.0.0.1:4317/api/v0/adapters/codex-cli/health
```

**恢复：** 安装/更新 Codex CLI，完成登录；若可执行文件不在 PATH，设置
`MIRACLE_CODEX_CLI_PATH`。然后调用 health refresh。

**不要：** 不要把 Codex token 写进 WorkflowSpec 或 ProviderProfile。

## 8. 真实 Codex 没有执行

**现象：** RunDraft 能创建但正式执行被拒绝。

**检查：**

- `MIRACLE_ENABLE_REAL_CODEX=1` 是否在 Sidecar 进程环境。
- Codex health 是否 healthy。
- RunDraft 是否确认且确认版本未过期。
- 模板是否使用允许的真实 Codex Adapter。
- runtime workspace 是否仓库外且可写。

**恢复：** 修复条件后重新 Dry-run 和确认；不要复用已变更草案的旧 confirmation。

## 9. Provider 缺少凭证

**现象：** `missing_credential`，节点 blocked。

**恢复：** 在启动 Sidecar 的本地进程环境中设置 Profile 引用的环境变量，再重启或刷新健康。

```bash
export DEEPSEEK_API_KEY='REDACTED'
```

**不要：** 不要通过 API、UI、Git 文件或日志提交真实 Key。

## 10. Provider 已配置但不可执行

**现象：** `configured_unverified`。

**原因：** 凭证存在不等于真实健康。系统尚未完成当前环境的 health probe/脱敏 completion。

**恢复：** 取得明确授权后执行目标 Provider smoke，检查脱敏 receipt。成功后再更新可执行健康
投影。Kimi 当前使用 `MOONSHOT_API_KEY`，不是 `KIMI_API_KEY`。

## 11. Provider 返回 401/403

**影响：** 身份或权限错误，不允许自动 Fallback。

**检查：** Key 是否有效、scope 是否匹配、Profile provider/Driver 是否一致、账号是否有模型权限。

**恢复：** 修复凭证或权限，再人工重试。不要把 401/403 当临时网络错误持续 Retry。

## 12. Provider 返回 429/5xx/网络错误

**行为：** 若错误分类、预算和健康候选允许，系统可以 Retry 或同类 Provider Fallback。

**检查：** Node detail 的 retry decision、attempt/time/cost budget、routing decision 和候选拒绝原因。

**恢复：** 等待 schedule 到期；或在 Attention 中调整策略/确认 Fallback。跨 Codex/Model API
切换必须二次确认。

## 13. Provider 超时

只有明确终止的 timeout 才能按策略 Retry。若外部执行状态不明，状态应为 unknown 或
dispatched_unknown，禁止自动重派。

检查 operation receipt、Provider 请求 ID 和是否实际终止。人工对账后再决定恢复。

## 14. Run 一直 queued

**检查：**

- ExecutionPlan reason code。
- required 上游是否完成。
- Gate 是否 pending_review。
- optional branch 的 join/wait_if_active/max_wait。
- Scheduler 是否运行。

**恢复：** 完成上游/Gate，或运行 Scheduler。不要直接把 NodeRun JSON 改为 running。

## 15. NodeRun blocked

常见根因：凭证、权限、输入 Artifact、hash/media type、Gate、Provider 健康或路径校验。

进入 Attention，处理根因卡片提供的动作。blocked 通常不是可重试的瞬时错误。

## 16. NodeAttempt failed

查看 `error_code`、Adapter kind、operation、receipt 和 RetryPolicy。确认是：

- 可恢复 Adapter/transport 错误。
- 不可恢复输入/权限/内容策略错误。
- 输出 schema/path/hash 错误。
- 外部执行成功但本地提交失败的事务恢复问题。

失败 Attempt 永久保留；修复后创建新 Attempt，而不是覆盖状态。

## 17. Retry 一直等待

`waiting_for_retry` 表示 `scheduled_for` 尚未到。页面应显示倒计时和预算。到期后运行 Scheduler。

如果时间已到仍不执行，检查 mutation lock、active schedule、最新 Attempt 和 Sidecar 时间。

## 18. Retry exhausted

次数、时间或成本任一预算耗尽都会进入 Attention。

恢复前先修复根因，再由授权者调整有限预算或选择人工重试。不要删除 retry state 让计数归零。

## 19. dispatched_unknown

这是高风险状态：请求可能已经到达外部系统，但本地未取得确定结果。

1. 停止自动 Retry。
2. 根据 operation/provider receipt 与外部系统对账。
3. 确认是否产生真实输出或费用。
4. 选择提交外部结果、标记终止或人工创建新 Attempt。

禁止自动重派相同业务动作。

## 20. Gate 长时间 pending_review

进入“审核”，确认选中的是当前 Run 和当前 Artifact version/hash。查看 `required_before` 和历史
决策。Historical Run 的 Gate 只能查看。

提交 approve 后再次运行 Scheduler；若下游仍不恢复，查看 ExecutionPlan 和 selector。

## 21. Gate reject 后无法返工

检查：

- 决策是否确实为 reject/request_changes。
- Gate 是否 historical read-only。
- 是否已经创建新 rework Attempt/Gate。
- Run mutation lock 是否忙。

409 `operation_in_progress` 时等待当前写入完成后重试，不要并发创建多个返工。

## 22. Artifact 无法预览

检查 manifest path、type、media type、文件存在、realpath 和 hash。文本类型支持本地预览；
二进制可能只显示引用。

`preview unavailable` 不等于 Artifact 丢失。若 hash 不一致，停止下游消费并创建 Attention。

## 23. Artifact hash 不一致

这是数据完整性问题。

1. 停止相关下游执行。
2. 核对 producer Attempt 和 manifest。
3. 检查文件是否被手工修改或恢复不完整。
4. 从可信备份恢复，或重新执行 producer 创建新版本。

不要更新 manifest hash 来迎合已被修改的文件。

## 24. Historical Import preview 失败

检查 source 是否位于 `MIRACLE_IMPORT_ROOTS`、realpath/symlink、源文件格式和允许的根目录。
preview 不写运行事实，可以修复输入后重试。

## 25. Historical Import commit 返回 409/422

- 409 runtime workspace：将 Miracle workspace 移到仓库外。
- 409 lock：等待当前导入完成；过期死锁由系统恢复。
- 422 control file：修复损坏源文件，不能推测缺失事实。

同一源内容重复导入应幂等返回或修复 receipt，不应生成多个不同 Run。

## 26. Historical Run 看起来不完整

查看页面 `gaps` 和 `source_confidence`。源资料缺少 task events、审批状态或 Artifact 时，系统只
展示可验证 projection。不要手工补 completed/approved。

## 27. Attention 重复或不消失

同一 root cause 应只有一个主 Attention，相关对象在卡片内展开。若状态已恢复但卡片仍 open：

1. 刷新 Run/Attention 投影。
2. 检查底层对象是否真正恢复。
3. 检查是否出现新 Attempt 导致卡片 reopen。
4. 核对 root cause key 和 resolved 事件。

危险确认、审核和对账问题不能手工关闭。

## 28. Task Baseline 与实际提交不同

访问 `/api/v0/project/roadmap`，检查 Git HEAD、dirty 状态和 evidence path。task-baseline 动态
读取 Git，但任务状态来自 `roadmap.json`，需要在任务真实完成时同步更新。

不要只改页面颜色；计划 JSON、证据文件和 Git commit 必须一致。

## 29. Help 页面找不到文章或图片

检查 `help-manifest.json`：article/asset ID、source、版本和文件是否存在。Help API 只接受白名单
ID，不接受文件路径。图片必须位于 `assets/manual/`，且 media type 在允许范围。

Help 故障不应影响 Run。若 `/api/v0/help` 失败但 `/api/v0/health` 也失败，先处理 Sidecar 主服务。

## 30. 收集支持信息

可以提供：

- Miracle 版本、Git commit、Node/npm/Codex 版本。
- 稳定 reason code 和 HTTP status。
- Run、NodeRun、Attempt、operation、Artifact、Gate ID。
- 已脱敏事件和最小复现步骤。
- 是否使用 fixture、historical 或真实 Adapter。

禁止提供：API Key、token、完整 prompt、隐藏推理、未脱敏 Artifact、个人绝对路径和账号密码。

# Task 4 P7-05 Retry 与故障恢复实施报告

## 状态

DONE

## Commit

- 初始实现 SHA: `9d8fd010183d94d563633a8ef067d02c9d7f3b73`
- 初始实现 Message: `实现真实执行retry与故障恢复`
- 修复轮 1 SHA: `4ff0caae67c9d9953a1494861288b8a080c5a016`
- 修复轮 1 Message: `修复retry预算复核与恢复幂等`
- 修复轮 2 SHA: `c1457b517a1ea463e0a2bfe06d4ae1ee8e912db9`
- 修复轮 2 Message: `修复retry排期消费与外部调用幂等`
- 修复轮 3 SHA: `af92c57cadf0557558381dbe55d260fb1106ac97`
- 修复轮 3 Message: `修复retry统一分类与恢复状态机`
- 修复轮 4 SHA: `f674aed9bf55f396eb6904a7e2f77553eea23d2d`
- 修复轮 4 Message: `修复retry终态补偿与统一投影`
- 修复轮 5 SHA: `84d2a55191c1a9f4f413315b4846c861c39b2d7d`
- 修复轮 5 Message: `修复retry运行时截止与兼容迁移`
- Branch: `codex/p7-05-retry-recovery`

## 变更文件

### Core

- `packages/core/src/retry-policy.ts`
- `packages/core/src/adapter-outcome.ts`
- `packages/core/test/retry-policy.test.ts`
- `packages/core/test/adapter-outcome.test.ts`
- `packages/core/src/types.ts`
- `packages/core/src/schemas.ts`
- `packages/core/src/index.ts`
- `packages/core/src/runner.ts`

### Sidecar

- `apps/sidecar/src/retry-store.ts`
- `apps/sidecar/src/server.ts`
- `apps/sidecar/src/codex-cli-adapter.ts`
- `apps/sidecar/src/codex-real-adapter.ts`
- `apps/sidecar/test/codex-cli-adapter.test.ts`
- `apps/sidecar/test/codex-real-node.test.ts`
- `apps/sidecar/test/retry-recovery.test.ts`
- `apps/sidecar/test/api.test.ts`
- `apps/sidecar/test/fixtures/bin/fake-codex.mjs`

### Web

- `apps/web/src/App.tsx`
- `apps/web/src/retry-ui.ts`
- `apps/web/src/retry-ui.test.ts`

### 任务与文档

- `plans/mvp-task-baseline/roadmap.json`
- `README.md`
- `VERSION_HISTORY.md`
- `docs/README.md`
- `docs/00-navigation/asset-index/17_文档资产关联与AI阅读导航.md`
- `docs/01-strategy/roadmap/07_后续对接路线图与任务拆解.md`
- `docs/05-delivery/p7-adapter-expansion/56_P7工程实施计划与任务拆解.md`
- `docs/05-delivery/p7-adapter-expansion/55_P7多节点真实执行与模型Adapter扩展总体设计.md`
- `docs/06-operations/user-guide/40_Miracle系统操作使用说明书.md`

## 关键设计

1. Core 统一 classifier 将真实 Codex `process_exit_nonzero` / `process_spawn_failed`
   归一为 `adapter_process_error`，确认终止的 `process_timeout + timed_out` 归一为
   `adapter_timeout`，`invalid_adapter_output` 归一为 `adapter_output_invalid`。
   `decideRetry` 只接收明确 failed 或已确认 timed_out 的 NodeAttempt；cancelled、aborted、
   unknown、invalid_result 和 dispatched_unknown 永不自动重派。
2. Retry 复用原 `operation_id`，为每次执行创建递增 `attempt_number` 和独立
   `attempt_id`；`attempts.json` 只追加、不覆盖。首 Attempt 的旧事件 ID 保持兼容，
   retry Attempt 使用 attempt scope 避免事件去重冲突。
3. RetryPolicy 只允许 fixed/exponential，`max_attempts` 为 1-3；attempt、total time、
   cost 三类预算均进入预算快照。schema 拒绝负数、NaN、Infinity、超过 3 次和无界时间值。
4. `RetryScheduleStore` 将 active schedule 写入
   `runs/:runId/retry_schedule.json`，使用唯一 temp 文件加 rename 原子替换；upsert 按
   operation 去重，同 operation 最多一条 active schedule。
5. Scheduler 未到 `scheduled_for` 不派发。到期后以失败 NodeRun 的临时 queued 计划视图
   重新校验输入/Gate，再复用 operation 创建新 Attempt。重启恢复同时核对 schedule、
   attempts 和 dispatch intent；已提交 Attempt 不重复 dispatch。
6. `dispatched_unknown` 和 `invalid_result` 会撤销对应 active retry，并保留 intent 转人工
   检查；不会自动重派。
7. Sidecar Orchestrator 单写 `retry_scheduled`、`retry_exhausted`、Attempt、Run 和
   Attention。预算耗尽按 run + node + error code 的 `root_cause_key` 聚合一张卡，提供
   inspect/fix/increase budget/manual retry 动作。
8. Node detail 投影 `retry_decision`；Web 展示 retry action、reason、operation、下一
   attempt、到期时间和预算快照。Historical Run 不产生 retry 投影写入，POST 写路径仍只读。
9. 本任务未实现 Provider fallback，未接真实第三方 API；fallback 保持 P7-08 范围。
10. 创建 schedule 时以 `elapsed + delay` 检查能否在 deadline 内排期；消费既有 schedule
    时使用 Core `consume` 模式，只按当前 elapsed、最新 attempts 和累计 cost 权威授权，
    避免到期后重复计入 backoff。
11. fake Codex 通过仓库外 temp wrapper 写 append-only counter。counter 独立于 Attempt、
    TraceEvent 和生产 API，覆盖 `dispatched_unknown` 与结果返回后 transaction journal
    重启恢复，恢复前后外部调用行数不增长。
12. NodeSpec `failure_policy.retry_policy` 支持完整策略覆盖；legacy `retry` 映射有限默认
    cost budget 5。首 Attempt 使用 policy attempt timeout，retry Attempt 使用
    `min(attempt_timeout_ms, remaining_total_budget_ms)`，remaining 不大于 0 时不派发。
13. `retry_state.json` 使用原子 temp + rename 持久化 waiting/exhausted/blocked 状态。
    terminal tombstone 区分“schedule effect 漏写”和“已经耗尽”，reconcile 始终使用 current now，
    防止第二轮扫描按旧 `created_at` 复活。
14. Scheduler、ExecutionPlan、Node detail 和 Web 共用 waiting_for_retry/due/exhausted/blocked
    投影；Web 仅在 due 时允许直接执行，并展示 attempt/time/cost 三类 used/limit。
15. blocked 结果写单根因 Attention；同 root cause 的后续 Attempt 合并关联对象并 reopen，
    不按 Attempt 重复建卡。
16. Codex CLI credential/auth/permission health failure 保留真实 Codex invocation 身份，但不启动
    外部进程；错误以 non-recoverable blocked AdapterResult 落盘，NodeRun、RetryState 和
    单根因 Attention 同步投影凭证配置与权限修复动作。
17. `retry_state.json` 的 waiting/exhausted/blocked 记录持久化 operation、node、attempt、
    reason、decision、error 和 `effects_committed`。reconcile 幂等补写 terminal
    `retry_exhausted`/Attention 后再标记 effects 完成；成功 Attempt 先写 durable completed
    tombstone，再删除 schedule，所有 projection 忽略 completed。
18. prepared dispatch intent 使用首 Attempt deadline 与 intent 内持久化 dispatch time/timeout
    验证身份，不按恢复时墙钟重建。当前预算仍在实际派发前权威复核；仅 prepared intent 可原子
    推进，operation/attempt/input/deadline/timeout identity 不变，dispatched_unknown 不更新、不重派。
19. Scheduler 对 due retry 仅把对应 failed NodeRun 映射为 queued 后重算 ExecutionPlan，
    Gate/input 决策优先于 retry execute 覆盖。waiting/exhausted/blocked 再叠加，并统一重算
    decisions、ready/paused/blocked、terminal、stop_reason 与 Node detail/Web 恢复动作。
20. 真实 Codex dispatch 每次强制刷新 CLI health；health/spawn 的 EACCES、EPERM 和 fake
    shell 126 归入 `permission_denied`，login status 缺凭证与检查失败分别归入
    `credential_missing`、`authentication_failed`。nonzero 后再次检查实时登录状态，仅在
    认证已失效时重分类 blocked，普通 nonzero 仍保持可重试。
21. Retry prepared intent 持久化首次 operation start 加 total time budget 得到的不可变
    `operation_deadline_at`。恢复身份校验只使用持久化 deadline、prepared time 和 timeout，
    不按当前墙钟改写 intent；deadline 穿透到真实 Adapter，并在 `spawn` 紧前重新读取 now，
    deadline 耗尽时返回确认 timed_out 且零 spawn，未耗尽时运行 timeout 取 invocation 与
    remaining 的较小值。
22. `required_gate_rejected` 继续投影为 `paused_for_gate`，Scheduler 与 Node detail 均返回
    `inspect_gate`、`create_rework`，且 Scheduler 首要动作优先选择 rejected gate。
23. RetryStateStore 显式识别缺少 attempt/error/effects 字段的前一 P7-05 格式；Sidecar
    reconcile 从同 operation 最新 Attempt 搬运真实身份和 error，并原子回写新格式。
    无法确定 error 时保留原 legacy 记录到 migration-blocked 文件，阻断 NodeRun 并建立
    `retry_state_migration_failed` Attention，不静默伪造错误，也不向 API 泄漏 parse 500。

## TDD 证据

### RED

Core:

```text
npm run test -w packages/core -- retry-policy.test.ts
exit 1
Test Files 1 failed
Tests 6 failed | 7 passed
关键失败：TypeError: decideRetry is not a function
```

Sidecar:

```text
npm run test -w apps/sidecar -- retry-recovery.test.ts
exit 1
Test Files 1 failed
关键失败：Cannot find module '../src/retry-store'
```

两次 RED 都由缺少目标生产能力导致，不是语法或夹具误报。

### GREEN

```text
npm run test -w packages/core -- retry-policy.test.ts
Test Files 1 passed
Tests 13 passed
```

```text
npm run test -w apps/sidecar -- retry-recovery.test.ts
Test Files 1 passed
Tests 2 passed
```

```text
npm run test -w apps/sidecar -- retry-recovery.test.ts codex-multi-node.test.ts
Test Files 2 passed
Tests 8 passed
```

Sidecar 测试启动 `tsx` IPC/本地 HTTP 时，沙箱内首次出现 `listen EPERM`；按权限流程在
沙箱外重跑后获得以上真实 GREEN 结果。

### 修复轮 1 RED

Core:

```text
npm run test -w packages/core -- retry-policy.test.ts
exit 1
Test Files 1 failed
Tests 2 failed | 13 passed
关键失败：
- total_time_budget 从 AdapterResult received_at 计算，elapsed_ms=1000 而非 60000
- retryPolicySchema 接受缺少 cost_budget 的策略
```

Sidecar:

```text
npm run test -w apps/sidecar -- retry-recovery.test.ts
exit 1
Test Files 1 failed
Tests 5 failed | 2 passed
关键失败：
- NodeAttempt 缺少真实 started_at/dispatched_at
- NodeSpec 显式 cost_budget=0 未覆盖默认策略
- Scheduler 到期消费未按最新时间预算阻断
- 直接 execute 未按最新成本预算阻断
- unknown dispatch intent 仍投影为 schedule_retry
```

以上 RED 均由缺少修复轮要求的生产能力触发。

### 修复轮 1 GREEN

```text
npm run test -w packages/core -- retry-policy.test.ts
Test Files 1 passed
Tests 15 passed
```

```text
npm run test -w apps/sidecar -- retry-recovery.test.ts
Test Files 1 passed
Tests 7 passed
```

恢复测试使用 `runner_operation_dispatched` 事件数与 Attempt 数作为可观察外部副作用计数，
证明预算耗尽和事务/Attempt 已提交后的恢复均未重复 dispatch。

### 修复轮 2 RED

Core:

```text
npm run test -w packages/core -- retry-policy.test.ts
exit 1
Test Files 1 failed
Tests 1 failed | 15 passed
关键失败：budget=1500、delay=1000 时，到 scheduled_for 消费 attempt 2 返回
require_attention；期望 schedule_retry。
```

Adapter 外部计数：

```text
npm run test -w apps/sidecar -- codex-real-node.test.ts
exit 1
Test Files 1 failed
Tests 2 failed | 26 passed
关键失败：缺少独立 Adapter 子进程计数通道，counter=0；修复测试夹具后由 temp wrapper
设置 marker，并由 fake Codex exec 自身 append，不修改生产 API。
```

### 修复轮 2 GREEN

```text
npm run test -w packages/core -- retry-policy.test.ts
Test Files 1 passed
Tests 16 passed
```

```text
npm run test -w apps/sidecar -- retry-recovery.test.ts codex-real-node.test.ts
Test Files 2 passed
Tests 35 passed
```

边界测试确认首次 `elapsed=0` 可排期、`elapsed=1000` 到期可消费 attempt 2、
`elapsed=1501` 才因 total deadline 耗尽。两类重启恢复均断言 fake Codex counter
在恢复前后不增长。

### 修复轮 3 RED

Core outcome classifier：

```text
npm run test -w packages/core -- adapter-outcome.test.ts retry-policy.test.ts
exit 1
Test Files 2 failed
Tests 13 failed | 16 passed
关键失败：缺少统一 classifier；真实 Codex process code 未归一；confirmed timed_out
被 decideRetry 拒绝。
```

完整 NodeSpec policy 与硬 timeout：

```text
npm run test -w packages/core -- retry-policy.test.ts codex-cli.test.ts
exit 1
Test Files 2 failed
Tests 3 failed | 39 passed
关键失败：resolveNodeRetryPolicy 不存在；NodeSpec 忽略无效 retry_policy；
AdapterInvocation timeout 仍为硬编码值。
```

恢复 tombstone 与 post-commit/pre-schedule：

```text
npm run test -w apps/sidecar -- retry-recovery.test.ts
exit 1
Test Files 1 failed
Tests 2 failed | 8 passed
关键失败：直接 execute 在 failed Node 无 schedule 时返回 terminal 409；
reconcile 使用旧 created_at 复活已耗尽 schedule。
```

统一投影、Attention 与 Web：

```text
npm run test -w apps/sidecar -- retry-recovery.test.ts
exit 1
Tests 3 failed | 9 passed
关键失败：未到期 stop_reason 不是 waiting_for_retry；exhausted phase 缺失；
已 resolved 的同根因 Attention 未合并新 Attempt/reopen。

npm run test -w apps/web -- retry-ui.test.ts
exit 1
关键失败：retry-ui 模块不存在，due 执行门禁和三类预算文案缺失。
```

真实 Adapter 副作用与 blocked 分类：

```text
npm run test -w apps/sidecar -- codex-real-node.test.ts -t 'retries one real Codex process failure once'
exit 1
Tests 1 failed
关键失败：fake Codex 尚未按 attempt 状态返回真实 process_exit_nonzero。

npm run test -w apps/sidecar -- codex-real-node.test.ts -t 'classifies a missing input artifact'
exit 1
Tests 1 failed
关键失败：Artifact missing 后 NodeRun 已 blocked，但 Attention 为空，Scheduler failed 为空。
```

排队耗尽即时投影：

```text
npm run test -w apps/sidecar -- retry-recovery.test.ts -t 'projects queued time exhaustion'
exit 1
Tests 1 failed
关键失败：Node detail 沿用落盘预算，返回 waiting_for_retry 而非 time_budget_exhausted。
```

所有 RED 均先于对应生产修复运行并由缺失行为触发。Sidecar 测试在沙箱内首次因 tsx IPC
`listen EPERM` 无法启动，按权限流程在沙箱外重跑后才记录功能 RED/GREEN。

### 修复轮 3 GREEN

```text
npm run test -w packages/core -- adapter-outcome.test.ts retry-policy.test.ts codex-cli.test.ts
Test Files 3 passed
Tests 54 passed

npm run test -w apps/sidecar -- retry-recovery.test.ts codex-real-node.test.ts
Test Files 2 passed
Tests 42 passed

npm run test -w apps/web -- retry-ui.test.ts
Test Files 1 passed
Tests 2 passed

npm run test -w apps/sidecar -- api.test.ts
Test Files 1 passed
Tests 30 passed
```

Stateful fake Codex 首次返回真实 `process_exit_nonzero`，第二次成功；append-only marker
精确为 2。重启、stale schedule、Scheduler/直接 execute 并发消费后 marker 不增长。
Artifact source 删除场景确认 `artifact_missing` -> blocked NodeRun + 单根因 Attention，
Scheduler 同步投影 terminal failure。

### 修复轮 4 RED

RetryState 可重放事实与 active upstream：

```text
npm run test -w packages/core -- retry-policy.test.ts execution-plan.test.ts
exit 1
关键失败：旧 RetryState schema 丢弃 attempt/error/effects facts 且拒绝 completed phase；
required Artifact 对应的 optional active 上游被误判 required_input_missing。
```

统一 due projection 与 Web 执行门禁：

```text
npm run test -w apps/web -- retry-ui.test.ts
exit 1
关键失败：due retry 即使 ExecutionPlan 已 blocked，Web 仍允许执行。
```

Sidecar blocked、补偿、intent 与 Gate/input 复核：

```text
npm run test -w apps/sidecar -- retry-recovery.test.ts api.test.ts codex-real-node.test.ts
exit 1
关键失败 7 项：credential health 仍启动外部进程；prepared intent 推进时钟后身份失效；
completed tombstone 缺失；terminal effects 不重放；due retry 绕过 required input；
active upstream 被误判缺失。

npm run test -w apps/sidecar -- codex-real-node.test.ts -t "turns missing Codex credentials"
exit 1
关键失败：blocked receipt 被压成 mock-local/no_executable_adapter 身份。
```

所有功能 RED 均在对应生产修复前运行；Sidecar 首次受沙箱 `tsx listen EPERM` 限制，
按权限流程在沙箱外重跑后记录真实行为失败。

### 修复轮 4 GREEN

```text
npm run test -w apps/sidecar -- retry-recovery.test.ts api.test.ts codex-real-node.test.ts codex-multi-node.test.ts
Test Files 4 passed
Tests 85 passed

npm run test -w packages/core -- adapter-outcome.test.ts retry-policy.test.ts execution-plan.test.ts codex-cli.test.ts
Test Files 4 passed
Tests 91 passed

npm run test -w apps/web -- retry-ui.test.ts historical.test.ts
Test Files 2 passed
Tests 5 passed
```

故障注入分别覆盖 retry terminal state 写入后/event 与 Attention 前、completed tombstone
写入后/schedule 删除前、prepared intent 落盘后推进时钟并重启。Stateful fake Codex
Attempt 2 外部计数保持精确 2；并发、stale schedule 与重启均未增加。

### 修复轮 5 RED

Codex health、permission、nonzero 重分类与 spawn deadline：

```text
npm run test -w apps/sidecar -- codex-cli-adapter.test.ts
exit 1
Test Files 1 failed
Tests 5 failed | 43 passed
关键失败：
- login status 检查失败仍记为 credential_missing
- health/spawn EACCES 仍记为 runtime_not_found/process_spawn_failed
- nonzero 后登录失效仍保留 process_exit_nonzero/recoverable=true
- deadline 已耗尽仍 spawn 并成功
- remaining deadline 未裁剪实际进程 timeout
```

动态失效、prepared intent、Gate action 与 legacy migration：

```text
npm run test -w apps/sidecar -- codex-real-node.test.ts retry-recovery.test.ts api.test.ts
exit 1
Test Files 3 failed
Tests 8 failed | 76 passed
关键失败：
- Sidecar 已缓存 healthy 后，credential/auth/permission 失效仍各新增一次 fake Codex exec
- prepared retry intent 恢复时 timeout 从 6000 被墙钟改写为 5148
- required_gate_rejected stop_reason 返回 attention_required
- legacy waiting/exhausted/unmatched 三类 Node detail 均返回 RetryState schema parse 500
```

所有失败均由目标生产行为缺失触发；普通 nonzero 保持可重试的保护断言在 RED 阶段已通过。

### 修复轮 5 GREEN

```text
npm run test -w apps/sidecar -- codex-cli-adapter.test.ts codex-real-node.test.ts retry-recovery.test.ts api.test.ts
Test Files 4 passed
Tests 132 passed
```

deadline regression mutation check 临时移除 Adapter deadline 输入后，两条测试分别因“过期仍成功”
和“进程 500ms 后仍运行”失败；恢复生产门禁后：

```text
npm run test -w apps/sidecar -- codex-cli-adapter.test.ts -t deadline
Test Files 1 passed
Tests 2 passed | 46 skipped
```

动态 credential/auth/permission 测试均先缓存 healthy，再无重启改写 fake Codex 状态；blocked
Attempt 后再次调用 direct execute 返回 409，外部 marker 不增长。legacy waiting、
exhausted 和无法关联 Attempt 三类 fixture 均覆盖 Node detail、Scheduler 与 direct execute。

## 完整测试结果

```text
npm run test
Core:    7 files, 114 tests passed
Sidecar: 10 files, 187 tests passed
Web:     3 files, 9 tests passed
Total:   20 files, 310 tests passed
```

```text
npm run typecheck
Core / Sidecar / Web 全部通过
```

```text
npm run build
Core / Sidecar TypeScript build 通过
Web Vite production build 通过（1865 modules transformed）
```

```text
git diff --check
通过，无 whitespace error
```

Roadmap 语义检查：

```json
{"current_node_id":"p7-06","p7-05":"completed","p7-06":"current"}
```

## 自审

- 自动 retry 只接受 classifier 确认的 failed 或 `process_timeout + timed_out`；cancelled、
  aborted、unknown、invalid_result 和 dispatched_unknown 均无自动派发路径。
- operation/attempt 身份、事件 ID 和历史追加规则一致。
- active schedule 去重、到期门禁、重启恢复和重复 dispatch 防护均有集成覆盖。
- Attention 按 root cause 去重，不按 Attempt 建卡。
- Historical Run 只读门禁未改变，完整 Sidecar 回归通过。
- 未加入 Provider fallback、真实第三方 API 或无关重构。
- 修复轮 1 确认所有有效 RetryPolicy 都有有限 cost budget；legacy NodeSpec 映射默认 5，
  模板显式值优先，budget snapshot 始终携带 `cost_budget`。
- retry 消费的最终授权统一位于 Run mutation lock 内，依据最新 attempts、当前时间和累计成本
  重新执行 `decideRetry`；拒绝时在 Adapter 调用前移除 schedule 并持久化 exhausted/Attention。
- active schedule 的 `retry_scheduled` 事件以稳定 event ID 补偿；Node detail 在 schedule 之前
  投影 unknown/invalid dispatch intent 的阻断决策。
- 修复轮 2 确认 schedule 创建与消费使用不同时间预算语义；reconcile 和最终锁内授权均使用
  `consume`，未到期门禁与 attempt/cost 权威复核保持不变。
- 外部幂等证据不依赖 Orchestrator 自己写入的 Attempt 或 TraceEvent；temp marker 只由实际
  fake Codex `exec` 进程追加，重启恢复断言 counter 行数稳定。
- 修复轮 3 对真实 Codex process/spawn/timeout/invalid-output code 逐项覆盖，默认 retryable
  codes 与归一 code 一致；凭证、权限、输入和 Artifact 缺失归入 blocked + Attention。
- RetryPolicy override 经 NodeSpec schema 完整校验；首 Attempt 和 retry Attempt 均使用节点
  attempt timeout，后者再受 remaining total budget 截断。
- durable retry state 关闭 post-commit/pre-schedule 与旧时间复活窗口；Scheduler 和直接
  execute 都先 recover/reconcile，再在 mutation lock 内做 authoritative consume 授权。
- Scheduler execution_plan、decisions、stop_reason/next actions、Node detail 和 Web 统一使用
  waiting/due/exhausted/blocked 当前投影。排队期间预算耗尽在 Node detail 查询时即可见。
- Stateful fake Codex 外部 marker 精确为 2；重启、并发和 stale schedule 恢复均未增加。
- 全量回归覆盖 Historical、Gate、P7-04 Scheduler；typecheck、build 和 diff check 均通过。
- 修复轮 4 确认 Codex credential/auth/permission health 不再降级为 recoverable
  `no_executable_adapter`，不会启动外部进程；NodeRun blocked、RetryState terminal 与单根因
  Attention 的错误身份和恢复动作一致。
- terminal retry effects 以 `effects_committed` 两阶段提交并可在重启后补偿；successful retry
  的 completed tombstone 先于 schedule 删除，projection 对 completed 无条件短路。
- prepared intent 的恢复验证不依赖当前墙钟；实际 dispatch 前仍以 current budget 授权，
  remaining 不大于 0 时 fake Codex counter 不增长，unknown intent 不更新。
- due retry 先进入统一 ExecutionPlan 复核 Gate/input，再叠加 retry phase。required input
  blocked 的 NodeRun/Attention 可在 Artifact 恢复后回到 queued，active 上游保持 wait。
- Scheduler 与 Node detail 共用 next-action helper；stop reason 区分
  `waiting_for_retry`、`attention_required`、`paused_for_gate` 和 `no_executable_nodes`，
  waiting/due 的统一 ExecutionPlan 均保持 `terminal=false`。
- 修复轮 5 确认 dispatch 不永久使用启动时 Codex health；凭证、认证检查和权限在无 Sidecar
  重启时动态 blocked，并以同 error code 聚合单根因 Attention，外部重试不新增 exec。
- prepared intent 的 deadline 与 timeout 均按持久化事实校验；墙钟推进不改写身份，最终
  `spawn` 临界点独立裁剪 timeout。fake clock 与真实悬挂子进程分别覆盖零 spawn 和 min timeout。
- rejected gate 的 Scheduler stop reason、首要 action 与 Node detail 完全一致，动作直接指向
  gate 检查与现有 rework API。
- legacy RetryState 只从真实 Attempt 迁移 error；waiting/exhausted 原子升级并幂等补偿 effects，
  无法关联时保存原记录、阻断执行并生成 migration Attention，不返回 500。

## 遗留关注

- P7-08 才实现 Provider fallback；当前 Attention 只提供检查根因、调整预算和人工重试。
- 本轮通过 mock-compatible Adapter 与 fake Codex 回归恢复协议，不调用真实第三方 Provider。

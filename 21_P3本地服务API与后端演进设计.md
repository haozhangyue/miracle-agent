# 21_P3本地服务API与后端演进设计

> 文档状态：P3 API 与后端演进详细设计。
>
> 核心约束：MVP 的 Node.js 服务是 Local Sidecar，不是商业化云端主后端的最终限定。

## 1. 服务边界

MVP 运行形态：

```text
Browser UI
-> Local Sidecar API
-> Local Workspace / Registry / Runtime Adapter / Run Trace
```

Local Sidecar 负责：

1. 受控读取和写入本地项目文件。
2. 读取 WorkflowSpec、DomainPack、Registry、Run Trace。
3. validate、dry-run、estimate。
4. 调用本地 CLI、MCP、HTTP/API adapter。
5. 生成本地 Event Journal、Run Manifest 和 Artifact Manifest。
6. 向 UI 提供运行状态查询和事件流。

Local Sidecar 不负责：

1. 多租户、组织、计费。
2. 商业化权限中心。
3. 云端任务调度。
4. 大规模并发 Worker 管理。
5. 企业级审计合规系统。

## 2. 后端演进边界

### 2.1 MVP

```text
React UI
-> Node.js Local Sidecar
-> YAML/JSON/JSONL files
-> CLI/MCP/API adapter
```

适合：

1. 本机 workspace。
2. 个人使用。
3. 原型和早期 MVP。
4. 可读、可 diff、可 Git 管理的数据。

### 2.2 商业化团队版

```text
React UI
-> Cloud Control Plane
-> Queue
-> Worker Pool
-> Local Sidecar / Remote Adapter / Provider
```

建议职责：

| 模块 | 职责 |
|---|---|
| Cloud Control Plane | 用户、组织、权限、计费、Registry、策略、Run 调度、审计。 |
| Queue | 长任务排队、限流、幂等、重试、失败对账。 |
| Worker Pool | Python/Node/远程 API Worker 执行能力型任务。 |
| Local Sidecar | 本地文件、CLI、MCP、Keychain/env 引用。 |
| Data Plane | PostgreSQL、对象存储、Event Journal、索引查询。 |

商业化阶段可以选 Java/Kotlin、Go 或同等级强后端栈；P3 不把 Node.js 绑定成最终主后端。

## 3. API 设计原则

1. UI 不直接写文件。
2. UI 不直接调用 provider。
3. Run 事实只能追加，不能覆盖历史。
4. Spec 修改生成 diff，不直接改 stable 模板。
5. 所有动作返回 `receipt` 或 `event_id`，方便审计。
6. 本地路径只使用 workspace handle，不把任意绝对路径暴露给 UI。
7. 错误必须归类为：validation、credential、provider、filesystem、permission、conflict、unknown。

## 4. MVP API 总览

路径前缀：

```text
/api/v0
```

核心 API：

| API | 方法 | 用途 |
|---|---|---|
| `/domains` | GET | 获取 DomainPack 列表。 |
| `/roles` | GET | 获取 RoleProfile 列表。 |
| `/registry/templates` | GET | 获取模板列表。 |
| `/workflows` | GET | 获取项目工作流。 |
| `/workflows/:id` | GET | 获取 WorkflowSpec。 |
| `/workflows/:id/validate` | POST | 校验 WorkflowSpec。 |
| `/workflows/:id/dry-run` | POST | 生成执行计划、风险和估算。 |
| `/runs` | GET | 获取 Run 列表。 |
| `/runs` | POST | 从 dry-run plan 或 WorkflowSpec 启动 Run。 |
| `/runs/:id` | GET | 获取 Run 详情。 |
| `/runs/:id/events` | GET | 获取事件。 |
| `/runs/:id/nodes/:nodeRunId` | GET | 获取节点运行详情。 |
| `/runs/:id/nodes/:nodeRunId/execute` | POST | 手动触发一个可执行 NodeRun，MVP 使用 `mock-local` Runner。 |
| `/agents/health` | GET | 获取 AgentHealth 投影。 |
| `/agents/collaboration` | GET | 获取 Agent 协作态势。 |
| `/attention` | GET | 获取 Attention 队列。 |
| `/attention/:id` | GET | 获取 Attention 详情。 |
| `/attention/:id/actions` | POST | 执行安全动作或记录意图。 |
| `/artifacts` | GET | 获取产物列表。 |
| `/artifacts/:id` | GET | 获取产物详情。 |
| `/gates/:id` | GET | 获取审核实例详情。 |
| `/gates/:id/decision` | POST | 提交审核决策。 |

## 5. API 详细约定

### 5.1 Domain 与 Registry

`GET /api/v0/domains`

返回：

```json
{
  "domains": [
    {
      "id": "content-production",
      "name": "内容生产",
      "version": "0.1.0",
      "status": "experimental",
      "template_count": 1
    }
  ]
}
```

`GET /api/v0/registry/templates?domain=content-production`

返回：

```json
{
  "templates": [
    {
      "template_id": "content-production-v0",
      "domain": "content-production",
      "name": "内容生产全流程",
      "version": "0.6.0",
      "status": "stable",
      "source": "local_registry"
    }
  ]
}
```

### 5.2 Workflow

`GET /api/v0/workflows/:id`

返回：

```json
{
  "workflow": {
    "id": "content-production-v0",
    "domain": "content-production",
    "version": "0.6.0",
    "status": "stable",
    "nodes": [],
    "edges": [],
    "gates": [],
    "artifacts": []
  },
  "metadata": {
    "source": "local_project",
    "readonly": false,
    "path_handle": "workflow:content-production-v0"
  }
}
```

`POST /api/v0/workflows/:id/validate`

返回：

```json
{
  "valid": false,
  "errors": [
    {
      "code": "missing_credential",
      "object_type": "ProviderPolicy",
      "object_id": "volc-tts",
      "message": "缺少 VOLC_TTS_API_KEY"
    }
  ],
  "warnings": [],
  "checked_at": "2026-06-26T10:00:00+08:00"
}
```

`POST /api/v0/workflows/:id/dry-run`

返回：

```json
{
  "plan_id": "dryrun_001",
  "workflow_id": "content-production-v0",
  "estimated_cost": {
    "min": 18,
    "max": 42,
    "currency": "CNY"
  },
  "risks": [
    {
      "severity": "P0",
      "code": "missing_credential",
      "recovery_actions": ["configure_credential", "switch_provider", "skip_optional_branch"]
    }
  ],
  "nodes": []
}
```

### 5.3 Run

`POST /api/v0/runs`

用途：

```text
从 DryRunPlan 或已验证 WorkflowSpec 启动一次 Run。
```

请求：

```json
{
  "workflow_id": "content-production-v0",
  "dry_run_plan_id": "dryrun_001",
  "execution_policy": "hybrid",
  "role_profile": "operator",
  "input_artifacts": [
    {
      "artifact_id": "input_brief_001",
      "type": "document"
    }
  ]
}
```

Sidecar 必须执行：

1. 创建 `RunSpec`。
2. 冻结 `WorkflowSnapshot`。
3. 固化 resolved components 和 resolved ProviderPolicy。
4. 生成初始 `NodeRun`。
5. 写入 `run_created` TraceEvent。
6. 返回可进入 Run 工作区的 `run_id`。

返回：

```json
{
  "run_id": "run_20260626_001",
  "run_spec_id": "runs/run_20260626_001/run_spec.json",
  "workflow_snapshot_id": "snap_001",
  "status": "created",
  "created_events": ["evt_run_created"],
  "initial_node_runs": ["nr_collect_sources"]
}
```

`GET /api/v0/runs`

返回：

```json
{
  "runs": [
    {
      "run_id": "run_20260626_001",
      "workflow_id": "content-production-v0",
      "domain": "content-production",
      "status": "running",
      "progress": {
        "done": 5,
        "total": 8
      },
      "attention_count": 2,
      "updated_at": "2026-06-26T10:10:00+08:00"
    }
  ]
}
```

`GET /api/v0/runs/:id`

返回：

```json
{
  "run": {
    "run_id": "run_20260626_001",
    "workflow_snapshot_id": "snap_001",
    "status": "running",
    "readonly_snapshot": true,
    "started_at": "2026-06-26T10:00:00+08:00"
  },
  "nodes": [],
  "artifacts": [],
  "attention": []
}
```

`GET /api/v0/runs/:id/nodes/:nodeRunId`

返回：

```json
{
  "node": {
    "node_run_id": "nr_collect",
    "status": "queued",
    "output_artifacts": []
  },
  "attempts": []
}
```

`POST /api/v0/runs/:id/nodes/:nodeRunId/execute`

请求：

```json
{
  "adapter_kind": "mock-local"
}
```

返回：

```json
{
  "accepted": true,
  "invocation": {
    "operation_id": "op_nr_collect_001",
    "node_run_id": "nr_collect",
    "adapter_kind": "mock-local",
    "provider": "codex-local"
  },
  "adapter_result": {
    "operation_id": "op_nr_collect_001",
    "node_run_id": "nr_collect",
    "status": "succeeded",
    "provider_receipt": {
      "provider": "codex-local",
      "adapter_kind": "mock-local"
    },
    "artifact_descriptors": []
  },
  "committed": {
    "node_run": {
      "status": "done"
    },
    "attempt": {
      "status": "succeeded"
    },
    "created_events": ["evt_op_nr_collect_001_committed"]
  }
}
```

约束：

1. `execute` 只允许触发 `queued` 或 `running` 的 `NodeRun`。
2. Adapter 只返回 `AdapterResult`；`NodeAttempt`、`ArtifactManifest`、`GateInstance`
   和 `TraceEvent` 仍由 Sidecar Orchestrator 单写入。
3. MVP 的 `mock-local` 只验证协议和状态提交，不代表真实 Codex/Hermes/OpenClaw 已接入。
4. 同一 `NodeRun` 执行期间必须持有本地 operation lock，防止并发请求重复提交运行事实。
5. Orchestrator 推进下游节点时必须校验 edge `artifact_selector`，只有匹配到 `created`
   且审核状态满足要求的 `ArtifactManifest` 才允许下游进入 `queued`。

### 5.4 Agent Collaboration

`GET /api/v0/agents/health?run_id=run_20260626_001`

返回：

```json
{
  "agents": [
    {
      "agent_id": "tts-agent",
      "status": "blocked",
      "active_runs": ["run_20260626_001"],
      "current_node_runs": ["nr_tts"],
      "waiting_for": ["credential:VOLC_TTS_API_KEY"],
      "equipped_libraries": ["tts-caption-library"],
      "heartbeat_at": "2026-06-26T10:03:00+08:00"
    }
  ]
}
```

`GET /api/v0/agents/collaboration?run_id=run_20260626_001`

返回：

```json
{
  "run_id": "run_20260626_001",
  "links": [
    {
      "from_agent": "content-agent",
      "to_agent": "script-agent",
      "artifact_id": "art_md_master_v2",
      "status": "waiting_gate"
    }
  ],
  "handoff_contracts": []
}
```

### 5.5 Attention

`GET /api/v0/attention?run_id=run_20260626_001`

返回：

```json
{
  "items": [
    {
      "attention_id": "att_tts_credential",
      "root_cause_key": "credential:VOLC_TTS_API_KEY:missing",
      "title": "TTS 凭证缺失",
      "severity": "P0",
      "status": "open",
      "related_object_count": 4
    }
  ]
}
```

`POST /api/v0/attention/:id/actions`

请求：

```json
{
  "action": "skip_optional_branch",
  "actor": "local_user",
  "confirm_token": "short_lived_ticket",
  "comment": "本次只交付 MD 分发包"
}
```

返回：

```json
{
  "accepted": true,
  "receipt_id": "receipt_001",
  "event_id": "evt_001",
  "effect": {
    "changed_objects": ["nr_video_branch"],
    "unaffected_paths": ["markdown_distribution"]
  }
}
```

### 5.6 Gate Review

`GET /api/v0/gates/:id`

返回：

```json
{
  "gate": {
    "gate_instance_id": "gate_artifact_review_001",
    "run_id": "run_20260626_001",
    "gate_spec_id": "review_primary_artifact",
    "status": "pending_review",
    "required_before": ["publish_package"],
    "target": {
      "type": "ArtifactManifest",
      "id": "art_report_v1"
    },
    "impact": {
      "blocked_node_runs": ["nr_publish_package"],
      "unaffected_paths": ["video_optional_branch"]
    }
  },
  "target_artifact": {
    "artifact_id": "art_report_v1",
    "type": "report",
    "version": 1,
    "review_status": "pending_review"
  },
  "history_decisions": []
}
```

`POST /api/v0/gates/:id/decision`

请求：

```json
{
  "decision": "reject",
  "actor": "local_user",
  "comment": "引用证据不足",
  "target_artifact_id": "art_report_v1"
}
```

返回：

```json
{
  "accepted": true,
  "gate_decision_id": "gd_001",
  "created_events": ["evt_gate_rejected"],
  "projection": {
    "projected_artifact_review_status": "rejected",
    "mutates_artifact": true
  },
  "next_suggested_actions": ["create_rework_attempt"]
}
```

提交语义：

- `approve` 会将目标 ArtifactManifest 的 `review_status` 更新为 `approved`，并按
  Edge selector 判断是否推进下游 NodeRun。
- `reject/request_changes` 会将目标 ArtifactManifest 的 `review_status` 更新为
  `rejected`，并阻塞 Gate `required_before` 中尚未完成的下游 NodeRun。
- Gate 决策不覆盖产物文件内容，不覆盖旧 Artifact version；返工必须通过新 Attempt 和
  新 Artifact version 表达。

## 6. 本地文件边界

MVP 建议目录：

```text
.miracle/
  domains/
  registry/
  workflows/
  runs/
    run_20260626_001/
      manifest.json
      run_spec.json
      workflow_snapshot.yaml
      events.jsonl
      artifacts.json
      attention.json
  artifacts/
```

规则：

1. UI 只拿 `path_handle`，不拿任意本地绝对路径。
2. Local Sidecar 做路径规范化和 workspace 边界检查。
3. 符号链接必须解析后仍在允许的 workspace 内。
4. 凭证只保存引用，不写明文值。
5. 写入前生成临时文件，成功后原子替换。
6. Run Event 只追加。

## 7. Runtime Adapter Contract

Adapter 输入：

```json
{
  "adapter_id": "codex-cli",
  "node_run_id": "nr_001",
  "capability_requirements": ["content.longform_draft"],
  "inputs": [],
  "provider_policy": {},
  "runtime_metadata": {}
}
```

Adapter 输出：

```json
{
  "status": "succeeded",
  "operation_id": "op_001",
  "node_run_id": "nr_001",
  "attempt_id": "attempt_001",
  "provider_receipt": {
    "provider": "local",
    "request_id": "local_req_001",
    "model": "codex-cli"
  },
  "artifact_descriptors": [
    {
      "logical_id": "md_master_draft",
      "type": "markdown",
      "path_handle": "artifacts/md_master_v1.md",
      "hash": "sha256:..."
    }
  ],
  "proposed_events": [],
  "cost": {
    "amount": 0.28,
    "currency": "USD"
  },
  "runtime_metadata": {
    "adapter": "codex-cli",
    "provider": "local"
  }
}
```

失败输出：

```json
{
  "status": "failed",
  "operation_id": "op_001",
  "node_run_id": "nr_001",
  "attempt_id": "attempt_001",
  "provider_receipt": {
    "provider": "remote-api",
    "request_id": "req_failed_001"
  },
  "error": {
    "code": "provider_failure",
    "message": "Provider unavailable",
    "recoverable": true
  },
  "suggested_actions": ["switch_provider", "retry_later"]
}
```

状态枚举：

```text
succeeded / failed / timed_out / cancelled / aborted / unknown
```

Adapter Contract 规则：

1. AdapterResult 必须带 `operation_id`、`node_run_id` 和 `attempt_id`，用于和 dispatched / received / committed 协议对账。
2. `provider_receipt` 必须脱敏保存，可为空但字段必须存在。
3. `artifact_descriptors` 只描述产物，不直接创建 ArtifactManifest。
4. `proposed_events` 只是候选事件摘要，不直接写 Event Journal。
5. Orchestrator 收到 AdapterResult 后，单写入 TraceEvent、NodeAttempt、ArtifactManifest 和投影。

P3 只定义 contract，不要求所有 adapter 实现。

## 8. 错误模型

统一错误：

| code | 用途 |
|---|---|
| `validation_error` | Spec 或引用不合法。 |
| `missing_credential` | 缺凭证。 |
| `permission_denied` | 权限不足或 workspace 不允许。 |
| `provider_failure` | Provider 调用失败。 |
| `filesystem_error` | 本地文件读写失败。 |
| `conflict` | UI、文件、模板版本冲突。 |
| `not_found` | 对象不存在。 |
| `unknown` | 未分类错误。 |

错误必须包含：

```json
{
  "code": "missing_credential",
  "message": "缺少 VOLC_TTS_API_KEY",
  "object_type": "ProviderPolicy",
  "object_id": "volc-tts",
  "recoverable": true,
  "suggested_actions": ["configure_credential", "switch_provider"]
}
```

## 9. 安全边界

MVP 必做：

1. 本地服务只监听 `127.0.0.1`。
2. API 使用 session token。
3. 检查 Origin / CSRF。
4. workspace handle 白名单。
5. path normalize 和 symlink 检查。
6. 高风险动作需要短时确认票据。
7. 不把密钥写入 Git 可见文件。

后续商业化：

1. Auth/OIDC。
2. 组织和租户隔离。
3. RBAC/ABAC。
4. 审计日志不可篡改。
5. 计费和额度。
6. Worker 沙箱。

## 10. P3 API 验收

P3 设计完成后必须能映射：

| 页面 | 主要 API |
|---|---|
| 首页 | `/runs`、`/attention`、`/registry/templates`、`/artifacts` |
| 新任务 | `/domains`、`/registry/templates`、`/workflows/:id/dry-run`、`POST /runs` |
| Dry-run | `/workflows/:id/validate`、`/workflows/:id/dry-run`、`POST /runs` |
| Run 工作区 | `/runs/:id`、`/runs/:id/events`、`/runs/:id/nodes/:nodeRunId`、`POST /runs/:id/nodes/:nodeRunId/execute` |
| Attention | `/attention`、`/attention/:id`、`/attention/:id/actions` |
| Agent Collaboration | `/agents/health`、`/agents/collaboration` |
| 审核抽屉 | `/artifacts/:id`、`/gates/:id`、`/gates/:id/decision` |

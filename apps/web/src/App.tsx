import {
  AlertTriangle,
  Archive,
  Bot,
  Boxes,
  CheckCircle2,
  ClipboardCheck,
  Eye,
  FileSearch,
  FileText,
  GitBranch,
  Home,
  LayoutDashboard,
  Loader2,
  Move,
  Network,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  Square,
  Workflow,
  XCircle
} from "lucide-react";
import { Background, Controls, MarkerType, ReactFlow, type Edge as FlowEdge, type Node as FlowNode } from "@xyflow/react";
import { useEffect, useMemo, useState } from "react";
import { artifactPreviewCapability, confidenceLabel, eventSortDescending, gapLabel, isHistoricalRun } from "./historical";
import { canConfirmRunDraft, runDraftModeLabel, summarizeBranchImpact } from "./run-drafts";

type Page = "home" | "new" | "dryrun" | "run" | "attention" | "agents" | "artifacts" | "review" | "canvas" | "sync" | "evolution";
type ApiState<T> = { loading: boolean; data?: T; error?: string; refreshing?: boolean; updatedAt?: number };

const apiBase = "/api/v0";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    headers: { "content-type": "application/json" },
    ...init
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

function useApi<T>(path: string, deps: unknown[] = [], enabled = true): ApiState<T> {
  const [state, setState] = useState<ApiState<T>>({ loading: true });
  useEffect(() => {
    if (!enabled) {
      setState({ loading: false });
      return;
    }
    let alive = true;
    setState((current) => current.data ? { ...current, loading: false, refreshing: true, error: undefined } : { loading: true });
    api<T>(path)
      .then((data) => alive && setState({ loading: false, refreshing: false, data, updatedAt: Date.now() }))
      .catch((error: Error) => alive && setState((current) => ({ ...current, loading: false, refreshing: false, error: error.message })));
    return () => {
      alive = false;
    };
  }, [...deps, enabled]);
  return state;
}

function statusClass(status: string) {
  if (["done", "completed", "approved", "succeeded"].includes(status)) return "ok";
  if (["running", "reviewing"].includes(status)) return "info";
  if (["blocked", "failed", "rejected", "missing", "reject", "request_changes"].includes(status)) return "danger";
  if (["pending_review", "waiting"].includes(status)) return "warn";
  return "muted";
}

function latestDecision(gate?: any) {
  const decisions = gate?.decisions ?? [];
  return decisions.length > 0 ? decisions[decisions.length - 1] : undefined;
}

function eventAuditMeta(type: string) {
  const map: Record<string, { label: string; className: string }> = {
    rework_attempt_created: { label: "返工 attempt", className: "audit" },
    artifact_manifest_created: { label: "产物版本创建", className: "audit" },
    gate_pending_review: { label: "Gate 待审核", className: "gate" },
    gate_decision_created: { label: "Gate 决策", className: "gate" },
    runner_operation_dispatched: { label: "Runner 派发", className: "runner" },
    adapter_result_received: { label: "Adapter 回执", className: "runner" },
    node_run_committed: { label: "NodeRun 提交", className: "runner" },
    scheduler_tick_started: { label: "Scheduler 启动", className: "runner" },
    scheduler_tick_completed: { label: "Scheduler 完成", className: "runner" },
    scheduler_run_started: { label: "Scheduler 连续推进", className: "runner" },
    scheduler_run_completed: { label: "Scheduler 停止", className: "runner" },
    attention_item_created: { label: "Attention 创建", className: "danger" },
    node_blocked: { label: "节点阻塞", className: "danger" },
    node_done: { label: "节点完成", className: "ok" },
    run_created: { label: "Run 创建", className: "muted" }
  };
  return map[type] ?? { label: type, className: "muted" };
}

function nodeStatusSummary(nodes: any[] = []) {
  return nodes.reduce((summary, node) => {
    const status = String(node.status ?? "unknown");
    if (status === "done" || status === "succeeded") summary.succeeded += 1;
    else if (status === "running") summary.running += 1;
    else if (status === "queued") summary.queued += 1;
    else if (status === "blocked") summary.blocked += 1;
    else if (status === "failed") summary.failed += 1;
    else summary.other += 1;
    return summary;
  }, { running: 0, queued: 0, blocked: 0, failed: 0, succeeded: 0, other: 0 });
}

function executionFeedback(status: string) {
  const map: Record<string, { title: string; body: string; action: string; tone: string }> = {
    running: {
      title: "节点正在执行",
      body: "轮询会自动刷新 NodeRun、Attempt 和事件审计。若长期无新事件，可手动刷新或检查 Sidecar 日志。",
      action: "等待 AdapterResult 回执",
      tone: "info"
    },
    reviewing: {
      title: "产物等待人工审核",
      body: "节点执行已经完成，ArtifactManifest 与 GateInstance 已提交。审核通过前不会自动进入受 Gate 约束的下游。",
      action: "查看 Gate",
      tone: "warn"
    },
    queued: {
      title: "节点等待调度",
      body: "可使用调度一次或自动推进触发 Scheduler；若上游 Gate 未通过，Scheduler 会保持暂停。",
      action: "运行 Scheduler",
      tone: "info"
    },
    blocked: {
      title: "节点被阻塞",
      body: "优先查看 Attention 根因。常见恢复动作是补凭证、切换 Provider、跳过可选分支或完成人工审核。",
      action: "查看 Attention 或审核",
      tone: "danger"
    },
    failed: {
      title: "最近一次执行失败",
      body: "先确认 NodeAttempt 的 AdapterResult，再决定重试、切换 Provider 或创建返工版本。失败事实保留在事件审计中。",
      action: "检查 Attempt 与事件",
      tone: "danger"
    },
    succeeded: {
      title: "节点已成功",
      body: "下游节点会在依赖满足后进入 queued/running；产物可在 Artifact Board 中查看。",
      action: "查看下游或产物",
      tone: "ok"
    },
    done: {
      title: "节点已完成",
      body: "下游节点会在依赖满足后进入 queued/running；产物可在 Artifact Board 中查看。",
      action: "查看下游或产物",
      tone: "ok"
    }
  };
  return map[status] ?? {
    title: "等待运行事实",
    body: "当前状态暂未映射到自动恢复动作，请查看 NodeRun JSON 和事件审计。",
    action: "查看事件",
    tone: "muted"
  };
}

function formatUpdatedAt(value?: number) {
  if (!value) return "尚未刷新";
  return new Date(value).toLocaleTimeString();
}

export function App() {
  const [page, setPage] = useState<Page>("home");
  const [workflowId, setWorkflowId] = useState("content-production-v0");
  const [draftId, setDraftId] = useState("");
  const [runId, setRunId] = useState("run-demo-001");
  const [selectedNode, setSelectedNode] = useState("nr_run-demo-001_E_tts");
  const [selectedAttention, setSelectedAttention] = useState("att_tts_credential");
  const [selectedArtifact, setSelectedArtifact] = useState("art_md_master_v2");
  const [selectedGate, setSelectedGate] = useState("gate-md-master-001");

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brandMark">M</div>
          <div>
            <strong>Miracle 奇迹系统</strong>
            <span>本地优先 · Agent OS</span>
          </div>
        </div>
        <nav>
          <NavButton page="home" active={page} setPage={setPage} icon={<Home size={18} />} label="首页" />
          <NavButton page="new" active={page} setPage={setPage} icon={<Plus size={18} />} label="新任务" />
          <NavButton page="dryrun" active={page} setPage={setPage} icon={<ShieldCheck size={18} />} label="Dry-run" />
          <NavButton page="run" active={page} setPage={setPage} icon={<Workflow size={18} />} label="任务运行" />
          <NavButton page="attention" active={page} setPage={setPage} icon={<AlertTriangle size={18} />} label="Attention" />
          <NavButton page="agents" active={page} setPage={setPage} icon={<Bot size={18} />} label="智能体" />
          <NavButton page="artifacts" active={page} setPage={setPage} icon={<Archive size={18} />} label="产物" />
          <NavButton page="review" active={page} setPage={setPage} icon={<ClipboardCheck size={18} />} label="审核" />
          <NavButton page="canvas" active={page} setPage={setPage} icon={<LayoutDashboard size={18} />} label="画布草稿" />
          <NavButton page="sync" active={page} setPage={setPage} icon={<GitBranch size={18} />} label="Spec Sync" />
          <NavButton page="evolution" active={page} setPage={setPage} icon={<Sparkles size={18} />} label="进化占位" />
        </nav>
        <div className="localStatus">
          <span>Local Sidecar</span>
          <strong>运行中</strong>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="workspace">默认工作区</div>
          <div className="search"><Search size={16} /> 搜索 Run、Workflow、Agent、Artifact...</div>
          <button className="primary" onClick={() => setPage("new")}><Plus size={16} /> 新任务</button>
          <div className="health"><span /> 本地服务 健康</div>
        </header>

        {page === "home" && <HomePage go={setPage} setRunId={setRunId} setAttention={setSelectedAttention} />}
        {page === "new" && <NewTaskPage workflowId={workflowId} setWorkflowId={setWorkflowId} setDraftId={setDraftId} go={setPage} />}
        {page === "dryrun" && <DryRunPage workflowId={workflowId} draftId={draftId} setRunId={setRunId} go={setPage} />}
        {page === "run" && <RunPage runId={runId} setRunId={setRunId} selectedNode={selectedNode} setSelectedNode={setSelectedNode} go={setPage} />}
        {page === "attention" && <AttentionPage runId={runId} selected={selectedAttention} setSelected={setSelectedAttention} setSelectedGate={setSelectedGate} go={setPage} />}
        {page === "agents" && <AgentsPage runId={runId} />}
        {page === "artifacts" && <ArtifactsPage runId={runId} selectedArtifact={selectedArtifact} setSelectedArtifact={setSelectedArtifact} />}
        {page === "review" && <ReviewPage runId={runId} selectedGate={selectedGate} setSelectedGate={setSelectedGate} />}
        {page === "canvas" && <CanvasPage workflowId={workflowId} />}
        {page === "sync" && <Placeholder title="Visual / Spec Sync" description="MVPS09 第一轮只保留入口和 spec diff 概念。文件 watcher 和冲突合并在后续实现。" />}
        {page === "evolution" && <Placeholder title="Evolution Board v0" description="MVPS10 第一轮只保留入口和 EvolutionCandidate 类型。进化建议算法在真实运行数据积累后实现。" />}
      </main>
    </div>
  );
}

function NavButton({ page, active, setPage, icon, label }: { page: Page; active: Page; setPage: (page: Page) => void; icon: React.ReactNode; label: string }) {
  return (
    <button className={active === page ? "nav active" : "nav"} onClick={() => setPage(page)}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function HomePage({ go, setRunId, setAttention }: { go: (page: Page) => void; setRunId: (id: string) => void; setAttention: (id: string) => void }) {
  const runs = useApi<{ runs: any[] }>("/runs", []);
  const attention = useApi<{ attention: any[] }>("/attention", []);
  const templates = useApi<{ templates: any[] }>("/registry/templates", []);
  const artifacts = useApi<{ artifacts: any[] }>("/artifacts", []);

  return (
    <section className="page">
      <PageTitle eyebrow="Action Center" title="待我处理" subtitle="任务、风险、产物和本地服务状态集中展示。" />
      <div className="grid two">
        <Panel title="Attention Queue" count={attention.data?.attention.length}>
          <DataState state={attention}>
            {attention.data?.attention.map((item) => (
              <button className="rowButton" key={item.attention_id} onClick={() => { setAttention(item.attention_id); go("attention"); }}>
                <Severity severity={item.severity} />
                <div><strong>{item.title}</strong><span>{item.root_cause_key}</span></div>
                <Pill value={item.status} />
              </button>
            ))}
          </DataState>
        </Panel>
        <Panel title="继续运行" count={runs.data?.runs.length}>
          <DataState state={runs}>
            {runs.data?.runs.map((run) => (
              <button className="runRow" key={run.run_id} onClick={() => { setRunId(run.run_id); go("run"); }}>
                <Play size={16} />
                <div><strong>{run.workflow_id}</strong><span>{run.run_id}</span>{run.view_meta?.origin === "historical_import" && <small className="historicalInline">Historical · {confidenceLabel(run.view_meta.source_confidence)}</small>}</div>
                <progress value={run.progress.done} max={run.progress.total} />
                <Pill value={run.status} />
              </button>
            ))}
          </DataState>
        </Panel>
      </div>
      <div className="grid four">
        {templates.data?.templates.slice(0, 4).map((template) => (
          <button className="quick" key={template.template_id} onClick={() => go("dryrun")}>
            <Boxes size={22} />
            <strong>{template.name}</strong>
            <span>{template.domain} · {template.status}</span>
          </button>
        ))}
      </div>
      <div className="grid two">
        <Panel title="最近交付" count={artifacts.data?.artifacts.length}>
          <DataState state={artifacts}>
            {artifacts.data?.artifacts.slice(0, 5).map((artifact) => (
              <div className="simpleRow" key={artifact.artifact_id}>
                <FileText size={16} />
                <span>{artifact.artifact_id}</span>
                <Pill value={artifact.review_status} />
              </div>
            ))}
          </DataState>
        </Panel>
        <Panel title="系统风险">
          <div className="riskList">
            <div><AlertTriangle size={18} /> TTS 凭证未配置 <Pill value="P0" /></div>
            <div><ShieldCheck size={18} /> Sidecar 本地模式 <Pill value="healthy" /></div>
          </div>
        </Panel>
      </div>
    </section>
  );
}

function NewTaskPage({ workflowId, setWorkflowId, setDraftId, go }: { workflowId: string; setWorkflowId: (id: string) => void; setDraftId: (id: string) => void; go: (page: Page) => void }) {
  const domains = useApi<{ domains: any[] }>("/domains", []);
  const templates = useApi<{ templates: any[] }>("/registry/templates", []);
  const [topicBrief, setTopicBrief] = useState("Codex 与 Claude Code 最新动态");
  const [includeVideo, setIncludeVideo] = useState(false);
  const [executionPolicy, setExecutionPolicy] = useState<"auto" | "manual" | "hybrid">("hybrid");
  const [createState, setCreateState] = useState("");

  async function createDraft() {
    setCreateState("正在创建 RunDraft");
    try {
      const result = await api<any>("/run-drafts", {
        method: "POST",
        body: JSON.stringify({
          workflow_id: workflowId,
          inputs: { topic_brief: topicBrief },
          enabled_optional_paths: includeVideo ? ["video_package"] : [],
          execution_policy: executionPolicy
        })
      });
      setDraftId(result.draft.draft_id);
      setCreateState(`草案已创建 · ${result.draft.draft_id}`);
      go("dryrun");
    } catch (error) {
      setCreateState(error instanceof Error ? error.message : "RunDraft 创建失败");
    }
  }

  return (
    <section className="page">
      <PageTitle eyebrow="New Task" title="启动新任务" subtitle="选择模板并创建 RunDraft；确认前不会创建 RunSpec、NodeRun 或 TraceEvent。" />
      <div className="grid two">
        <Panel title="领域">
          <DataState state={domains}>
            <div className="chipGrid">{domains.data?.domains.map((domain) => <span className="domainChip" key={domain.id}>{domain.name}<small>{domain.id}</small></span>)}</div>
          </DataState>
        </Panel>
        <Panel title="模板">
          <DataState state={templates}>
            {templates.data?.templates.map((template) => (
              <label className="templateOption" key={template.workflow_id}>
                <input type="radio" checked={workflowId === template.workflow_id} onChange={() => setWorkflowId(template.workflow_id)} />
                <span><strong>{template.name}</strong><small>{template.domain} · {template.version}</small></span>
              </label>
            ))}
          </DataState>
        </Panel>
      </div>
      <Panel title="启动配置">
        <div className="draftComposer">
          <label><span>任务主题</span><input value={topicBrief} onChange={(event) => setTopicBrief(event.target.value)} /></label>
          <label><span>执行策略</span><select value={executionPolicy} onChange={(event) => setExecutionPolicy(event.target.value as typeof executionPolicy)}><option value="hybrid">Hybrid</option><option value="manual">Manual</option><option value="auto">Auto</option></select></label>
          <label className="checkboxOption"><input type="checkbox" checked={includeVideo} onChange={(event) => setIncludeVideo(event.target.checked)} /><span>启用可选视频分支</span></label>
        </div>
      </Panel>
      <div className="actionBar"><button className="primary" onClick={createDraft} disabled={!topicBrief.trim()}><ShieldCheck size={16} /> 创建草案并 Dry-run</button></div>
      {createState && <div className="receiptLine">{createState}</div>}
    </section>
  );
}

function DryRunPage({ workflowId, draftId, setRunId, go }: { workflowId: string; draftId: string; setRunId: (id: string) => void; go: (page: Page) => void }) {
  const draftBundle = useApi<any>(`/run-drafts/${draftId}`, [draftId], Boolean(draftId));
  const [plan, setPlan] = useState<ApiState<any>>({ loading: false });
  const [actionState, setActionState] = useState("");
  const [localBundle, setLocalBundle] = useState<any>();
  const [topicEdit, setTopicEdit] = useState("");
  const [includeVideoEdit, setIncludeVideoEdit] = useState(false);

  useEffect(() => {
    if (!draftBundle.data?.draft || localBundle) return;
    setTopicEdit(String(draftBundle.data.draft.inputs?.topic_brief ?? ""));
    setIncludeVideoEdit(draftBundle.data.draft.enabled_optional_paths?.includes("video_package") ?? false);
  }, [draftBundle.data, localBundle]);

  useEffect(() => {
    if (!draftId) {
      setPlan({ loading: false, error: "请先在“新任务”页面创建 RunDraft" });
      return;
    }
    const revision = draftBundle.data?.draft?.revision;
    if (typeof revision !== "number") return;
    let alive = true;
    setPlan({ loading: true });
    api<any>(`/run-drafts/${draftId}/dry-run`, { method: "POST", body: JSON.stringify({ expected_revision: revision }) })
      .then((data) => {
        if (!alive) return;
        setLocalBundle(data);
        setPlan({ loading: false, refreshing: false, data, updatedAt: Date.now() });
      })
      .catch((error: Error) => alive && setPlan((current) => ({ ...current, loading: false, refreshing: false, error: error.message })));
    return () => {
      alive = false;
    };
  }, [draftId, draftBundle.data?.draft?.revision]);

  const draft = localBundle?.draft ?? plan.data?.draft ?? draftBundle.data?.draft;
  const draftPlan = localBundle?.plan ?? plan.data?.plan ?? draftBundle.data?.plan;
  const branchSummary = summarizeBranchImpact(draftPlan?.branch_impact ?? []);
  const confirmable = canConfirmRunDraft(draft, draftPlan);

  async function confirmDraft() {
    if (!draftId || !draftPlan?.plan_hash) return;
    setActionState("正在记录启动确认");
    try {
      const result = await api<any>(`/run-drafts/${draftId}/confirmation`, {
        method: "POST",
        body: JSON.stringify({
          decision: "confirm",
          expected_revision: draft.revision,
          plan_hash: draftPlan.plan_hash,
          acknowledgements: draftPlan.required_acknowledgements,
          actor: "operator",
          comment: "已确认当前 Dry-run 计划与风险"
        })
      });
      setLocalBundle(result);
      setActionState("计划已确认；等待真实 Adapter 就绪后才能转换为正式 Run");
    } catch (error) {
      setActionState(error instanceof Error ? error.message : "确认失败");
    }
  }

  async function saveAndDryRun() {
    if (!draftId || typeof draft?.revision !== "number") return;
    setActionState("正在保存草案并重新 Dry-run");
    try {
      const updated = await api<any>(`/run-drafts/${draftId}`, {
        method: "PATCH",
        body: JSON.stringify({
          expected_revision: draft.revision,
          inputs: { ...draft.inputs, topic_brief: topicEdit },
          enabled_optional_paths: includeVideoEdit ? ["video_package"] : [],
          actor: "operator"
        })
      });
      const replanned = await api<any>(`/run-drafts/${draftId}/dry-run`, {
        method: "POST",
        body: JSON.stringify({ expected_revision: updated.draft.revision, actor: "operator" })
      });
      setLocalBundle(replanned);
      setPlan({ loading: false, data: replanned, updatedAt: Date.now() });
      setActionState("草案已更新，旧确认已失效，新的 Dry-run 计划已生成");
    } catch (error) {
      setActionState(error instanceof Error ? error.message : "草案更新失败");
    }
  }

  async function decideDraft(decision: "revise" | "cancel") {
    if (!draftId || typeof draft?.revision !== "number") return;
    setActionState(decision === "revise" ? "正在撤回确认" : "正在取消草案");
    try {
      const result = await api<any>(`/run-drafts/${draftId}/confirmation`, {
        method: "POST",
        body: JSON.stringify({ decision, expected_revision: draft.revision, actor: "operator" })
      });
      setLocalBundle(result);
      if (decision === "revise") {
        setPlan({ loading: false });
        setActionState("确认已撤回；修改后请重新生成 Dry-run");
      } else {
        setActionState("草案已取消；未创建任何正式 Run 事实");
      }
    } catch (error) {
      setActionState(error instanceof Error ? error.message : "草案决策失败");
    }
  }

  async function tryStartRun() {
    if (!draftId || !draftPlan?.plan_hash) return;
    setActionState("正在检查 Adapter 启动条件");
    try {
      const result = await api<any>("/runs", { method: "POST", body: JSON.stringify({
        draft_id: draftId,
        draft_plan_id: draftPlan.draft_plan_id,
        plan_hash: draftPlan.plan_hash,
        confirmation_id: localBundle?.confirmation?.confirmation_id ?? plan.data?.confirmation?.confirmation_id
      }) });
      setRunId(result.run_id);
      go("run");
    } catch (error) {
      setActionState(error instanceof Error ? error.message : "Adapter 尚未就绪");
    }
  }

  return (
    <section className="page">
      <PageTitle eyebrow="Dry-run" title="启动前检查" subtitle={`${runDraftModeLabel(draft?.status ?? "draft")} · ${draftId || workflowId}`} />
      <div className="draftModeBanner"><strong>{runDraftModeLabel(draft?.status ?? "draft")}</strong><span>RunDraft 只记录启动意图和确认，不属于正式运行事实。</span><Pill value={draft?.status ?? "draft"} /></div>
      <Panel title="草案输入与可选分支">
        <div className="draftComposer">
          <label><span>任务主题</span><input value={topicEdit} onChange={(event) => setTopicEdit(event.target.value)} disabled={draft?.status === "cancelled"} /></label>
          <label className="checkboxOption"><input type="checkbox" checked={includeVideoEdit} onChange={(event) => setIncludeVideoEdit(event.target.checked)} disabled={draft?.status === "cancelled"} /><span>启用可选视频分支</span></label>
          <button onClick={saveAndDryRun} disabled={!topicEdit.trim() || draft?.status === "cancelled" || draft?.status === "converted"}><ShieldCheck size={16} /> 保存并重新 Dry-run</button>
        </div>
      </Panel>
      <Panel title="执行计划与风险">
        <DataState state={plan}>
          <div className="metricRow">
            <Metric label="节点" value={String(draftPlan?.core_plan?.nodes?.length ?? draftPlan?.execution_summary?.node_count ?? 0)} />
            <Metric label="风险" value={String(draftPlan?.risks?.length ?? draftPlan?.core_plan?.risks?.length ?? 0)} />
            <Metric label="Required path" value={String(draftPlan?.startability?.required_path ?? "-")} />
            <Metric label="Optional blocked" value={String(branchSummary.optional_blocked)} />
            <Metric label="成本区间" value={`${draftPlan?.core_plan?.estimated_cost?.min ?? "-"}-${draftPlan?.core_plan?.estimated_cost?.max ?? "-"} ${draftPlan?.core_plan?.estimated_cost?.currency ?? ""}`} />
            <Metric label="预计时长" value={`${draftPlan?.execution_summary?.estimated_duration_minutes?.min ?? "-"}-${draftPlan?.execution_summary?.estimated_duration_minutes?.max ?? "-"} 分钟`} />
          </div>
          <div className="riskCards">
            {(draftPlan?.risks ?? draftPlan?.core_plan?.risks ?? []).map((risk: any) => (
              <div className="riskCard" key={`${risk.code}-${risk.message}`}>
                <Severity severity={risk.severity} />
                <strong>{risk.code}</strong>
                <span>{risk.message ?? risk.blocking_scope}</span>
              </div>
            ))}
          </div>
          <div className="draftPlanGrid">
            <div><strong>分支影响</strong>{(draftPlan?.branch_impact ?? []).map((branch: any) => <span key={branch.branch_id}>{branch.branch_id} · {branch.selection} · {branch.readiness}</span>)}</div>
            <div><strong>审核门</strong>{(draftPlan?.gate_plan ?? []).map((gate: any) => <span key={gate.gate_spec_id}>{gate.gate_spec_id} · manual · blocks {gate.required_before?.length ?? 0}</span>)}</div>
            <div><strong>凭证检查</strong>{(draftPlan?.credential_checks ?? []).map((credential: any) => <span key={credential.credential_ref}>{credential.credential_ref} · {credential.status} · {credential.blocking_scope}</span>)}</div>
            <div><strong>Provider 解析</strong>{(draftPlan?.provider_resolution ?? []).map((item: any) => <span key={item.node_id}>{item.node_id} · {item.provider}</span>)}</div>
          </div>
        </DataState>
      </Panel>
      <div className="actionBar">
        <button onClick={() => decideDraft("revise")} disabled={draft?.status !== "confirmed"}>撤回确认</button>
        <button className="dangerAction" onClick={() => decideDraft("cancel")} disabled={draft?.status === "cancelled" || draft?.status === "converted"}>取消草案</button>
        <button className="primary" onClick={confirmDraft} disabled={!confirmable}><CheckCircle2 size={16} /> 确认当前计划</button>
        <button onClick={tryStartRun} disabled={draft?.status !== "confirmed"}><Play size={16} /> 启动正式 Run</button>
      </div>
      {actionState && <div className="receiptLine">{actionState}</div>}
    </section>
  );
}

function RunPage({ runId, setRunId, selectedNode, setSelectedNode, go }: { runId: string; setRunId: (id: string) => void; selectedNode: string; setSelectedNode: (id: string) => void; go: (page: Page) => void }) {
  const [refresh, setRefresh] = useState(0);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(true);
  const [lastAutoRefreshAt, setLastAutoRefreshAt] = useState<number>();
  const [executeState, setExecuteState] = useState<string>("");
  const [schedulerState, setSchedulerState] = useState<string>("");
  const runs = useApi<{ runs: any[] }>("/runs", []);
  const run = useApi<any>(`/runs/${runId}`, [runId, refresh]);
  const dag = useApi<any>(`/runs/${runId}/dag`, [runId, refresh]);
  const events = useApi<any>(`/runs/${runId}/events`, [runId, refresh]);
  const operations = useApi<{ operations: any[] }>(`/operations?run_id=${runId}`, [runId, refresh]);
  const attention = useApi<any>(`/attention?run_id=${runId}`, [runId, refresh]);
  const nodesForRun = (dag.data?.dag.nodes ?? []).filter((item: any) => String(item.node_run_id ?? "").startsWith(`nr_${runId}_`));
  const selectedNodeForRun = selectedNode.startsWith(`nr_${runId}_`) && nodesForRun.some((item: any) => item.node_run_id === selectedNode) ? selectedNode : (nodesForRun[0]?.node_run_id ?? "");
  const node = useApi<any>(`/runs/${runId}/nodes/${selectedNodeForRun}`, [runId, selectedNodeForRun, refresh], Boolean(selectedNodeForRun));
  const historical = isHistoricalRun(run.data?.run, run.data?.view_meta);
  const activeOperation = operations.data?.operations.find((operation) => operation.node_run_id === selectedNodeForRun);
  const selectedGateForNode = run.data?.gates?.find((gate: any) => (node.data?.node?.output_artifacts ?? []).includes(gate.target?.id));
  const statusSummary = useMemo(() => nodeStatusSummary(run.data?.nodes ?? []), [run.data?.nodes]);
  const attentionCount = attention.data?.attention?.length ?? run.data?.attention?.length ?? 0;
  const stages = useMemo(() => {
    const workflow = run.data?.workflow;
    if (!workflow) return [];
    return Array.from(new Set(Object.values(workflow.layouts?.dag ?? {}).map((item: any) => item.stage ?? "默认阶段")));
  }, [run.data]);
  const flowNodes = useMemo<FlowNode[]>(() => {
    return (dag.data?.dag.nodes ?? []).map((item: any) => ({
      id: item.id,
      type: "default",
      position: { x: Math.round(item.position.x * 0.55), y: Math.round(item.position.y * 1.15) },
      data: {
        label: (
          <div className={`flowNode ${statusClass(item.status)}`}>
            <strong>{item.name}</strong>
            <span>{item.agent_id ?? "-"} · NodeRun · {item.status}</span>
            <small>{item.stage}</small>
          </div>
        ),
        nodeRunId: item.node_run_id
      },
      className: item.node_run_id === selectedNodeForRun ? "flowShell selected" : "flowShell"
    }));
  }, [dag.data, selectedNodeForRun]);
  const flowEdges = useMemo<FlowEdge[]>(() => {
    return (dag.data?.dag.edges ?? []).map((item: any) => ({
      id: item.id,
      source: item.from,
      target: item.to,
      label: item.label,
      animated: !item.required,
      markerEnd: { type: MarkerType.ArrowClosed },
      style: { stroke: item.required ? "#1d64e8" : "#f59e0b", strokeWidth: item.required ? 2 : 1.5 },
      labelStyle: { fill: item.required ? "#1d64e8" : "#9a5b00", fontWeight: 700 }
    }));
  }, [dag.data]);
  useEffect(() => {
    const firstNodeRunId = nodesForRun[0]?.node_run_id;
    const selectedExists = nodesForRun.some((item: any) => item.node_run_id === selectedNode);
    if (firstNodeRunId && !selectedExists) setSelectedNode(firstNodeRunId);
  }, [nodesForRun, selectedNode, setSelectedNode]);
  useEffect(() => {
    if (!autoRefreshEnabled || !runId) return;
    const intervalId = window.setInterval(() => {
      setLastAutoRefreshAt(Date.now());
      setRefresh((value) => value + 1);
    }, 5000);
    return () => window.clearInterval(intervalId);
  }, [autoRefreshEnabled, runId]);

  async function executeSelectedNode() {
    if (!selectedNodeForRun || historical) return;
    setExecuteState("执行中");
    try {
      const result = await api<any>(`/runs/${runId}/nodes/${selectedNodeForRun}/execute`, { method: "POST", body: JSON.stringify({}) });
      setExecuteState(`已提交 · ${result.adapter_result.status}`);
      setRefresh((value) => value + 1);
    } catch (error) {
      setExecuteState(error instanceof Error ? error.message : "执行失败");
    }
  }
  async function runSchedulerTick() {
    if (historical) return;
    setSchedulerState("Scheduler tick 执行中");
    try {
      const result = await api<any>(`/runs/${runId}/scheduler/tick`, { method: "POST", body: JSON.stringify({ max_nodes: 1 }) });
      setSchedulerState(`Scheduler 完成 · executed ${result.executed?.length ?? 0} · paused ${result.paused?.length ?? 0}`);
      setRefresh((value) => value + 1);
    } catch (error) {
      setSchedulerState(error instanceof Error ? error.message : "Scheduler 执行失败");
    }
  }
  async function runSchedulerLoop() {
    if (historical) return;
    setSchedulerState("Scheduler 自动推进中");
    try {
      const result = await api<any>(`/runs/${runId}/scheduler/run`, { method: "POST", body: JSON.stringify({ max_ticks: 8, max_nodes_per_tick: 1 }) });
      setSchedulerState(`自动推进停止 · ${result.stop_reason} · executed ${result.summary?.nodes_executed ?? 0} · attention ${result.summary?.attention_items_created ?? 0}`);
      setRefresh((value) => value + 1);
    } catch (error) {
      setSchedulerState(error instanceof Error ? error.message : "Scheduler 自动推进失败");
    }
  }
  async function cancelActiveOperation() {
    if (!activeOperation) return;
    setExecuteState(`正在取消 ${activeOperation.operation_id}`);
    try {
      const result = await api<any>(`/operations/${activeOperation.operation_id}/cancel`, { method: "POST", body: JSON.stringify({}) });
      setExecuteState(`取消请求 · ${result.status}`);
      setRefresh((value) => value + 1);
    } catch (error) {
      setExecuteState(error instanceof Error ? error.message : "取消操作失败");
    }
  }
  const selectedStatus = String(node.data?.node?.status ?? "");
  const executable = ["queued", "running"].includes(selectedStatus);

  return (
    <section className="page">
      <PageTitle eyebrow="Run Workspace" title={String(run.data?.run.workflow_id ?? runId)} subtitle={`${runId} · RunSpec / WorkflowSnapshot 只读`} />
      {historical && (
        <div className="historicalBanner">
          <div><strong>Historical · Read-only</strong><span>本次 Run 来自历史工作区投影，不会调用 Runner，也不会修改源文件。</span></div>
          <Pill value={confidenceLabel(run.data?.view_meta?.source_confidence)} />
          {run.data?.source_meta?.gaps?.length > 0 && <small>{run.data.source_meta.gaps.length} 个证据缺口</small>}
          {run.data?.source_meta?.gaps?.length > 0 && <div className="historicalGaps">{run.data.source_meta.gaps.map((gap: any) => <span key={gap.code}>{gapLabel(gap)}</span>)}</div>}
        </div>
      )}
      <div className="runHeader">
        <label className="runSelector"><span>当前 Run</span><select value={runId} onChange={(event) => setRunId(event.target.value)}>{runs.data?.runs.map((item) => <option key={item.run_id} value={item.run_id}>{item.run_id}</option>)}</select></label>
        <Metric label="状态" value={String(run.data?.run.status ?? "-")} />
        <Metric label="节点" value={String((run.data?.nodes ?? []).length)} />
        <Metric label="Attention" value={String(attentionCount)} />
        <div className="refreshPanel">
          <div>
            <RefreshCw className={run.refreshing || events.refreshing || attention.refreshing ? "spin" : ""} size={16} />
            <strong>{autoRefreshEnabled ? "自动刷新中" : "自动刷新暂停"}</strong>
          </div>
          <small>间隔 5s · 最近 {formatUpdatedAt(run.updatedAt ?? events.updatedAt ?? attention.updatedAt ?? lastAutoRefreshAt)}</small>
          <div className="refreshActions">
            <button onClick={() => setAutoRefreshEnabled((value) => !value)}>{autoRefreshEnabled ? "暂停" : "开启"}</button>
            <button onClick={() => setRefresh((value) => value + 1)}>立即刷新</button>
          </div>
        </div>
        <button onClick={() => go("attention")}>查看 Attention</button>
        {!historical && <button onClick={runSchedulerTick}>调度一次</button>}
        {!historical && <button onClick={runSchedulerLoop}>自动推进</button>}
      </div>
      <div className="statusStrip">
        <StatusCounter label="running" value={statusSummary.running} />
        <StatusCounter label="queued" value={statusSummary.queued} />
        <StatusCounter label="blocked" value={statusSummary.blocked} />
        <StatusCounter label="failed" value={statusSummary.failed} />
        <StatusCounter label="succeeded" value={statusSummary.succeeded} />
      </div>
      {schedulerState && <div className="receiptLine">{schedulerState}</div>}
      <div className="stageTabs">{stages.map((stage) => <span key={String(stage)}>{String(stage)}</span>)}</div>
      <div className="runGrid">
        <Panel title="执行流程视图">
          <DataState state={dag}>
            <div className="flowCanvas">
              <ReactFlow
                nodes={flowNodes}
                edges={flowEdges}
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable
                fitView
                onNodeClick={(_, clicked) => clicked.data.nodeRunId && setSelectedNode(String(clicked.data.nodeRunId))}
              >
                <Controls showInteractive={false} />
                <Background gap={22} size={1} />
              </ReactFlow>
            </div>
            <div className="flowLegend"><span><i className="requiredLine" /> required</span><span><i className="optionalLine" /> optional</span><span>layout 只影响 UI，不影响执行依赖</span></div>
          </DataState>
        </Panel>
        <Panel title="所选节点上下文">
          <DataState state={node}>
            <div className="nodeContext">
              <div className="detailHeader">
                <Workflow size={22} />
                <div>
                  <strong>{node.data?.node?.node_id ?? selectedNodeForRun}</strong>
                  <span>{node.data?.node?.node_run_id}</span>
                </div>
                <Pill value={selectedStatus} />
              </div>
              <ExecutionFeedback status={selectedStatus} go={go} onRefresh={() => setRefresh((value) => value + 1)} />
              <div className="safeActions">
                {!historical && <button onClick={executeSelectedNode} disabled={!executable}><Play size={16} /> 执行当前节点</button>}
                {!historical && activeOperation && <button className="dangerAction" onClick={cancelActiveOperation}><Square size={15} /> 取消 Operation</button>}
                {selectedGateForNode && <button onClick={() => go("review")}><ClipboardCheck size={15} /> 查看 Gate</button>}
                <button onClick={() => setRefresh((value) => value + 1)}>刷新</button>
              </div>
              {activeOperation && (
                <div className="operationCard">
                  <div><strong>实时 Operation</strong><Pill value={activeOperation.status} /></div>
                  <span>{activeOperation.adapter_id} · {activeOperation.provider}</span>
                  <small>{activeOperation.operation_id}</small>
                </div>
              )}
              {selectedGateForNode && (
                <div className="gateInline">
                  <strong>{selectedGateForNode.gate_spec_id}</strong>
                  <Pill value={selectedGateForNode.status} />
                  <small>Artifact · {selectedGateForNode.target?.id}</small>
                </div>
              )}
              {historical && <div className="readOnlyNote">Historical Run 仅供查看，节点执行与调度操作已隐藏。</div>}
              {executeState && <div className="receiptLine">{executeState}</div>}
              <h3>NodeRun</h3>
              <pre className="jsonBlock compact">{JSON.stringify(node.data?.node, null, 2)}</pre>
              <h3>NodeAttempt</h3>
              {(node.data?.attempts ?? []).length === 0 ? (
                <div className="previewEmpty"><Archive size={24} /><strong>暂无 Attempt</strong><span>执行当前节点后会显示 AdapterResult 对账记录。</span></div>
              ) : (
                <div className="attemptList">
                  {node.data.attempts.map((attempt: any) => (
                    <div key={attempt.attempt_id}>
                      <strong>{attempt.attempt_id}</strong>
                      <Pill value={attempt.status} />
                      <span>{attempt.provider_receipt?.adapter_id ?? "-"} · {attempt.provider_receipt?.provider ?? "-"}</span>
                      <small>{attempt.operation_id} · {attempt.provider_receipt?.latency_ms ?? 0} ms · cost {attempt.provider_receipt?.cost ?? "-"}</small>
                      <small>隔离工作区元数据：{attempt.attempt_id}（不显示外部 runtime 绝对路径）</small>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </DataState>
        </Panel>
      </div>
      <Panel title="事件与审计">
        <DataState state={events}>
          {eventSortDescending(events.data?.events ?? []).map((event: any) => {
            const meta = eventAuditMeta(event.type);
            return (
              <div className={`eventRow ${meta.className}`} key={event.event_id}>
                <span>{event.created_at}</span>
                <strong>{meta.label}</strong>
                <em>{event.message}</em>
                <small>{event.subject?.type ?? "-"} · {event.subject?.id ?? "-"}</small>
              </div>
            );
          })}
        </DataState>
      </Panel>
    </section>
  );
}

function ExecutionFeedback({ status, go, onRefresh }: { status: string; go: (page: Page) => void; onRefresh: () => void }) {
  const feedback = executionFeedback(status);
  return (
    <div className={`executionFeedback ${feedback.tone}`}>
      <div>
        <strong>{feedback.title}</strong>
        <span>{feedback.body}</span>
      </div>
      <Pill value={feedback.action} />
      {["blocked", "failed"].includes(status) && (
        <div className="feedbackActions">
          <button onClick={() => go("attention")}><AlertTriangle size={14} /> 查看 Attention</button>
          <button onClick={onRefresh}><RefreshCw size={14} /> 刷新状态</button>
        </div>
      )}
    </div>
  );
}

function AttentionPage({ runId, selected, setSelected, setSelectedGate, go }: { runId: string; selected: string; setSelected: (id: string) => void; setSelectedGate: (id: string) => void; go: (page: Page) => void }) {
  const attention = useApi<{ attention: any[] }>(`/attention?run_id=${runId}`, [runId]);
  const current = attention.data?.attention.find((item) => item.attention_id === selected) ?? attention.data?.attention[0];
  useEffect(() => {
    if (attention.data?.attention[0] && !attention.data.attention.some((item) => item.attention_id === selected)) setSelected(attention.data.attention[0].attention_id);
  }, [attention.data, selected, setSelected]);
  function openReviewFromAttention() {
    const gateObject = current?.related_objects.find((object: any) => object.type === "GateInstance");
    if (gateObject?.id) setSelectedGate(gateObject.id);
    go("review");
  }
  return (
    <section className="page">
      <PageTitle eyebrow="Attention Queue" title="根因联动处置" subtitle={`${runId} · 一个根因对应一个主 Attention Item，关联对象展开显示。`} />
      <div className="attentionGrid">
        <Panel title="关注队列" count={attention.data?.attention.length}>
          <DataState state={attention}>
            {attention.data?.attention.map((item) => (
              <button className={item.attention_id === current?.attention_id ? "attentionItem active" : "attentionItem"} key={item.attention_id} onClick={() => setSelected(item.attention_id)}>
                <Severity severity={item.severity} />
                <strong>{item.title}</strong>
                <small>{item.root_cause_key}</small>
              </button>
            ))}
          </DataState>
        </Panel>
        <Panel title="详情与安全动作">
          {current && (
            <div className="detailStack">
              <h3>{current.title}</h3>
              <p>{current.root_cause_key}</p>
              <div className="objectList">{current.related_objects.map((object: any) => <span key={`${object.type}-${object.id}`}>{object.type} · {object.label ?? object.id}</span>)}</div>
              <div className="safeActions">
                {current.safe_actions.map((action: string) => (
                  <button key={action} onClick={() => action.includes("gate") && openReviewFromAttention()} disabled={!action.includes("gate")}>
                    {action}
                  </button>
                ))}
              </div>
            </div>
          )}
        </Panel>
      </div>
    </section>
  );
}

function AgentsPage({ runId }: { runId: string }) {
  const collaboration = useApi<any>(`/agents/collaboration?run_id=${runId}`, [runId]);
  return (
    <section className="page">
      <PageTitle eyebrow="Agent Collaboration" title="多 Agent 协同态势" subtitle={`${runId} · 展示 Agent 健康、等待对象、阻塞传播和交接合同。`} />
      <Panel title="Agent Map">
        <DataState state={collaboration}>
          <div className="agentGrid">
            {collaboration.data?.agents.map((agent: any) => (
              <div className="agentCard" key={agent.agent_id}>
                <Bot size={20} />
                <strong>{agent.name}</strong>
                <Pill value={agent.status} />
                <small>active: {agent.active_runs?.join(", ") || "-"}</small>
                <small>current: {agent.current_node_runs?.join(", ") || "-"}</small>
                <small>queued: {agent.queued_node_runs?.join(", ") || "-"}</small>
                <small>waiting: {agent.waiting_for?.join(", ") || "-"}</small>
                {agent.source_confidence && <small>证据：{agent.source_confidence}</small>}
              </div>
            ))}
          </div>
        </DataState>
      </Panel>
    </section>
  );
}

function ArtifactsPage({ runId, selectedArtifact, setSelectedArtifact }: { runId: string; selectedArtifact: string; setSelectedArtifact: (id: string) => void }) {
  const artifacts = useApi<{ artifacts: any[] }>(`/artifacts?run_id=${runId}`, [runId]);
  const selectedArtifactForRun = artifacts.data?.artifacts.some((item) => item.artifact_id === selectedArtifact) ? selectedArtifact : (artifacts.data?.artifacts[0]?.artifact_id ?? "");
  const detail = useApi<any>(`/artifacts/${selectedArtifactForRun}?run_id=${runId}`, [runId, selectedArtifactForRun], Boolean(selectedArtifactForRun));
  useEffect(() => {
    if (artifacts.data?.artifacts[0] && !artifacts.data.artifacts.some((item) => item.artifact_id === selectedArtifact)) setSelectedArtifact(artifacts.data.artifacts[0].artifact_id);
  }, [artifacts.data, selectedArtifact, setSelectedArtifact]);
  return (
    <section className="page">
      <PageTitle eyebrow="Artifact Board" title="产物资产" subtitle={`${runId} · 按类型、版本、审核状态和 producer 查看产物。`} />
      <div className="artifactGrid">
        <Panel title="Artifact Manifest" count={artifacts.data?.artifacts.length}>
          <DataState state={artifacts}>
            <table><thead><tr><th>产物</th><th>类型</th><th>状态</th><th>审核</th><th>操作</th></tr></thead>
            <tbody>{artifacts.data?.artifacts.map((artifact) => (
              <tr key={artifact.artifact_id} className={artifact.artifact_id === selectedArtifact ? "selectedRow" : ""}>
                <td><strong>{artifact.artifact_id}</strong><small>v{artifact.version} · {artifact.producer}</small></td>
                <td>{artifact.type}</td>
                <td><Pill value={artifact.status} /></td>
                <td><Pill value={artifact.review_status} /></td>
                <td><button className="linkButton" onClick={() => setSelectedArtifact(artifact.artifact_id)}><Eye size={14} /> 预览</button></td>
              </tr>
            ))}</tbody></table>
          </DataState>
        </Panel>
        <Panel title="Artifact Detail Preview">
          <DataState state={detail}>
            <div className="artifactDetail">
              <div className="detailHeader">
                <FileSearch size={22} />
                <div>
                <strong>{detail.data?.artifact.artifact_id}</strong>
                  <span>{detail.data?.artifact.path}</span>
                </div>
                <Pill value={artifactPreviewCapability(detail.data?.artifact ?? {}).label} />
              </div>
              <div className="manifestGrid">
                <Metric label="类型" value={String(detail.data?.artifact.type)} />
                <Metric label="版本" value={`v${detail.data?.artifact.version}`} />
                <Metric label="Hash" value={String(detail.data?.artifact.hash).replace("sha256:", "")} />
              </div>
              <ArtifactPreviewBox detail={detail.data} />
            </div>
          </DataState>
        </Panel>
      </div>
    </section>
  );
}

function ArtifactPreviewBox({ detail }: { detail: any }) {
  const preview = detail?.preview;
  if (!preview?.available) {
    return <div className="previewEmpty"><Archive size={28} /><strong>暂无可预览内容</strong><span>{preview?.reason ?? "当前产物没有本地预览。"}</span></div>;
  }
  if (preview.mode === "json") {
    let content = preview.content;
    try {
      content = JSON.stringify(JSON.parse(preview.content), null, 2);
    } catch {
      content = preview.content;
    }
    return <pre className="previewBlock">{content}</pre>;
  }
  return <pre className={preview.mode === "markdown" ? "previewBlock markdownPreview" : "previewBlock"}>{preview.content}</pre>;
}

function ReviewPage({ runId, selectedGate, setSelectedGate }: { runId: string; selectedGate: string; setSelectedGate: (id: string) => void }) {
  const [refresh, setRefresh] = useState(0);
  const [decisionResult, setDecisionResult] = useState<any>();
  const [reworkResult, setReworkResult] = useState<any>();
  const [actionState, setActionState] = useState("");
  const run = useApi<any>(`/runs/${runId}`, [runId, refresh]);
  const selectedGateForRun = run.data?.gates?.some((item: any) => item.gate_instance_id === selectedGate) ? selectedGate : (run.data?.gates?.[0]?.gate_instance_id ?? "");
  const gate = useApi<any>(`/gates/${selectedGateForRun}?run_id=${runId}`, [runId, selectedGateForRun, refresh], Boolean(selectedGateForRun));
  const currentGate = gate.data?.gate;
  const historical = isHistoricalRun(run.data?.run, run.data?.view_meta);
  const currentDecision = latestDecision(currentGate);
  const canDecide = !historical && currentGate?.status === "pending_review";
  const canCreateRework = !historical && currentGate?.status === "decided" && ["reject", "request_changes"].includes(currentDecision?.decision ?? "");
  useEffect(() => {
    if (run.data?.gates?.[0] && !run.data.gates.some((item: any) => item.gate_instance_id === selectedGate)) setSelectedGate(run.data.gates[0].gate_instance_id);
  }, [run.data, selectedGate, setSelectedGate]);

  function clearGateActionState() {
    setDecisionResult(undefined);
    setReworkResult(undefined);
    setActionState("");
  }

  function selectGateForReview(gateId: string) {
    if (gateId === selectedGateForRun) return;
    clearGateActionState();
    setSelectedGate(gateId);
  }

  async function decide(decision: "approve" | "reject" | "request_changes") {
    setActionState("提交 GateDecision 中");
    const result = await api<any>(`/gates/${selectedGateForRun}/decision?run_id=${runId}`, {
      method: "POST",
      body: JSON.stringify({
        decision,
        actor: "local_user",
        comment: decision === "approve" ? "审核通过" : "需要创建返工版本"
      })
    });
    setDecisionResult(result);
    setReworkResult(undefined);
    setActionState(`已写入 GateDecision · ${result.gate_decision_id}`);
    setRefresh((value) => value + 1);
  }

  async function createRework() {
    setActionState("创建返工版本中");
    const result = await api<any>(`/gates/${selectedGateForRun}/rework?run_id=${runId}`, {
      method: "POST",
      body: JSON.stringify({ actor: "local_user", comment: currentDecision?.comment ?? "审核驳回后创建返工版本" })
    });
    setReworkResult(result);
    setDecisionResult(undefined);
    setSelectedGate(result.gate.gate_instance_id);
    setActionState(`已创建返工版本 · ${result.artifact.artifact_id}`);
    setRefresh((value) => value + 1);
  }

  return (
    <section className="page">
      <PageTitle eyebrow="Gate Review" title="审核抽屉" subtitle={`${runId} · GateDecision、返工 attempt 和 TraceEvent 由 Sidecar Orchestrator 单写入。`} />
      {historical && <div className="historicalBanner"><div><strong>Historical · Read-only</strong><span>历史审核证据仅供查看，不能提交决策或创建返工。</span></div><Pill value={confidenceLabel(run.data?.view_meta?.source_confidence)} /></div>}
      <div className="reviewGrid">
        <Panel title="Gate 列表" count={run.data?.gates?.length}>
          <DataState state={run}>
            <div className="gateList">
              {run.data?.gates.map((item: any) => {
                const decision = latestDecision(item);
                return (
                  <button className={item.gate_instance_id === selectedGateForRun ? "gateSelector active" : "gateSelector"} key={item.gate_instance_id} onClick={() => selectGateForReview(item.gate_instance_id)}>
                    <ClipboardCheck size={16} />
                    <span>
                      <strong>{item.gate_instance_id}</strong>
                      <small>{item.gate_spec_id} · {decision?.decision ?? "等待决策"}</small>
                    </span>
                    <Pill value={item.status} />
                  </button>
                );
              })}
            </div>
          </DataState>
        </Panel>
        <Panel title="Gate Detail">
          <DataState state={gate}>
            <div className="reviewBox">
              <div className="detailHeader">
                <ClipboardCheck size={24} />
                <div>
                  <strong>{currentGate?.gate_instance_id}</strong>
                  <span>{currentGate?.gate_spec_id} · target {currentGate?.target?.id}</span>
                </div>
                <Pill value={currentGate?.status} />
              </div>
              <div className="manifestGrid">
                <Metric label="最新决策" value={currentDecision?.decision ?? "pending"} />
                <Metric label="阻塞下游" value={String(currentGate?.required_before?.length ?? 0)} />
                <Metric label="目标版本" value={`v${gate.data?.target_artifact?.version ?? "-"}`} />
              </div>
              <pre className="jsonBlock compact">{JSON.stringify(gate.data?.target_artifact, null, 2)}</pre>
              <div className="safeActions">
                <button onClick={() => decide("approve")} disabled={!canDecide}><CheckCircle2 size={16} /> 批准</button>
                <button className="dangerAction" onClick={() => decide("reject")} disabled={!canDecide}><XCircle size={16} /> 驳回</button>
                <button className="dangerAction" onClick={() => decide("request_changes")} disabled={!canDecide}><AlertTriangle size={16} /> 要求修改</button>
                <button onClick={createRework} disabled={!canCreateRework}><GitBranch size={16} /> 创建返工版本</button>
              </div>
              {actionState && <div className="receiptLine">{actionState}</div>}
              <ProjectionPanel projection={decisionResult?.projection ?? gate.data?.projection} receipt={decisionResult} />
              <ReworkReceipt receipt={reworkResult} />
              <DecisionHistory decisions={gate.data?.history_decisions ?? []} />
            </div>
          </DataState>
        </Panel>
      </div>
    </section>
  );
}

function ProjectionPanel({ projection, receipt }: { projection?: any; receipt?: any }) {
  if (!projection) return null;
  return (
    <div className="projectionPanel">
      <header>
        <strong>决策投影</strong>
        <Pill value={projection.projected_artifact_review_status} />
      </header>
      <p>该投影用于说明 Gate 决策后的执行影响，不直接覆盖 ArtifactManifest。</p>
      {receipt && <div className="receiptLine">Receipt: {receipt.gate_decision_id} · Events: {receipt.created_events?.join(", ")}</div>}
      <div className="projectionList">
        {projection.affected_node_runs.map((item: any) => (
          <div key={item.node_id}>
            <strong>{item.node_id}</strong>
            <span>{`${item.current_status ?? "-"} -> ${item.projected_status}`}</span>
            <small>{item.reason}</small>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReworkReceipt({ receipt }: { receipt?: any }) {
  if (!receipt) return null;
  return (
    <div className="reworkPanel">
      <header>
        <strong>返工创建回执</strong>
        <Pill value={receipt.accepted ? "accepted" : "failed"} />
      </header>
      <div className="manifestGrid">
        <Metric label="Attempt" value={receipt.rework_attempt_id} />
        <Metric label="新产物" value={`${receipt.artifact.artifact_id} · v${receipt.artifact.version}`} />
        <Metric label="新 Gate" value={receipt.gate.gate_instance_id} />
      </div>
      <div className="auditTrail">
        {receipt.created_events?.map((eventId: string) => <span key={eventId}>{eventId}</span>)}
      </div>
      <p>旧 Artifact 和旧 GateDecision 保留；新 ArtifactManifest 进入 pending_review，并创建新的 GateInstance 等待审核。</p>
    </div>
  );
}

function DecisionHistory({ decisions }: { decisions: any[] }) {
  return (
    <div className="decisionHistory">
      <h3>GateDecision 历史</h3>
      {decisions.length === 0 ? (
        <div className="previewEmpty compactEmpty"><ClipboardCheck size={20} /><strong>等待人工审核</strong><span>批准、驳回或要求修改后会写入 GateDecision。</span></div>
      ) : (
        decisions.map((decision) => (
          <div className="decisionRow" key={decision.decision_id}>
            <Pill value={decision.decision} />
            <strong>{decision.actor}</strong>
            <span>{decision.comment ?? "-"}</span>
            <small>{decision.created_at}</small>
          </div>
        ))
      )}
    </div>
  );
}

function CanvasPage({ workflowId }: { workflowId: string }) {
  const draftState = useApi<any>(`/workflows/${workflowId}/canvas-draft`, [workflowId]);
  const [objects, setObjects] = useState<any[]>([]);
  const [saveState, setSaveState] = useState<string>("未保存");
  const [publishState, setPublishState] = useState<any>();
  const [draftMeta, setDraftMeta] = useState<any>();
  const [nodeTitle, setNodeTitle] = useState("Pencil 原型节点");
  const [nodeCapability, setNodeCapability] = useState("prototype.pencil");
  const [nodeZone, setNodeZone] = useState("content");

  useEffect(() => {
    if (draftState.data?.draft.objects) {
      setObjects(draftState.data.draft.objects);
      setDraftMeta(draftState.data);
      setSaveState("已加载草稿");
    }
  }, [draftState.data]);

  const zones = objects.filter((object) => object.type === "zone");
  const nodeDrafts = objects.filter((object) => object.node_spec_draft);

  function moveObject(id: string, dx: number, dy: number) {
    setObjects((current) => current.map((object) => object.id === id ? { ...object, x: object.x + dx, y: object.y + dy } : object));
    setSaveState("有未保存修改");
  }

  async function saveDraft() {
    try {
      const result = await api<any>(`/workflows/${workflowId}/canvas-draft`, {
        method: "POST",
        body: JSON.stringify({ objects })
      });
      setObjects(result.draft.objects);
      setDraftMeta(result);
      setSaveState(`已保存 · ${new Date(result.draft.updated_at).toLocaleTimeString()}`);
      return { ok: true, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : "validate failed";
      setSaveState(`保存失败 · ${message}`);
      return { ok: false, error: message };
    }
  }

  async function addNodeDraft() {
    if (objects.length === 0) {
      setSaveState("生成已取消 · 画布尚未加载");
      return;
    }
    setSaveState("正在生成 NodeSpec draft");
    try {
      const result = await api<any>(`/workflows/${workflowId}/canvas-draft/nodes`, {
        method: "POST",
        body: JSON.stringify({
          objects,
          title: nodeTitle,
          capability: nodeCapability,
          zone_id: nodeZone,
          node_type: nodeCapability === "prototype.pencil" ? "mcp_tool" : "transform",
          artifact_type: nodeCapability === "prototype.pencil" ? "prototype" : "document"
        })
      });
      setObjects(result.draft.objects);
      setDraftMeta(result);
      const nodeId = result.node_object?.node_spec_draft?.node_spec?.id ?? result.node_object?.ref_id;
      setSaveState(`已生成草稿节点 · ${nodeId}`);
    } catch (error) {
      setSaveState(`生成失败 · ${error instanceof Error ? error.message : "NodeSpec draft invalid"}`);
    }
  }

  async function publishDraft() {
    setPublishState({ status: "发布中" });
    try {
      const saved = await saveDraft();
      if (!saved.ok) {
        setPublishState({ status: "失败", error: `保存草稿失败，发布已取消：${saved.error}` });
        return;
      }
      const result = await api<any>(`/workflows/${workflowId}/canvas-draft/publish`, { method: "POST", body: JSON.stringify({}) });
      setPublishState(result);
    } catch (error) {
      setPublishState({ status: "失败", error: error instanceof Error ? error.message : "发布失败" });
    }
  }

  return (
    <section className="page">
      <PageTitle eyebrow="Infinite Canvas Draft" title="无限画布草稿态" subtitle="草稿只保存 layout/spec diff，不改变 WorkflowSpec 执行依赖。" />
      <div className="canvasToolbar">
        <Pill value={saveState} />
        <div className="toolbarActions">
          <button onClick={saveDraft}><Save size={16} /> 保存草稿</button>
          <button className="primary" onClick={publishDraft}><GitBranch size={16} /> 发布 Workflow draft</button>
        </div>
      </div>
      <Panel title="新增 NodeSpec Draft">
        <div className="nodeDraftComposer">
          <label>
            <span>节点标题</span>
            <input value={nodeTitle} onChange={(event) => setNodeTitle(event.target.value)} />
          </label>
          <label>
            <span>能力需求</span>
            <select value={nodeCapability} onChange={(event) => setNodeCapability(event.target.value)}>
              <option value="prototype.pencil">prototype.pencil</option>
              <option value="content.refine_plan">content.refine_plan</option>
              <option value="image.generate">image.generate</option>
              <option value="research.verify">research.verify</option>
            </select>
          </label>
          <label>
            <span>画布区域</span>
            <select value={nodeZone} onChange={(event) => setNodeZone(event.target.value)}>
              {zones.map((zone) => {
                const zoneId = zone.ref_id ?? zone.id.replace(/^zone_/, "");
                return <option value={zoneId} key={zone.id}>{zone.title ?? zoneId}</option>;
              })}
            </select>
          </label>
          <button className="primary" onClick={addNodeDraft}><Plus size={16} /> 生成节点草稿</button>
        </div>
        <div className="nodeDraftSummary">
          <Metric label="草稿节点" value={String(nodeDrafts.length)} />
          <Metric label="校验结果" value={draftMeta?.validation?.valid === false ? "invalid" : "ready"} />
          <Metric label="待发布操作" value={String(draftMeta?.spec_diff_preview?.operations?.length ?? objects.length)} />
        </div>
      </Panel>
      <Panel title="Canvas Draft Board">
        <DataState state={draftState}>
          <div className="canvasBoard">
            {objects.map((object) => (
              <div
                className={object.type === "zone" ? "canvasZone" : "canvasCard"}
                key={object.id}
                style={{ left: object.x, top: object.y, width: object.width, height: object.height }}
              >
                <header>
                  <strong>{object.title ?? object.id}</strong>
                  <Pill value={object.type} />
                </header>
                {object.type !== "zone" && <small>{object.ref_id} · {object.zone_id ?? "unassigned"}</small>}
                {object.node_spec_draft && (
                  <div className="nodeDraftBadge">
                    <Pill value={`NodeSpec · ${object.node_spec_draft.status}`} />
                    <small>{object.node_spec_draft.node_spec.capability_requirements.join(", ")}</small>
                  </div>
                )}
                {object.type !== "zone" && (
                  <div className="moveControls">
                    <button onClick={() => moveObject(object.id, -24, 0)}><Move size={13} />左</button>
                    <button onClick={() => moveObject(object.id, 24, 0)}>右</button>
                    <button onClick={() => moveObject(object.id, 0, -24)}>上</button>
                    <button onClick={() => moveObject(object.id, 0, 24)}>下</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </DataState>
      </Panel>
      <Panel title="Spec Diff Preview">
        <DataState state={draftState}>
          {draftMeta?.validation && (
            <div className="validationStrip">
              <Pill value={draftMeta.validation.valid ? "validate-ready" : "validate-failed"} />
              <span>{draftMeta.validation.errors?.length ?? 0} errors · {draftMeta.validation.warnings?.length ?? 0} warnings</span>
            </div>
          )}
          <pre className="jsonBlock">{JSON.stringify(draftMeta?.spec_diff_preview ?? {
            workflow_id: workflowId,
            operations: objects.map((object) => ({ op: "replace", path: `/layouts/canvas/objects/${object.id}`, value: { x: object.x, y: object.y, zone_id: object.zone_id } }))
          }, null, 2)}</pre>
          {publishState && (
            <div className="publishReceipt">
              <strong>Publish Receipt</strong>
              <pre className="jsonBlock compact">{JSON.stringify(publishState, null, 2)}</pre>
            </div>
          )}
        </DataState>
      </Panel>
    </section>
  );
}

function Placeholder({ title, description }: { title: string; description: string }) {
  return <section className="page"><PageTitle eyebrow="Reserved" title={title} subtitle={description} /><Panel title="P4 第一轮占位"><div className="placeholder"><Network size={40} /><p>{description}</p></div></Panel></section>;
}

function PageTitle({ eyebrow, title, subtitle }: { eyebrow: string; title: string; subtitle: string }) {
  return <div className="pageTitle"><span>{eyebrow}</span><h1>{title}</h1><p>{subtitle}</p></div>;
}

function Panel({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return <section className="panel"><header><h2>{title}</h2>{typeof count === "number" && <span className="count">{count}</span>}</header>{children}</section>;
}

function DataState<T>({ state, children }: { state: ApiState<T>; children: React.ReactNode }) {
  if (state.loading && !state.data) return <div className="loading"><Loader2 className="spin" size={18} /> 加载中</div>;
  if (state.error && !state.data) return <div className="error"><AlertTriangle size={18} /> {state.error}</div>;
  return <>
    {state.refreshing && <div className="refreshHint"><Loader2 className="spin" size={14} /> 正在刷新最新运行状态</div>}
    {state.error && <div className="inlineError"><AlertTriangle size={14} /> 刷新失败，当前展示上一次成功数据：{state.error}</div>}
    {children}
  </>;
}

function Pill({ value }: { value?: string }) {
  return <span className={`pill ${statusClass(value ?? "muted")}`}>{value ?? "-"}</span>;
}

function Severity({ severity }: { severity: string }) {
  return <span className={`severity ${severity.toLowerCase()}`}>{severity}</span>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong></div>;
}

function StatusCounter({ label, value }: { label: string; value: number }) {
  return (
    <div className={`statusCounter ${statusClass(label)}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

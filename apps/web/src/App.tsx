import {
  AlertTriangle,
  Archive,
  Bot,
  Boxes,
  CheckCircle2,
  ClipboardCheck,
  FileText,
  GitBranch,
  Home,
  LayoutDashboard,
  Loader2,
  Network,
  Play,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Workflow,
  XCircle
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type Page = "home" | "new" | "dryrun" | "run" | "attention" | "agents" | "artifacts" | "review" | "canvas" | "sync" | "evolution";
type ApiState<T> = { loading: boolean; data?: T; error?: string };

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

function useApi<T>(path: string, deps: unknown[] = []): ApiState<T> {
  const [state, setState] = useState<ApiState<T>>({ loading: true });
  useEffect(() => {
    let alive = true;
    setState({ loading: true });
    api<T>(path)
      .then((data) => alive && setState({ loading: false, data }))
      .catch((error: Error) => alive && setState({ loading: false, error: error.message }));
    return () => {
      alive = false;
    };
  }, deps);
  return state;
}

function statusClass(status: string) {
  if (["done", "completed", "approved"].includes(status)) return "ok";
  if (["running", "reviewing"].includes(status)) return "info";
  if (["blocked", "failed", "rejected", "missing"].includes(status)) return "danger";
  if (["pending_review", "waiting"].includes(status)) return "warn";
  return "muted";
}

export function App() {
  const [page, setPage] = useState<Page>("home");
  const [workflowId, setWorkflowId] = useState("content-production-v0");
  const [runId, setRunId] = useState("run-demo-001");
  const [selectedNode, setSelectedNode] = useState("nr_run-demo-001_E_tts");
  const [selectedAttention, setSelectedAttention] = useState("att_tts_credential");
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
          <NavButton page="canvas" active={page} setPage={setPage} icon={<LayoutDashboard size={18} />} label="画布占位" />
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
        {page === "new" && <NewTaskPage workflowId={workflowId} setWorkflowId={setWorkflowId} go={setPage} />}
        {page === "dryrun" && <DryRunPage workflowId={workflowId} setRunId={setRunId} go={setPage} />}
        {page === "run" && <RunPage runId={runId} selectedNode={selectedNode} setSelectedNode={setSelectedNode} go={setPage} />}
        {page === "attention" && <AttentionPage selected={selectedAttention} setSelected={setSelectedAttention} go={setPage} />}
        {page === "agents" && <AgentsPage />}
        {page === "artifacts" && <ArtifactsPage />}
        {page === "review" && <ReviewPage selectedGate={selectedGate} setSelectedGate={setSelectedGate} />}
        {page === "canvas" && <Placeholder title="Infinite Canvas Prototype" description="MVPS08 第一轮只保留入口和 CanvasLayout 数据结构。完整无限画布在 P4 第二轮实现。" />}
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
                <div><strong>{run.workflow_id}</strong><span>{run.run_id}</span></div>
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

function NewTaskPage({ workflowId, setWorkflowId, go }: { workflowId: string; setWorkflowId: (id: string) => void; go: (page: Page) => void }) {
  const domains = useApi<{ domains: any[] }>("/domains", []);
  const templates = useApi<{ templates: any[] }>("/registry/templates", []);
  return (
    <section className="page">
      <PageTitle eyebrow="New Task" title="启动新任务" subtitle="选择领域、模板和执行策略，启动前先 Dry-run。" />
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
      <div className="actionBar"><button className="primary" onClick={() => go("dryrun")}><ShieldCheck size={16} /> 进入 Dry-run</button></div>
    </section>
  );
}

function DryRunPage({ workflowId, setRunId, go }: { workflowId: string; setRunId: (id: string) => void; go: (page: Page) => void }) {
  const plan = useApi<any>(`/workflows/${workflowId}/dry-run`, [workflowId]);
  async function startRun() {
    const result = await api<any>("/runs", { method: "POST", body: JSON.stringify({ workflow_id: workflowId, execution_policy: "hybrid", role_profile: "operator" }) });
    setRunId(result.run_id);
    go("run");
  }
  return (
    <section className="page">
      <PageTitle eyebrow="Dry-run" title="启动前检查" subtitle={`Workflow: ${workflowId}`} />
      <Panel title="执行计划与风险">
        <DataState state={plan}>
          <div className="metricRow">
            <Metric label="节点" value={String(plan.data?.nodes.length ?? 0)} />
            <Metric label="风险" value={String(plan.data?.risks.length ?? 0)} />
            <Metric label="成本区间" value={`¥${plan.data?.estimated_cost.min} - ¥${plan.data?.estimated_cost.max}`} />
          </div>
          <div className="riskCards">
            {plan.data?.risks.map((risk: any) => (
              <div className="riskCard" key={`${risk.code}-${risk.message}`}>
                <Severity severity={risk.severity} />
                <strong>{risk.code}</strong>
                <span>{risk.message}</span>
              </div>
            ))}
          </div>
        </DataState>
      </Panel>
      <div className="actionBar"><button className="primary" onClick={startRun}><Play size={16} /> 启动 Run</button></div>
    </section>
  );
}

function RunPage({ runId, selectedNode, setSelectedNode, go }: { runId: string; selectedNode: string; setSelectedNode: (id: string) => void; go: (page: Page) => void }) {
  const run = useApi<any>(`/runs/${runId}`, [runId]);
  const events = useApi<any>(`/runs/${runId}/events`, [runId]);
  const node = selectedNode ? useApi<any>(`/runs/${runId}/nodes/${selectedNode}`, [runId, selectedNode]) : { loading: false } as ApiState<any>;
  const stages = useMemo(() => {
    const workflow = run.data?.workflow;
    if (!workflow) return [];
    return Array.from(new Set(Object.values(workflow.layouts.dag).map((item: any) => item.stage ?? "默认阶段")));
  }, [run.data]);

  return (
    <section className="page">
      <PageTitle eyebrow="Run Workspace" title={String(run.data?.run.workflow_id ?? runId)} subtitle={`${runId} · RunSpec / WorkflowSnapshot 只读`} />
      <div className="runHeader">
        <Metric label="状态" value={String(run.data?.run.status ?? "-")} />
        <Metric label="节点" value={String((run.data?.nodes ?? []).length)} />
        <Metric label="Attention" value={String((run.data?.attention ?? []).length)} />
        <button onClick={() => go("attention")}>查看 Attention</button>
      </div>
      <div className="stageTabs">{stages.map((stage) => <span key={String(stage)}>{String(stage)}</span>)}</div>
      <div className="runGrid">
        <Panel title="执行流程视图">
          <DataState state={run}>
            <div className="dagList">
              {run.data?.workflow.nodes.map((spec: any) => {
                const nodeRun = run.data.nodes.find((item: any) => item.node_id === spec.id);
                return (
                  <button className={nodeRun?.node_run_id === selectedNode ? "dagNode selected" : "dagNode"} key={spec.id} onClick={() => setSelectedNode(nodeRun?.node_run_id)}>
                    <span className={`dot ${statusClass(nodeRun?.status ?? "queued")}`} />
                    <strong>{spec.name}</strong>
                    <small>{spec.agent_candidates[0]} · NodeRun · {nodeRun?.status ?? "queued"}</small>
                  </button>
                );
              })}
            </div>
          </DataState>
        </Panel>
        <Panel title="所选节点上下文">
          <DataState state={node}>
            <pre className="jsonBlock">{JSON.stringify(node.data?.node, null, 2)}</pre>
          </DataState>
        </Panel>
      </div>
      <Panel title="事件与审计">
        <DataState state={events}>
          {events.data?.events.map((event: any) => (
            <div className="eventRow" key={event.event_id}><span>{event.created_at}</span><strong>{event.type}</strong><em>{event.message}</em></div>
          ))}
        </DataState>
      </Panel>
    </section>
  );
}

function AttentionPage({ selected, setSelected, go }: { selected: string; setSelected: (id: string) => void; go: (page: Page) => void }) {
  const attention = useApi<{ attention: any[] }>("/attention", []);
  const current = attention.data?.attention.find((item) => item.attention_id === selected) ?? attention.data?.attention[0];
  return (
    <section className="page">
      <PageTitle eyebrow="Attention Queue" title="根因联动处置" subtitle="一个根因对应一个主 Attention Item，关联对象展开显示。" />
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
              <div className="safeActions">{current.safe_actions.map((action: string) => <button key={action} onClick={() => action.includes("gate") && go("review")}>{action}</button>)}</div>
            </div>
          )}
        </Panel>
      </div>
    </section>
  );
}

function AgentsPage() {
  const collaboration = useApi<any>("/agents/collaboration", []);
  return (
    <section className="page">
      <PageTitle eyebrow="Agent Collaboration" title="多 Agent 协同态势" subtitle="展示 Agent 健康、等待对象、阻塞传播和交接合同。" />
      <Panel title="Agent Map">
        <DataState state={collaboration}>
          <div className="agentGrid">
            {collaboration.data?.agents.map((agent: any) => (
              <div className="agentCard" key={agent.agent_id}>
                <Bot size={20} />
                <strong>{agent.name}</strong>
                <Pill value={agent.status} />
                <small>active: {agent.active_runs.join(", ") || "-"}</small>
                <small>waiting: {agent.waiting_for.join(", ") || "-"}</small>
              </div>
            ))}
          </div>
        </DataState>
      </Panel>
    </section>
  );
}

function ArtifactsPage() {
  const artifacts = useApi<{ artifacts: any[] }>("/artifacts", []);
  return (
    <section className="page">
      <PageTitle eyebrow="Artifact Board" title="产物资产" subtitle="按类型、版本、审核状态和 producer 查看产物。" />
      <Panel title="Artifact Manifest">
        <DataState state={artifacts}>
          <table><thead><tr><th>产物</th><th>类型</th><th>版本</th><th>状态</th><th>审核</th><th>Producer</th></tr></thead>
          <tbody>{artifacts.data?.artifacts.map((artifact) => <tr key={artifact.artifact_id}><td>{artifact.artifact_id}</td><td>{artifact.type}</td><td>v{artifact.version}</td><td><Pill value={artifact.status} /></td><td><Pill value={artifact.review_status} /></td><td>{artifact.producer}</td></tr>)}</tbody></table>
        </DataState>
      </Panel>
    </section>
  );
}

function ReviewPage({ selectedGate }: { selectedGate: string; setSelectedGate: (id: string) => void }) {
  const [refresh, setRefresh] = useState(0);
  const gate = useApi<any>(`/gates/${selectedGate}?run_id=run-demo-001`, [selectedGate, refresh]);
  async function decide(decision: "approve" | "reject") {
    await api(`/gates/${selectedGate}/decision?run_id=run-demo-001`, { method: "POST", body: JSON.stringify({ decision, actor: "local_user", comment: decision === "approve" ? "审核通过" : "需要返工" }) });
    setRefresh((value) => value + 1);
  }
  return (
    <section className="page">
      <PageTitle eyebrow="Gate Review" title="审核抽屉" subtitle="决策写入事件和 GateDecision，不覆盖 Artifact。" />
      <Panel title="Gate Detail">
        <DataState state={gate}>
          <div className="reviewBox">
            <ClipboardCheck size={24} />
            <h3>{gate.data?.gate.gate_spec_id}</h3>
            <Pill value={gate.data?.gate.status} />
            <pre className="jsonBlock">{JSON.stringify(gate.data?.target_artifact, null, 2)}</pre>
            <div className="safeActions"><button onClick={() => decide("approve")}><CheckCircle2 size={16} /> 批准</button><button onClick={() => decide("reject")}><XCircle size={16} /> 驳回</button></div>
          </div>
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
  if (state.loading) return <div className="loading"><Loader2 className="spin" size={18} /> 加载中</div>;
  if (state.error) return <div className="error"><AlertTriangle size={18} /> {state.error}</div>;
  return <>{children}</>;
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

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
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  Workflow,
  XCircle
} from "lucide-react";
import { Background, Controls, MarkerType, ReactFlow, type Edge as FlowEdge, type Node as FlowNode } from "@xyflow/react";
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
    node_blocked: { label: "节点阻塞", className: "danger" },
    node_done: { label: "节点完成", className: "ok" },
    run_created: { label: "Run 创建", className: "muted" }
  };
  return map[type] ?? { label: type, className: "muted" };
}

export function App() {
  const [page, setPage] = useState<Page>("home");
  const [workflowId, setWorkflowId] = useState("content-production-v0");
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
        {page === "new" && <NewTaskPage workflowId={workflowId} setWorkflowId={setWorkflowId} go={setPage} />}
        {page === "dryrun" && <DryRunPage workflowId={workflowId} setRunId={setRunId} go={setPage} />}
        {page === "run" && <RunPage runId={runId} selectedNode={selectedNode} setSelectedNode={setSelectedNode} go={setPage} />}
        {page === "attention" && <AttentionPage selected={selectedAttention} setSelected={setSelectedAttention} setSelectedGate={setSelectedGate} go={setPage} />}
        {page === "agents" && <AgentsPage />}
        {page === "artifacts" && <ArtifactsPage selectedArtifact={selectedArtifact} setSelectedArtifact={setSelectedArtifact} />}
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
  const [refresh, setRefresh] = useState(0);
  const [executeState, setExecuteState] = useState<string>("");
  const run = useApi<any>(`/runs/${runId}`, [runId, refresh]);
  const dag = useApi<any>(`/runs/${runId}/dag`, [runId, refresh]);
  const events = useApi<any>(`/runs/${runId}/events`, [runId, refresh]);
  const node = selectedNode ? useApi<any>(`/runs/${runId}/nodes/${selectedNode}`, [runId, selectedNode, refresh]) : { loading: false } as ApiState<any>;
  const stages = useMemo(() => {
    const workflow = run.data?.workflow;
    if (!workflow) return [];
    return Array.from(new Set(Object.values(workflow.layouts.dag).map((item: any) => item.stage ?? "默认阶段")));
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
      className: item.node_run_id === selectedNode ? "flowShell selected" : "flowShell"
    }));
  }, [dag.data, selectedNode]);
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
    const firstNodeRunId = dag.data?.dag.nodes[0]?.node_run_id;
    const selectedExists = dag.data?.dag.nodes.some((item: any) => item.node_run_id === selectedNode);
    if (firstNodeRunId && !selectedExists) setSelectedNode(firstNodeRunId);
  }, [dag.data, selectedNode, setSelectedNode]);

  async function executeSelectedNode() {
    if (!selectedNode) return;
    setExecuteState("执行中");
    try {
      const result = await api<any>(`/runs/${runId}/nodes/${selectedNode}/execute`, { method: "POST", body: JSON.stringify({}) });
      setExecuteState(`已提交 · ${result.adapter_result.status}`);
      setRefresh((value) => value + 1);
    } catch (error) {
      setExecuteState(error instanceof Error ? error.message : "执行失败");
    }
  }
  const selectedStatus = String(node.data?.node?.status ?? "");
  const executable = ["queued", "running"].includes(selectedStatus);

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
                  <strong>{node.data?.node?.node_id ?? selectedNode}</strong>
                  <span>{node.data?.node?.node_run_id}</span>
                </div>
                <Pill value={selectedStatus} />
              </div>
              <div className="safeActions">
                <button onClick={executeSelectedNode} disabled={!executable}><Play size={16} /> 执行当前节点</button>
                <button onClick={() => setRefresh((value) => value + 1)}>刷新</button>
              </div>
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
                      <small>{attempt.operation_id}</small>
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
          {events.data?.events.map((event: any) => {
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

function AttentionPage({ selected, setSelected, setSelectedGate, go }: { selected: string; setSelected: (id: string) => void; setSelectedGate: (id: string) => void; go: (page: Page) => void }) {
  const attention = useApi<{ attention: any[] }>("/attention", []);
  const current = attention.data?.attention.find((item) => item.attention_id === selected) ?? attention.data?.attention[0];
  function openReviewFromAttention() {
    const gateObject = current?.related_objects.find((object: any) => object.type === "GateInstance");
    if (gateObject?.id) setSelectedGate(gateObject.id);
    go("review");
  }
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

function ArtifactsPage({ selectedArtifact, setSelectedArtifact }: { selectedArtifact: string; setSelectedArtifact: (id: string) => void }) {
  const artifacts = useApi<{ artifacts: any[] }>("/artifacts", []);
  const detail = useApi<any>(`/artifacts/${selectedArtifact}`, [selectedArtifact]);
  return (
    <section className="page">
      <PageTitle eyebrow="Artifact Board" title="产物资产" subtitle="按类型、版本、审核状态和 producer 查看产物。" />
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
                <Pill value={detail.data?.preview.mode} />
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
  const gate = useApi<any>(`/gates/${selectedGate}?run_id=${runId}`, [runId, selectedGate, refresh]);
  const currentGate = gate.data?.gate;
  const currentDecision = latestDecision(currentGate);
  const canDecide = currentGate?.status === "pending_review";
  const canCreateRework = currentGate?.status === "decided" && ["reject", "request_changes"].includes(currentDecision?.decision ?? "");

  function clearGateActionState() {
    setDecisionResult(undefined);
    setReworkResult(undefined);
    setActionState("");
  }

  function selectGateForReview(gateId: string) {
    if (gateId === selectedGate) return;
    clearGateActionState();
    setSelectedGate(gateId);
  }

  async function decide(decision: "approve" | "reject" | "request_changes") {
    setActionState("提交 GateDecision 中");
    const result = await api<any>(`/gates/${selectedGate}/decision?run_id=${runId}`, {
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
    const result = await api<any>(`/gates/${selectedGate}/rework?run_id=${runId}`, {
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
      <PageTitle eyebrow="Gate Review" title="审核抽屉" subtitle="GateDecision、返工 attempt 和 TraceEvent 由 Sidecar Orchestrator 单写入。" />
      <div className="reviewGrid">
        <Panel title="Gate 列表" count={run.data?.gates?.length}>
          <DataState state={run}>
            <div className="gateList">
              {run.data?.gates.map((item: any) => {
                const decision = latestDecision(item);
                return (
                  <button className={item.gate_instance_id === selectedGate ? "gateSelector active" : "gateSelector"} key={item.gate_instance_id} onClick={() => selectGateForReview(item.gate_instance_id)}>
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

  useEffect(() => {
    if (draftState.data?.draft.objects) {
      setObjects(draftState.data.draft.objects);
      setSaveState("已加载草稿");
    }
  }, [draftState.data]);

  function moveObject(id: string, dx: number, dy: number) {
    setObjects((current) => current.map((object) => object.id === id ? { ...object, x: object.x + dx, y: object.y + dy } : object));
    setSaveState("有未保存修改");
  }

  async function saveDraft() {
    const result = await api<any>(`/workflows/${workflowId}/canvas-draft`, {
      method: "POST",
      body: JSON.stringify({ objects })
    });
    setObjects(result.draft.objects);
    setSaveState(`已保存 · ${new Date(result.draft.updated_at).toLocaleTimeString()}`);
  }

  async function publishDraft() {
    setPublishState({ status: "发布中" });
    try {
      await saveDraft();
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
          <pre className="jsonBlock">{JSON.stringify({
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

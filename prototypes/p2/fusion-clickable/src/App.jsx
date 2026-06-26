import { useMemo, useState } from "react";
import {
  Archive,
  Bell,
  Bot,
  Box,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  ClipboardCheck,
  ClipboardList,
  Clock3,
  FileText,
  GitBranch,
  Home as HomeIcon,
  Link2,
  MoreHorizontal,
  PlayCircle,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Upload,
  Workflow,
  Wrench,
  X,
  Zap,
} from "lucide-react";

const views = [
  { id: "home", label: "首页", icon: HomeIcon },
  { id: "run", label: "任务运行", icon: ClipboardList },
  { id: "workflow", label: "工作流", icon: Workflow },
  { id: "agents", label: "智能体", icon: Bot },
  { id: "review", label: "审核与交付", icon: ClipboardCheck },
  { id: "registry", label: "资源库", icon: Archive },
  { id: "settings", label: "设置", icon: Settings },
];

const runTabs = ["总览", "流程", "协作", "产物", "时间线", "审计"];

const stages = [
  { id: "all", label: "全部阶段", count: "" },
  { id: "intel", label: "情报采集", count: "1" },
  { id: "content", label: "内容策划与母稿", count: "1" },
  { id: "script", label: "脚本与分镜", count: "1" },
  { id: "tts", label: "音频与字幕", count: "1" },
  { id: "video", label: "视频制作", count: "1" },
  { id: "publish", label: "分发与复盘", count: "1" },
];

const nodes = [
  {
    id: "intel",
    stage: "intel",
    number: 1,
    title: "情报采集与事实核验",
    status: "done",
    statusText: "done",
    owner: "intelligence-agent",
    detail: "clean_events.json 已生成，证据链完整。",
    artifact: "clean_events.json",
    artifactMeta: "ArtifactManifest · v1",
  },
  {
    id: "md",
    stage: "content",
    number: 2,
    title: "内容 MD 母稿",
    status: "pending_review",
    statusText: "GateInstance · pending_review",
    owner: "content-agent",
    detail: "md_master_v2.md 等待 GateInstance 审核。",
    artifact: "md_master_v2.md",
    artifactMeta: "ArtifactManifest · v2",
  },
  {
    id: "script",
    stage: "script",
    number: 3,
    title: "脚本与分镜",
    status: "queued",
    statusText: "queued",
    owner: "script-agent",
    detail: "等待上游 Gate 批准。",
    artifact: "script_draft_v1.md",
    artifactMeta: "尚未开始",
  },
  {
    id: "tts",
    stage: "tts",
    number: 4,
    title: "TTS 与字幕",
    status: "blocked",
    statusText: "NodeRun · blocked",
    owner: "tts-agent",
    detail: "缺少 VOLC_TTS_API_KEY，视频分支受阻，Markdown 分发不受影响。",
    artifact: "audio_master_v1.wav / subtitle_master_v1.srt",
    artifactMeta: "未生成",
  },
  {
    id: "video",
    stage: "video",
    number: 5,
    title: "视频渲染",
    status: "waiting",
    statusText: "AgentHealth · waiting",
    owner: "video-agent",
    detail: "等待音频和字幕产物。",
    artifact: "video_master_v1.mp4",
    artifactMeta: "未生成",
  },
  {
    id: "publish",
    stage: "publish",
    number: 6,
    title: "分发复盘",
    status: "queued",
    statusText: "queued",
    owner: "distribution-agent",
    detail: "等待内容包确认后开始。",
    artifact: "publish_package_v1",
    artifactMeta: "未生成",
  },
];

const attentionItems = [
  {
    id: "tts-credential",
    type: "需要修复",
    title: "NodeRun · blocked",
    subtitle: "TTS 与字幕",
    priority: "P0",
    waiting: "38 分钟",
    cause: "缺少 VOLC_TTS_API_KEY",
    impact: "视频分支无法继续；Markdown 分发不受影响。",
    scope: "1 个节点被阻塞，2 个下游节点等待。",
    firstSeen: "10:56:12",
    run: "Run-20250623-001",
    objects: [
      ["Agent", "tts-agent", "AgentHealth · waiting"],
      ["Node", "TTS 与字幕", "NodeRun · blocked"],
      ["Artifact", "audio_master_v1.wav", "未生成"],
      ["Artifact", "subtitle_master_v1.srt", "未生成"],
    ],
  },
  {
    id: "md-review",
    type: "需要决定",
    title: "GateInstance · pending_review",
    subtitle: "内容 MD 母稿 md_master_v2",
    priority: "P0",
    waiting: "22 分钟",
    cause: "母稿进入人工审核门",
    impact: "脚本与分镜节点保持 queued。",
    scope: "影响 3 个下游节点。",
    firstSeen: "10:44:08",
    run: "Run-20250623-001",
    objects: [
      ["Gate", "gate-md-master-002", "pending_review"],
      ["Agent", "content-agent", "reviewing"],
      ["Artifact", "md_master_v2.md", "pending_review"],
      ["Node", "脚本与分镜", "queued"],
    ],
  },
  {
    id: "video-failed",
    type: "需要修复",
    title: "NodeRun · failed",
    subtitle: "视频渲染",
    priority: "P1",
    waiting: "6 分钟",
    cause: "渲染任务缺少音频输入",
    impact: "视频主产物无法生成。",
    scope: "等待上游字幕和音频。",
    firstSeen: "11:18:21",
    run: "Run-20250623-001",
    objects: [
      ["Node", "视频渲染", "NodeRun · failed"],
      ["Agent", "video-agent", "waiting"],
      ["Artifact", "video_master_v1.mp4", "未生成"],
      ["Provider", "HyperFrames", "ready"],
    ],
  },
  {
    id: "reconcile",
    type: "需要校对",
    title: "ArtifactManifest · reconciliation_conflict",
    subtitle: "clean_events.json",
    priority: "P1",
    waiting: "18 分钟",
    cause: "事实清洗产物与母稿引用存在一处不一致",
    impact: "不阻断当前 Run，但进入发布前必须核对。",
    scope: "影响母稿事实链。",
    firstSeen: "11:06:40",
    run: "Run-20250623-001",
    objects: [
      ["Artifact", "clean_events.json", "conflict"],
      ["Node", "内容 MD 母稿", "done"],
      ["Gate", "publish-safe", "required"],
      ["Agent", "editor-agent", "idle"],
    ],
  },
  {
    id: "provider-quota",
    type: "需要关注",
    title: "ModelProvider · quota_warning",
    subtitle: "images-create (openai)",
    priority: "P2",
    waiting: "1 小时 12 分钟",
    cause: "模型配额进入预警阈值",
    impact: "不影响当前文本链路，可能影响后续图像节点。",
    scope: "影响视觉资产分支。",
    firstSeen: "09:44:12",
    run: "全局",
    objects: [
      ["Provider", "images-create", "quota_warning"],
      ["Component", "image-library", "degraded"],
      ["Workflow", "visual-production-v0", "at_risk"],
      ["Agent", "visual-agent", "idle"],
    ],
  },
];

const collaborationAgents = [
  {
    id: "intelligence",
    number: 1,
    name: "intelligence-agent",
    role: "情报采集与事实核验",
    status: "done",
    statusText: "done",
    handoff: "clean_events.json -> content-agent",
    contract: "输出必须带 source_url、claim、confidence 和 evidence_hash。",
    health: "完成 · 证据链完整",
  },
  {
    id: "content",
    number: 2,
    name: "content-agent",
    role: "内容 MD 母稿",
    status: "pending_review",
    statusText: "GateInstance · pending_review",
    handoff: "md_master_v2.md -> script-agent",
    contract: "GateDecision approved 后才允许脚本池读取。",
    health: "等待人工审核",
  },
  {
    id: "script",
    number: 3,
    name: "script-agent",
    role: "脚本与分镜",
    status: "queued",
    statusText: "queued",
    handoff: "script_draft_v1.md -> tts-agent / video-agent",
    contract: "读取母稿版本和 hash，不读取未批准草稿。",
    health: "排队 · 上游 Gate 未放行",
  },
  {
    id: "tts",
    number: 4,
    name: "tts-agent",
    role: "TTS 与字幕",
    status: "blocked",
    statusText: "NodeRun · blocked",
    handoff: "audio_master_v1.wav + subtitle_master_v1.srt -> video-agent",
    contract: "必须具备 ProviderCredential，并写入 ArtifactManifest。",
    health: "阻塞 · VOLC_TTS_API_KEY 缺失",
  },
  {
    id: "video",
    number: 5,
    name: "video-agent",
    role: "视频渲染",
    status: "waiting",
    statusText: "AgentHealth · waiting",
    handoff: "video_master_v1.mp4 -> distribution-agent",
    contract: "等待音频、字幕和画面配置齐备后启动。",
    health: "等待 tts-agent 产物",
  },
  {
    id: "distribution",
    number: 6,
    name: "distribution-agent",
    role: "分发复盘",
    status: "queued",
    statusText: "queued",
    handoff: "publish_package_v1 -> review/delivery",
    contract: "Markdown 分发可绕过视频分支，视频分发必须等待最终渲染 Gate。",
    health: "排队 · 可走 MD 分支",
  },
];

function StatusPill({ status, children }) {
  return <span className={`status-pill status-${status}`}>{children ?? status}</span>;
}

function TopBar({ variant, setActive }) {
  return (
    <header className={`topbar ${variant}`}>
      <div className="workspace-switch">
        <Box size={18} />
        <span>{variant === "home" ? "默认工作区" : "Run 工作区"}</span>
        <ChevronDown size={15} />
      </div>
      <label className="search-box">
        <Search size={17} />
        <input placeholder="全局搜索，运行、工作流、智能体、产物、文档..." />
        <kbd>⌘K</kbd>
      </label>
      <button className="primary action-blue" onClick={() => setActive("new-task")}>
        <Plus size={17} />
        新任务
      </button>
      <button className="attention-button" onClick={() => setActive("attention")}>
        <Bell size={17} />
        Attention
        <span>{variant === "home" ? "12" : "7"}</span>
      </button>
      <div className="health-dot">
        <CircleDot size={15} />
        本地服务 <strong>{variant === "home" ? "健康" : "运行中"}</strong>
      </div>
      <div className="user-chip">张岳</div>
    </header>
  );
}

function AppShell({ active, setActive, children }) {
  const shellVariant = active === "home" ? "home-shell" : active === "attention" ? "attention-shell" : "run-shell";
  return (
    <div className={`app-shell ${shellVariant}`}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">M</div>
          <div>
            <strong>Miracle 奇迹系统</strong>
            <span>{active === "home" ? "Agent OS" : "本地优先的 Agent OS"}</span>
          </div>
        </div>
        <nav className="nav-list" aria-label="主导航">
          {views.map((view) => {
            const Icon = view.icon;
            const selected =
              active === view.id ||
              (view.id === "run" && ["run", "new-task", "dry-run"].includes(active)) ||
              (view.id === "review" && active === "review");
            return (
              <button key={view.id} className={selected ? "active" : ""} onClick={() => setActive(view.id)}>
                <Icon size={18} />
                {view.label}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          <span>{active === "home" ? "本地服务" : "系统状态"}</span>
          <strong>{active === "home" ? "健康 · v0.6.2" : "Local Service · 运行中"}</strong>
          {active !== "home" && (
            <div className="service-list">
              <span>数据库 正常</span>
              <span>事件总线 正常</span>
              <span>存储 正常</span>
            </div>
          )}
        </div>
      </aside>
      <main className="main-panel">
        <TopBar variant={active === "home" ? "home" : "workspace"} setActive={setActive} />
        {children}
      </main>
    </div>
  );
}

function PageHeader({ eyebrow, title, desc, action }) {
  return (
    <header className="page-header">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{desc}</p>
      </div>
      {action}
    </header>
  );
}

function Home({ setActive }) {
  return (
    <section className="home-view">
      <div className="home-main">
        <section className="home-section">
          <div className="section-title">
            <h2>待我处理 <span>3</span></h2>
          </div>
          <table className="home-table">
            <thead>
              <tr>
                <th>优先级</th>
                <th>事项</th>
                <th>类型</th>
                <th>所属对象</th>
                <th>状态</th>
                <th>影响范围</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><span className="priority high">高</span></td>
                <td><strong>母稿待审核</strong><small>请审核内容 MD 母稿 v2</small></td>
                <td>审核</td>
                <td>GateInstance · gate-md-master-002<br />Run · run-20250623-001</td>
                <td><StatusPill status="pending_review">GateInstance · pending_review</StatusPill></td>
                <td>脚本与分镜等 3 个节点</td>
                <td><button onClick={() => setActive("review")}>去审核</button></td>
              </tr>
              <tr className="selected-row">
                <td><span className="priority high">高</span></td>
                <td><strong>TTS 缺凭证</strong><small>TTS 与字幕节点被阻塞</small></td>
                <td>阻塞</td>
                <td>NodeRun · node-tts-001<br />Run · run-20250623-001</td>
                <td><StatusPill status="blocked">NodeRun · blocked</StatusPill></td>
                <td>视频分支无法继续；Markdown 分发不受影响</td>
                <td><button onClick={() => setActive("attention")}>处理</button></td>
              </tr>
              <tr>
                <td><span className="priority mid">中</span></td>
                <td><strong>视频渲染等待</strong><small>等待音频产物与字幕通过</small></td>
                <td>等待</td>
                <td>AgentHealth · video-agent<br />Run · run-20250623-001</td>
                <td><StatusPill status="waiting">AgentHealth · waiting</StatusPill></td>
                <td>等待上游 2 个产物</td>
                <td><button onClick={() => setActive("run")}>查看</button></td>
              </tr>
            </tbody>
          </table>
        </section>

        <section className="home-section">
          <div className="section-title">
            <h2>继续运行 <span>2</span></h2>
          </div>
          <table className="home-table run-table">
            <thead>
              <tr>
                <th>运行 / 工作流</th>
                <th>模板</th>
                <th>进度</th>
                <th>当前阶段</th>
                <th>状态</th>
                <th>更新时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr className="selected-row">
                <td><strong>制作一期 Codex 与 Claude Code 最新动态内容包</strong><small>run-20250623-001</small></td>
                <td>content-production-v0<br />version 0.6</td>
                <td><Progress value={62} label="5 / 8 节点完成" /></td>
                <td>TTS 与字幕被阻塞</td>
                <td><span className="live-dot">运行中</span></td>
                <td>2 分钟前</td>
                <td><button onClick={() => setActive("run")}>进入运行</button></td>
              </tr>
              <tr>
                <td><strong>AI 视频热点周报 2025-06-22</strong><small>run-20250622-002</small></td>
                <td>content-production-v0<br />version 0.6</td>
                <td><Progress value={88} label="7 / 8 节点完成" /></td>
                <td>视频渲染中</td>
                <td><span className="live-dot">运行中</span></td>
                <td>18 分钟前</td>
                <td><button onClick={() => setActive("run")}>进入运行</button></td>
              </tr>
            </tbody>
          </table>
        </section>

        <section className="quick-launch">
          <h2>快速启动</h2>
          <div className="launch-grid">
            <LaunchCard icon={Sparkles} title="推荐：内容生产全流程 (A-G)" desc="采集 -> 清洗 -> MD -> 脚本 -> 分镜 -> TTS -> 视频 -> 分发 -> 复盘" action="使用推荐" onClick={() => setActive("new-task")} />
            <LaunchCard icon={FileText} title="AI 生成方案草案" desc="输入任务描述，AI 为你生成工作流草案并预估成本与风险" action="生成草案" onClick={() => setActive("new-task")} />
            <LaunchCard icon={Wrench} title="从模板自定义" desc="基于模板创建副本，自由增删节点，满足个性化需求" action="从模板创建" onClick={() => setActive("new-task")} />
            <LaunchCard icon={Upload} title="导入工作流" desc="导入 YAML/JSON 工作流文件，快速加入你的项目" action="导入文件" onClick={() => setActive("dry-run")} />
          </div>
        </section>

        <div className="home-bottom-grid">
          <HomePanel title="最近交付" rows={["内容包 v1.0（含视频） · 已交付", "内容包 v1.0（仅 MD） · 已交付", "热点资讯汇总 v1.2 · 已交付"]} />
          <HomePanel title="系统风险" rows={["TTS 凭证未配置（VOLC） · 高", "Claude Code 官方流速率限制 · 中", "存储空间使用率 > 80% · 中"]} />
        </div>
      </div>
      <aside className="home-dock">
        <button className="dock-close"><X size={19} /></button>
        <div className="dock-title">
          <span className="alert-dot">!</span>
          <h2>TTS 缺凭证</h2>
        </div>
        <div className="meta-stack">
          <span><Link2 size={15} /> NodeRun · node-tts-001</span>
          <span><GitBranch size={15} /> Run · run-20250623-001</span>
        </div>
        <StatusPill status="blocked">NodeRun · blocked</StatusPill>
        <h3>根因</h3>
        <p>缺少 VOLC_TTS_API_KEY 凭证，导致 TTS 与字幕节点无法执行。</p>
        <h3>影响范围</h3>
        <p>视频分支无法继续；Markdown 分发不受影响。</p>
        <h3>恢复动作</h3>
        <div className="dock-actions">
          <button><FileText size={17} /> 配置凭证（推荐）</button>
          <button><ShieldCheck size={17} /> 切换 Provider</button>
          <button><GitBranch size={17} /> 跳过可选视频分支</button>
        </div>
        <h3>相关对象</h3>
        <div className="related-box">
          <span>AgentHealth · tts-agent <b>waiting</b></span>
          <span>GateInstance · gate-tts-001 <b>pending_review</b></span>
          <span>ArtifactManifest · subtitle.srt <b>pending</b></span>
        </div>
        <h3>时间线</h3>
        <div className="timeline-small">
          <span>14:22 NodeRun 创建并进入 running</span>
          <span>14:22 缺少凭证检查失败</span>
          <span>14:22 NodeRun 状态变更为 blocked</span>
        </div>
        <button className="primary dock-primary">我已配置，重新尝试</button>
      </aside>
    </section>
  );
}

function LaunchCard({ icon: Icon, title, desc, action, onClick }) {
  return (
    <button className="launch-card" onClick={onClick}>
      <Icon size={28} />
      <strong>{title}</strong>
      <p>{desc}</p>
      <span>{action}</span>
    </button>
  );
}

function HomePanel({ title, rows }) {
  return (
    <section className="home-section compact">
      <h2>{title}</h2>
      <table className="home-table compact-table">
        <tbody>
          {rows.map((row) => (
            <tr key={row}>
              <td>{row}</td>
              <td><MoreHorizontal size={16} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Progress({ value, label }) {
  return (
    <div className="progress-cell">
      <div className="progress-bar"><span style={{ width: `${value}%` }} /></div>
      <small>{value}% · {label}</small>
    </div>
  );
}

function NewTask({ setActive }) {
  return (
    <section className="aux-page">
      <PageHeader
        eyebrow="辅助页面 · 与 A/B/C 视觉保持一致"
        title="启动内容生产任务"
        desc="工作流选择方式和执行策略分开，避免 Auto 术语混用。"
      />
      <div className="two-col">
        <div className="surface">
          <h2>任务输入</h2>
          <label>任务描述</label>
          <textarea defaultValue="制作一期 Codex 与 Claude Code 最新动态的中文内容包" />
          <label>工作流选择方式</label>
          <div className="segmented">
            <button className="selected">推荐模板</button>
            <button>从模板自定义</button>
            <button>AI 生成草案</button>
          </div>
          <label>执行策略</label>
          <div className="segmented">
            <button className="selected">Auto</button>
            <button>Manual</button>
            <button>Hybrid</button>
          </div>
        </div>
        <div className="surface">
          <h2>推荐理由</h2>
          <ul className="clean-list">
            <li>匹配 content-production-v0。</li>
            <li>保留高风险 Gate 人工审核。</li>
            <li>TTS/视频分支可选，允许失败隔离。</li>
          </ul>
          <button className="primary wide" onClick={() => setActive("dry-run")}>进入 Validate / Dry-run</button>
        </div>
      </div>
    </section>
  );
}

function DryRun({ setActive }) {
  return (
    <section className="aux-page">
      <PageHeader
        eyebrow="辅助页面 · 启动前检查"
        title="Validate / Dry-run"
        desc="启动前展示凭证、Gate、Provider、成本、风险和分支影响。"
      />
      <div className="surface">
        <div className="dry-run-summary">
          <MiniPanel title="节点" value="8 个" desc="1 个 optional branch" />
          <MiniPanel title="Gate" value="4 个" desc="2 个需要人工审核" />
          <MiniPanel title="预计成本" value="¥18-42" desc="视频分支影响最大" />
          <MiniPanel title="风险" value="1 个阻塞" desc="TTS 凭证缺失" />
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>节点</th>
              <th>Agent</th>
              <th>检查</th>
              <th>恢复动作</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>内容 MD 母稿</td>
              <td>content-agent</td>
              <td><StatusPill status="pending_review">pending_review</StatusPill></td>
              <td>保留 Gate</td>
            </tr>
            <tr>
              <td>TTS 与字幕</td>
              <td>tts-agent</td>
              <td><StatusPill status="blocked">blocked</StatusPill></td>
              <td>配置凭证 / 切换 Provider / 跳过视频分支</td>
            </tr>
            <tr>
              <td>分发复盘</td>
              <td>distribution-agent</td>
              <td><StatusPill status="ready">ready</StatusPill></td>
              <td>可继续 Markdown 分发</td>
            </tr>
          </tbody>
        </table>
        <div className="button-row right">
          <button>返回调整</button>
          <button className="primary" onClick={() => setActive("run")}>启动 Run</button>
        </div>
      </div>
    </section>
  );
}

function RunWorkspace() {
  const [selectedStage, setSelectedStage] = useState("all");
  const [selectedNode, setSelectedNode] = useState("tts");
  const [eventsOpen, setEventsOpen] = useState(true);
  const activeNode = useMemo(() => nodes.find((node) => node.id === selectedNode) ?? nodes[0], [selectedNode]);
  const visibleNodes = selectedStage === "all" ? nodes : nodes.filter((node) => node.stage === selectedStage);

  return (
    <section className="run-view">
      <div className="run-hero">
        <div className="rocket-mark"><Zap size={28} /></div>
        <div className="run-title">
          <span>当前任务</span>
          <h1>制作一期 Codex 与 Claude Code 最新动态约中文内容包</h1>
          <p>Run ID: run_20250623_01A7 · 创建于 2026-06-23 10:12:35</p>
        </div>
        <div className="run-state">
          <StatusPill status="running">Run · running</StatusPill>
          <span>WorkflowSnapshot · v0.6 · 只读</span>
        </div>
        <div className="run-metric">
          <span>注意事项 (Attention)</span>
          <strong><b className="red">2</b><b className="orange">0</b><b className="purple">0</b><b>0</b></strong>
          <button>查看详情</button>
        </div>
        <div className="run-metric">
          <span>已运行</span>
          <strong>00:24:37</strong>
          <small>预计总时长 01:20:00</small>
        </div>
        <div className="run-metric">
          <span>预估成本</span>
          <strong>$ 0.284</strong>
          <Progress value={14} label="预算 $2.000" />
        </div>
      </div>

      <div className="run-tabs">
        {runTabs.map((tab, index) => <button key={tab} className={index === 1 ? "selected" : ""}>{tab}</button>)}
        <div className="run-tools">
          <button><RefreshCw size={16} /> 刷新</button>
          <button>暂停</button>
          <button>更多 <ChevronDown size={16} /></button>
        </div>
      </div>

      <div className="run-layout">
        <aside className="stage-rail">
          <div className="rail-title">
            <strong>流程阶段过滤</strong>
            <small>非导航</small>
          </div>
          {stages.map((stage) => (
            <button key={stage.id} className={stage.id === selectedStage ? "selected" : ""} onClick={() => setSelectedStage(stage.id)}>
              <span>{stage.label}</span>
              {stage.count && <b>{stage.count}</b>}
            </button>
          ))}
          <label className="rail-toggle">
            <span>仅看异常节点</span>
            <input type="checkbox" />
          </label>
          <div className="workflow-card">
            <h3>流程信息</h3>
            <p>工作流模板 <strong>content-production-v0</strong></p>
            <p>模板版本 <strong>0.6</strong></p>
            <p>Snapshot ID <strong>snap_7f3c9e...</strong></p>
          </div>
        </aside>

        <div className="flow-board">
          <div className="flow-board-head">
            <h2>执行流程视图</h2>
            <div>
              <span>视图：</span>
              <button className="selected">DAG</button>
              <button>列表</button>
            </div>
          </div>
          <div className="node-stack">
            {visibleNodes.map((node) => (
              <button key={node.id} className={`node-card ${selectedNode === node.id ? "selected" : ""} status-border-${node.status}`} onClick={() => setSelectedNode(node.id)}>
                <span className={`node-number ${node.status}`}>{node.number}</span>
                <div className="node-body">
                  <div>
                    <h3>{node.title}</h3>
                    <StatusPill status={node.status}>{node.statusText}</StatusPill>
                  </div>
                  <p>Agent: {node.owner} · NodeRun · {node.statusText}</p>
                  <div className="artifact-chip">
                    <FileText size={16} />
                    <strong>{node.artifact}</strong>
                    <span>{node.artifactMeta}</span>
                  </div>
                </div>
                <span className="node-action">详情 <ChevronDown size={15} /></span>
              </button>
            ))}
          </div>
        </div>

        <aside className="node-detail">
          <button className="drawer-close"><X size={18} /></button>
          <div className="detail-heading">
            <span className={`node-number ${activeNode.status}`}>{activeNode.number}</span>
            <div>
              <h2>{activeNode.title}</h2>
              <StatusPill status={activeNode.status}>{activeNode.statusText}</StatusPill>
            </div>
          </div>
          <div className="detail-grid">
            <span>Agent</span><strong>{activeNode.owner}</strong>
            <span>Provider</span><strong>火山引擎 TTS</strong>
            <span>NodeRun ID</span><strong>nr_8d2f9a7e</strong>
            <span>最新 Attempt</span><strong>attempt_001 · failed</strong>
            <span>运行时长</span><strong>00:04:21</strong>
          </div>
          <h3>根因与影响</h3>
          <p>根因：缺少 VOLC_TTS_API_KEY</p>
          <p>影响：视频分支无法继续；Markdown 分发不受影响。</p>
          <h3>可恢复动作</h3>
          <div className="restore-list">
            <button><Wrench size={17} /> 配置凭证 <span>前往配置</span></button>
            <button><RefreshCw size={17} /> 切换 Provider <span>切换</span></button>
            <button><GitBranch size={17} /> 跳过可选视频分支 <span>跳过</span></button>
          </div>
          <div className="edit-note">
            <strong>编辑与变更</strong>
            <p>Run 使用冻结的 WorkflowSnapshot，当前结构为只读。</p>
            <button>基于当前快照创建 Workflow draft</button>
          </div>
        </aside>
      </div>

      <div className={`event-drawer ${eventsOpen ? "open" : ""}`}>
        <button onClick={() => setEventsOpen(!eventsOpen)}>
          <span>事件与审计（最近 20 条）</span>
          <ChevronDown size={18} />
        </button>
        <div className="event-list">
          <p><b>10:20:11</b> TTS 与字幕 · attempt_001 失败：缺少 VOLC_TTS_API_KEY · NodeRun · blocked</p>
          <p><b>10:19:58</b> 视频渲染 · Agent 进入等待状态，等待音频与字幕产物 · AgentHealth · waiting</p>
          <p><b>10:18:44</b> 内容 MD 母稿 · GateInstance gate-md-master-002 创建，等待人工审核</p>
          <p><b>10:16:21</b> 情报采集与事实校验 · 产物 clean_events.json 已生成</p>
        </div>
      </div>
    </section>
  );
}

function Attention() {
  const [active, setActive] = useState(attentionItems[0].id);
  const item = attentionItems.find((entry) => entry.id === active) ?? attentionItems[0];

  return (
    <section className="attention-view">
      <div className="context-strip">
        <div>
          <span>当前运行 Run Context</span>
          <h1>制作一期 Codex 与 Claude Code 最新动态约中文内容包</h1>
          <p>content-production-v0 · version 0.6</p>
        </div>
        <div>
          <StatusPill status="running">Run · running</StatusPill>
          <p>WorkflowSnapshot · v0.6 · 只读</p>
        </div>
        <div>
          <span>总体进度</span>
          <Progress value={62} label="已完成 7/12 节点" />
        </div>
        <div>
          <span>成本（估算/实际）</span>
          <strong>¥ 34.21 / ¥ 28.76</strong>
        </div>
        <div>
          <span>时长</span>
          <strong>01:42:17</strong>
        </div>
      </div>

      <div className="run-tabs attention-tabs">
        {runTabs.map((tab, index) => <button key={tab} className={index === 2 ? "selected" : ""}>{tab}</button>)}
      </div>

      <div className="attention-grid">
        <div className="attention-queue">
          <div className="panel-head">
            <h2>Attention Queue <span>关注队列</span></h2>
            <small>全部关注项 7</small>
          </div>
          <div className="attention-stats">
            <div className="red">需要决定 <strong>2</strong></div>
            <div className="orange">需要修复 <strong>2</strong></div>
            <div className="blue">需要校对 <strong>1</strong></div>
            <div className="purple">需要关注 <strong>2</strong></div>
          </div>
          <div className="queue-filters">
            {["全部 (7)", "open (5)", "acknowledged (1)", "snoozed (1)", "resolved (23)"].map((filter, index) => (
              <button key={filter} className={index === 0 ? "selected" : ""}>{filter}</button>
            ))}
            <button>按优先级</button>
          </div>
          {attentionItems.map((entry) => (
            <button key={entry.id} className={`attention-row ${entry.id === active ? "selected" : ""}`} onClick={() => setActive(entry.id)}>
              <div className="row-side" />
              <div className="row-main">
                <div className="row-title">
                  <span>{entry.type}</span>
                  <strong>{entry.title}</strong>
                  <b>{entry.priority}</b>
                  <em>等待 {entry.waiting}</em>
                </div>
                <p>{entry.subtitle}</p>
                {entry.id === active && (
                  <div className="row-expanded">
                    <div>
                      <span>原因</span>
                      <strong>{entry.cause}</strong>
                      <span>影响</span>
                      <strong>{entry.impact}</strong>
                      <span>影响范围</span>
                      <strong>{entry.scope}</strong>
                      <span>关联 Run</span>
                      <strong>{entry.run}</strong>
                    </div>
                    <div>
                      <span>相关对象 ({entry.objects.length})</span>
                      {entry.objects.map(([type, name, state]) => (
                        <p key={`${type}-${name}`}><b>{type}</b> {name} <em>{state}</em></p>
                      ))}
                    </div>
                    <div className="safe-actions">
                      <button>配置凭证</button>
                      <button>切换 Provider</button>
                      <button>跳过可选视频分支</button>
                      <button>静音 30 分钟</button>
                    </div>
                  </div>
                )}
              </div>
              <ChevronDown size={18} />
            </button>
          ))}
        </div>

        <aside className="agent-situation">
          <div className="panel-head">
            <h2>智能体协作与依赖态势</h2>
            <span>自动刷新</span>
          </div>
          <div className="agent-summary">
            <div><span>运行中</span><strong>1</strong></div>
            <div><span>等待中</span><strong>2</strong></div>
            <div><span>已阻塞</span><strong>1</strong></div>
            <div><span>已完成</span><strong>1</strong></div>
            <div><span>排队中</span><strong>2</strong></div>
          </div>
          <div className="agent-chain">
            {nodes.map((node) => (
              <button key={node.id} className={`${node.id === "tts" ? "hot" : ""} ${node.status}`} onClick={() => setActive(node.id === "tts" ? "tts-credential" : "md-review")}>
                <span className={`node-number ${node.status}`}>{node.number}</span>
                <div>
                  <strong>{node.owner}</strong>
                  <p>Node · {node.title}</p>
                  <StatusPill status={node.status}>{node.statusText}</StatusPill>
                </div>
                <div className="chain-artifact">
                  <FileText size={15} />
                  <span>{node.artifact}</span>
                  <b>{node.artifactMeta}</b>
                </div>
              </button>
            ))}
          </div>
          <div className="selected-impact">
            <strong>当前选中：{item.title}（{item.subtitle}）</strong>
            <div>
              <span>影响下游 2 个节点</span>
              <span>关联产物 2 个（未生成）</span>
            </div>
            <button>在流程中定位</button>
          </div>
        </aside>
      </div>
    </section>
  );
}

function AgentCollaboration() {
  const [active, setActive] = useState("tts");
  const agent = collaborationAgents.find((entry) => entry.id === active) ?? collaborationAgents[0];

  return (
    <section className="collab-view">
      <div className="collab-hero">
        <div>
          <span>P2F-07 · Agent Collaboration</span>
          <h1>多 Agent 协同与交接态势</h1>
          <p>围绕当前 Run 展示 Agent 职责、交接合同、依赖阻塞和可恢复动作，避免用户只看到单个节点状态。</p>
        </div>
        <div className="collab-metrics">
          <MiniPanel title="活跃 Agent" value="6" desc="1 blocked / 2 waiting" />
          <MiniPanel title="交接合同" value="5" desc="2 个受 Gate 约束" />
          <MiniPanel title="阻塞传播" value="2" desc="影响 video / publish" />
        </div>
      </div>

      <div className="collab-grid">
        <section className="agent-map surface">
          <div className="panel-head">
            <h2>协同链路</h2>
            <small>当前 Run 的 Agent 交接图</small>
          </div>
          <div className="agent-lanes">
            {collaborationAgents.map((entry) => (
              <button key={entry.id} className={`agent-lane ${entry.id === active ? "selected" : ""} ${entry.status}`} onClick={() => setActive(entry.id)}>
                <span className={`node-number ${entry.status}`}>{entry.number}</span>
                <div>
                  <strong>{entry.name}</strong>
                  <p>{entry.role}</p>
                  <StatusPill status={entry.status}>{entry.statusText}</StatusPill>
                </div>
                <span className="handoff-chip">{entry.handoff}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="handoff-panel surface">
          <div className="panel-head">
            <h2>交接协议与阻塞传播</h2>
            <small>选中：{agent.name}</small>
          </div>
          <div className="handoff-card">
            <span>Agent 职责</span>
            <strong>{agent.role}</strong>
            <span>当前状态</span>
            <StatusPill status={agent.status}>{agent.statusText}</StatusPill>
            <span>交接合同</span>
            <p>{agent.contract}</p>
            <span>输出去向</span>
            <p>{agent.handoff}</p>
          </div>
          <div className="dependency-board">
            <div>
              <h3>上游输入</h3>
              <p>md_master_v2.md · pending_review</p>
              <p>script_draft_v1.md · queued</p>
            </div>
            <div>
              <h3>当前风险</h3>
              <p>{agent.health}</p>
              <p>失败后保留 NodeAttempt，不覆盖 NodeRun 历史。</p>
            </div>
            <div>
              <h3>下游影响</h3>
              <p>video-agent waiting</p>
              <p>distribution-agent 可走 Markdown 分支。</p>
            </div>
          </div>
        </section>

        <aside className="collab-actions surface">
          <div className="panel-head">
            <h2>恢复动作</h2>
            <small>必须绑定对象和安全边界</small>
          </div>
          <div className="restore-list">
            <button><Wrench size={17} /> 配置 ProviderCredential <span>影响 tts-agent</span></button>
            <button><RefreshCw size={17} /> 切换备用 Provider <span>保留 Attempt</span></button>
            <button><GitBranch size={17} /> 跳过可选视频分支 <span>仅 MD 交付</span></button>
          </div>
          <div className="event-list collab-events">
            <p><b>10:20:11</b> tts-agent attempt_001 failed，写入 NodeRun blocked。</p>
            <p><b>10:19:58</b> video-agent 进入 waiting，等待音频与字幕产物。</p>
            <p><b>10:18:44</b> content-agent 创建 GateInstance，阻止未审核母稿进入脚本池。</p>
          </div>
        </aside>
      </div>
    </section>
  );
}

function MiniPanel({ title, value, desc }) {
  return (
    <div className="mini-panel">
      <span>{title}</span>
      <strong>{value}</strong>
      <p>{desc}</p>
    </div>
  );
}

function ReviewDrawer() {
  return (
    <section className="aux-page">
      <PageHeader
        eyebrow="辅助页面 · 审核抽屉"
        title="母稿审核"
        desc="保留 Artifact version/hash、Gate、证据、下游影响和返工版本规则。"
      />
      <div className="review-shell">
        <div className="surface">
          <h2>md_master_v2.md</h2>
          <div className="detail-grid">
            <span>Artifact</span><strong>ArtifactManifest · pending_review</strong>
            <span>Version</span><strong>2</strong>
            <span>Hash</span><strong>sha256:8c21...a49e</strong>
            <span>Gate</span><strong>gate-md-master-002</strong>
          </div>
          <div className="article-preview">
            <h3>Codex 与 Claude Code 最新动态</h3>
            <p>本稿汇总官方源、开发者文档和产品更新，保留事实边界和证据链。</p>
          </div>
        </div>
        <aside className="surface">
          <h2>审核决定</h2>
          <p>驳回会创建新 Artifact version 和 NodeAttempt，不覆盖历史。</p>
          <div className="button-row vertical">
            <button className="primary">批准并进入脚本池</button>
            <button>要求返工</button>
            <button>查看下游影响</button>
          </div>
        </aside>
      </div>
    </section>
  );
}

function PlaceholderPage({ title, desc }) {
  return (
    <section className="aux-page">
      <PageHeader eyebrow="P2 暂不展开" title={title} desc={desc} />
      <div className="surface">
        <p>当前 P2 原型只验证首页、Run 工作区、Attention 根因联动与审核闭环。该模块保留为导航入口，后续进入独立设计任务。</p>
      </div>
    </section>
  );
}

export function App() {
  const [active, setActive] = useState("home");

  return (
    <AppShell active={active} setActive={setActive}>
      {active === "home" && <Home setActive={setActive} />}
      {active === "new-task" && <NewTask setActive={setActive} />}
      {active === "dry-run" && <DryRun setActive={setActive} />}
      {active === "run" && <RunWorkspace />}
      {active === "attention" && <Attention />}
      {active === "review" && <ReviewDrawer />}
      {active === "workflow" && <PlaceholderPage title="工作流" desc="Workflow Builder 和 Registry 视图后续单独展开。" />}
      {active === "agents" && <AgentCollaboration />}
      {active === "registry" && <PlaceholderPage title="资源库" desc="组件库、模板和 Provider 资产后续进入资源库设计。" />}
      {active === "settings" && <PlaceholderPage title="设置" desc="凭证、Provider、权限和审计策略后续进入设置设计。" />}
    </AppShell>
  );
}

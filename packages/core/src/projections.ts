import type { AgentHealthProjection, ArtifactManifest, AttentionItem, GateInstance, NodeRun, WorkflowSpec } from "./types";

export function buildRunSummary(run: { run_id: string; workflow_id: string; status: string; created_at?: string }, nodes: NodeRun[]) {
  return {
    run_id: run.run_id,
    workflow_id: run.workflow_id,
    status: run.status,
    progress: {
      done: nodes.filter((node) => node.status === "done").length,
      total: nodes.length
    },
    updated_at: nodes[0]?.updated_at ?? run.created_at ?? new Date().toISOString()
  };
}

export function buildAttentionFromFacts(nodes: NodeRun[], agents: AgentHealthProjection[], artifacts: ArtifactManifest[], gates: GateInstance[]): AttentionItem[] {
  const items: AttentionItem[] = [];
  const blockedTts = nodes.find((node) => node.status === "blocked" && node.blocked_reason?.includes("VOLC_TTS_API_KEY"));
  if (blockedTts) {
    items.push({
      attention_id: "att_tts_credential",
      root_cause_key: "credential:VOLC_TTS_API_KEY:missing",
      title: "TTS 凭证缺失",
      severity: "P0",
      status: "open",
      related_objects: [
        { type: "NodeRun", id: blockedTts.node_run_id, label: "TTS 与字幕" },
        ...agents.filter((agent) => agent.waiting_for.includes("credential:VOLC_TTS_API_KEY")).map((agent) => ({ type: "AgentHealth", id: agent.agent_id, label: agent.name })),
        ...artifacts.filter((artifact) => artifact.status === "missing").map((artifact) => ({ type: "ArtifactManifest", id: artifact.artifact_id, label: artifact.type }))
      ],
      impact: {
        blocked_nodes: [blockedTts.node_run_id],
        waiting_agents: agents.filter((agent) => agent.waiting_for.length > 0).map((agent) => agent.agent_id),
        unaffected_paths: ["markdown_distribution"]
      },
      safe_actions: ["configure_credential", "switch_provider", "skip_optional_branch"]
    });
  }

  for (const gate of gates.filter((item) => item.status === "pending_review")) {
    items.push({
      attention_id: `att_${gate.gate_instance_id}`,
      root_cause_key: `gate:${gate.gate_instance_id}:pending_review`,
      title: "母稿待审核",
      severity: "P0",
      status: "open",
      related_objects: [{ type: "GateInstance", id: gate.gate_instance_id }, gate.target],
      impact: {
        blocked_nodes: gate.required_before,
        waiting_agents: [],
        unaffected_paths: []
      },
      safe_actions: ["approve_gate", "reject_gate", "request_changes"]
    });
  }

  return items;
}

export function buildDagProjection(workflow: WorkflowSpec, nodes: NodeRun[]) {
  return {
    nodes: workflow.nodes.map((node) => ({
      id: node.id,
      name: node.name,
      type: node.type,
      status: nodes.find((run) => run.node_id === node.id)?.status ?? "queued",
      position: workflow.layouts.dag[node.id] ?? { x: 0, y: 0 },
      stage: workflow.layouts.dag[node.id]?.stage ?? "default"
    })),
    edges: workflow.edges.map((edge) => ({
      id: `${edge.from}->${edge.to}`,
      from: edge.from,
      to: edge.to,
      required: edge.required,
      join_policy: edge.join_policy
    }))
  };
}

import type {
  AgentHealthProjection,
  ArtifactManifest,
  AttentionItem,
  CanvasLayout,
  DagProjection,
  GateDecision,
  GateDecisionProjection,
  GateInstance,
  NodeRun,
  WorkflowSpec
} from "./types";

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

export function buildDagProjection(workflow: WorkflowSpec, nodes: NodeRun[]): DagProjection {
  return {
    nodes: workflow.nodes.map((node) => ({
      id: node.id,
      node_run_id: nodes.find((run) => run.node_id === node.id)?.node_run_id,
      name: node.name,
      type: node.type,
      status: nodes.find((run) => run.node_id === node.id)?.status ?? "queued",
      agent_id: nodes.find((run) => run.node_id === node.id)?.agent_id,
      provider: nodes.find((run) => run.node_id === node.id)?.provider,
      position: workflow.layouts.dag[node.id] ?? { x: 0, y: 0 },
      stage: workflow.layouts.dag[node.id]?.stage ?? "default",
      input_artifacts: node.inputs.map((input) => input.artifact_spec_ref ?? input.id),
      output_artifacts: node.outputs.map((output) => output.artifact_spec_ref ?? output.id),
      review_gate_ref: node.review_gate_ref
    })),
    edges: workflow.edges.map((edge) => ({
      id: `${edge.from}->${edge.to}`,
      from: edge.from,
      to: edge.to,
      required: edge.required,
      label: edge.required ? "required" : "optional",
      join_policy: edge.join_policy
    }))
  };
}

export function buildGateDecisionProjection(gate: GateInstance, workflow: WorkflowSpec, nodes: NodeRun[], decision?: GateDecision["decision"]): GateDecisionProjection {
  const approved = decision === "approve" || (!decision && gate.decisions.at(-1)?.decision === "approve");
  const rejected = decision === "reject" || decision === "request_changes" || (!decision && ["reject", "request_changes"].includes(gate.decisions.at(-1)?.decision ?? ""));
  return {
    gate_instance_id: gate.gate_instance_id,
    current_status: gate.status,
    target_artifact_id: gate.target.id,
    projected_artifact_review_status: approved ? "approved" : rejected ? "rejected" : "pending_review",
    affected_node_runs: gate.required_before.map((nodeId) => {
      const nodeRun = nodes.find((node) => node.node_id === nodeId);
      const nodeSpec = workflow.nodes.find((node) => node.id === nodeId);
      return {
        node_id: nodeId,
        node_run_id: nodeRun?.node_run_id,
        current_status: nodeRun?.status,
        projected_status: approved ? (nodeRun?.status === "queued" ? "queued" : nodeRun?.status ?? "queued") : rejected ? "blocked" : "reviewing",
        reason: approved
          ? `Gate 通过后，${nodeSpec?.name ?? nodeId} 可按原执行计划继续判断输入。`
          : rejected
            ? `Gate 驳回后，${nodeSpec?.name ?? nodeId} 等待返工产物。`
            : `${nodeSpec?.name ?? nodeId} 等待 Gate 决策。`
      };
    }),
    event_types: decision ? ["gate_decision_created", "gate_projection_refreshed"] : ["gate_projection_refreshed"],
    mutates_artifact: false
  };
}

export function buildCanvasDraftFromWorkflow(workflow: WorkflowSpec): CanvasLayout {
  const zones = workflow.layouts.canvas?.zones ?? [];
  const zoneObjects = zones.map((zone, index) => ({
    id: `zone_${zone.id}`,
    type: "zone" as const,
    title: zone.name,
    ref_id: zone.id,
    x: 60 + index * 330,
    y: 60,
    width: 290,
    height: 360
  }));
  const nodeObjects = workflow.nodes.map((node, index) => {
    const dag = workflow.layouts.dag[node.id] ?? { x: 80 + index * 220, y: 140 };
    const zone = zones.find((item) => item.node_ids.includes(node.id));
    return {
      id: `node_${node.id}`,
      type: "node" as const,
      title: node.name,
      ref_id: node.id,
      zone_id: zone?.id,
      x: Math.round(dag.x / 1.7) + 80,
      y: Math.round(dag.y / 1.7) + 160,
      width: 210,
      height: 78
    };
  });
  return {
    workflow_id: workflow.id,
    status: "draft",
    updated_at: new Date().toISOString(),
    objects: [...zoneObjects, ...nodeObjects]
  };
}

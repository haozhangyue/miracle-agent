import {
  buildCanvasDraftFromWorkflow,
  buildDagProjection,
  buildGateDecisionProjection,
  adapterPluginShells,
  createAdapterInvocation,
  createArtifactManifestsFromAdapterResult,
  createDryRunPlan,
  createNodeAttemptFromAdapterResult,
  createRunFromWorkflow,
  createRunnerTraceEvents,
  executeMockAdapter,
  validateWorkflowSpec,
  type AdapterArtifactDescriptor,
  type ArtifactManifest,
  type CanvasLayout,
  type GateDecision,
  type GateInstance,
  type NodeAttempt,
  type NodeRun,
  type RunSpec,
  type WorkflowSpec
} from "@miracle/core";
import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readdir, readFile, writeFile, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const workspaceDir = process.env.MIRACLE_WORKSPACE_DIR ?? path.join(rootDir, "fixtures/mvp-workspace/.miracle");
const port = Number(process.env.MIRACLE_SIDECAR_PORT ?? 4317);
const execGit = promisify(execFile);

type JsonValue = Record<string, unknown> | unknown[];

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "http://127.0.0.1:5174",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(body, null, 2));
}

function sendError(res: ServerResponse, status: number, code: string, message: string) {
  sendJson(res, status, { error: { code, message, recoverable: status < 500 } });
}

function sendHtml(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

async function readJson<T>(relativePath: string): Promise<T> {
  const raw = await readFile(path.join(workspaceDir, relativePath), "utf8");
  return JSON.parse(raw) as T;
}

async function readJsonOptional<T>(relativePath: string): Promise<T | undefined> {
  try {
    return await readJson<T>(relativePath);
  } catch {
    return undefined;
  }
}

async function writeJson(relativePath: string, value: unknown) {
  const target = path.join(workspaceDir, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function gitText(args: string[]) {
  const { stdout } = await execGit("/usr/bin/git", ["-C", rootDir, ...args], { encoding: "utf8" });
  return String(stdout).trim();
}

async function gitTextOptional(args: string[]) {
  try {
    return await gitText(args);
  } catch {
    return "";
  }
}

function parseCommitLine(line: string) {
  const [hash, short_hash, author, date, subject] = line.split("\u001f");
  return { hash, short_hash, author, date, subject };
}

async function getGitSyncState() {
  const [branch, head, latestRaw, statusRaw, recentRaw] = await Promise.all([
    gitTextOptional(["rev-parse", "--abbrev-ref", "HEAD"]),
    gitTextOptional(["rev-parse", "HEAD"]),
    gitTextOptional(["log", "-1", "--format=%H%x1f%h%x1f%an%x1f%cI%x1f%s"]),
    gitTextOptional(["status", "--porcelain"]),
    gitTextOptional(["log", "-5", "--format=%H%x1f%h%x1f%an%x1f%cI%x1f%s"])
  ]);
  const statusLines = statusRaw.split("\n").filter(Boolean);
  return {
    available: Boolean(head),
    branch,
    head,
    dirty: statusLines.length > 0,
    uncommitted_count: statusLines.length,
    latest_commit: latestRaw ? parseCommitLine(latestRaw) : undefined,
    recent_commits: recentRaw.split("\n").filter(Boolean).map(parseCommitLine),
    refreshed_at: new Date().toISOString()
  };
}

function collectEvidencePaths(input: unknown) {
  const paths = new Set<string>();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.evidence_paths)) {
      for (const item of record.evidence_paths) {
        if (typeof item === "string") paths.add(item);
      }
    }
    for (const item of Object.values(record)) visit(item);
  };
  visit(input);
  return Array.from(paths).sort();
}

async function getEvidenceState(relativePath: string) {
  const target = path.resolve(rootDir, relativePath);
  const insideRepo = target === rootDir || target.startsWith(`${rootDir}${path.sep}`);
  if (!insideRepo) {
    return { path: relativePath, exists: false, tracked: false, last_commit: undefined, reason: "path_outside_repo" };
  }
  let exists = false;
  let kind = "missing";
  try {
    const info = await stat(target);
    exists = true;
    kind = info.isDirectory() ? "directory" : "file";
  } catch {
    exists = false;
  }
  const tracked = Boolean(await gitTextOptional(["ls-files", "--error-unmatch", "--", relativePath]));
  const lastCommitRaw = await gitTextOptional(["log", "-1", "--format=%H%x1f%h%x1f%an%x1f%cI%x1f%s", "--", relativePath]);
  return {
    path: relativePath,
    exists,
    kind,
    tracked,
    last_commit: lastCommitRaw ? parseCommitLine(lastCommitRaw) : undefined
  };
}

async function buildProjectRoadmap() {
  const raw = await readFile(path.join(rootDir, "plans/mvp-task-baseline/roadmap.json"), "utf8");
  const roadmap = JSON.parse(raw) as Record<string, unknown>;
  const evidencePaths = collectEvidencePaths(roadmap);
  const [git, evidence] = await Promise.all([
    getGitSyncState(),
    Promise.all(evidencePaths.map(getEvidenceState))
  ]);
  return {
    ...roadmap,
    sync_state: {
      git,
      evidence,
      evidence_total: evidence.length,
      evidence_existing: evidence.filter((item) => item.exists).length,
      evidence_missing: evidence.filter((item) => !item.exists).map((item) => item.path),
      refreshed_at: new Date().toISOString()
    }
  };
}

async function appendEvent(runId: string, event: unknown) {
  const file = path.join(workspaceDir, "runs", runId, "events.jsonl");
  await writeFile(file, `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "a" });
}

async function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function listJsonFiles<T>(folder: string): Promise<T[]> {
  const entries = await readdir(path.join(workspaceDir, folder), { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
  return Promise.all(files.map((file) => readJson<T>(path.join(folder, file.name))));
}

async function listRuns() {
  const entries = await readdir(path.join(workspaceDir, "runs"), { withFileTypes: true });
  const runs = [];
  for (const entry of entries.filter((item) => item.isDirectory())) {
    const run = await readJson<Record<string, unknown>>(path.join("runs", entry.name, "run_spec.json"));
    const nodes = await readJson<Array<{ status: string; updated_at?: string }>>(path.join("runs", entry.name, "nodes.json"));
    const attention = await readJson<Array<unknown>>(path.join("runs", entry.name, "attention.json")).catch(() => []);
    runs.push({
      run_id: run.run_id,
      workflow_id: run.workflow_id,
      domain: String(run.workflow_id).replace("-v0", ""),
      status: run.status,
      progress: { done: nodes.filter((node) => node.status === "done").length, total: nodes.length },
      attention_count: attention.length,
      updated_at: nodes[0]?.["updated_at"] ?? run.created_at
    });
  }
  return runs;
}

async function readWorkflow(id: string): Promise<WorkflowSpec> {
  return readJson<WorkflowSpec>(`workflows/${id}.json`);
}

async function readRunBundle(runId: string) {
  const run = await readJson<Record<string, unknown>>(`runs/${runId}/run_spec.json`);
  const snapshot = await readJson<Record<string, unknown>>(`runs/${runId}/workflow_snapshot.json`);
  const workflowId = typeof snapshot.workflow_ref === "string" ? snapshot.workflow_ref : String(run.workflow_id);
  const workflow = typeof snapshot.workflow === "object" && snapshot.workflow ? (snapshot.workflow as WorkflowSpec) : await readWorkflow(workflowId);
  const nodes = await readJson<JsonValue>(`runs/${runId}/nodes.json`);
  const artifacts = await readJson<JsonValue>(`runs/${runId}/artifacts.json`);
  const gates = await readJson<JsonValue>(`runs/${runId}/gates.json`);
  const attention = await readJson<JsonValue>(`runs/${runId}/attention.json`).catch(() => []);
  return { run, snapshot, workflow, nodes, artifacts, gates, attention };
}

async function readEvents(runId: string) {
  const raw = await readFile(path.join(workspaceDir, "runs", runId, "events.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function resolveWorkspacePath(relativePath: string) {
  const root = path.resolve(workspaceDir);
  const target = path.resolve(root, relativePath);
  return target.startsWith(`${root}${path.sep}`) ? target : undefined;
}

function previewMode(filePath: string, artifactType: string): "markdown" | "json" | "text" | "binary" {
  const ext = path.extname(filePath).toLowerCase();
  if (artifactType === "markdown" || ext === ".md") return "markdown";
  if (artifactType === "json" || ext === ".json") return "json";
  if ([".txt", ".srt", ".vtt", ".csv", ".log"].includes(ext) || ["script", "document", "publish_package", "report", "image"].includes(artifactType)) return "text";
  return "binary";
}

async function readArtifactPreview(artifact: ArtifactManifest) {
  const artifactPath = String(artifact.path ?? "");
  const type = String(artifact.type ?? "");
  const mode = previewMode(artifactPath, type);
  if (artifact.status === "missing") {
    return { available: false, mode: "missing", reason: "ArtifactManifest 状态为 missing，当前没有可预览文件。" };
  }
  if (mode === "binary") {
    return { available: false, mode, reason: "二进制产物当前只展示 Manifest，后续接入媒体播放器或下载能力。" };
  }
  const targetPath = resolveWorkspacePath(artifactPath);
  if (!targetPath) {
    return { available: false, mode: "missing", reason: "ArtifactManifest 路径超出当前 workspace，已拒绝预览。" };
  }
  try {
    const raw = await readFile(targetPath, "utf8");
    const limit = 12_000;
    return {
      available: true,
      mode,
      content: raw.length > limit ? raw.slice(0, limit) : raw,
      truncated: raw.length > limit
    };
  } catch {
    return { available: false, mode: "missing", reason: `本地文件不存在：${artifactPath}` };
  }
}

async function writeArtifactDescriptorFile(descriptor: AdapterArtifactDescriptor) {
  if (descriptor.content === undefined) return;
  const targetPath = resolveWorkspacePath(descriptor.path);
  if (!targetPath) throw new Error(`Artifact path escapes workspace: ${descriptor.path}`);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, descriptor.content, "utf8");
}

function buildGateInstancesForArtifacts(input: { workflow: WorkflowSpec; runId: string; artifacts: ArtifactManifest[]; descriptors: AdapterArtifactDescriptor[] }): GateInstance[] {
  const gates: GateInstance[] = [];
  for (const artifact of input.artifacts) {
    const descriptor = input.descriptors.find((item) => item.artifact_id === artifact.artifact_id);
    const artifactSpec = descriptor?.artifact_spec_ref ? input.workflow.artifacts.find((spec) => spec.id === descriptor.artifact_spec_ref) : undefined;
    const linkedSpec = artifactSpec ?? input.workflow.artifacts.find((spec) => spec.type === artifact.type && spec.review_policy.gate_spec_id);
    const gateSpecId = linkedSpec?.review_policy.gate_spec_id;
    const gateSpec = input.workflow.gates.find((gate) => gate.id === gateSpecId);
    if (gateSpec && linkedSpec?.review_policy.mode === "manual") {
      gates.push({
        gate_instance_id: `gate_${artifact.artifact_id}`,
        run_id: input.runId,
        gate_spec_id: gateSpec.id,
        target: { type: "ArtifactManifest" as const, id: artifact.artifact_id },
        status: "pending_review" as const,
        required_before: gateSpec.required_before,
        decisions: []
      });
    }
  }
  return gates;
}

function artifactQualifiesForEdge(edge: WorkflowSpec["edges"][number], sourceNode: NodeRun | undefined, artifacts: ArtifactManifest[]) {
  if (!sourceNode || sourceNode.status !== "done") return false;
  if (!edge.artifact_selector) return true;
  return artifacts.some((artifact) => {
    if (!sourceNode.output_artifacts.includes(artifact.artifact_id)) return false;
    if (artifact.status !== "created") return false;
    if (edge.artifact_selector?.artifact_type && artifact.type !== edge.artifact_selector.artifact_type) return false;
    if (edge.artifact_selector?.review_status && artifact.review_status !== edge.artifact_selector.review_status) return false;
    return true;
  });
}

function shouldQueueDownstream(workflow: WorkflowSpec, nodes: NodeRun[], artifacts: ArtifactManifest[], nodeId: string, triggeringEdge: WorkflowSpec["edges"][number]) {
  if (!artifactQualifiesForEdge(triggeringEdge, nodes.find((node) => node.node_id === triggeringEdge.from), artifacts)) return false;
  const incomingRequiredEdges = workflow.edges.filter((edge) => edge.to === nodeId && edge.required);
  return incomingRequiredEdges.every((edge) => artifactQualifiesForEdge(edge, nodes.find((node) => node.node_id === edge.from), artifacts));
}

function advanceDownstreamNodes(workflow: WorkflowSpec, nodes: NodeRun[], artifacts: ArtifactManifest[], completedNodeId: string, updatedAt: string) {
  const downstreamEdges = workflow.edges.filter((edge) => edge.from === completedNodeId);
  const downstreamById = new Map(downstreamEdges.map((edge) => [edge.to, edge]));
  for (const node of nodes) {
    const triggeringEdge = downstreamById.get(node.node_id);
    if (!triggeringEdge || node.status !== "waiting") continue;
    if (shouldQueueDownstream(workflow, nodes, artifacts, node.node_id, triggeringEdge)) {
      node.status = "queued";
      node.updated_at = updatedAt;
    }
  }
}

function blockGateRequiredNodes(nodes: NodeRun[], requiredBefore: string[], reason: string, updatedAt: string) {
  for (const node of nodes) {
    if (!requiredBefore.includes(node.node_id)) continue;
    if (["done", "running"].includes(node.status)) continue;
    node.status = "blocked";
    node.blocked_reason = reason;
    node.updated_at = updatedAt;
  }
}

function refreshAttentionAfterGateDecision(attention: JsonValue, gateId: string, decision: GateDecision["decision"]) {
  if (!Array.isArray(attention)) return [];
  return attention.map((item) => {
    if (!item || typeof item !== "object") return item;
    const entry = item as Record<string, unknown>;
    if (entry.root_cause_key !== `gate:${gateId}:pending_review`) return item;
    return {
      ...entry,
      status: decision === "approve" ? "resolved" : "acknowledged"
    };
  });
}

async function publishCanvasDraftAsWorkflow(workflowId: string, draft: CanvasLayout) {
  const workflow = await readWorkflow(workflowId);
  const nodeIds = new Set(workflow.nodes.map((node) => node.id));
  const zoneObjects = draft.objects.filter((object) => object.type === "zone");
  const nodeObjects = draft.objects.filter((object) => object.type === "node" && object.ref_id && nodeIds.has(object.ref_id));
  const zones = zoneObjects.map((zone) => ({
    id: zone.ref_id ?? zone.id.replace(/^zone_/, ""),
    name: zone.title ?? zone.ref_id ?? zone.id,
    node_ids: nodeObjects.filter((object) => object.zone_id === (zone.ref_id ?? zone.id.replace(/^zone_/, ""))).map((object) => String(object.ref_id))
  }));
  const draftId = `${workflow.id}-canvas-draft-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;
  const nextWorkflow: WorkflowSpec = {
    ...workflow,
    id: draftId,
    name: `${workflow.name} · Canvas Draft`,
    registry_meta: {
      ...workflow.registry_meta,
      status: "draft"
    },
    layouts: {
      ...workflow.layouts,
      canvas: { zones }
    }
  };
  const validation = validateWorkflowSpec(nextWorkflow);
  if (!validation.valid) return { accepted: false, validation };
  await writeJson(`workflows/${draftId}.json`, nextWorkflow);
  return {
    accepted: true,
    workflow_id: draftId,
    workflow_path: `workflows/${draftId}.json`,
    validation
  };
}

function getId(parts: string[], index: number) {
  return decodeURIComponent(parts[index] ?? "");
}

async function route(req: IncomingMessage, res: ServerResponse) {
  if (req.method === "OPTIONS") return sendJson(res, 204, {});
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && (url.pathname === "/task-baseline" || url.pathname === "/task-baseline/")) {
    const html = await readFile(path.join(rootDir, "plans/mvp-task-baseline/index.html"), "utf8");
    return sendHtml(res, 200, html);
  }

  if (url.pathname === "/api/v0/health") {
    return sendJson(res, 200, { status: "ok", mode: "local-sidecar", workspace: workspaceDir });
  }

  if (req.method === "GET" && url.pathname === "/api/v0/domains") {
    return sendJson(res, 200, { domains: await listJsonFiles("domains") });
  }

  if (req.method === "GET" && url.pathname === "/api/v0/roles") {
    return sendJson(res, 200, { roles: await readJson("registry/roles.json") });
  }

  if (req.method === "GET" && url.pathname === "/api/v0/registry/templates") {
    return sendJson(res, 200, { templates: await readJson("registry/templates.json") });
  }

  if (req.method === "GET" && url.pathname === "/api/v0/adapters") {
    return sendJson(res, 200, { adapters: adapterPluginShells });
  }

  if (req.method === "GET" && url.pathname === "/api/v0/project/roadmap") {
    return sendJson(res, 200, await buildProjectRoadmap());
  }

  if (req.method === "GET" && url.pathname === "/api/v0/workflows") {
    const workflows = await listJsonFiles<WorkflowSpec>("workflows");
    return sendJson(res, 200, {
      workflows: workflows.map((workflow) => ({ id: workflow.id, name: workflow.name, version: workflow.version, domain: workflow.domain, status: workflow.registry_meta.status }))
    });
  }

  if (parts[0] === "api" && parts[1] === "v0" && parts[2] === "workflows" && parts[3]) {
    const workflowId = getId(parts, 3);
    const workflow = await readWorkflow(workflowId);
    if (req.method === "GET" && parts.length === 4) return sendJson(res, 200, { workflow, metadata: { source: workflow.registry_meta.source, readonly: false } });
    if (req.method === "POST" && parts[4] === "validate") return sendJson(res, 200, validateWorkflowSpec(workflow));
    if (req.method === "POST" && parts[4] === "dry-run") return sendJson(res, 200, createDryRunPlan(workflow, []));
    if (parts[4] === "canvas-draft") {
      const draftPath = `drafts/canvas-${workflowId}.json`;
      if (req.method === "POST" && parts[5] === "publish") {
        const draft = (await readJsonOptional<CanvasLayout>(draftPath)) ?? buildCanvasDraftFromWorkflow(workflow);
        const result = await publishCanvasDraftAsWorkflow(workflowId, draft);
        return sendJson(res, result.accepted ? 201 : 422, result);
      }
      if (req.method === "GET") {
        const draft = (await readJsonOptional<CanvasLayout>(draftPath)) ?? buildCanvasDraftFromWorkflow(workflow);
        return sendJson(res, 200, {
          draft,
          spec_diff_preview: {
            diff_id: `diff_canvas_${workflowId}`,
            workflow_id: workflowId,
            operations: draft.objects.map((object) => ({ op: "replace", path: `/layouts/canvas/objects/${object.id}`, value: object }))
          }
        });
      }
      if (req.method === "POST") {
        const body = await parseBody(req);
        const objects = Array.isArray(body.objects) ? body.objects : [];
        const draft: CanvasLayout = {
          workflow_id: workflowId,
          status: "draft",
          updated_at: new Date().toISOString(),
          objects: objects.map((object) => object as CanvasLayout["objects"][number])
        };
        await writeJson(draftPath, draft);
        return sendJson(res, 200, {
          accepted: true,
          draft,
          spec_diff_preview: {
            diff_id: `diff_canvas_${Date.now()}`,
            workflow_id: workflowId,
            operations: draft.objects.map((object) => ({ op: "replace", path: `/layouts/canvas/objects/${object.id}`, value: object }))
          }
        });
      }
    }
  }

  if (req.method === "GET" && url.pathname === "/api/v0/runs") {
    return sendJson(res, 200, { runs: await listRuns() });
  }

  if (req.method === "POST" && url.pathname === "/api/v0/runs") {
    const body = await parseBody(req);
    const workflowId = String(body.workflow_id ?? "content-production-v0");
    const workflow = await readWorkflow(workflowId);
    const runId = `run-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 17)}-${Math.random().toString(36).slice(2, 6)}`;
    const created = createRunFromWorkflow(workflow, {
      runId,
      executionPolicy: body.execution_policy === "auto" || body.execution_policy === "manual" ? body.execution_policy : "hybrid",
      roleProfile: String(body.role_profile ?? "operator")
    });
    await writeJson(`runs/${runId}/run_spec.json`, created.runSpec);
    await writeJson(`runs/${runId}/workflow_snapshot.json`, created.workflowSnapshot);
    await writeJson(`runs/${runId}/nodes.json`, created.nodeRuns);
    await writeJson(`runs/${runId}/attempts.json`, []);
    await writeJson(`runs/${runId}/artifacts.json`, []);
    await writeJson(`runs/${runId}/gates.json`, []);
    await writeJson(`runs/${runId}/attention.json`, []);
    await writeFile(path.join(workspaceDir, "runs", runId, "events.jsonl"), created.events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
    await writeJson(`runs/${runId}/manifest.json`, {
      run_id: runId,
      run_spec_path: `runs/${runId}/run_spec.json`,
      workflow_snapshot_path: `runs/${runId}/workflow_snapshot.json`,
      attempts_path: `runs/${runId}/attempts.json`,
      events_path: `runs/${runId}/events.jsonl`
    });
    return sendJson(res, 201, {
      run_id: runId,
      run_spec_id: `runs/${runId}/run_spec.json`,
      workflow_snapshot_id: created.workflowSnapshot.snapshot_id,
      status: created.runSpec.status,
      created_events: created.events.map((event) => event.event_id),
      initial_node_runs: created.nodeRuns.map((node) => node.node_run_id)
    });
  }

  if (parts[0] === "api" && parts[1] === "v0" && parts[2] === "runs" && parts[3]) {
    const runId = getId(parts, 3);
    if (req.method === "GET" && parts.length === 4) return sendJson(res, 200, await readRunBundle(runId));
    if (req.method === "GET" && parts[4] === "events") return sendJson(res, 200, { events: await readEvents(runId) });
    if (req.method === "GET" && parts[4] === "dag") {
      const bundle = await readRunBundle(runId);
      return sendJson(res, 200, { dag: buildDagProjection(bundle.workflow, bundle.nodes as NodeRun[]) });
    }
    if (parts[4] === "nodes" && parts[5]) {
      const bundle = await readRunBundle(runId);
      const nodeRunId = getId(parts, 5);
      const nodes = bundle.nodes as Array<Record<string, unknown>>;
      const node = nodes.find((item) => item.node_run_id === nodeRunId);
      if (!node) return sendError(res, 404, "not_found", "NodeRun not found");
      const attempts = (await readJsonOptional<NodeAttempt[]>(`runs/${runId}/attempts.json`)) ?? [];
      if (parts.length === 6) return sendJson(res, 200, { node, attempts: attempts.filter((attempt) => attempt.node_run_id === nodeRunId) });
      if (req.method === "POST" && parts[6] === "execute") {
        const lockName = nodeRunId.replace(/[^a-zA-Z0-9._-]/g, "_");
        const lockDir = path.join(workspaceDir, "runs", runId, "locks", `${lockName}.lock`);
        await mkdir(path.dirname(lockDir), { recursive: true });
        try {
          await mkdir(lockDir, { recursive: false });
        } catch {
          return sendError(res, 409, "operation_in_progress", "NodeRun already has an execute operation in progress.");
        }

        try {
          const lockedBundle = await readRunBundle(runId);
          const runSpec = lockedBundle.run as unknown as RunSpec;
          const nodeRuns = lockedBundle.nodes as NodeRun[];
          const targetNodeRun = nodeRuns.find((item) => item.node_run_id === nodeRunId);
          if (!targetNodeRun) return sendError(res, 404, "not_found", "NodeRun not found");
          if (!["queued", "running"].includes(targetNodeRun.status)) {
            return sendError(res, 409, "node_not_executable", `Only queued or running NodeRun can be executed. Current status: ${targetNodeRun.status}`);
          }

          const dispatchedAt = new Date().toISOString();
          targetNodeRun.status = "running";
          targetNodeRun.started_at = targetNodeRun.started_at ?? dispatchedAt;
          targetNodeRun.updated_at = dispatchedAt;
          await writeJson(`runs/${runId}/nodes.json`, nodeRuns);

          const invocation = createAdapterInvocation({ runSpec, workflow: lockedBundle.workflow, nodeRun: targetNodeRun, createdAt: dispatchedAt });
          const result = executeMockAdapter({ invocation, workflow: lockedBundle.workflow, receivedAt: new Date().toISOString() });
          const attempt = createNodeAttemptFromAdapterResult(result);
          const createdArtifacts = createArtifactManifestsFromAdapterResult({
            result,
            runId,
            nodeRun: targetNodeRun,
            producer: targetNodeRun.agent_id ?? "mock-runner",
            createdAt: result.received_at
          });
          for (const descriptor of result.artifact_descriptors) await writeArtifactDescriptorFile(descriptor);

          const artifacts = lockedBundle.artifacts as ArtifactManifest[];
          const gates = lockedBundle.gates as GateInstance[];
          const createdGates = buildGateInstancesForArtifacts({ workflow: lockedBundle.workflow, runId, artifacts: createdArtifacts, descriptors: result.artifact_descriptors });
          const committedStatus: NodeRun["status"] = result.status === "succeeded" ? (createdGates.length > 0 ? "reviewing" : "done") : "failed";
          targetNodeRun.status = committedStatus;
          targetNodeRun.updated_at = result.received_at;
          targetNodeRun.output_artifacts = Array.from(new Set([...targetNodeRun.output_artifacts, ...createdArtifacts.map((artifact) => artifact.artifact_id)]));

          const nextAttempts = [...attempts, attempt];
          const nextArtifacts = [...artifacts, ...createdArtifacts];
          const nextGates = [...gates, ...createdGates];
          if (committedStatus === "done") advanceDownstreamNodes(lockedBundle.workflow, nodeRuns, nextArtifacts, targetNodeRun.node_id, result.received_at);
          runSpec.status = "running";

          await writeJson(`runs/${runId}/run_spec.json`, runSpec);
          await writeJson(`runs/${runId}/nodes.json`, nodeRuns);
          await writeJson(`runs/${runId}/attempts.json`, nextAttempts);
          await writeJson(`runs/${runId}/artifacts.json`, nextArtifacts);
          await writeJson(`runs/${runId}/gates.json`, nextGates);

          const runnerEvents = createRunnerTraceEvents({ invocation, result, committedNodeStatus: committedStatus });
          const artifactEvents = createdArtifacts.map((artifact) => ({
            event_id: `evt_${artifact.artifact_id}_created`,
            run_id: runId,
            type: "artifact_manifest_created",
            subject: { type: "ArtifactManifest", id: artifact.artifact_id },
            message: `ArtifactManifest ${artifact.artifact_id} created by Orchestrator`,
            created_at: artifact.created_at
          }));
          const gateEvents = createdGates.map((gate) => ({
            event_id: `evt_${gate.gate_instance_id}_pending`,
            run_id: runId,
            type: "gate_pending_review",
            subject: { type: "GateInstance", id: gate.gate_instance_id },
            message: `GateInstance ${gate.gate_instance_id} pending review`,
            created_at: result.received_at
          }));
          const events = [...runnerEvents, ...artifactEvents, ...gateEvents];
          for (const event of events) await appendEvent(runId, event);

          return sendJson(res, 200, {
            accepted: true,
            invocation,
            adapter_result: result,
            committed: {
              node_run: targetNodeRun,
              attempt,
              artifacts: createdArtifacts,
              gates: createdGates,
              created_events: events.map((event) => event.event_id)
            }
          });
        } finally {
          await rm(lockDir, { recursive: true, force: true });
        }
      }
    }
  }

  if (req.method === "GET" && url.pathname === "/api/v0/agents/health") {
    return sendJson(res, 200, { agents: await readJson("agents/agents.json") });
  }

  if (req.method === "GET" && url.pathname === "/api/v0/agents/collaboration") {
    const agents = await readJson<Array<Record<string, unknown>>>("agents/agents.json");
    return sendJson(res, 200, {
      agents,
      links: [
        { from: "intelligence-agent", to: "content-agent", artifact: "art_clean_events_v1" },
        { from: "content-agent", to: "distribution-agent", gate: "gate-md-master-001" },
        { from: "tts-agent", to: "video-agent", blocked_by: "credential:VOLC_TTS_API_KEY" }
      ]
    });
  }

  if (req.method === "GET" && url.pathname === "/api/v0/attention") {
    const runId = url.searchParams.get("run_id") ?? "run-demo-001";
    return sendJson(res, 200, { attention: await readJson(`runs/${runId}/attention.json`) });
  }

  if (parts[0] === "api" && parts[1] === "v0" && parts[2] === "attention" && parts[3]) {
    const attentionId = getId(parts, 3);
    const runId = url.searchParams.get("run_id") ?? "run-demo-001";
    if (req.method === "GET") {
      const attention = await readJson<Array<Record<string, unknown>>>(`runs/${runId}/attention.json`);
      const item = attention.find((entry) => entry.attention_id === attentionId);
      return item ? sendJson(res, 200, { attention: item }) : sendError(res, 404, "not_found", "Attention not found");
    }
    if (req.method === "POST" && parts[4] === "actions") {
      const body = await parseBody(req);
      return sendJson(res, 200, { accepted: true, receipt_id: `receipt_${Date.now()}`, event_id: `evt_attention_${Date.now()}`, action: body.action ?? "acknowledge" });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/v0/artifacts") {
    const runId = url.searchParams.get("run_id") ?? "run-demo-001";
    return sendJson(res, 200, { artifacts: await readJson(`runs/${runId}/artifacts.json`) });
  }

  if (parts[0] === "api" && parts[1] === "v0" && parts[2] === "artifacts" && parts[3] && req.method === "GET") {
    const runId = url.searchParams.get("run_id") ?? "run-demo-001";
    const artifacts = await readJson<ArtifactManifest[]>(`runs/${runId}/artifacts.json`);
    const artifact = artifacts.find((item) => item.artifact_id === getId(parts, 3));
    if (!artifact) return sendError(res, 404, "not_found", "Artifact not found");
    return sendJson(res, 200, { artifact, preview: await readArtifactPreview(artifact) });
  }

  if (parts[0] === "api" && parts[1] === "v0" && parts[2] === "gates" && parts[3]) {
    const gateId = getId(parts, 3);
    const runId = url.searchParams.get("run_id") ?? "run-demo-001";
    const gates = await readJson<GateInstance[]>(`runs/${runId}/gates.json`);
    const artifacts = await readJson<ArtifactManifest[]>(`runs/${runId}/artifacts.json`);
    const gate = gates.find((item) => item.gate_instance_id === gateId);
    if (!gate) return sendError(res, 404, "not_found", "Gate not found");
    if (req.method === "GET") {
      const bundle = await readRunBundle(runId);
      return sendJson(res, 200, {
        gate,
        target_artifact: artifacts.find((artifact) => artifact.artifact_id === gate.target.id),
        history_decisions: gate.decisions,
        projection: buildGateDecisionProjection(gate, bundle.workflow, bundle.nodes as NodeRun[])
      });
    }
    if (req.method === "POST" && parts[4] === "decision") {
      const body = await parseBody(req);
      const decisionValue = body.decision === "reject" || body.decision === "request_changes" ? body.decision : "approve";
      const lockName = gateId.replace(/[^a-zA-Z0-9._-]/g, "_");
      const lockDir = path.join(workspaceDir, "runs", runId, "locks", `${lockName}.gate.lock`);
      await mkdir(path.dirname(lockDir), { recursive: true });
      try {
        await mkdir(lockDir, { recursive: false });
      } catch {
        return sendError(res, 409, "operation_in_progress", "GateInstance already has a decision operation in progress.");
      }

      try {
        const lockedBundle = await readRunBundle(runId);
        const lockedGates = lockedBundle.gates as GateInstance[];
        const lockedGate = lockedGates.find((item) => item.gate_instance_id === gateId);
        if (!lockedGate) return sendError(res, 404, "not_found", "Gate not found");
        if (lockedGate.status !== "pending_review") {
          return sendError(res, 409, "gate_already_decided", "GateInstance is already decided. Create a new review cycle before adding another decision.");
        }

        const decision: GateDecision = {
          decision_id: `gd_${Date.now()}`,
          actor: String(body.actor ?? "local_user"),
          decision: decisionValue,
          comment: String(body.comment ?? ""),
          created_at: new Date().toISOString()
        };
        lockedGate.decisions.push(decision);
        lockedGate.status = "decided";

        const lockedArtifacts = lockedBundle.artifacts as ArtifactManifest[];
        const nodes = lockedBundle.nodes as NodeRun[];
        const targetArtifact = lockedArtifacts.find((artifact) => artifact.artifact_id === lockedGate.target.id);
        const producerNode = targetArtifact ? nodes.find((node) => node.node_run_id === targetArtifact.node_run_id) : undefined;
        if (targetArtifact) {
          targetArtifact.review_status = decision.decision === "approve" ? "approved" : "rejected";
        }
        if (decision.decision === "approve" && producerNode) {
          producerNode.status = "done";
          producerNode.updated_at = decision.created_at;
          advanceDownstreamNodes(lockedBundle.workflow, nodes, lockedArtifacts, producerNode.node_id, decision.created_at);
        }
        if (decision.decision !== "approve") {
          blockGateRequiredNodes(nodes, lockedGate.required_before, `Gate ${lockedGate.gate_instance_id} ${decision.decision}，等待返工产物`, decision.created_at);
        }

        const nextAttention = refreshAttentionAfterGateDecision(lockedBundle.attention, lockedGate.gate_instance_id, decision.decision);
        await writeJson(`runs/${runId}/gates.json`, lockedGates);
        await writeJson(`runs/${runId}/artifacts.json`, lockedArtifacts);
        await writeJson(`runs/${runId}/nodes.json`, nodes);
        await writeJson(`runs/${runId}/attention.json`, nextAttention);
        const event = {
          event_id: `evt_gate_${decision.decision_id}`,
          run_id: runId,
          type: "gate_decision_created",
          subject: { type: "GateInstance", id: lockedGate.gate_instance_id },
          message: `Gate decision ${decision.decision} by ${decision.actor}`,
          created_at: decision.created_at
        };
        await appendEvent(runId, event);
        const bundle = await readRunBundle(runId);
        return sendJson(res, 200, {
          accepted: true,
          gate_decision_id: decision.decision_id,
          created_events: [event.event_id],
          projection: buildGateDecisionProjection(lockedGate, bundle.workflow, bundle.nodes as NodeRun[], decision.decision, true),
          next_suggested_actions: decision.decision === "approve" ? ["continue_downstream"] : ["create_rework_attempt"]
        });
      } finally {
        await rm(lockDir, { recursive: true, force: true });
      }
    }
  }

  return sendError(res, 404, "not_found", `${req.method ?? "GET"} ${url.pathname} not found`);
}

const server = createServer((req, res) => {
  route(req, res).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown sidecar error";
    sendError(res, 500, "sidecar_error", message);
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Miracle Local Sidecar listening on http://127.0.0.1:${port}`);
  console.log(`Workspace: ${workspaceDir}`);
});

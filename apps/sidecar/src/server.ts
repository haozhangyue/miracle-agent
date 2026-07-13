import {
  buildCanvasDraftFromWorkflow,
  buildDagProjection,
  buildGateDecisionProjection,
  buildAdapterRegistry,
  canvasNodeSpecDraftSchema,
  createAdapterInvocation,
  createArtifactManifestsFromAdapterResult,
  createDryRunPlan,
  createNodeAttemptFromAdapterResult,
  createRunFromWorkflow,
  createRunnerTraceEvents,
  defaultAdapterManifests,
  executeMockAdapter,
  parseAdapterManifests,
  parseAdapterResultForInvocation,
  selectAdapterManifest,
  type AdapterManifest,
  type AdapterRegistryEntry,
  validateWorkflowSpec,
  type AdapterResult,
  type AttentionItem,
  type AdapterArtifactDescriptor,
  type ArtifactManifest,
  type CanvasLayout,
  type CanvasNodeSpecDraft,
  type GateDecision,
  type GateInstance,
  type HistoricalImportRequest,
  RunDraftError,
  type NodeSpec,
  type NodeAttempt,
  type NodeRun,
  type RunSpec,
  type ValidationResult,
  type WorkflowSpec
} from "@miracle/core";
import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readdir, readFile, writeFile, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  commitHistoricalImport,
  HistoricalImportError,
  previewHistoricalImport,
  readHistoricalImport
} from "./historical-importer";
import { RunDraftStore, RunDraftStoreError } from "./run-draft-store";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const workspaceDir = process.env.MIRACLE_WORKSPACE_DIR ?? path.join(rootDir, "fixtures/mvp-workspace/.miracle");
const workflowRegistryDir = process.env.MIRACLE_WORKFLOW_REGISTRY_DIR ?? path.join(rootDir, "fixtures/mvp-workspace/.miracle/workflows");
const port = Number(process.env.MIRACLE_SIDECAR_PORT ?? 4317);
const historicalImportRoots = (process.env.MIRACLE_IMPORT_ROOTS ?? "")
  .split(path.delimiter)
  .map((item) => item.trim())
  .filter(Boolean);
const execGit = promisify(execFile);
const runDraftStore = new RunDraftStore({ workspace_dir: workspaceDir, workflows_dir: workflowRegistryDir });

type JsonValue = Record<string, unknown> | unknown[];
type SchedulerDecision = {
  node_run_id: string;
  node_id: string;
  status: NodeRun["status"];
  decision: "execute" | "pause_for_gate" | "skip";
  reason: string;
  gate_instance_id?: string;
};
type SchedulerFailure = {
  decision: SchedulerDecision;
  node_run_id: string;
  node_id: string;
  error: { code: string; message: string; recoverable: boolean };
};
type CanvasObject = CanvasLayout["objects"][number];
type NodeExecutionResult =
  | {
      accepted: false;
      status_code: number;
      error: { code: string; message: string };
    }
  | {
      accepted: true;
      invocation: ReturnType<typeof createAdapterInvocation>;
      adapter_result: AdapterResult;
      committed: {
        node_run: NodeRun;
        attempt: NodeAttempt;
        artifacts: ArtifactManifest[];
        gates: GateInstance[];
        created_events: string[];
      };
    };

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "http://127.0.0.1:5174",
    "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
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

function availableCredentialKeys() {
  return Object.entries(process.env)
    .filter(([, value]) => typeof value === "string" && value.length > 0)
    .map(([key]) => key);
}

function createRunDraftId() {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 17);
  return `rundraft_${timestamp}_${Math.random().toString(36).slice(2, 8)}`;
}

async function readAdapterManifests(): Promise<AdapterManifest[]> {
  try {
    const raw = await listJsonFiles<unknown>("adapters");
    return parseAdapterManifests(raw);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return defaultAdapterManifests;
    }
    throw error;
  }
}

async function readAdapterRegistry(): Promise<AdapterRegistryEntry[]> {
  return buildAdapterRegistry({ manifests: await readAdapterManifests(), availableCredentials: availableCredentialKeys() });
}

type RunViewMeta = {
  origin: "native" | "historical_import";
  mode: "executable" | "historical_readonly";
  source_confidence: "high" | "mixed" | "low";
  source_meta_available: boolean;
};

type HistoricalSourceMetaProjection = {
  mode: "historical_readonly";
  source_run_dir: string;
  source_fingerprint: string;
  imported_at: string;
  gaps: Array<{ code: string; severity: string; message: string }>;
  objects: Record<string, { confidence?: string; source_paths?: string[] }>;
};

function buildRunViewMeta(run: Record<string, unknown>, sourceMeta?: HistoricalSourceMetaProjection): RunViewMeta {
  if (run.run_mode !== "historical_readonly") {
    return { origin: "native", mode: "executable", source_confidence: "high", source_meta_available: false };
  }
  const gaps = sourceMeta?.gaps ?? [];
  const sourceConfidence = gaps.some((gap) => gap.severity === "error") ? "low" : gaps.length > 0 ? "mixed" : "high";
  return { origin: "historical_import", mode: "historical_readonly", source_confidence: sourceConfidence, source_meta_available: Boolean(sourceMeta) };
}

async function listRuns() {
  const entries = await readdir(path.join(workspaceDir, "runs"), { withFileTypes: true });
  const runs = [];
  for (const entry of entries.filter((item) => item.isDirectory() && !item.name.startsWith("."))) {
    const run = await readJson<Record<string, unknown>>(path.join("runs", entry.name, "run_spec.json"));
    const nodes = await readJson<Array<{ status: string; updated_at?: string }>>(path.join("runs", entry.name, "nodes.json"));
    const attention = await readJson<Array<unknown>>(path.join("runs", entry.name, "attention.json")).catch(() => []);
    const sourceMeta = await readJsonOptional<HistoricalSourceMetaProjection>(path.join("runs", entry.name, "source_meta.json"));
    runs.push({
      run_id: run.run_id,
      workflow_id: run.workflow_id,
      domain: String(run.workflow_id).replace("-v0", ""),
      status: run.status,
      progress: { done: nodes.filter((node) => ["done", "completed"].includes(node.status)).length, total: nodes.length },
      attention_count: attention.length,
      updated_at: nodes[0]?.["updated_at"] ?? run.created_at,
      view_meta: buildRunViewMeta(run, sourceMeta)
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
  const sourceMeta = await readJsonOptional<HistoricalSourceMetaProjection>(`runs/${runId}/source_meta.json`);
  return { run, snapshot, workflow, nodes, artifacts, gates, attention, source_meta: sourceMeta, view_meta: buildRunViewMeta(run, sourceMeta) };
}

async function isHistoricalReadOnlyRun(runId: string) {
  const run = await readJsonOptional<{ run_mode?: string }>(`runs/${runId}/run_spec.json`);
  return run?.run_mode === "historical_readonly";
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

function qualifiedArtifactsForEdge(edge: WorkflowSpec["edges"][number], sourceNode: NodeRun | undefined, artifacts: ArtifactManifest[]) {
  if (!sourceNode || sourceNode.status !== "done") return [];
  const sourceArtifacts = artifacts.filter((artifact) => {
    if (!sourceNode.output_artifacts.includes(artifact.artifact_id)) return false;
    if (artifact.status !== "created") return false;
    if (edge.artifact_selector?.artifact_type && artifact.type !== edge.artifact_selector.artifact_type) return false;
    if (edge.artifact_selector?.review_status && artifact.review_status !== edge.artifact_selector.review_status) return false;
    return true;
  });
  if (!edge.artifact_selector) return sourceArtifacts;
  return sourceArtifacts;
}

function artifactQualifiesForEdge(edge: WorkflowSpec["edges"][number], sourceNode: NodeRun | undefined, artifacts: ArtifactManifest[]) {
  if (!sourceNode || sourceNode.status !== "done") return false;
  if (!edge.artifact_selector) return true;
  return qualifiedArtifactsForEdge(edge, sourceNode, artifacts).length > 0;
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
    const canAdvance = node.status === "waiting" || (node.status === "blocked" && node.blocked_reason?.includes("Gate "));
    if (!triggeringEdge || !canAdvance) continue;
    if (shouldQueueDownstream(workflow, nodes, artifacts, node.node_id, triggeringEdge)) {
      const incomingEdges = workflow.edges.filter((edge) => edge.to === node.node_id);
      const upstreamArtifacts = incomingEdges.flatMap((edge) => qualifiedArtifactsForEdge(edge, nodes.find((source) => source.node_id === edge.from), artifacts));
      node.upstream_artifacts = Array.from(new Set([...node.upstream_artifacts, ...upstreamArtifacts.map((artifact) => artifact.artifact_id)]));
      node.status = "queued";
      delete node.blocked_reason;
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

function safeId(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function nextArtifactVersion(artifacts: ArtifactManifest[], targetArtifact: ArtifactManifest) {
  const versions = artifacts
    .filter((artifact) => artifact.node_run_id === targetArtifact.node_run_id && artifact.type === targetArtifact.type)
    .map((artifact) => artifact.version);
  return Math.max(targetArtifact.version, ...versions) + 1;
}

function nextReworkArtifactId(targetArtifact: ArtifactManifest, version: number) {
  if (/_v\d+$/.test(targetArtifact.artifact_id)) return targetArtifact.artifact_id.replace(/_v\d+$/, `_v${version}`);
  return `${safeId(targetArtifact.artifact_id)}_rework_v${version}`;
}

function nextReworkArtifactPath(targetArtifact: ArtifactManifest, artifactId: string, version: number) {
  const ext = path.extname(targetArtifact.path);
  if (ext) {
    const withoutExt = targetArtifact.path.slice(0, -ext.length);
    if (/_v\d+$/.test(withoutExt)) return `${withoutExt.replace(/_v\d+$/, `_v${version}`)}${ext}`;
    return `${withoutExt}_rework_v${version}${ext}`;
  }
  return `artifacts/${artifactId}.txt`;
}

async function writeReworkArtifactFile(input: {
  targetArtifact: ArtifactManifest;
  nextArtifact: ArtifactManifest;
  content?: string;
  comment: string;
}) {
  const mode = previewMode(input.nextArtifact.path, input.nextArtifact.type);
  if (mode === "binary") return;
  const targetPath = resolveWorkspacePath(input.nextArtifact.path);
  if (!targetPath) throw new Error(`Artifact path escapes workspace: ${input.nextArtifact.path}`);
  const previousPreview = await readArtifactPreview(input.targetArtifact);
  const previousContent = previousPreview.available && "content" in previousPreview ? String(previousPreview.content ?? "") : "";
  const content =
    input.content ??
    `${previousContent}\n\n---\n\n## 返工版本\n\n- supersedes: ${input.targetArtifact.artifact_id}\n- reason: ${input.comment || "Gate 驳回后创建返工版本"}\n`;
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content, "utf8");
}

function addGatePendingAttention(attention: JsonValue, gate: GateInstance) {
  const items = Array.isArray(attention) ? attention.filter((item) => item && typeof item === "object") : [];
  const nextItem = {
    attention_id: `att_${gate.gate_instance_id}`,
    root_cause_key: `gate:${gate.gate_instance_id}:pending_review`,
    title: "返工产物待审核",
    severity: "P0",
    status: "open",
    related_objects: [{ type: "GateInstance", id: gate.gate_instance_id }, gate.target],
    impact: {
      blocked_nodes: gate.required_before,
      waiting_agents: [],
      unaffected_paths: []
    },
    safe_actions: ["approve_gate", "reject_gate", "request_changes"]
  };
  return [...items.filter((item) => (item as Record<string, unknown>).root_cause_key !== nextItem.root_cause_key), nextItem];
}

function preferredAdapterKinds(provider: string): AdapterManifest["kind"][] {
  if (provider.includes("codex")) return ["codex", "mock-local"];
  if (provider.includes("hermes")) return ["hermes", "mock-local"];
  if (provider.includes("openclaw")) return ["openclaw", "mock-local"];
  if (["openai", "anthropic", "volc-tts", "official-api"].some((name) => provider.includes(name))) return ["official-api", "mock-local"];
  if (provider.includes("mock")) return ["mock-local", "codex"];
  return ["mock-local", "codex"];
}

function buildAdapterUnavailableResult(input: {
  invocation: ReturnType<typeof createAdapterInvocation>;
  message: string;
  receivedAt?: string;
}): AdapterResult {
  return {
    operation_id: input.invocation.operation_id,
    attempt_id: input.invocation.attempt_id,
    node_run_id: input.invocation.node_run_id,
    status: "failed",
    provider_receipt: {
      provider: input.invocation.provider,
      adapter_kind: input.invocation.adapter_kind,
      adapter_id: input.invocation.adapter_id,
      operation_id: input.invocation.operation_id,
      raw_receipt_id: `receipt_${input.invocation.operation_id}`
    },
    artifact_descriptors: [],
    error: {
      code: "no_executable_adapter",
      message: input.message,
      recoverable: true
    },
    received_at: input.receivedAt ?? new Date().toISOString()
  };
}

function selectAdapterForNode(input: {
  manifests: AdapterManifest[];
  node: WorkflowSpec["nodes"][number];
  provider: string;
  availableCredentials: string[];
}) {
  return (
    selectAdapterManifest({
      manifests: input.manifests,
      capabilityRequirements: input.node.capability_requirements,
      provider: input.provider,
      preferredKinds: preferredAdapterKinds(input.provider),
      availableCredentials: input.availableCredentials
    }) ??
    selectAdapterManifest({
      manifests: input.manifests,
      capabilityRequirements: input.node.capability_requirements,
      preferredKinds: preferredAdapterKinds(input.provider),
      availableCredentials: input.availableCredentials
    })
  );
}

function executeSidecarAdapter(input: {
  invocation: ReturnType<typeof createAdapterInvocation>;
  workflow: WorkflowSpec;
  nodeRun: NodeRun;
  adapter: AdapterRegistryEntry;
  receivedAt?: string;
}): AdapterResult {
  const receivedAt = input.receivedAt ?? new Date().toISOString();
  if (!input.adapter.executable) {
    return {
      operation_id: input.invocation.operation_id,
      attempt_id: input.invocation.attempt_id,
      node_run_id: input.invocation.node_run_id,
      status: "failed",
      provider_receipt: {
        provider: input.invocation.provider,
        adapter_kind: input.invocation.adapter_kind,
        adapter_id: input.invocation.adapter_id,
        operation_id: input.invocation.operation_id,
        raw_receipt_id: `receipt_${input.invocation.operation_id}`
      },
      artifact_descriptors: [],
      error: {
        code: "adapter_unavailable",
        message: `Adapter ${input.adapter.id} is unavailable: ${input.adapter.unavailable_reasons.join(", ")}`,
        recoverable: true
      },
      received_at: receivedAt
    };
  }
  if (input.nodeRun.provider === "mock-failure") {
    return {
      operation_id: input.invocation.operation_id,
      attempt_id: input.invocation.attempt_id,
      node_run_id: input.invocation.node_run_id,
      status: "failed",
      provider_receipt: {
        provider: input.invocation.provider,
        adapter_kind: input.invocation.adapter_kind,
        adapter_id: input.invocation.adapter_id,
        operation_id: input.invocation.operation_id,
        raw_receipt_id: `receipt_${input.invocation.operation_id}`
      },
      artifact_descriptors: [],
      error: {
        code: "mock_failure",
        message: "Mock failure provider requested a failed AdapterResult.",
        recoverable: true
      },
      received_at: receivedAt
    };
  }
  if (input.nodeRun.provider === "mock-invalid-receipt") {
    const result = executeMockAdapter({ invocation: input.invocation, workflow: input.workflow, receivedAt });
    return { ...result, provider_receipt: { ...result.provider_receipt, operation_id: "op_mismatched" } };
  }
  if (input.adapter.execution_mode !== "mock-compatible") {
    return {
      operation_id: input.invocation.operation_id,
      attempt_id: input.invocation.attempt_id,
      node_run_id: input.invocation.node_run_id,
      status: "failed",
      provider_receipt: {
        provider: input.invocation.provider,
        adapter_kind: input.invocation.adapter_kind,
        adapter_id: input.invocation.adapter_id,
        operation_id: input.invocation.operation_id,
        raw_receipt_id: `receipt_${input.invocation.operation_id}`
      },
      artifact_descriptors: [],
      error: {
        code: "adapter_runtime_not_implemented",
        message: `Adapter ${input.adapter.id} runtime ${input.adapter.runtime.local_executor} is not implemented in MVP.`,
        recoverable: true
      },
      received_at: receivedAt
    };
  }
  return executeMockAdapter({ invocation: input.invocation, workflow: input.workflow, receivedAt });
}

function buildSchedulerFailureAttentionItem(input: { failure: SchedulerFailure; node?: NodeRun }): AttentionItem {
  const nodeId = input.node?.node_id ?? input.failure.node_id;
  const nodeRunId = input.node?.node_run_id ?? input.failure.node_run_id;
  return {
    attention_id: `att_${safeId(nodeRunId)}_execution_failed`,
    root_cause_key: `node:${nodeRunId}:execution_failed`,
    title: "NodeRun 执行失败",
    severity: "P0",
    status: "open",
    related_objects: [
      { type: "NodeRun", id: nodeRunId, label: nodeId },
      { type: "SchedulerDecision", id: input.failure.decision.decision }
    ],
    impact: {
      blocked_nodes: [nodeRunId],
      waiting_agents: input.node?.agent_id ? [input.node.agent_id] : [],
      unaffected_paths: []
    },
    safe_actions: ["inspect_node_attempt", "retry_node", "switch_provider"]
  };
}

async function persistSchedulerFailureAttention(runId: string, failures: SchedulerFailure[]) {
  if (failures.length === 0) return { attention_items: [] as AttentionItem[], created_events: [] as string[] };
  const bundle = await readRunBundle(runId);
  const nodes = bundle.nodes as NodeRun[];
  const currentAttention = Array.isArray(bundle.attention) ? (bundle.attention as AttentionItem[]) : [];
  const byRootCause = new Map(currentAttention.map((item) => [item.root_cause_key, item]));
  const createdAt = new Date().toISOString();
  const attentionItems = failures.map((failure) => buildSchedulerFailureAttentionItem({ failure, node: nodes.find((node) => node.node_run_id === failure.node_run_id) }));
  for (const item of attentionItems) byRootCause.set(item.root_cause_key, item);
  await writeJson(`runs/${runId}/attention.json`, Array.from(byRootCause.values()));

  const events = attentionItems.map((item) => ({
    event_id: `evt_${item.attention_id}_${Date.parse(createdAt)}`,
    run_id: runId,
    type: "attention_item_created",
    subject: { type: "AttentionItem", id: item.attention_id },
    message: `AttentionItem ${item.root_cause_key} opened by scheduler`,
    created_at: createdAt
  }));
  for (const event of events) await appendEvent(runId, event);
  return { attention_items: attentionItems, created_events: events.map((event) => event.event_id) };
}

async function executeNodeRunOnce(runId: string, nodeRunId: string): Promise<NodeExecutionResult> {
  const lockName = safeId(nodeRunId);
  const lockDir = path.join(workspaceDir, "runs", runId, "locks", `${lockName}.lock`);
  await mkdir(path.dirname(lockDir), { recursive: true });
  try {
    await mkdir(lockDir, { recursive: false });
  } catch {
    return {
      accepted: false,
      status_code: 409,
      error: { code: "operation_in_progress", message: "NodeRun already has an execute operation in progress." }
    };
  }

  try {
    const lockedBundle = await readRunBundle(runId);
    const runSpec = lockedBundle.run as unknown as RunSpec;
    const nodeRuns = lockedBundle.nodes as NodeRun[];
    const targetNodeRun = nodeRuns.find((item) => item.node_run_id === nodeRunId);
    if (!targetNodeRun) {
      return {
        accepted: false,
        status_code: 404,
        error: { code: "not_found", message: "NodeRun not found" }
      };
    }
    if (!["queued", "running"].includes(targetNodeRun.status)) {
      return {
        accepted: false,
        status_code: 409,
        error: { code: "node_not_executable", message: `Only queued or running NodeRun can be executed. Current status: ${targetNodeRun.status}` }
      };
    }

    const previousNodeRun = structuredClone(targetNodeRun);
    const dispatchedAt = new Date().toISOString();
    targetNodeRun.status = "running";
    targetNodeRun.started_at = targetNodeRun.started_at ?? dispatchedAt;
    targetNodeRun.updated_at = dispatchedAt;
    await writeJson(`runs/${runId}/nodes.json`, nodeRuns);

    const nodeSpec = lockedBundle.workflow.nodes.find((node) => node.id === targetNodeRun.node_id);
    const provider = targetNodeRun.provider ?? runSpec.resolved_provider_policy.default_provider;
    const manifests = await readAdapterManifests();
    const availableCredentials = availableCredentialKeys();
    const adapter = nodeSpec && selectAdapterForNode({ manifests, node: nodeSpec, provider, availableCredentials });
    const invocation = createAdapterInvocation({
      runSpec,
      workflow: lockedBundle.workflow,
      nodeRun: targetNodeRun,
      createdAt: dispatchedAt,
      adapterKind: adapter?.kind,
      adapterId: adapter?.id
    });
    const rawResult = adapter
      ? executeSidecarAdapter({ invocation, workflow: lockedBundle.workflow, nodeRun: targetNodeRun, adapter, receivedAt: new Date().toISOString() })
      : buildAdapterUnavailableResult({
          invocation,
          message: `No executable adapter supports NodeSpec ${targetNodeRun.node_id} capabilities: ${nodeSpec?.capability_requirements.join(", ") ?? "unknown"}`,
          receivedAt: new Date().toISOString()
        });
    let result: AdapterResult;
    try {
      result = parseAdapterResultForInvocation(invocation, rawResult);
    } catch (error) {
      Object.assign(targetNodeRun, previousNodeRun);
      await writeJson(`runs/${runId}/nodes.json`, nodeRuns);
      throw error;
    }
    const attempt = createNodeAttemptFromAdapterResult(result);
    const createdArtifacts = createArtifactManifestsFromAdapterResult({
      result,
      runId,
      nodeRun: targetNodeRun,
      producer: targetNodeRun.agent_id ?? "mock-runner",
      createdAt: result.received_at
    });
    for (const descriptor of result.artifact_descriptors) await writeArtifactDescriptorFile(descriptor);

    const attempts = (await readJsonOptional<NodeAttempt[]>(`runs/${runId}/attempts.json`)) ?? [];
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

    return {
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
    };
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

function buildSchedulerDecisions(workflow: WorkflowSpec, nodes: NodeRun[], gates: GateInstance[]): SchedulerDecision[] {
  const pendingGateByNode = new Map<string, GateInstance>();
  for (const gate of gates.filter((item) => item.status === "pending_review")) {
    for (const nodeId of gate.required_before) pendingGateByNode.set(nodeId, gate);
  }
  const nodeOrder = new Map(workflow.nodes.map((node, index) => [node.id, index]));
  return nodes
    .filter((node) => ["queued", "blocked", "reviewing", "waiting"].includes(node.status))
    .sort((a, b) => (nodeOrder.get(a.node_id) ?? 9999) - (nodeOrder.get(b.node_id) ?? 9999))
    .map((node): SchedulerDecision => {
      const gate = pendingGateByNode.get(node.node_id);
      if (gate) {
        return {
          node_run_id: node.node_run_id,
          node_id: node.node_id,
          status: node.status,
          decision: "pause_for_gate",
          reason: `GateInstance ${gate.gate_instance_id} pending_review`,
          gate_instance_id: gate.gate_instance_id
        };
      }
      if (node.status === "queued") {
        return {
          node_run_id: node.node_run_id,
          node_id: node.node_id,
          status: node.status,
          decision: "execute",
          reason: "queued NodeRun is executable"
        };
      }
      return {
        node_run_id: node.node_run_id,
        node_id: node.node_id,
        status: node.status,
        decision: "skip",
        reason: `NodeRun status ${node.status} is not executable by scheduler`
      };
    });
}

function schedulerLimits(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(5, Math.floor(parsed)));
}

function schedulerTickLimits(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 8;
  return Math.max(1, Math.min(20, Math.floor(parsed)));
}

async function buildSchedulerPlan(runId: string, maxNodes: number) {
  const bundle = await readRunBundle(runId);
  const decisions = buildSchedulerDecisions(bundle.workflow, bundle.nodes as NodeRun[], bundle.gates as GateInstance[]);
  const executable = decisions.filter((decision) => decision.decision === "execute").slice(0, maxNodes);
  const paused = decisions.filter((decision) => decision.decision === "pause_for_gate");
  const skipped = decisions.filter((decision) => decision.decision === "skip");
  return { decisions, executable, paused, skipped };
}

async function commitSchedulerTick(runId: string, maxNodes: number) {
  const { decisions, executable, paused, skipped } = await buildSchedulerPlan(runId, maxNodes);
  const tickId = `sched_${safeId(runId)}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const startedAt = new Date().toISOString();
  const startedEvent = {
    event_id: `evt_${tickId}_started`,
    run_id: runId,
    type: "scheduler_tick_started",
    subject: { type: "RunSpec", id: runId },
    message: `Scheduler tick started with ${executable.length} executable NodeRun(s)`,
    created_at: startedAt
  };
  await appendEvent(runId, startedEvent);

  const executed = [];
  const failed: SchedulerFailure[] = [];
  for (const decision of executable) {
    try {
      const result = await executeNodeRunOnce(runId, decision.node_run_id);
      if (!result.accepted) {
        failed.push({
          decision,
          node_run_id: decision.node_run_id,
          node_id: decision.node_id,
          error: { code: result.error.code, message: result.error.message, recoverable: result.status_code < 500 }
        });
        continue;
      }
      executed.push({ decision, result });
      if (result.committed.node_run.status === "failed") {
        failed.push({
          decision,
          node_run_id: decision.node_run_id,
          node_id: decision.node_id,
          error: result.adapter_result.error ?? { code: "adapter_failed", message: `AdapterResult ${result.adapter_result.status}`, recoverable: true }
        });
      }
    } catch (error) {
      failed.push({
        decision,
        node_run_id: decision.node_run_id,
        node_id: decision.node_id,
        error: {
          code: "scheduler_execute_exception",
          message: error instanceof Error ? error.message : "Unknown scheduler execute exception",
          recoverable: false
        }
      });
    }
  }

  const attention = await persistSchedulerFailureAttention(runId, failed);
  const completedAt = new Date().toISOString();
  const completedEvent = {
    event_id: `evt_${tickId}_completed`,
    run_id: runId,
    type: "scheduler_tick_completed",
    subject: { type: "RunSpec", id: runId },
    message: `Scheduler tick completed: executed ${executed.length}, failed ${failed.length}, paused ${paused.length}`,
    created_at: completedAt
  };
  await appendEvent(runId, completedEvent);

  return {
    accepted: true,
    mode: "commit",
    tick_id: tickId,
    run_id: runId,
    max_nodes: maxNodes,
    decisions,
    executable,
    executed,
    failed,
    paused,
    skipped,
    attention_items: attention.attention_items,
    created_events: [startedEvent.event_id, ...attention.created_events, completedEvent.event_id],
    next_suggested_actions: failed.length > 0 ? ["inspect_attention", "retry_node_or_switch_provider"] : paused.length > 0 ? ["review_pending_gates"] : ["refresh_run"]
  };
}

async function runSchedulerUntilStop(runId: string, maxTicks: number, maxNodesPerTick: number) {
  const runIdSafe = safeId(runId);
  const schedulerRunId = `sched_run_${runIdSafe}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const startedAt = new Date().toISOString();
  const startedEvent = {
    event_id: `evt_${schedulerRunId}_started`,
    run_id: runId,
    type: "scheduler_run_started",
    subject: { type: "RunSpec", id: runId },
    message: `Scheduler run started with max ${maxTicks} tick(s)`,
    created_at: startedAt
  };
  await appendEvent(runId, startedEvent);

  const ticks = [];
  let stopReason: "no_executable_nodes" | "paused_for_gate" | "execution_failed" | "max_ticks_reached" = "max_ticks_reached";
  for (let index = 0; index < maxTicks; index += 1) {
    const plan = await buildSchedulerPlan(runId, maxNodesPerTick);
    if (plan.executable.length === 0) {
      stopReason = plan.paused.length > 0 ? "paused_for_gate" : "no_executable_nodes";
      ticks.push({
        mode: "dry_stop",
        tick_index: index + 1,
        decisions: plan.decisions,
        executable: plan.executable,
        paused: plan.paused,
        skipped: plan.skipped
      });
      break;
    }
    const tick = await commitSchedulerTick(runId, maxNodesPerTick);
    ticks.push({ tick_index: index + 1, ...tick });
    if (tick.failed.length > 0) {
      stopReason = "execution_failed";
      break;
    }
  }
  if (stopReason === "max_ticks_reached") {
    const terminalPlan = await buildSchedulerPlan(runId, maxNodesPerTick);
    if (terminalPlan.executable.length === 0) {
      stopReason = terminalPlan.paused.length > 0 ? "paused_for_gate" : "no_executable_nodes";
      ticks.push({
        mode: "dry_stop",
        tick_index: ticks.length + 1,
        decisions: terminalPlan.decisions,
        executable: terminalPlan.executable,
        paused: terminalPlan.paused,
        skipped: terminalPlan.skipped
      });
    }
  }

  const completedAt = new Date().toISOString();
  const completedEvent = {
    event_id: `evt_${schedulerRunId}_completed`,
    run_id: runId,
    type: "scheduler_run_completed",
    subject: { type: "RunSpec", id: runId },
    message: `Scheduler run stopped: ${stopReason}`,
    created_at: completedAt
  };
  await appendEvent(runId, completedEvent);

  const executedCount = ticks.reduce((total, tick) => total + (Array.isArray((tick as Record<string, unknown>).executed) ? ((tick as Record<string, unknown>).executed as unknown[]).length : 0), 0);
  const failedCount = ticks.reduce((total, tick) => total + (Array.isArray((tick as Record<string, unknown>).failed) ? ((tick as Record<string, unknown>).failed as unknown[]).length : 0), 0);
  const attentionCount = ticks.reduce(
    (total, tick) => total + (Array.isArray((tick as Record<string, unknown>).attention_items) ? ((tick as Record<string, unknown>).attention_items as unknown[]).length : 0),
    0
  );

  return {
    accepted: true,
    mode: "run",
    scheduler_run_id: schedulerRunId,
    run_id: runId,
    max_ticks: maxTicks,
    max_nodes_per_tick: maxNodesPerTick,
    stop_reason: stopReason,
    ticks,
    summary: {
      ticks_committed: ticks.filter((tick) => (tick as Record<string, unknown>).mode === "commit").length,
      nodes_executed: executedCount,
      failures: failedCount,
      attention_items_created: attentionCount
    },
    created_events: [startedEvent.event_id, completedEvent.event_id],
    next_suggested_actions:
      stopReason === "paused_for_gate"
        ? ["review_pending_gates"]
        : stopReason === "execution_failed"
          ? ["inspect_attention", "retry_node_or_switch_provider"]
          : stopReason === "max_ticks_reached"
            ? ["run_scheduler_again_or_increase_limit"]
            : ["refresh_run"]
  };
}

function safeIdSegment(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 38);
}

function uniqueNodeId(workflow: WorkflowSpec, draft: CanvasLayout, requested: string) {
  const existing = new Set([
    ...workflow.nodes.map((node) => node.id),
    ...draft.objects.flatMap((object) => (object.ref_id ? [object.ref_id] : []))
  ]);
  const base = safeIdSegment(requested) || "canvas_node";
  let candidate = base;
  let index = 1;
  while (existing.has(candidate)) {
    candidate = `${base}_${index}`;
    index += 1;
  }
  return candidate;
}

function buildCanvasNodeSpecDraft(params: {
  workflow: WorkflowSpec;
  draft: CanvasLayout;
  title?: unknown;
  nodeId?: unknown;
  zoneId?: unknown;
  capability?: unknown;
  nodeType?: unknown;
  artifactType?: unknown;
}): CanvasObject {
  const title = typeof params.title === "string" && params.title.trim() ? params.title.trim() : "Pencil 原型节点";
  const capability = typeof params.capability === "string" && params.capability.trim() ? params.capability.trim() : "prototype.pencil";
  const artifactType = typeof params.artifactType === "string" && params.artifactType.trim() ? params.artifactType.trim() : "prototype";
  const allowedTypes: NodeSpec["type"][] = ["start", "source", "transform", "agent", "tool", "mcp_tool", "branch", "loop", "review_gate", "artifact", "subworkflow", "end", "terminate"];
  const nodeType = typeof params.nodeType === "string" && allowedTypes.includes(params.nodeType as NodeSpec["type"]) ? (params.nodeType as NodeSpec["type"]) : "mcp_tool";
  const requestedId = typeof params.nodeId === "string" && params.nodeId.trim() ? params.nodeId.trim() : `${safeIdSegment(capability) || "prototype"}_draft`;
  const nodeId = uniqueNodeId(params.workflow, params.draft, requestedId);
  const zoneObjects = params.draft.objects.filter((object) => object.type === "zone");
  const requestedZoneId = typeof params.zoneId === "string" && params.zoneId.trim() ? params.zoneId.trim() : undefined;
  const zoneId = requestedZoneId ?? zoneObjects[0]?.ref_id ?? zoneObjects[0]?.id.replace(/^zone_/, "");
  const zone = zoneObjects.find((object) => (object.ref_id ?? object.id.replace(/^zone_/, "")) === zoneId);
  const siblingCount = params.draft.objects.filter((object) => object.type === "node" && object.zone_id === zoneId).length;
  const nodeSpec: NodeSpec = {
    id: nodeId,
    name: title,
    type: nodeType,
    domain_tags: [params.workflow.domain, "canvas-draft"],
    capability_requirements: [capability],
    recommended_libraries: capability === "prototype.pencil" ? ["pencil-mcp-library"] : [],
    agent_candidates: capability === "prototype.pencil" ? ["prototype-agent"] : [],
    inputs: [{ id: "brief", kind: "parameter", required: false }],
    outputs: [{ id: `${safeIdSegment(artifactType) || "artifact"}_draft`, kind: "artifact", artifact_type: artifactType, required: false }],
    failure_policy: { retry: 0, on_missing_input: "blocked", on_provider_failure: "failed" }
  };
  const nodeSpecDraft: CanvasNodeSpecDraft = {
    draft_id: `node_spec_draft_${nodeId}`,
    status: "draft",
    created_from: "canvas",
    node_spec: nodeSpec
  };

  return {
    id: `node_${nodeId}`,
    type: "node",
    title,
    ref_id: nodeId,
    zone_id: zoneId,
    x: (zone?.x ?? 60) + 18,
    y: (zone?.y ?? 80) + 104 + siblingCount * 104,
    width: 216,
    height: 104,
    node_spec_draft: nodeSpecDraft
  };
}

function validationWithExtraErrors(base: ValidationResult, errors: ValidationResult["errors"]): ValidationResult {
  return {
    ...base,
    valid: base.valid && errors.length === 0,
    errors: [...errors, ...base.errors]
  };
}

function buildWorkflowCandidateFromCanvasDraft(workflow: WorkflowSpec, draft: CanvasLayout) {
  const extraErrors: ValidationResult["errors"] = [];
  const existingNodeIds = new Set(workflow.nodes.map((node) => node.id));
  const draftNodes: NodeSpec[] = [];

  for (const object of draft.objects) {
    if (!object.node_spec_draft) continue;
    const parsed = canvasNodeSpecDraftSchema.safeParse(object.node_spec_draft);
    if (!parsed.success) {
      extraErrors.push({
        code: "invalid_node_spec_draft",
        object_type: "CanvasObject",
        object_id: object.id,
        message: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
      });
      continue;
    }
    if (object.ref_id && object.ref_id !== parsed.data.node_spec.id) {
      extraErrors.push({
        code: "node_spec_draft_ref_mismatch",
        object_type: "CanvasObject",
        object_id: object.id,
        message: `画布对象 ref_id ${object.ref_id} 与 NodeSpec id ${parsed.data.node_spec.id} 不一致`
      });
    }
    if (!existingNodeIds.has(parsed.data.node_spec.id)) draftNodes.push(parsed.data.node_spec);
  }

  const zoneObjects = draft.objects.filter((object) => object.type === "zone");
  const nodeObjects = draft.objects.filter((object) => object.type === "node" && object.ref_id);
  const zoneNames = new Map(zoneObjects.map((zone) => [zone.ref_id ?? zone.id.replace(/^zone_/, ""), zone.title ?? zone.ref_id ?? zone.id]));
  const zones = zoneObjects.map((zone) => {
    const zoneId = zone.ref_id ?? zone.id.replace(/^zone_/, "");
    return {
      id: zoneId,
      name: zone.title ?? zoneId,
      node_ids: nodeObjects.filter((object) => object.zone_id === zoneId).map((object) => String(object.ref_id))
    };
  });
  const dag = { ...workflow.layouts.dag };
  for (const object of nodeObjects) {
    const nodeId = String(object.ref_id);
    dag[nodeId] = {
      x: Math.round(object.x),
      y: Math.round(object.y),
      stage: object.zone_id ? zoneNames.get(object.zone_id) : dag[nodeId]?.stage
    };
  }

  const candidate: WorkflowSpec = {
    ...workflow,
    nodes: [...workflow.nodes, ...draftNodes],
    layouts: {
      ...workflow.layouts,
      dag,
      canvas: { zones }
    }
  };
  return {
    workflow: candidate,
    validation: validationWithExtraErrors(validateWorkflowSpec(candidate), extraErrors)
  };
}

function stampCanvasDraftValidation(draft: CanvasLayout, validation: ValidationResult): CanvasLayout {
  return {
    ...draft,
    objects: draft.objects.map((object) => {
      if (!object.node_spec_draft) return object;
      const nodeId = object.node_spec_draft.node_spec.id;
      const hasNodeError = validation.errors.some((error) => error.object_id === nodeId || error.object_id === object.id || error.message.includes(nodeId));
      return {
        ...object,
        node_spec_draft: {
          ...object.node_spec_draft,
          status: hasNodeError ? "invalid" : "ready",
          validation
        }
      };
    })
  };
}

function buildCanvasSpecDiffPreview(workflow: WorkflowSpec, draft: CanvasLayout) {
  const candidate = buildWorkflowCandidateFromCanvasDraft(workflow, draft);
  const existingNodeIds = new Set(workflow.nodes.map((node) => node.id));
  const operations: Array<{ op: "add" | "replace" | "remove"; path: string; value?: unknown }> = [
    { op: "replace", path: "/layouts/canvas/zones", value: candidate.workflow.layouts.canvas?.zones ?? [] }
  ];
  for (const object of draft.objects.filter((item) => item.type === "node" && item.ref_id)) {
    operations.push({ op: "replace", path: `/layouts/dag/${object.ref_id}`, value: { x: object.x, y: object.y, zone_id: object.zone_id } });
    if (object.node_spec_draft && !existingNodeIds.has(object.node_spec_draft.node_spec.id)) {
      operations.push({ op: "add", path: "/nodes/-", value: object.node_spec_draft.node_spec });
    }
  }
  return {
    diff_id: `diff_canvas_${workflow.id}_${Date.now()}`,
    workflow_id: workflow.id,
    operations
  };
}

async function publishCanvasDraftAsWorkflow(workflowId: string, draft: CanvasLayout) {
  const workflow = await readWorkflow(workflowId);
  const candidate = buildWorkflowCandidateFromCanvasDraft(workflow, draft);
  if (!candidate.validation.valid) return { accepted: false, validation: candidate.validation };
  const draftId = `${workflow.id}-canvas-draft-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;
  const nextWorkflow: WorkflowSpec = {
    ...candidate.workflow,
    id: draftId,
    name: `${workflow.name} · Canvas Draft`,
    registry_meta: {
      ...workflow.registry_meta,
      status: "draft"
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
    const adapters = await readAdapterRegistry();
    return sendJson(res, 200, {
      adapters,
      summary: {
        total: adapters.length,
        executable: adapters.filter((adapter) => adapter.executable).length,
        blocked: adapters.filter((adapter) => adapter.status === "blocked").length,
        missing_credentials: adapters.flatMap((adapter) => adapter.credential_status.filter((credential) => credential.required && !credential.configured).map((credential) => credential.key))
      }
    });
  }

  if (req.method === "POST" && url.pathname === "/api/v0/run-drafts") {
    const body = await parseBody(req);
    const workflowId = String(body.workflow_id ?? "");
    if (!workflowId) return sendError(res, 400, "workflow_required", "workflow_id is required");
    const created = await runDraftStore.create({
      draft_id: createRunDraftId(),
      workflow_id: workflowId,
      inputs: body.inputs && typeof body.inputs === "object" && !Array.isArray(body.inputs) ? body.inputs as Record<string, unknown> : {},
      enabled_optional_paths: Array.isArray(body.enabled_optional_paths) ? body.enabled_optional_paths.map(String) : [],
      execution_policy: body.execution_policy === "auto" || body.execution_policy === "manual" ? body.execution_policy : "hybrid",
      actor: String(body.actor ?? "local_user")
    });
    return sendJson(res, 201, created);
  }

  if (parts[0] === "api" && parts[1] === "v0" && parts[2] === "run-drafts" && parts[3]) {
    const draftId = getId(parts, 3);
    if (req.method === "GET" && parts.length === 4) return sendJson(res, 200, await runDraftStore.read(draftId));
    if (req.method === "PATCH" && parts.length === 4) {
      const body = await parseBody(req);
      if (!Number.isInteger(body.expected_revision)) return sendError(res, 400, "expected_revision_required", "expected_revision must be an integer");
      const updated = await runDraftStore.update({
        draft_id: draftId,
        expected_revision: Number(body.expected_revision),
        patch: {
          ...(body.inputs && typeof body.inputs === "object" && !Array.isArray(body.inputs) ? { inputs: body.inputs as Record<string, unknown> } : {}),
          ...(Array.isArray(body.enabled_optional_paths) ? { enabled_optional_paths: body.enabled_optional_paths.map(String) } : {}),
          ...(body.execution_policy === "auto" || body.execution_policy === "manual" || body.execution_policy === "hybrid" ? { execution_policy: body.execution_policy } : {})
        },
        actor: String(body.actor ?? "local_user")
      });
      return sendJson(res, 200, updated);
    }
    if (req.method === "POST" && parts[4] === "dry-run") {
      const body = await parseBody(req);
      if (!Number.isInteger(body.expected_revision)) return sendError(res, 400, "expected_revision_required", "expected_revision must be an integer");
      const planned = await runDraftStore.dryRun({
        draft_id: draftId,
        expected_revision: Number(body.expected_revision),
        actor: String(body.actor ?? "local_user"),
        available_credentials: availableCredentialKeys()
      });
      return sendJson(res, 200, planned);
    }
    if (req.method === "POST" && parts[4] === "confirmation") {
      const body = await parseBody(req);
      if (!Number.isInteger(body.expected_revision)) return sendError(res, 400, "expected_revision_required", "expected_revision must be an integer");
      if (body.decision === "revise") {
        return sendJson(res, 200, await runDraftStore.revise({
          draft_id: draftId,
          expected_revision: Number(body.expected_revision),
          actor: String(body.actor ?? "local_user")
        }));
      }
      if (body.decision === "cancel") {
        return sendJson(res, 200, await runDraftStore.cancel({
          draft_id: draftId,
          expected_revision: Number(body.expected_revision),
          actor: String(body.actor ?? "local_user")
        }));
      }
      if (body.decision !== "confirm") return sendError(res, 400, "unsupported_confirmation_decision", "decision must be confirm, revise or cancel");
      const confirmed = await runDraftStore.confirm({
        draft_id: draftId,
        expected_revision: Number(body.expected_revision),
        plan_hash: String(body.plan_hash ?? ""),
        actor: String(body.actor ?? "local_user"),
        acknowledgements: Array.isArray(body.acknowledgements) ? body.acknowledgements.map(String) : []
      });
      return sendJson(res, 200, confirmed);
    }
  }

  if (req.method === "GET" && url.pathname === "/api/v0/project/roadmap") {
    return sendJson(res, 200, await buildProjectRoadmap());
  }

  if (req.method === "POST" && (url.pathname === "/api/v0/historical-imports/preview" || url.pathname === "/api/v0/historical-imports")) {
    const body = await parseBody(req);
    const sampleKind = body.sample_kind === "w23" ? "w23" : body.sample_kind === "w24" ? "w24" : undefined;
    if (!sampleKind) return sendError(res, 400, "invalid_sample_kind", "sample_kind must be w24 or w23");
    const workflowId = String(body.workflow_id ?? "");
    if (!workflowId) return sendError(res, 400, "workflow_required", "workflow_id is required");
    if (!/^[a-zA-Z0-9._-]+$/.test(workflowId)) {
      return sendError(res, 400, "invalid_workflow_id", "workflow_id may only contain letters, numbers, dot, underscore and hyphen");
    }
    const request: HistoricalImportRequest = {
      source_run_dir: String(body.source_run_dir ?? ""),
      workflow_id: workflowId,
      sample_kind: sampleKind
    };
    const options = {
      workspaceDir,
      allowedRoots: historicalImportRoots,
      workflowPath: path.join(workflowRegistryDir, `${workflowId}.json`),
      repositoryRoot: rootDir
    };
    if (url.pathname.endsWith("/preview")) return sendJson(res, 200, await previewHistoricalImport(request, options));
    return sendJson(res, 201, await commitHistoricalImport(request, options));
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "v0" && parts[2] === "historical-imports" && parts[3]) {
    return sendJson(res, 200, await readHistoricalImport(getId(parts, 3), workspaceDir));
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
    if (req.method === "POST" && parts[4] === "dry-run") {
      const availableCredentials = availableCredentialKeys();
      const plan = createDryRunPlan(workflow, availableCredentials);
      const manifests = await readAdapterManifests();
      return sendJson(res, 200, {
        ...plan,
        adapter_routing: workflow.nodes.map((node) => {
          const selected = selectAdapterForNode({ manifests, node, provider: workflow.provider_policy.default_provider, availableCredentials });
          return {
            node_id: node.id,
            selected_adapter_id: selected?.id,
            selected_adapter_kind: selected?.kind,
            executable: Boolean(selected),
            missing_capabilities: selected ? [] : node.capability_requirements
          };
        })
      });
    }
    if (parts[4] === "canvas-draft") {
      const draftPath = `drafts/canvas-${workflowId}.json`;
      if (req.method === "POST" && parts[5] === "nodes") {
        const body = await parseBody(req);
        const currentDraft: CanvasLayout = Array.isArray(body.objects) && body.objects.length > 0
          ? {
              workflow_id: workflowId,
              status: "draft",
              updated_at: new Date().toISOString(),
              objects: body.objects.map((object) => object as CanvasLayout["objects"][number])
            }
          : (await readJsonOptional<CanvasLayout>(draftPath)) ?? buildCanvasDraftFromWorkflow(workflow);
        const nodeObject = buildCanvasNodeSpecDraft({
          workflow,
          draft: currentDraft,
          title: body.title,
          nodeId: body.node_id,
          zoneId: body.zone_id,
          capability: body.capability,
          nodeType: body.node_type,
          artifactType: body.artifact_type
        });
        const candidateDraft: CanvasLayout = {
          ...currentDraft,
          workflow_id: workflowId,
          status: "draft",
          updated_at: new Date().toISOString(),
          objects: [...currentDraft.objects, nodeObject]
        };
        const candidate = buildWorkflowCandidateFromCanvasDraft(workflow, candidateDraft);
        const draft = stampCanvasDraftValidation(candidateDraft, candidate.validation);
        if (!candidate.validation.valid) {
          return sendJson(res, 422, {
            accepted: false,
            draft,
            node_object: nodeObject,
            validation: candidate.validation,
            spec_diff_preview: buildCanvasSpecDiffPreview(workflow, draft)
          });
        }
        await writeJson(draftPath, draft);
        return sendJson(res, 201, {
          accepted: true,
          draft,
          node_object: draft.objects.find((object) => object.id === nodeObject.id),
          validation: candidate.validation,
          spec_diff_preview: buildCanvasSpecDiffPreview(workflow, draft)
        });
      }
      if (req.method === "POST" && parts[5] === "publish") {
        const draft = (await readJsonOptional<CanvasLayout>(draftPath)) ?? buildCanvasDraftFromWorkflow(workflow);
        const result = await publishCanvasDraftAsWorkflow(workflowId, draft);
        return sendJson(res, result.accepted ? 201 : 422, result);
      }
      if (req.method === "GET") {
        const rawDraft = (await readJsonOptional<CanvasLayout>(draftPath)) ?? buildCanvasDraftFromWorkflow(workflow);
        const candidate = buildWorkflowCandidateFromCanvasDraft(workflow, rawDraft);
        const draft = stampCanvasDraftValidation(rawDraft, candidate.validation);
        return sendJson(res, 200, {
          draft,
          validation: candidate.validation,
          spec_diff_preview: buildCanvasSpecDiffPreview(workflow, draft)
        });
      }
      if (req.method === "POST") {
        const body = await parseBody(req);
        const objects = Array.isArray(body.objects) ? body.objects : [];
        const rawDraft: CanvasLayout = {
          workflow_id: workflowId,
          status: "draft",
          updated_at: new Date().toISOString(),
          objects: objects.map((object) => object as CanvasLayout["objects"][number])
        };
        const candidate = buildWorkflowCandidateFromCanvasDraft(workflow, rawDraft);
        const draft = stampCanvasDraftValidation(rawDraft, candidate.validation);
        if (!candidate.validation.valid) {
          return sendJson(res, 422, {
            accepted: false,
            draft,
            validation: candidate.validation,
            spec_diff_preview: buildCanvasSpecDiffPreview(workflow, draft)
          });
        }
        await writeJson(draftPath, draft);
        return sendJson(res, 200, {
          accepted: true,
          draft,
          validation: candidate.validation,
          spec_diff_preview: buildCanvasSpecDiffPreview(workflow, draft)
        });
      }
    }
  }

  if (req.method === "GET" && url.pathname === "/api/v0/runs") {
    return sendJson(res, 200, { runs: await listRuns() });
  }

  if (req.method === "POST" && url.pathname === "/api/v0/runs") {
    const body = await parseBody(req);
    if (body.draft_id) {
      await runDraftStore.requestLaunch({
        draft_id: String(body.draft_id),
        draft_plan_id: String(body.draft_plan_id ?? ""),
        plan_hash: String(body.plan_hash ?? ""),
        confirmation_id: String(body.confirmation_id ?? ""),
        adapter_ready: false
      });
    }
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
    if (req.method === "POST" && (await isHistoricalReadOnlyRun(runId))) {
      return sendError(res, 409, "historical_run_read_only", "Historical run is read-only and cannot execute scheduler or node commands.");
    }
    if (req.method === "POST" && parts[4] === "scheduler" && parts[5] === "tick") {
      const body = await parseBody(req);
      const dryRun = body.dry_run === true;
      const maxNodes = schedulerLimits(body.max_nodes);
      const plan = await buildSchedulerPlan(runId, maxNodes);
      const tickId = `sched_${safeId(runId)}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

      if (dryRun) {
        return sendJson(res, 200, {
          accepted: true,
          mode: "dry_run",
          tick_id: tickId,
          run_id: runId,
          max_nodes: maxNodes,
          decisions: plan.decisions,
          executable: plan.executable,
          paused: plan.paused,
          skipped: plan.skipped,
          next_suggested_actions: plan.executable.length > 0 ? ["run_scheduler_tick"] : plan.paused.length > 0 ? ["review_pending_gates"] : ["wait_for_new_queued_nodes"]
        });
      }

      return sendJson(res, 200, await commitSchedulerTick(runId, maxNodes));
    }
    if (req.method === "POST" && parts[4] === "scheduler" && parts[5] === "run") {
      const body = await parseBody(req);
      const maxTicks = schedulerTickLimits(body.max_ticks);
      const maxNodesPerTick = schedulerLimits(body.max_nodes_per_tick ?? body.max_nodes);
      return sendJson(res, 200, await runSchedulerUntilStop(runId, maxTicks, maxNodesPerTick));
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
        const result = await executeNodeRunOnce(runId, nodeRunId);
        if (!result.accepted) return sendError(res, result.status_code, result.error.code, result.error.message);
        return sendJson(res, 200, result);
      }
    }
  }

  if (req.method === "GET" && url.pathname === "/api/v0/agents/health") {
    return sendJson(res, 200, { agents: await readJson("agents/agents.json") });
  }

  if (req.method === "GET" && url.pathname === "/api/v0/agents/collaboration") {
    const runId = url.searchParams.get("run_id");
    if (runId) {
      const bundle = await readRunBundle(runId);
      const configuredAgents = await readJson<Array<Record<string, unknown>>>("agents/agents.json");
      const agentMap = new Map(configuredAgents.map((agent) => [String(agent.agent_id), { ...agent }]));
      const sourceMeta = bundle.source_meta as HistoricalSourceMetaProjection | undefined;
      for (const node of bundle.nodes as NodeRun[]) {
        const agentId = node.agent_id ?? `agent-${node.node_id}`;
        const configured = agentMap.get(agentId) ?? { agent_id: agentId, name: agentId, equipped_libraries: [] };
        const source = sourceMeta?.objects?.[node.node_run_id];
        const status = node.status === "done" ? "done" : node.status === "reviewing" ? "reviewing" : node.status;
        const currentNodeRuns = ["running", "reviewing", "blocked", "failed"].includes(node.status) ? [node.node_run_id] : [];
        const queuedNodeRuns = node.status === "queued" ? [node.node_run_id] : [];
        agentMap.set(agentId, {
          ...configured,
          status,
          active_runs: [runId],
          current_node_runs: currentNodeRuns,
          queued_node_runs: queuedNodeRuns,
          waiting_for: node.status === "waiting" ? node.upstream_artifacts : [],
          blocked_reason: node.status === "blocked" ? "历史证据显示节点处于 blocked" : null,
          source_confidence: source?.confidence?.startsWith("observed") ? "observed" : source ? "inferred" : "unknown"
        });
      }
      return sendJson(res, 200, {
        run_id: runId,
        view_meta: bundle.view_meta,
        agents: Array.from(agentMap.values()),
        links: bundle.workflow.edges.map((edge) => ({ from: edge.from, to: edge.to, required: edge.required }))
      });
    }
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
    if (req.method === "POST" && (await isHistoricalReadOnlyRun(runId))) {
      return sendError(res, 409, "historical_run_read_only", "Historical run is read-only and cannot create GateDecision or rework facts.");
    }
    if (req.method === "POST" && parts[4] === "rework") {
      const body = await parseBody(req);
      const lockName = safeId(gateId);
      const lockDir = path.join(workspaceDir, "runs", runId, "locks", `${lockName}.rework.lock`);
      await mkdir(path.dirname(lockDir), { recursive: true });
      try {
        await mkdir(lockDir, { recursive: false });
      } catch {
        return sendError(res, 409, "operation_in_progress", "GateInstance already has a rework operation in progress.");
      }

      try {
        const lockedBundle = await readRunBundle(runId);
        const runSpec = lockedBundle.run as unknown as RunSpec;
        const lockedGates = lockedBundle.gates as GateInstance[];
        const lockedGate = lockedGates.find((item) => item.gate_instance_id === gateId);
        if (!lockedGate) return sendError(res, 404, "not_found", "Gate not found");
        const latestDecision = lockedGate.decisions.at(-1);
        if (lockedGate.status !== "decided" || !latestDecision || !["reject", "request_changes"].includes(latestDecision.decision)) {
          return sendError(res, 409, "gate_not_reworkable", "Only a rejected or request_changes GateInstance can create a rework attempt.");
        }

        const lockedArtifacts = lockedBundle.artifacts as ArtifactManifest[];
        const nodes = lockedBundle.nodes as NodeRun[];
        const targetArtifact = lockedArtifacts.find((artifact) => artifact.artifact_id === lockedGate.target.id);
        if (!targetArtifact) return sendError(res, 404, "not_found", "Target ArtifactManifest not found");
        const producerNode = nodes.find((node) => node.node_run_id === targetArtifact.node_run_id);
        if (!producerNode) return sendError(res, 404, "not_found", "Producer NodeRun not found");

        const createdAt = new Date().toISOString();
        const version = nextArtifactVersion(lockedArtifacts, targetArtifact);
        const artifactId = nextReworkArtifactId(targetArtifact, version);
        const artifactPath = nextReworkArtifactPath(targetArtifact, artifactId, version);
        const operationId = `op_rework_${safeId(producerNode.node_run_id)}_${Date.parse(createdAt)}`;
        const attempt: NodeAttempt = {
          attempt_id: `attempt_${safeId(operationId)}`,
          node_run_id: producerNode.node_run_id,
          operation_id: operationId,
          attempt_kind: "rework",
          status: "succeeded",
          provider_receipt: {
            provider: producerNode.provider ?? runSpec.resolved_provider_policy.default_provider,
            adapter_kind: "mock-local",
            raw_receipt_id: `receipt_${operationId}`
          },
          created_at: createdAt
        };
        const nextArtifact: ArtifactManifest = {
          artifact_id: artifactId,
          run_id: runId,
          node_run_id: producerNode.node_run_id,
          type: targetArtifact.type,
          version,
          path: artifactPath,
          hash: `sha256:rework-${safeId(operationId)}`,
          status: "created",
          review_status: "pending_review",
          producer: producerNode.agent_id ?? targetArtifact.producer,
          created_at: createdAt,
          supersedes_artifact_id: targetArtifact.artifact_id,
          rework_of_gate_instance_id: lockedGate.gate_instance_id
        };
        const nextGate: GateInstance = {
          gate_instance_id: `gate_${nextArtifact.artifact_id}`,
          run_id: runId,
          gate_spec_id: lockedGate.gate_spec_id,
          target: { type: "ArtifactManifest", id: nextArtifact.artifact_id },
          status: "pending_review",
          required_before: lockedGate.required_before,
          decisions: []
        };

        await writeReworkArtifactFile({
          targetArtifact,
          nextArtifact,
          content: typeof body.content === "string" ? body.content : undefined,
          comment: String(body.comment ?? latestDecision.comment ?? "")
        });

        targetArtifact.review_status = "rejected";
        producerNode.status = "reviewing";
        producerNode.updated_at = createdAt;
        producerNode.output_artifacts = Array.from(new Set([...producerNode.output_artifacts, nextArtifact.artifact_id]));
        blockGateRequiredNodes(nodes, lockedGate.required_before, `Gate ${nextGate.gate_instance_id} pending_review，等待返工审核通过`, createdAt);

        const attempts = (await readJsonOptional<NodeAttempt[]>(`runs/${runId}/attempts.json`)) ?? [];
        const nextArtifacts = [...lockedArtifacts, nextArtifact];
        const nextGates = [...lockedGates, nextGate];
        const nextAttention = addGatePendingAttention(lockedBundle.attention, nextGate);
        runSpec.status = "running";

        await writeJson(`runs/${runId}/run_spec.json`, runSpec);
        await writeJson(`runs/${runId}/nodes.json`, nodes);
        await writeJson(`runs/${runId}/attempts.json`, [...attempts, attempt]);
        await writeJson(`runs/${runId}/artifacts.json`, nextArtifacts);
        await writeJson(`runs/${runId}/gates.json`, nextGates);
        await writeJson(`runs/${runId}/attention.json`, nextAttention);

        const events = [
          {
            event_id: `evt_${operationId}_rework_attempt`,
            run_id: runId,
            type: "rework_attempt_created",
            subject: { type: "NodeRun", id: producerNode.node_run_id },
            message: `Rework attempt created from GateInstance ${lockedGate.gate_instance_id}`,
            created_at: createdAt
          },
          {
            event_id: `evt_${nextArtifact.artifact_id}_created`,
            run_id: runId,
            type: "artifact_manifest_created",
            subject: { type: "ArtifactManifest", id: nextArtifact.artifact_id },
            message: `ArtifactManifest ${nextArtifact.artifact_id} created as rework version`,
            created_at: createdAt
          },
          {
            event_id: `evt_${nextGate.gate_instance_id}_pending`,
            run_id: runId,
            type: "gate_pending_review",
            subject: { type: "GateInstance", id: nextGate.gate_instance_id },
            message: `GateInstance ${nextGate.gate_instance_id} pending review for rework artifact`,
            created_at: createdAt
          }
        ];
        for (const event of events) await appendEvent(runId, event);

        return sendJson(res, 201, {
          accepted: true,
          rework_attempt_id: attempt.attempt_id,
          artifact: nextArtifact,
          gate: nextGate,
          created_events: events.map((event) => event.event_id),
          next_suggested_actions: ["review_rework_gate"]
        });
      } finally {
        await rm(lockDir, { recursive: true, force: true });
      }
    }
    if (req.method === "POST" && parts[4] === "decision") {
      const body = await parseBody(req);
      const decisionValue = body.decision === "reject" || body.decision === "request_changes" ? body.decision : "approve";
      const lockName = safeId(gateId);
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
    if (error instanceof HistoricalImportError) {
      const status =
        error.code === "source_path_not_allowed"
          ? 403
          : error.code === "source_run_not_found"
            ? 404
            : error.code === "historical_import_not_found"
              ? 404
            : error.code === "runtime_workspace_required" || error.code === "import_lock_timeout"
              ? 409
              : 422;
      return sendError(res, status, error.code, error.message);
    }
    if (error instanceof RunDraftStoreError) {
      const status = error.code === "draft_not_found" || error.code === "workflow_not_found"
        ? 404
        : error.code === "invalid_draft_id" || error.code === "invalid_workflow_id"
          ? 400
          : 409;
      return sendError(res, status, error.code, error.message);
    }
    if (error instanceof RunDraftError) {
      return sendError(res, 409, error.code, error.message);
    }
    const message = error instanceof Error ? error.message : "Unknown sidecar error";
    sendError(res, 500, "sidecar_error", message);
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Miracle Local Sidecar listening on http://127.0.0.1:${port}`);
  console.log(`Workspace: ${workspaceDir}`);
});

import {
  buildHistoricalProjection,
  historicalRunSpecSchema,
  workflowSpecSchema,
  type ArtifactReviewStatus,
  type GateDecision,
  type GateStatus,
  type HistoricalArtifactEvidence,
  type HistoricalAttemptEvidence,
  type HistoricalGateEvidence,
  type HistoricalGap,
  type HistoricalImportPreview,
  type HistoricalImportRequest,
  type HistoricalNodeEvidence,
  type HistoricalProjectionInput,
  type HistoricalRunProjection,
  type HistoricalSourceEvent,
  type WorkflowSpec
} from "@miracle/core";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const importerVersion = "0.1.0";

type JsonObject = Record<string, unknown>;

export interface HistoricalImporterOptions {
  workspaceDir: string;
  allowedRoots: string[];
  workflowPath: string;
  repositoryRoot: string;
  now?: string;
}

export interface HistoricalImportInspection {
  preview: HistoricalImportPreview;
  projection: HistoricalRunProjection;
}

export interface HistoricalImportCommitResult extends HistoricalImportPreview {
  reused: boolean;
  target_dir: string;
}

export class HistoricalImportError extends Error {
  constructor(
    public readonly code:
      | "source_path_not_allowed"
      | "source_run_not_found"
      | "workflow_mismatch"
      | "invalid_source_data"
      | "runtime_workspace_required"
      | "import_lock_timeout"
      | "historical_import_not_found",
    message: string
  ) {
    super(message);
  }
}

const controlFiles = [
  "00_任务控制/phase_status.md",
  "00_任务控制/task_trace.json",
  "00_任务控制/task_events.jsonl",
  "00_任务控制/approval_decisions.jsonl"
] as const;

const phaseToNode: Record<string, string> = {
  C0_script_pool_selection: "C0_script_pool_selection",
  C_ppt_storyboard: "C_ppt_storyboard",
  D_voiceover_audio: "D_voiceover_audio",
  E_visual_video: "E_visual_video",
  F_final_render: "F_final_render",
  G_distribution_retro: "G_distribution_retro"
};

const nodeProducer: Record<string, string> = {
  A_fact_intelligence: "intelligence-agent",
  B_md_master: "content-agent",
  C0_script_pool_selection: "script-agent",
  C_ppt_storyboard: "ppt-agent",
  D_voiceover_audio: "tts-agent",
  E_visual_video: "video-agent",
  F_final_render: "video-agent",
  G_distribution_retro: "distribution-agent"
};

const artifactDefinitions: Array<{ relativePath: string; nodeId: string; type: string }> = [
  { relativePath: "01_采集归档/raw_items.md", nodeId: "A_fact_intelligence", type: "markdown" },
  { relativePath: "02_清洗核验/clean_events.md", nodeId: "A_fact_intelligence", type: "markdown" },
  { relativePath: "03_内容母稿/MD母稿_公众号知乎版.md", nodeId: "B_md_master", type: "markdown" },
  { relativePath: "03_内容母稿/口播脚本池/script_selection_summary.json", nodeId: "C0_script_pool_selection", type: "json" },
  { relativePath: "04_PPT视频/分镜草案/storyboard_adapter_manifest.json", nodeId: "C_ppt_storyboard", type: "json" },
  { relativePath: "04_PPT视频/TTS字幕/audio_manifest.json", nodeId: "D_voiceover_audio", type: "json" },
  { relativePath: "04_PPT视频/HyperFrames工程/tts_handoff_manifest.json", nodeId: "E_visual_video", type: "json" },
  { relativePath: "04_PPT视频/render_manifest.json", nodeId: "F_final_render", type: "json" },
  { relativePath: "05_平台分发/全平台发布包.md", nodeId: "G_distribution_retro", type: "publish_package" },
  { relativePath: "06_质检复盘/发布前质检与复盘.md", nodeId: "G_distribution_retro", type: "report" }
];

function safeId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
}

function stableArtifactId(nodeId: string, relativePath: string) {
  const suffix = createHash("sha256").update(relativePath).digest("hex").slice(0, 10);
  return `art_${safeId(nodeId)}_${safeId(relativePath)}_${suffix}`;
}

async function exists(target: string) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(target: string): Promise<T> {
  try {
    return JSON.parse(await readFile(target, "utf8")) as T;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new HistoricalImportError("invalid_source_data", `Invalid JSON in ${target}: ${error.message}`);
    }
    throw error;
  }
}

async function readJsonLines(target: string): Promise<JsonObject[]> {
  if (!(await exists(target))) return [];
  const lines = (await readFile(target, "utf8")).split("\n");
  return lines.flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected a JSON object");
      const object = parsed as JsonObject;
      if (object.schema_version !== undefined && object.schema_version !== 1) {
        throw new Error(`unsupported schema_version ${String(object.schema_version)}`);
      }
      return [object];
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid JSON";
      throw new HistoricalImportError("invalid_source_data", `Invalid JSONL in ${target}:${index + 1}: ${message}`);
    }
  });
}

async function listFiles(root: string, current = root): Promise<Array<{ relative_path: string; absolute_path: string; size: number; mtime_ms: number }>> {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === ".DS_Store" || entry.name.startsWith(".tmp")) continue;
    const absolutePath = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(root, absolutePath)));
    if (entry.isFile()) {
      const metadata = await stat(absolutePath);
      files.push({ relative_path: path.relative(root, absolutePath), absolute_path: absolutePath, size: metadata.size, mtime_ms: metadata.mtimeMs });
    }
  }
  return files.sort((a, b) => a.relative_path.localeCompare(b.relative_path));
}

async function ensureAllowedSource(sourceRunDir: string, allowedRoots: string[]) {
  let sourceReal: string;
  try {
    sourceReal = await realpath(sourceRunDir);
  } catch {
    throw new HistoricalImportError("source_run_not_found", `Historical source run not found: ${sourceRunDir}`);
  }
  const roots = await Promise.all(
    allowedRoots.map(async (root) => {
      try {
        return await realpath(root);
      } catch {
        return path.resolve(root);
      }
    })
  );
  const allowed = roots.some((root) => sourceReal === root || sourceReal.startsWith(`${root}${path.sep}`));
  if (!allowed) throw new HistoricalImportError("source_path_not_allowed", `Historical source is outside MIRACLE_IMPORT_ROOTS: ${sourceRunDir}`);
  return sourceReal;
}

function fingerprint(files: Array<{ relative_path: string; size: number }>, hashes: Map<string, string>) {
  const hash = createHash("sha256");
  hash.update(importerVersion);
  for (const file of files) hash.update(`${file.relative_path}\0${file.size}\0${hashes.get(file.relative_path) ?? "missing"}\n`);
  return `sha256:${hash.digest("hex")}`;
}

async function fileHash(target: string) {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(target);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return `sha256:${hash.digest("hex")}`;
}

function parsePhaseStatus(raw: string) {
  const phases = new Map<string, { status: string; updated_at?: string }>();
  for (const line of raw.split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim().replace(/^`|`$/g, ""));
    if (cells.length < 4 || cells[0] === "phase" || /^-+$/.test(cells[0] ?? "")) continue;
    phases.set(cells[0], { status: cells[2], updated_at: cells[3] });
  }
  return phases;
}

function isoTime(value: unknown, fallback: string) {
  if (typeof value !== "string") return fallback;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? fallback : new Date(parsed).toISOString();
}

function statusForPhase(status: string | undefined) {
  if (status === "pending_review") return "reviewing" as const;
  if (status === "blocked") return "blocked" as const;
  if (status === "failed") return "failed" as const;
  if (status === "approved" || status === "auto-approved" || status === "done") return "done" as const;
  return "waiting" as const;
}

function nodeFromStep(value: unknown) {
  if (typeof value !== "string") return undefined;
  if (value.startsWith("C0")) return "C0_script_pool_selection";
  if (value.startsWith("C")) return "C_ppt_storyboard";
  if (value.startsWith("D")) return "D_voiceover_audio";
  if (value.startsWith("E")) return "E_visual_video";
  if (value.startsWith("F")) return "F_final_render";
  if (value.startsWith("G")) return "G_distribution_retro";
  return undefined;
}

function reviewStatus(nodeId: string, phases: Map<string, { status: string }>, decisions: JsonObject[]): ArtifactReviewStatus {
  const latestDecision = decisions.filter((item) => item.phase === nodeId).at(-1)?.decision;
  if (latestDecision === "approve") return "approved";
  if (latestDecision === "reject" || latestDecision === "request_changes") return "rejected";
  const phaseStatus = phases.get(nodeId)?.status;
  if (phaseStatus === "pending_review") return "pending_review";
  if (phaseStatus === "approved" || phaseStatus === "auto-approved" || phaseStatus === "done") return "approved";
  return "none";
}

async function buildArtifacts(
  sourceRunDir: string,
  sampleKind: HistoricalImportRequest["sample_kind"],
  files: Awaited<ReturnType<typeof listFiles>>,
  hashes: Map<string, string>,
  phases: Map<string, { status: string }>,
  decisions: JsonObject[]
) {
  const fileMap = new Map(files.map((file) => [file.relative_path, file]));
  const definitions = [...artifactDefinitions];
  for (const file of files.filter((item) => path.extname(item.relative_path).toLowerCase() === ".mp4")) {
    definitions.push({ relativePath: file.relative_path, nodeId: "F_final_render", type: "video" });
  }
  const artifacts: HistoricalArtifactEvidence[] = [];
  for (const definition of definitions) {
    const file = fileMap.get(definition.relativePath);
    if (!file) continue;
    const confidence = sampleKind === "w23" || ["A_fact_intelligence", "B_md_master", "G_distribution_retro"].includes(definition.nodeId) ? "inferred" : "observed_from_artifact";
    artifacts.push({
      artifact_id: stableArtifactId(definition.nodeId, definition.relativePath),
      node_id: definition.nodeId,
      type: definition.type,
      path: file.absolute_path,
      hash: hashes.get(file.relative_path) ?? (await fileHash(file.absolute_path)),
      status: "created",
      review_status: sampleKind === "w23" ? "none" : reviewStatus(definition.nodeId, phases, decisions),
      producer: nodeProducer[definition.nodeId] ?? "historical-importer",
      confidence,
      source_paths: [definition.relativePath]
    });
  }
  return artifacts;
}

function buildNodes(input: {
  workflow: WorkflowSpec;
  sampleKind: HistoricalImportRequest["sample_kind"];
  phases: Map<string, { status: string; updated_at?: string }>;
  artifacts: HistoricalArtifactEvidence[];
  importedAt: string;
}): HistoricalNodeEvidence[] {
  return input.workflow.nodes.map((node) => {
    const phase = input.phases.get(node.id);
    const sourcePaths = input.artifacts.filter((artifact) => artifact.node_id === node.id).flatMap((artifact) => artifact.source_paths);
    if (input.sampleKind === "w24" && phase) {
      return {
        node_id: node.id,
        status: statusForPhase(phase.status),
        confidence: "observed_from_status",
        source_paths: ["00_任务控制/phase_status.md", ...sourcePaths],
        updated_at: isoTime(phase.updated_at, input.importedAt)
      };
    }
    const hasArtifact = sourcePaths.length > 0;
    return {
      node_id: node.id,
      status: hasArtifact ? (node.id === "G_distribution_retro" ? "waiting" : "done") : "waiting",
      confidence: hasArtifact ? "inferred" : "missing",
      source_paths: sourcePaths,
      updated_at: input.importedAt
    };
  });
}

function buildAttempts(trace: JsonObject | undefined, runId: string, importedAt: string): HistoricalAttemptEvidence[] {
  const steps = Array.isArray(trace?.steps) ? (trace.steps as JsonObject[]) : [];
  return steps.flatMap((step) => {
    const nodeId = nodeFromStep(step.id);
    if (!nodeId) return [];
    const attemptId = `attempt_${runId}_${safeId(String(step.id))}`;
    const statusText = String(step.status ?? "unknown");
    return [
      {
        attempt_id: attemptId,
        node_run_id: `nr_${runId}_${nodeId}`,
        operation_id: `historical_${runId}_${safeId(String(step.id))}`,
        attempt_kind: "execute" as const,
        status: statusText.includes("done") ? ("succeeded" as const) : statusText.includes("failed") ? ("failed" as const) : ("unknown" as const),
        provider_receipt: { historical: true, step_id: step.id, duration_sec: step.duration_sec, tool_calls: step.tool_calls },
        created_at: importedAt,
        confidence: "observed_from_trace" as const,
        source_paths: ["00_任务控制/task_trace.json"]
      }
    ];
  });
}

function mapDecision(raw: JsonObject): GateDecision | undefined {
  const decision = raw.decision;
  if (decision !== "approve" && decision !== "reject" && decision !== "request_changes") return undefined;
  return {
    decision_id: `decision_${safeId(String(raw.phase ?? "unknown"))}_${safeId(String(raw.generated_at ?? "historical"))}`,
    actor: String(raw.reviewer ?? "historical-reviewer"),
    decision,
    comment: String(raw.comment ?? ""),
    created_at: isoTime(raw.generated_at, new Date(0).toISOString())
  };
}

function buildGates(input: {
  sampleKind: HistoricalImportRequest["sample_kind"];
  workflow: WorkflowSpec;
  phases: Map<string, { status: string }>;
  artifacts: HistoricalArtifactEvidence[];
  decisions: JsonObject[];
}): HistoricalGateEvidence[] {
  if (input.sampleKind === "w23") return [];
  return input.workflow.gates.flatMap((gate) => {
    const artifactSpec = input.workflow.artifacts.find((artifact) => artifact.id === gate.target_artifact_ref);
    const target = input.artifacts.find((artifact) => artifact.node_id === artifactSpec?.produced_by && artifact.type === artifactSpec.type);
    if (!target) return [];
    const phaseId = artifactSpec?.produced_by ?? "";
    const phase = input.phases.get(phaseId);
    const decisions = input.decisions.filter((item) => item.phase === phaseId).map(mapDecision).filter((item): item is GateDecision => Boolean(item));
    if (decisions.length === 0 && phase?.status !== "pending_review") return [];
    const status: GateStatus = decisions.length > 0 ? "decided" : "pending_review";
    const sourcePaths = [
      ...(phase ? ["00_任务控制/phase_status.md"] : []),
      ...(decisions.length > 0 ? ["00_任务控制/approval_decisions.jsonl"] : []),
      ...target.source_paths
    ];
    return [
      {
        gate_spec_id: gate.id,
        target_artifact_id: target.artifact_id,
        status,
        decisions,
        confidence: decisions.length > 0 ? "observed_from_event" : phase ? "observed_from_status" : "inferred",
        source_paths: sourcePaths
      }
    ];
  });
}

function buildSourceEvents(lines: JsonObject[], runId: string, importedAt: string): HistoricalSourceEvent[] {
  return lines.map((event, index) => {
    const nodeId = phaseToNode[String(event.phase ?? "")] ?? nodeFromStep(event.step_id);
    return {
      source_path: "00_任务控制/task_events.jsonl",
      source_line: index + 1,
      occurred_at: isoTime(event.ts, importedAt),
      event_type: String(event.event ?? "unknown"),
      subject_type: nodeId ? "NodeRun" : "RunSpec",
      subject_id: nodeId ? `nr_${runId}_${nodeId}` : runId,
      message: String(event.summary ?? event.event ?? "Historical source event")
    };
  });
}

function gapsFor(sampleKind: HistoricalImportRequest["sample_kind"], files: Array<{ relative_path: string }>): HistoricalGap[] {
  if (sampleKind === "w23") {
    const missing = controlFiles.filter((file) => !files.some((item) => item.relative_path === file));
    return [
      { code: "control_files_missing", severity: "error", message: `缺少结构化控制文件：${missing.join("、")}` },
      { code: "trace_history_missing", severity: "error", message: "不能还原 historical TraceEvent 或 NodeAttempt" },
      { code: "gate_history_missing", severity: "warning", message: "不能生成 observed GateDecision" }
    ];
  }
  const gaps: HistoricalGap[] = [{ code: "early_phases_inferred", severity: "warning", message: "A/B/G 缺少标准 phase status，状态来自产物存在性" }];
  if (files.some((file) => path.extname(file.relative_path).toLowerCase() === ".mp4")) {
    gaps.push({ code: "media_files_referenced_only", severity: "warning", message: "大媒体只记录源路径和 metadata，不复制到 Miracle workspace" });
  }
  return gaps;
}

async function normalizedEvidence(request: HistoricalImportRequest, options: HistoricalImporterOptions) {
  const sourceRunDir = await ensureAllowedSource(request.source_run_dir, options.allowedRoots);
  const files = await listFiles(sourceRunDir);
  const hashes = new Map<string, string>();
  for (const file of files) hashes.set(file.relative_path, await fileHash(file.absolute_path));
  const sourceFingerprint = fingerprint(files, hashes);
  const workflow = workflowSpecSchema.parse(await readJson(options.workflowPath));
  if (workflow.id !== request.workflow_id) throw new HistoricalImportError("workflow_mismatch", `Workflow ${workflow.id} does not match ${request.workflow_id}`);
  const importedAt = options.now ?? new Date().toISOString();
  const runId = `run-real-${request.sample_kind}-${safeId(path.basename(sourceRunDir))}-${sourceFingerprint.slice(7, 15)}`;
  const phasePath = path.join(sourceRunDir, controlFiles[0]);
  const phases = (await exists(phasePath)) ? parsePhaseStatus(await readFile(phasePath, "utf8")) : new Map<string, { status: string; updated_at?: string }>();
  const tracePath = path.join(sourceRunDir, controlFiles[1]);
  const trace = (await exists(tracePath)) ? await readJson<JsonObject>(tracePath) : undefined;
  if (trace && (Array.isArray(trace) || typeof trace !== "object" || (trace.schema_version !== undefined && trace.schema_version !== 1))) {
    throw new HistoricalImportError("invalid_source_data", `Unsupported task trace schema in ${tracePath}`);
  }
  const sourceEventLines = await readJsonLines(path.join(sourceRunDir, controlFiles[2]));
  const decisionLines = await readJsonLines(path.join(sourceRunDir, controlFiles[3]));
  const artifacts = await buildArtifacts(sourceRunDir, request.sample_kind, files, hashes, phases, decisionLines);
  const input: HistoricalProjectionInput = {
    request: { ...request, source_run_dir: sourceRunDir },
    workflow,
    run_id: runId,
    source_fingerprint: sourceFingerprint,
    imported_at: importedAt,
    source_files: files.map((file) => file.relative_path),
    nodes: buildNodes({ workflow, sampleKind: request.sample_kind, phases, artifacts, importedAt }),
    attempts: request.sample_kind === "w24" ? buildAttempts(trace, runId, importedAt) : [],
    artifacts,
    gates: buildGates({ sampleKind: request.sample_kind, workflow, phases, artifacts, decisions: decisionLines }),
    source_events: request.sample_kind === "w24" ? buildSourceEvents(sourceEventLines, runId, importedAt) : [],
    gaps: gapsFor(request.sample_kind, files)
  };
  return { files, input, projection: buildHistoricalProjection(input) };
}

export async function previewHistoricalImport(request: HistoricalImportRequest, options: HistoricalImporterOptions): Promise<HistoricalImportInspection> {
  const inspected = await normalizedEvidence(request, options);
  historicalRunSpecSchema.parse(inspected.projection.runSpec);
  const importId = `import_${inspected.input.source_fingerprint.slice(7, 23)}`;
  return {
    preview: {
      import_id: importId,
      run_id: inspected.input.run_id,
      source_fingerprint: inspected.input.source_fingerprint,
      valid: true,
      files: inspected.files.map((file) => ({ relative_path: file.relative_path, exists: true, size: file.size })),
      gaps: inspected.input.gaps,
      projected_counts: {
        nodes: inspected.projection.nodeRuns.length,
        artifacts: inspected.projection.artifacts.length,
        gates: inspected.projection.gates.length,
        events: inspected.projection.events.length,
        attention: inspected.projection.attention.length
      }
    },
    projection: inspected.projection
  };
}

async function writeJson(target: string, value: unknown) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function ensureRuntimeWorkspace(workspaceDir: string, repositoryRoot: string) {
  const lexicalWorkspace = path.resolve(workspaceDir);
  const lexicalRepository = path.resolve(repositoryRoot);
  if (lexicalWorkspace === lexicalRepository || lexicalWorkspace.startsWith(`${lexicalRepository}${path.sep}`)) {
    throw new HistoricalImportError(
      "runtime_workspace_required",
      "Historical imports require an external runtime workspace outside the Miracle repository."
    );
  }
  await mkdir(workspaceDir, { recursive: true });
  const workspace = await realpath(workspaceDir);
  const repository = await realpath(repositoryRoot);
  if (workspace === repository || workspace.startsWith(`${repository}${path.sep}`)) {
    throw new HistoricalImportError(
      "runtime_workspace_required",
      "Historical imports require an external runtime workspace outside the Miracle repository."
    );
  }
}

type ImportLockOwner = { pid: number; created_at: string };

function processIsAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

async function recoverStaleImportLock(lockDir: string, staleAfterMs: number) {
  let owner: ImportLockOwner | undefined;
  try {
    const parsed = JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8")) as Partial<ImportLockOwner>;
    if (typeof parsed.pid === "number" && typeof parsed.created_at === "string") owner = parsed as ImportLockOwner;
  } catch {
    owner = undefined;
  }
  const lockStat = await stat(lockDir).catch(() => undefined);
  if (!lockStat) return true;
  const createdAt = owner ? Date.parse(owner.created_at) : Number.NaN;
  const ageMs = Date.now() - (Number.isNaN(createdAt) ? lockStat.mtimeMs : createdAt);
  if (ageMs < staleAfterMs || (owner && processIsAlive(owner.pid))) return false;

  const quarantine = `${lockDir}.stale-${process.pid}-${Date.now()}`;
  try {
    await rename(lockDir, quarantine);
    await rm(quarantine, { recursive: true, force: true });
    return true;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return true;
    return false;
  }
}

async function acquireImportLock(lockDir: string, timeoutMs = 5_000, staleAfterMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  await mkdir(path.dirname(lockDir), { recursive: true });
  while (true) {
    try {
      await mkdir(lockDir, { recursive: false });
      try {
        await writeJson(path.join(lockDir, "owner.json"), { pid: process.pid, created_at: new Date().toISOString() });
      } catch (error) {
        await rm(lockDir, { recursive: true, force: true });
        throw error;
      }
      return;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (code !== "EEXIST") throw error;
      if (await recoverStaleImportLock(lockDir, staleAfterMs)) continue;
      if (Date.now() >= deadline) throw new HistoricalImportError("import_lock_timeout", "Historical import is still in progress.");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function writeImportReceipt(inspected: HistoricalImportInspection, workspaceDir: string, targetDir: string) {
  await writeJson(path.join(workspaceDir, "imports", `${inspected.preview.import_id}.json`), {
    ...inspected.preview,
    status: "committed",
    target_dir: targetDir,
    imported_at: inspected.projection.sourceMeta.imported_at
  });
}

export async function commitHistoricalImport(request: HistoricalImportRequest, options: HistoricalImporterOptions): Promise<HistoricalImportCommitResult> {
  await ensureRuntimeWorkspace(options.workspaceDir, options.repositoryRoot);
  const inspected = await previewHistoricalImport(request, options);
  const targetDir = path.join(options.workspaceDir, "runs", inspected.preview.run_id);
  const lockDir = path.join(options.workspaceDir, "imports", ".locks", `${inspected.preview.import_id}.lock`);
  await acquireImportLock(lockDir);
  try {
    const existingMetaPath = path.join(targetDir, "source_meta.json");
    if (await exists(existingMetaPath)) {
      const existing = await readJson<{ source_fingerprint?: string }>(existingMetaPath);
      if (existing.source_fingerprint === inspected.preview.source_fingerprint) {
        await writeImportReceipt(inspected, options.workspaceDir, targetDir);
        return { ...inspected.preview, reused: true, target_dir: targetDir };
      }
    }

    const stagingDir = path.join(options.workspaceDir, "runs", ".staging", inspected.preview.import_id);
    await rm(stagingDir, { recursive: true, force: true });
    await mkdir(stagingDir, { recursive: true });
    const projection = inspected.projection;
    await writeJson(path.join(stagingDir, "run_spec.json"), projection.runSpec);
    await writeJson(path.join(stagingDir, "workflow_snapshot.json"), projection.workflowSnapshot);
    await writeJson(path.join(stagingDir, "nodes.json"), projection.nodeRuns);
    await writeJson(path.join(stagingDir, "attempts.json"), projection.attempts);
    await writeJson(path.join(stagingDir, "artifacts.json"), projection.artifacts);
    await writeJson(path.join(stagingDir, "gates.json"), projection.gates);
    await writeJson(path.join(stagingDir, "attention.json"), projection.attention);
    await writeJson(path.join(stagingDir, "source_meta.json"), projection.sourceMeta);
    await writeJson(path.join(stagingDir, "manifest.json"), projection.manifest);
    await writeFile(path.join(stagingDir, "events.jsonl"), `${projection.events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
    await mkdir(path.dirname(targetDir), { recursive: true });
    await rename(stagingDir, targetDir);
    await writeImportReceipt(inspected, options.workspaceDir, targetDir);
    return { ...inspected.preview, reused: false, target_dir: targetDir };
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

export async function readHistoricalImport(importId: string, workspaceDir: string) {
  if (!/^import_[a-f0-9]{16}$/.test(importId)) {
    throw new HistoricalImportError("historical_import_not_found", `Historical import not found: ${importId}`);
  }
  try {
    return await readJson(path.join(workspaceDir, "imports", `${importId}.json`));
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") throw new HistoricalImportError("historical_import_not_found", `Historical import not found: ${importId}`);
    throw error;
  }
}

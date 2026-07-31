import {
  buildCanvasDraftFromWorkflow,
  adapterManifestSchema,
  adapterInvocationSchema,
  buildDagProjection,
  buildGateDecisionProjection,
  calculateExecutionPlan,
  buildAdapterRegistry,
  codexCliRealAdapterManifest,
  canvasNodeSpecDraftSchema,
  createAdapterInvocation,
  createArtifactManifestsFromAdapterResult,
  createDryRunPlan,
  createNodeAttemptFromAdapterResult,
  createRunFromWorkflow,
  createRunnerTraceEvents,
  classifyAdapterOutcome,
  decideRetry,
  defaultAdapterManifests,
  executeMockAdapter,
  parseAdapterResultForInvocation,
  resolveNodeRetryPolicy,
  selectAdapterManifest,
  selectProviderRoute,
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
  type NodeExecutionDecision,
  type NodeRun,
  type RunSpec,
  type RetryDecision,
  type RetryPolicy,
  type RetryScheduleRecord,
  type RetryStateRecord,
  type ProviderRoutingDecision,
  type ValidationResult,
  type WorkflowSpec
} from "@miracle/core";
import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { constants } from "node:fs";
import { readdir, readFile, writeFile, mkdir, open, lstat, realpath, rename, rm, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  commitHistoricalImport,
  HistoricalImportError,
  previewHistoricalImport,
  readHistoricalImport
} from "./historical-importer";
import { RunDraftStore, RunDraftStoreError } from "./run-draft-store";
import { CodexCliAdapter, CodexCliAdapterError, type CodexCliHealth } from "./codex-cli-adapter";
import { assertUniqueArtifactTargetPaths, resolveArtifactInputFiles } from "./artifact-input-resolver";
import { NodeOutputContractError, buildNodeOutputContract } from "./node-output-contract";
import { codexPreflightFailure, startCodexOperation } from "./codex-real-adapter";
import { ModelApiAdapter, modelApiFallbackFailure } from "./model-api-adapter";
import { authorizeProviderCredential } from "./model-api-authorization";
import { buildProviderHealthProjection, readProviderCatalog } from "./provider-catalog";
import { createProviderDriverRegistry } from "./provider-driver-registry";
import {
  RetryScheduleStore,
  RetryStateStore,
  type RetryStateMigrationIssue
} from "./retry-store";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const workspaceDir = process.env.MIRACLE_WORKSPACE_DIR ?? path.join(rootDir, "fixtures/mvp-workspace/.miracle");
const serverInstanceId = randomUUID();
const eventWriteQueues = new Map<string, Promise<void>>();
const providerDriverRegistry = createProviderDriverRegistry();
const modelApiOperations = new Map<string, {
  operation_id: string;
  attempt_id: string;
  run_id: string;
  node_run_id: string;
  adapter_id: string;
  provider: string;
  provider_profile_id?: string;
  started_at: string;
  cancel_requested: boolean;
  controller: AbortController;
}>();
const modelApiOperationTombstones = new Map<string, {
  operation_id: string;
  attempt_id: string;
  run_id: string;
  node_run_id: string;
  adapter_id: string;
  provider: string;
  provider_profile_id?: string;
  status: AdapterResult["status"];
  completed_at: string;
}>();
const maxModelApiOperationTombstones = 128;

type ModelApiOperationReceipt = {
  operation_id: string;
  attempt_id: string;
  run_id: string;
  node_run_id: string;
  adapter_id: string;
  provider: string;
  provider_profile_id?: string;
  status: AdapterResult["status"];
  completed_at: string;
};
const runtimeWorkspaceDir = process.env.MIRACLE_RUNTIME_WORKSPACE_DIR ?? path.join(homedir(), ".miracle-agent");
const workflowRegistryDir = process.env.MIRACLE_WORKFLOW_REGISTRY_DIR ?? path.join(rootDir, "fixtures/mvp-workspace/.miracle/workflows");
const port = Number(process.env.MIRACLE_SIDECAR_PORT ?? 4317);
const historicalImportRoots = (process.env.MIRACLE_IMPORT_ROOTS ?? "")
  .split(path.delimiter)
  .map((item) => item.trim())
  .filter(Boolean);
const execGit = promisify(execFile);
const runDraftStore = new RunDraftStore({ workspace_dir: workspaceDir, workflows_dir: workflowRegistryDir });
const retryScheduleStore = new RetryScheduleStore({ workspace_dir: workspaceDir });
const retryStateStore = new RetryStateStore({ workspace_dir: workspaceDir });
const codexCliAdapter = new CodexCliAdapter({
  workspace_dir: runtimeWorkspaceDir,
  repository_root: rootDir,
  executable_path: process.env.MIRACLE_CODEX_CLI_PATH,
  command_prefix_args: process.env.MIRACLE_CODEX_CLI_ARGUMENT_PREFIX ? [process.env.MIRACLE_CODEX_CLI_ARGUMENT_PREFIX] : []
});

class ProviderCredentialAuthorizationError extends Error {
  readonly code = "credential_not_authorized";

  constructor() {
    super("Provider credential_ref is not authorized for this Model API Adapter.");
  }
}

class RetryStateReconciliationBusyError extends Error {
  readonly code = "operation_in_progress";

  constructor(runId: string) {
    super(`Run ${runId} already has a state mutation in progress; retry after the current operation finishes.`);
    this.name = "RetryStateReconciliationBusyError";
  }
}
void codexCliAdapter.recoverOrphanedOperations();

type JsonValue = Record<string, unknown> | unknown[];
type SchedulerDecision = {
  node_run_id: string;
  node_id: string;
  status: NodeRun["status"];
  decision: NodeExecutionDecision["decision"];
  reason_code: string;
  gate_instance_id?: string;
  retry_operation_id?: string;
  retry_attempt_number?: number;
  retry_decision?: RetryDecision;
};
type SchedulerFailure = {
  decision: SchedulerDecision;
  node_run_id: string;
  node_id: string;
  error: { code: string; message: string; recoverable: boolean };
  retry_decision?: RetryDecision;
};
type CanvasObject = CanvasLayout["objects"][number];
type RunRoutingDecision = ProviderRoutingDecision & {
  decision_id: string;
  revision: number;
  node_run_id: string;
  current_adapter_kind?: "codex" | "model-api";
  target_attempt_number: number;
};
type FallbackConfirmation = {
  confirmation_id: string;
  decision_id: string;
  operation_id: string;
  node_run_id: string;
  expected_current_adapter_kind: "codex" | "model-api";
  target_provider_profile_id: string;
  target_attempt_number: number;
  actor: string;
  status: "confirmed";
  confirmed_at: string;
};
type ProviderFallbackContext = {
  decision: RunRoutingDecision;
  selected_provider: string;
  selected_profile_id: string;
  started_event: {
    event_id: string;
    run_id: string;
    type: "provider_fallback_started";
    subject: { type: "NodeRun"; id: string };
    message: string;
    created_at: string;
  };
};
type NodeExecutionResult =
  | {
      accepted: false;
      status_code: number;
      error: { code: string; message: string; reason_code?: string };
      retry_decision?: RetryDecision;
      retry_attention_items?: AttentionItem[];
      retry_events?: string[];
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
      retry_decision?: RetryDecision;
      retry_attention_items: AttentionItem[];
      retry_events: string[];
    };

type NodeCommitTransaction = {
  node_run_id: string;
  invocation: ReturnType<typeof createAdapterInvocation>;
  adapter_result: AdapterResult;
  node_updates: NodeRun[];
  attempt: NodeAttempt;
  artifacts: ArtifactManifest[];
  gates: GateInstance[];
  events: Array<{ event_id: string }>;
  committed: {
    node_run: NodeRun;
    attempt: NodeAttempt;
    artifacts: ArtifactManifest[];
    gates: GateInstance[];
    created_events: string[];
  };
  dispatch_intent_relative_path?: string;
};

type NodeDispatchIntent = {
  node_run_id: string;
  invocation: ReturnType<typeof createAdapterInvocation>;
  decision: {
    reason_code: string;
    resolved_input_count: number;
    resolved_input_ids: string[];
  };
  event: {
    event_id: string;
    run_id: string;
    type: "node_inputs_resolved";
    subject: { type: "NodeRun"; id: string };
    message: string;
    created_at: string;
  };
  state: "prepared" | "dispatched_unknown" | "invalid_result";
  prepared_at: string;
  operation_deadline_at?: string;
  dispatched_at?: string;
  error?: { code: string; message: string };
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
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function isNodeDispatchIntent(value: unknown): value is NodeDispatchIntent {
  if (!isRecord(value) || !isNonEmptyString(value.node_run_id) || !isRecord(value.invocation) || !isRecord(value.decision) || !isRecord(value.event)) return false;
  const invocation = value.invocation;
  const decision = value.decision;
  const event = value.event;
  const hasValidError = isRecord(value.error) && isNonEmptyString(value.error.code) && isNonEmptyString(value.error.message);
  const validState = value.state === "prepared"
    || (value.state === "dispatched_unknown" && isTimestamp(value.dispatched_at))
    || (value.state === "invalid_result" && hasValidError);
  return isNonEmptyString(invocation.operation_id)
    && isNonEmptyString(invocation.attempt_id)
    && isNonEmptyString(invocation.run_id)
    && isNonEmptyString(invocation.node_run_id)
    && isNonEmptyString(event.event_id)
    && event.type === "node_inputs_resolved"
    && isNonEmptyString(event.message)
    && isTimestamp(event.created_at)
    && isNonEmptyString(event.run_id)
    && isRecord(event.subject)
    && event.subject.type === "NodeRun"
    && isNonEmptyString(event.subject.id)
    && isTimestamp(value.prepared_at)
    && isNonEmptyString(decision.reason_code)
    && Number.isSafeInteger(decision.resolved_input_count)
    && Number(decision.resolved_input_count) >= 0
    && Array.isArray(decision.resolved_input_ids)
    && decision.resolved_input_ids.every(isNonEmptyString)
    && (value.operation_deadline_at === undefined || isTimestamp(value.operation_deadline_at))
    && validState;
}

function invalidNodeDispatchIntent(relativePath: string, reason: string): never {
  throw new Error(`Invalid NodeDispatchIntent: ${relativePath}; ${reason}`);
}

function adapterOperationPrefix(nodeRunId: string) {
  return `op_${nodeRunId.replace(/[^a-zA-Z0-9_-]/g, "_")}_`;
}

function nodeSpecExpectedOutputs(nodeSpec: NodeSpec) {
  return nodeSpec.outputs.map((output) => ({
    output_id: output.id,
    artifact_type: output.artifact_type ?? "document",
    artifact_spec_ref: output.artifact_spec_ref,
    required: output.required
  }));
}

function sameStringArray(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameResolvedInputs(left: NodeExecutionDecision["resolved_inputs"], right: NodeExecutionDecision["resolved_inputs"]) {
  return left.length === right.length && left.every((input, index) => {
    const candidate = right[index];
    return candidate?.input_id === input.input_id
      && candidate.source_kind === input.source_kind
      && candidate.source_ref === input.source_ref
      && candidate.artifact_id === input.artifact_id
      && candidate.artifact_version === input.artifact_version
      && candidate.artifact_hash === input.artifact_hash
      && candidate.media_type === input.media_type
      && candidate.required === input.required
      && isTimestamp(candidate.resolved_at)
      && isTimestamp(input.resolved_at)
      && candidate.resolved_at === input.resolved_at;
  });
}

function normalizeResolvedInputsForDispatch(inputs: NodeExecutionDecision["resolved_inputs"], dispatchedAt: string) {
  return inputs.map((input) => ({ ...input, resolved_at: dispatchedAt }));
}

function nodeInputsResolvedEvent(input: {
  runId: string;
  nodeRunId: string;
  invocation: ReturnType<typeof createAdapterInvocation>;
  reasonCode: string;
}) {
  return {
    event_id: `evt_${input.invocation.attempt_id}_inputs_resolved`,
    run_id: input.runId,
    type: "node_inputs_resolved" as const,
    subject: { type: "NodeRun" as const, id: input.nodeRunId },
    message: `NodeRun ${input.nodeRunId} resolved ${input.invocation.resolved_inputs.length} input(s); reason_code=${input.reasonCode}`,
    created_at: input.invocation.dispatched_at
  };
}

async function readNodeDispatchIntent(
  relativePath: string,
  expected: {
    runId: string;
    nodeRunId: string;
    nodeId: string;
    runSpec: RunSpec;
    workflow: WorkflowSpec;
    nodeRun: NodeRun;
    nodeSpec: NodeSpec;
    decision: NodeExecutionDecision;
    adapter?: AdapterRegistryEntry;
    providerProfileId?: string;
    retryDeadlineAt?: string;
  }
) {
  const rawIntent = await readJsonOptional<unknown>(relativePath);
  if (rawIntent === undefined) return undefined;
  if (!isNodeDispatchIntent(rawIntent)) invalidNodeDispatchIntent(relativePath, "minimal structure is malformed");
  let intent: NodeDispatchIntent = rawIntent;
  const parsedInvocation = adapterInvocationSchema.safeParse(intent.invocation);
  if (!parsedInvocation.success) invalidNodeDispatchIntent(relativePath, "invocation does not satisfy adapterInvocationSchema");
  let invocation = parsedInvocation.data;
  const attemptNumber = invocation.attempt_number ?? 1;
  const event = intent.event;
  const decision = intent.decision;
  const expectedOperationPrefix = adapterOperationPrefix(invocation.node_run_id);
  const operationTimestamp = invocation.operation_id.slice(expectedOperationPrefix.length);
  const resolvedInputIds = invocation.resolved_inputs.map((input) => input.input_id);
  const expectedOutputs = nodeSpecExpectedOutputs(expected.nodeSpec);
  const expectedResolvedInputs = normalizeResolvedInputsForDispatch(expected.decision.resolved_inputs, invocation.dispatched_at);
  let persistedRetryDeadlineAt = attemptNumber > 1 ? intent.operation_deadline_at : undefined;
  if (attemptNumber > 1 && !persistedRetryDeadlineAt && expected.retryDeadlineAt) {
    persistedRetryDeadlineAt = expected.retryDeadlineAt;
    intent = { ...intent, operation_deadline_at: persistedRetryDeadlineAt };
    await writeJsonAtomically(relativePath, intent);
  }
  if (attemptNumber > 1 && (
    !persistedRetryDeadlineAt
    || !expected.retryDeadlineAt
    || persistedRetryDeadlineAt !== expected.retryDeadlineAt
  )) {
    invalidNodeDispatchIntent(relativePath, "persisted retry operation deadline does not match the first Attempt budget");
  }
  if (attemptNumber === 1 && intent.operation_deadline_at !== undefined) {
    invalidNodeDispatchIntent(relativePath, "initial dispatch intent must not declare a retry operation deadline");
  }
  const remainingTotalBudgetMs = persistedRetryDeadlineAt
    ? Date.parse(persistedRetryDeadlineAt) - Date.parse(invocation.dispatched_at)
    : undefined;
  if (remainingTotalBudgetMs !== undefined && (!Number.isFinite(remainingTotalBudgetMs) || remainingTotalBudgetMs <= 0)) {
    invalidNodeDispatchIntent(relativePath, "persisted retry runtime deadline is not after the prepared invocation");
  }
  let rebuiltInvocation = createAdapterInvocation({
    runSpec: expected.runSpec,
    workflow: expected.workflow,
    nodeRun: expected.nodeRun,
    createdAt: invocation.dispatched_at,
    adapterKind: expected.adapter?.kind,
    adapterId: expected.adapter?.id,
    resolvedInputs: expectedResolvedInputs,
    operationId: invocation.operation_id,
    attemptNumber,
    providerProfileId: expected.providerProfileId,
    remainingTotalBudgetMs
  });
  const routeIdentityChanged = invocation.adapter_kind !== rebuiltInvocation.adapter_kind
    || invocation.adapter_id !== rebuiltInvocation.adapter_id
    || invocation.provider !== rebuiltInvocation.provider
    || invocation.provider_profile_id !== rebuiltInvocation.provider_profile_id;
  const canReroutePreparedFallback = intent.state === "prepared"
    && attemptNumber > 1
    && typeof invocation.provider_profile_id === "string"
    && typeof expected.providerProfileId === "string";
  if (routeIdentityChanged && canReroutePreparedFallback) {
    const reroutedInvocation = {
      ...invocation,
      adapter_kind: rebuiltInvocation.adapter_kind,
      adapter_id: rebuiltInvocation.adapter_id,
      provider: rebuiltInvocation.provider,
      ...(rebuiltInvocation.provider_profile_id
        ? { provider_profile_id: rebuiltInvocation.provider_profile_id }
        : {})
    };
    if (!rebuiltInvocation.provider_profile_id) delete reroutedInvocation.provider_profile_id;
    invocation = reroutedInvocation;
    intent = { ...intent, invocation };
    await writeJsonAtomically(relativePath, intent);
  } else if (routeIdentityChanged && intent.state !== "prepared") {
    rebuiltInvocation = createAdapterInvocation({
      runSpec: expected.runSpec,
      workflow: expected.workflow,
      nodeRun: { ...expected.nodeRun, provider: invocation.provider },
      createdAt: invocation.dispatched_at,
      adapterKind: invocation.adapter_kind,
      adapterId: invocation.adapter_id,
      resolvedInputs: expectedResolvedInputs,
      operationId: invocation.operation_id,
      attemptNumber,
      providerProfileId: invocation.provider_profile_id,
      remainingTotalBudgetMs
    });
  }

  if (intent.node_run_id !== expected.nodeRunId
    || invocation.run_id !== expected.runId
    || invocation.node_run_id !== expected.nodeRunId
    || invocation.node_id !== expected.nodeId
    || event.run_id !== expected.runId
    || !isRecord(event.subject)
    || event.subject.type !== "NodeRun"
    || event.subject.id !== expected.nodeRunId
    || event.event_id !== `evt_${invocation.attempt_id}_inputs_resolved`
    || invocation.attempt_id !== (attemptNumber === 1 ? `attempt_${invocation.operation_id}` : `attempt_${invocation.operation_id}_${attemptNumber}`)
    || !invocation.operation_id.startsWith(expectedOperationPrefix)
    || !/^\d+$/.test(operationTimestamp)
    || (attemptNumber === 1 && operationTimestamp !== String(Date.parse(invocation.dispatched_at)))
    || invocation.operation_id !== rebuiltInvocation.operation_id
    || invocation.attempt_id !== rebuiltInvocation.attempt_id
    || decision.resolved_input_count !== resolvedInputIds.length
    || !sameStringArray(decision.resolved_input_ids, resolvedInputIds)
    || decision.reason_code !== expected.decision.reason_code
    || !sameStringArray(invocation.capability_requirements, expected.nodeSpec.capability_requirements)
    || invocation.expected_outputs.length !== expectedOutputs.length
    || invocation.expected_outputs.some((output, index) => {
      const expectedOutput = expectedOutputs[index];
      return output.output_id !== expectedOutput?.output_id
        || output.artifact_type !== expectedOutput.artifact_type
        || output.artifact_spec_ref !== expectedOutput.artifact_spec_ref
        || output.required !== expectedOutput.required;
    })
    || !sameResolvedInputs(invocation.resolved_inputs, expectedResolvedInputs)
    || JSON.stringify(invocation) !== JSON.stringify(rebuiltInvocation)
    || intent.prepared_at !== invocation.dispatched_at) {
    invalidNodeDispatchIntent(relativePath, "identity or resolved input facts do not match the expected NodeRun");
  }
  return {
    ...intent,
    invocation: rebuiltInvocation,
    event: nodeInputsResolvedEvent({
      runId: expected.runId,
      nodeRunId: expected.nodeRunId,
      invocation: rebuiltInvocation,
      reasonCode: expected.decision.reason_code
    }),
    prepared_at: rebuiltInvocation.dispatched_at
  };
}

async function writeJson(relativePath: string, value: unknown) {
  const target = path.join(workspaceDir, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJsonAtomically(relativePath: string, value: unknown) {
  const target = path.join(workspaceDir, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeJsonAtomicallyAt(target, value);
}

async function writeJsonAtomicallyAt(target: string, value: unknown) {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function modelApiOperationReceiptRelativePath(operationId: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(operationId)) return undefined;
  return `${operationId}.json`;
}

function isPathInside(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function modelApiOperationReceiptRoot() {
  const canonicalWorkspace = await realpath(workspaceDir);
  if (!(await stat(canonicalWorkspace)).isDirectory()) throw new Error("Model API receipt workspace is not a directory.");
  const receiptRoot = path.join(canonicalWorkspace, "model-api-operations");
  try {
    const rootInfo = await lstat(receiptRoot);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error("Model API receipt root is unsafe.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(receiptRoot, { mode: 0o700 });
  }
  const rootInfo = await lstat(receiptRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error("Model API receipt root is unsafe.");
  const canonicalRoot = await realpath(receiptRoot);
  if (canonicalRoot !== receiptRoot || !isPathInside(canonicalWorkspace, canonicalRoot)) {
    throw new Error("Model API receipt root escapes the workspace.");
  }
  const handle = await open(receiptRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isDirectory()) throw new Error("Model API receipt root is not a directory.");
    const currentRoot = await lstat(receiptRoot);
    if (currentRoot.isSymbolicLink() || !currentRoot.isDirectory() || await realpath(receiptRoot) !== canonicalRoot) {
      throw new Error("Model API receipt root changed during verification.");
    }
  } finally {
    await handle.close();
  }
  return canonicalRoot;
}

async function delayModelApiReceiptWrite() {
  const delayMs = Number(process.env.MIRACLE_MODEL_API_RECEIPT_WRITE_DELAY_MS ?? "0");
  if (Number.isFinite(delayMs) && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function isModelApiOperationReceipt(value: unknown, operationId: string): value is ModelApiOperationReceipt {
  if (!isRecord(value) || value.operation_id !== operationId) return false;
  return isNonEmptyString(value.attempt_id)
    && isNonEmptyString(value.run_id)
    && isNonEmptyString(value.node_run_id)
    && isNonEmptyString(value.adapter_id)
    && isNonEmptyString(value.provider)
    && ["succeeded", "failed", "timed_out", "cancelled", "aborted", "unknown"].includes(String(value.status))
    && isTimestamp(value.completed_at);
}

async function writeModelApiOperationReceipt(receipt: ModelApiOperationReceipt) {
  const fileName = modelApiOperationReceiptRelativePath(receipt.operation_id);
  if (!fileName) throw new Error("Model API operation_id is unsafe for receipt persistence.");
  await modelApiOperationReceiptRoot();
  await delayModelApiReceiptWrite();
  const receiptRoot = await modelApiOperationReceiptRoot();
  await writeJsonAtomicallyAt(path.join(receiptRoot, fileName), receipt);
}

async function readModelApiOperationReceipt(operationId: string) {
  const fileName = modelApiOperationReceiptRelativePath(operationId);
  if (!fileName) return undefined;
  try {
    const receiptRoot = await modelApiOperationReceiptRoot();
    const receiptHandle = await open(path.join(receiptRoot, fileName), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const receipt = JSON.parse(await receiptHandle.readFile({ encoding: "utf8" })) as unknown;
      return isModelApiOperationReceipt(receipt, operationId) ? receipt : undefined;
    } finally {
      await receiptHandle.close();
    }
  } catch {
    return undefined;
  }
}

async function writeAbsoluteJson(target: string, value: unknown) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function stageRunFromDraft(input: {
  workflow: WorkflowSpec;
  executionPolicy: "auto" | "manual" | "hybrid";
  inputs: Record<string, unknown>;
  draftId: string;
  planHash: string;
}) {
  const planKey = input.planHash.replace(/^sha256:/, "").slice(0, 12);
  const runId = `run-${safeId(input.draftId)}-${safeId(planKey)}`;
  const created = createRunFromWorkflow(input.workflow, {
    runId,
    executionPolicy: input.executionPolicy,
    roleProfile: "operator"
  });
  created.runSpec.resolved_components = Array.from(new Set([...created.runSpec.resolved_components, "codex-cli-real"]));
  const runsRoot = path.join(workspaceDir, "runs");
  const stagingDir = path.join(runsRoot, `.${runId}.launching`);
  const finalDir = path.join(runsRoot, runId);
  await mkdir(runsRoot, { recursive: true });
  const existingContext = await readFile(path.join(finalDir, "launch_context.json"), "utf8")
    .then((value) => JSON.parse(value) as { draft_id?: unknown; plan_hash?: unknown })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
  if (existingContext) {
    if (existingContext.draft_id !== input.draftId || existingContext.plan_hash !== input.planHash) {
      throw new RunDraftStoreError("launch_handoff_required", `Run ${runId} already exists with different launch references.`);
    }
    await Promise.all([
      stat(path.join(finalDir, "run_spec.json")),
      stat(path.join(finalDir, "workflow_snapshot.json")),
      stat(path.join(finalDir, "nodes.json")),
      stat(path.join(finalDir, "events.jsonl"))
    ]);
    return { run_id: runId, reused: true };
  }
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: false });
  try {
    await Promise.all([
      writeAbsoluteJson(path.join(stagingDir, "run_spec.json"), created.runSpec),
      writeAbsoluteJson(path.join(stagingDir, "workflow_snapshot.json"), created.workflowSnapshot),
      writeAbsoluteJson(path.join(stagingDir, "nodes.json"), created.nodeRuns),
      writeAbsoluteJson(path.join(stagingDir, "attempts.json"), []),
      writeAbsoluteJson(path.join(stagingDir, "artifacts.json"), []),
      writeAbsoluteJson(path.join(stagingDir, "gates.json"), []),
      writeAbsoluteJson(path.join(stagingDir, "attention.json"), []),
      writeAbsoluteJson(path.join(stagingDir, "launch_context.json"), {
        draft_id: input.draftId,
        plan_hash: input.planHash,
        inputs: input.inputs,
        created_at: created.runSpec.created_at
      }),
      writeAbsoluteJson(path.join(stagingDir, "manifest.json"), {
        run_id: runId,
        run_spec_path: `runs/${runId}/run_spec.json`,
        workflow_snapshot_path: `runs/${runId}/workflow_snapshot.json`,
        attempts_path: `runs/${runId}/attempts.json`,
        events_path: `runs/${runId}/events.jsonl`
      }),
      writeFile(path.join(stagingDir, "events.jsonl"), `${created.events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8")
    ]);
    await rename(stagingDir, finalDir);
    return {
      run_id: runId,
      rollback: async () => rm(finalDir, { recursive: true, force: true })
    };
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
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

async function withEventJournalLock<T>(runId: string, operation: () => Promise<T>) {
  const previous = eventWriteQueues.get(runId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  eventWriteQueues.set(runId, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (eventWriteQueues.get(runId) === current) eventWriteQueues.delete(runId);
  }
}

async function readEventJournalLocked(runId: string) {
  const file = path.join(workspaceDir, "runs", runId, "events.jsonl");
  const existing = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  if (existing && !existing.endsWith("\n")) throw new Error("Event Journal has an incomplete trailing record.");
  const events = existing.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  return { file, existing, events };
}

async function appendEventLocked(runId: string, event: unknown, journal?: Awaited<ReturnType<typeof readEventJournalLocked>>) {
  const currentJournal = journal ?? await readEventJournalLocked(runId);
  await writeJsonlAtomically(currentJournal.file, `${currentJournal.existing}${JSON.stringify(event)}\n`);
}

async function appendEvent(runId: string, event: unknown) {
  await withEventJournalLock(runId, () => appendEventLocked(runId, event));
}

async function appendEventIfMissing(runId: string, event: { event_id: string; [key: string]: unknown }) {
  return withEventJournalLock(runId, async () => {
    const journal = await readEventJournalLocked(runId);
    const existingIds = new Set(journal.events.map((item) => String(item.event_id ?? "")));
    if (existingIds.has(event.event_id)) return false;
    await appendEventLocked(runId, event, journal);
    return true;
  });
}

async function writeJsonlAtomically(target: string, content: string) {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
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

function routingDecisionsPath(runId: string) {
  return `runs/${runId}/routing_decisions.json`;
}

function fallbackConfirmationsPath(runId: string) {
  return `runs/${runId}/fallback_confirmations.json`;
}

type StoredRunRoutingDecision = Omit<RunRoutingDecision, "decision_id" | "revision"> & {
  decision_id?: string;
  revision?: number;
};

function routingDecisionIdentity(item: { operation_id: string; node_run_id: string; target_attempt_number: number }) {
  return `${item.operation_id}\0${item.node_run_id}\0${item.target_attempt_number}`;
}

function comparableRoutingDecision(item: Omit<RunRoutingDecision, "decision_id" | "revision"> | StoredRunRoutingDecision | RunRoutingDecision) {
  return {
    operation_id: item.operation_id,
    node_run_id: item.node_run_id,
    current_adapter_kind: item.current_adapter_kind,
    target_attempt_number: item.target_attempt_number,
    selected_adapter_kind: item.selected_adapter_kind,
    selected_provider_profile_id: item.selected_provider_profile_id,
    candidate_profile_ids: item.candidate_profile_ids,
    rejected_candidates: item.rejected_candidates,
    reason_codes: item.reason_codes,
    estimated_cost: item.estimated_cost,
    requires_confirmation: item.requires_confirmation
  };
}

function normalizedRoutingDecisionId(item: StoredRunRoutingDecision, revision: number) {
  return `route_${createHash("sha256")
    .update(JSON.stringify([item.operation_id, item.node_run_id, item.target_attempt_number, revision, comparableRoutingDecision(item)]))
    .digest("hex")
    .slice(0, 24)}`;
}

function normalizeRoutingDecisionHistory(stored: StoredRunRoutingDecision[]) {
  const revisions = new Map<string, number>();
  let changed = false;
  const decisions = stored.map((item) => {
    const identity = routingDecisionIdentity(item);
    const revision = (revisions.get(identity) ?? 0) + 1;
    revisions.set(identity, revision);
    const decisionId = typeof item.decision_id === "string" && item.decision_id.length > 0 && item.revision === revision
      ? item.decision_id
      : normalizedRoutingDecisionId(item, revision);
    if (item.revision !== revision || item.decision_id !== decisionId) changed = true;
    return { ...item, decision_id: decisionId, revision } as RunRoutingDecision;
  });
  return { decisions, changed };
}

async function readStoredRoutingDecisions(runId: string) {
  return (await readJsonOptional<StoredRunRoutingDecision[]>(routingDecisionsPath(runId))) ?? [];
}

async function readRoutingDecisions(runId: string) {
  return normalizeRoutingDecisionHistory(await readStoredRoutingDecisions(runId)).decisions;
}

async function readFallbackConfirmations(runId: string) {
  return (await readJsonOptional<FallbackConfirmation[]>(fallbackConfirmationsPath(runId))) ?? [];
}

async function persistRoutingDecision(
  runId: string,
  decision: Omit<RunRoutingDecision, "decision_id" | "revision">
): Promise<{ decision: RunRoutingDecision; created: boolean }> {
  const normalized = normalizeRoutingDecisionHistory(await readStoredRoutingDecisions(runId));
  const current = normalized.decisions;
  const revisions = current.filter((item) => routingDecisionIdentity(item) === routingDecisionIdentity(decision));
  const latest = revisions.sort((left, right) => left.revision - right.revision).at(-1);
  if (latest && JSON.stringify(comparableRoutingDecision(latest)) === JSON.stringify(comparableRoutingDecision(decision))) {
    if (normalized.changed) await writeJsonAtomically(routingDecisionsPath(runId), current);
    return { decision: latest, created: false };
  }
  const revision = (latest?.revision ?? 0) + 1;
  const decisionId = `route_${createHash("sha256")
    .update(JSON.stringify([decision.operation_id, decision.node_run_id, decision.target_attempt_number, revision, comparableRoutingDecision(decision)]))
    .digest("hex")
    .slice(0, 24)}`;
  const persisted = { ...decision, decision_id: decisionId, revision };
  await writeJsonAtomically(routingDecisionsPath(runId), [...current, persisted]);
  return { decision: persisted, created: true };
}

function adapterKindFromAttempt(attempt: NodeAttempt): "codex" | "model-api" | undefined {
  const kind = attempt.provider_receipt?.adapter_kind;
  return kind === "codex" || kind === "model-api" ? kind : undefined;
}

function providerFromAttempt(attempt: NodeAttempt) {
  const provider = attempt.provider_receipt?.provider;
  return typeof provider === "string" && provider.length > 0 ? provider : undefined;
}

function providerProfileFromAttempt(attempt: NodeAttempt) {
  const profileId = attempt.provider_receipt?.provider_profile_id;
  return typeof profileId === "string" && profileId.length > 0 ? profileId : undefined;
}

function providerCostFromAttempt(attempt: NodeAttempt) {
  const receipt = attempt.provider_receipt;
  if (!receipt || typeof receipt !== "object") return 0;
  const direct = receipt.cost;
  if (typeof direct === "number" && Number.isFinite(direct) && direct >= 0) return direct;
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    const amount = (direct as Record<string, unknown>).amount;
    if (typeof amount === "number" && Number.isFinite(amount) && amount >= 0) return amount;
  }
  return 0;
}

function fallbackFailureForAttempt(attempt: NodeAttempt) {
  const modelApiFailure = modelApiFallbackFailure(attempt);
  if (modelApiFailure) return modelApiFailure;
  if (
    adapterKindFromAttempt(attempt) === "codex"
    && attempt.status === "failed"
    && attempt.error?.recoverable === true
  ) {
    return { error_code: "adapter_process_error", status: "failed" as const };
  }
  return undefined;
}

async function buildProviderFallbackContext(input: {
  runId: string;
  nodeRun: NodeRun;
  nodeSpec: NodeSpec;
  runSpec: RunSpec;
  attempts: NodeAttempt[];
  activeRetry: RetryScheduleRecord;
  decidedAt: string;
}): Promise<{ context?: ProviderFallbackContext; confirmation_required: boolean }> {
  const operationAttempts = input.attempts
    .filter((attempt) => attempt.operation_id === input.activeRetry.operation_id)
    .sort((left, right) => (left.attempt_number ?? 1) - (right.attempt_number ?? 1));
  const latestAttempt = operationAttempts.at(-1);
  if (!latestAttempt) return { confirmation_required: false };
  const currentAdapterKind = adapterKindFromAttempt(latestAttempt);
  const failure = fallbackFailureForAttempt(latestAttempt);
  if (!currentAdapterKind || !failure) return { confirmation_required: false };

  const catalog = await readProviderCatalogEntries();
  const availableCredentials = availableCredentialKeys();
  const adapterManifests = await readAdapterManifests();
  const health = buildProviderHealthProjection(catalog, {
    credentialKeys: availableCredentials,
    driverProviderBindings: providerDriverRegistry.registeredDriverBindings()
  });
  const healthById = new Map(health.map((item) => [item.profile.id, item]));
  const fallbackOrder = input.runSpec.resolved_provider_policy.fallback_providers;
  const allowedProviders = new Set(input.runSpec.resolved_provider_policy.allowed_providers);
  const allowedAdapterKinds = input.nodeSpec.runtime_policy?.allowed_adapter_kinds
    ?? (currentAdapterKind === "model-api" ? ["model-api" as const] : ["codex" as const]);
  const modelApiAllowed = allowedAdapterKinds.includes("model-api");
  const candidates = modelApiAllowed
      ? catalog.filter((entry) => allowedProviders.has(entry.profile.provider)).map((entry, index) => {
        const projection = healthById.get(entry.profile.id);
        const fallbackIndex = fallbackOrder.indexOf(entry.profile.provider);
        const adapterExecutable = adapterManifests.some((manifest) =>
          manifest.kind === "model-api"
          && manifest.status !== "blocked"
          && manifest.runtime.can_execute
          && manifest.supported_providers.includes(entry.profile.provider)
          && input.nodeSpec.capability_requirements.every((capability) => manifest.capabilities.includes(capability))
          && authorizeProviderCredential(manifest, entry.profile).authorized
        );
        return {
          id: entry.profile.id,
          provider: entry.profile.provider,
          adapter_kind: "model-api" as const,
          capabilities: entry.capabilities,
          executable: Boolean(projection?.driver_registered) && adapterExecutable,
          credential_available: Boolean(projection?.credential.configured),
          health_status: projection?.health_status ?? "unavailable" as const,
          user_priority: entry.routing?.user_priority ?? (fallbackIndex >= 0 ? fallbackIndex : fallbackOrder.length + index + 100),
          cost_tier: entry.routing?.cost_tier ?? 100,
          ...(entry.routing?.estimated_cost ? { estimated_cost: entry.routing.estimated_cost } : {})
        };
      })
    : [];
  const failedProvider = providerFromAttempt(latestAttempt);
  const failedProviderProfiles = catalog.filter((entry) => entry.profile.provider === failedProvider);
  const receiptProfileId = providerProfileFromAttempt(latestAttempt);
  const failedProfileId = receiptProfileId
    ?? (failedProviderProfiles.length === 1 ? failedProviderProfiles[0]?.profile.id : undefined);
  const failedProviderId = !receiptProfileId && failedProviderProfiles.length > 1 ? failedProvider : undefined;
  const policy = retryPolicyForNode(input.nodeSpec);
  const firstDispatchedAt = operationAttempts
    .map((attempt) => attempt.dispatched_at ?? attempt.started_at ?? attempt.created_at)
    .filter((value): value is string => typeof value === "string")
    .sort()[0];
  const elapsedMs = firstDispatchedAt ? Math.max(0, Date.parse(input.decidedAt) - Date.parse(firstDispatchedAt)) : 0;
  const decision = selectProviderRoute({
    operation_id: input.activeRetry.operation_id,
    capability_requirements: input.nodeSpec.capability_requirements,
    allowed_adapter_kinds: allowedAdapterKinds,
    current_adapter_kind: currentAdapterKind,
    ...(failedProfileId ? { failed_profile_id: failedProfileId } : {}),
    ...(failedProviderId ? { failed_provider_id: failedProviderId } : {}),
    failure,
    profiles: candidates,
    budget: {
      attempts_used: operationAttempts.length,
      max_attempts: policy.max_attempts,
      elapsed_ms: elapsedMs,
      total_time_budget_ms: policy.total_time_budget_ms,
      cost_used: operationAttempts.reduce((total, attempt) => total + providerCostFromAttempt(attempt), 0),
      cost_budget: policy.cost_budget
    },
    decided_at: input.decidedAt
  });
  const draftRecord: Omit<RunRoutingDecision, "decision_id" | "revision"> = {
    ...decision,
    node_run_id: input.nodeRun.node_run_id,
    current_adapter_kind: currentAdapterKind,
    target_attempt_number: input.activeRetry.attempt_number
  };
  const persistedDecision = await persistRoutingDecision(input.runId, draftRecord);
  const record = persistedDecision.decision;
  if (persistedDecision.created) {
    await appendEventIfMissing(input.runId, {
      event_id: `evt_${record.decision_id}`,
      run_id: input.runId,
      type: "provider_routing_decided",
      subject: { type: "NodeRun", id: input.nodeRun.node_run_id },
      message: `Provider routing revision ${record.revision}: ${record.reason_codes.join(", ")}`,
      created_at: record.decided_at
    });
  }
  if (!decision.selected_provider_profile_id) return { confirmation_required: false };
  const selectedEntry = catalog.find((entry) => entry.profile.id === decision.selected_provider_profile_id);
  if (!selectedEntry) return { confirmation_required: false };
  const startedEvent = {
    event_id: `evt_${safeId(decision.operation_id)}_fallback_${input.activeRetry.attempt_number}_started`,
    run_id: input.runId,
    type: "provider_fallback_started" as const,
    subject: { type: "NodeRun" as const, id: input.nodeRun.node_run_id },
    message: `Provider fallback started: ${failedProvider ?? currentAdapterKind} -> ${selectedEntry.profile.provider}`,
    created_at: input.decidedAt
  };
  const context = {
    decision: record,
    selected_provider: selectedEntry.profile.provider,
    selected_profile_id: selectedEntry.profile.id,
    started_event: startedEvent
  };
  if (!decision.requires_confirmation) return { context, confirmation_required: false };
  const confirmed = (await readFallbackConfirmations(input.runId)).some((confirmation) =>
    confirmation.decision_id === record.decision_id
    && confirmation.operation_id === record.operation_id
    && confirmation.node_run_id === input.nodeRun.node_run_id
    && confirmation.expected_current_adapter_kind === currentAdapterKind
    && confirmation.target_provider_profile_id === record.selected_provider_profile_id
    && confirmation.target_attempt_number === record.target_attempt_number
    && confirmation.status === "confirmed"
  );
  return { context, confirmation_required: !confirmed };
}

function createRunDraftId() {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 17);
  return `rundraft_${timestamp}_${Math.random().toString(36).slice(2, 8)}`;
}

async function readAdapterManifests(): Promise<AdapterManifest[]> {
  try {
    const raw = await listJsonFiles<unknown>("adapters");
    return raw.map((manifest) => {
      const parsed = adapterManifestSchema.safeParse(manifest);
      if (parsed.success) return parsed.data;
      if (parsed.error.issues.some((issue) => issue.path[0] === "provider_profiles" && issue.path.at(-1) === "credential_ref")) {
        throw new ProviderCredentialAuthorizationError();
      }
      throw parsed.error;
    });
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

async function readProviderCatalogEntries() {
  return readProviderCatalog(workspaceDir);
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
  const attempts = await readJson<JsonValue>(`runs/${runId}/attempts.json`).catch(() => []);
  const artifacts = await readJson<JsonValue>(`runs/${runId}/artifacts.json`);
  const gates = await readJson<JsonValue>(`runs/${runId}/gates.json`);
  const attention = await readJson<JsonValue>(`runs/${runId}/attention.json`).catch(() => []);
  const sourceMeta = await readJsonOptional<HistoricalSourceMetaProjection>(`runs/${runId}/source_meta.json`);
  return { run, snapshot, workflow, nodes, attempts, artifacts, gates, attention, source_meta: sourceMeta, view_meta: buildRunViewMeta(run, sourceMeta) };
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

async function writeArtifactDescriptorFile(descriptor: AdapterArtifactDescriptor): Promise<{ path?: string; created: boolean }> {
  if (descriptor.content === undefined) return { created: false };
  const lexicalTargetPath = resolveWorkspacePath(descriptor.path);
  if (!lexicalTargetPath || path.dirname(descriptor.path) !== "artifacts") throw new Error(`Artifact path escapes workspace: ${descriptor.path}`);
  const workspaceRoot = await realpath(workspaceDir);
  const artifactsRootPath = path.join(workspaceRoot, "artifacts");
  await mkdir(artifactsRootPath, { recursive: false }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const [artifactsEntry, artifactsRoot] = await Promise.all([lstat(artifactsRootPath), realpath(artifactsRootPath)]);
  if (
    artifactsEntry.isSymbolicLink() ||
    !artifactsEntry.isDirectory() ||
    artifactsRoot !== artifactsRootPath
  ) {
    throw new Error("Artifact parent directory is not canonical.");
  }
  const targetPath = path.join(artifactsRoot, path.basename(lexicalTargetPath));
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  try {
    handle = await open(
      targetPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    created = true;
    const entry = await handle.stat();
    if (!entry.isFile() || entry.nlink !== 1) throw new Error("Artifact target must be a single-link regular file.");
    await handle.writeFile(descriptor.content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    return { path: targetPath, created: true };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (created) await rm(targetPath, { force: true }).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const [entry, resolved] = await Promise.all([lstat(targetPath), realpath(targetPath)]);
      if (
        entry.isSymbolicLink() ||
        !entry.isFile() ||
        entry.nlink !== 1 ||
        path.dirname(resolved) !== artifactsRoot
      ) {
        throw new Error("Existing Artifact target is not a canonical single-link file.");
      }
      const existingHash = `sha256:${createHash("sha256").update(await readFile(resolved)).digest("hex")}`;
      if (existingHash === descriptor.hash) return { path: resolved, created: false };
      throw new Error("Existing Artifact target does not match the immutable descriptor hash.");
    }
    throw error;
  }
}

async function stageArtifactDescriptorFiles(descriptors: AdapterArtifactDescriptor[]) {
  const createdPaths: string[] = [];
  const rollback = async () => {
    for (const target of createdPaths.reverse()) await rm(target, { force: true }).catch(() => undefined);
  };
  try {
    for (const descriptor of descriptors) {
      const staged = await writeArtifactDescriptorFile(descriptor);
      if (staged.created && staged.path) createdPaths.push(staged.path);
    }
    return rollback;
  } catch (error) {
    await rollback();
    throw error;
  }
}

function nodeCommitTransactionRelativePath(runId: string, nodeRunId: string) {
  const prefix = safeId(nodeRunId).slice(0, 48) || "node";
  const suffix = createHash("sha256").update(nodeRunId).digest("hex").slice(0, 16);
  return `runs/${runId}/transactions/${prefix}_${suffix}.json`;
}

function nodeDispatchIntentRelativePath(runId: string, nodeRunId: string) {
  const prefix = safeId(nodeRunId).slice(0, 48) || "node";
  const suffix = createHash("sha256").update(nodeRunId).digest("hex").slice(0, 16);
  return `runs/${runId}/dispatches/${prefix}_${suffix}.json`;
}

function runMutationLockPath(runId: string) {
  return path.join(workspaceDir, "runs", runId, "locks", `${safeId(runId)}.mutation.lock`);
}

type MutationLockOwner = {
  instance_id: string;
  owner_token: string;
  pid: number;
  created_at: string;
};

function isMutationLockOwner(value: unknown): value is MutationLockOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const owner = value as Partial<MutationLockOwner>;
  return typeof owner.instance_id === "string"
    && owner.instance_id.length > 0
    && typeof owner.owner_token === "string"
    && owner.owner_token.length > 0
    && Number.isSafeInteger(owner.pid)
    && Number(owner.pid) > 0
    && typeof owner.created_at === "string"
    && Number.isFinite(Date.parse(owner.created_at));
}

function isProcessAlive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    if (code === "ESRCH" || code === "EINVAL") return false;
    throw error;
  }
}

async function resolveCanonicalLockTarget(lockDir: string, containerDir: string, errorMessage: string) {
  const containerEntry = await lstat(containerDir);
  if (containerEntry.isSymbolicLink() || !containerEntry.isDirectory()) {
    throw new Error(`${errorMessage}: ${containerDir}`);
  }
  const canonicalContainer = await realpath(containerDir);
  const parent = path.dirname(lockDir);
  await mkdir(parent, { recursive: true });
  const parentEntry = await lstat(parent);
  if (parentEntry.isSymbolicLink() || !parentEntry.isDirectory()) {
    throw new Error(`${errorMessage}: ${parent}`);
  }
  const canonicalParent = await realpath(parent);
  if (path.dirname(canonicalParent) !== canonicalContainer) {
    throw new Error(`${errorMessage}: ${parent}`);
  }
  return path.join(canonicalParent, path.basename(lockDir));
}

async function publishOwnedLockDirectory(lockDir: string, owner: MutationLockOwner) {
  try {
    await mkdir(lockDir, { recursive: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    await writeFile(
      path.join(lockDir, "owner.json"),
      `${JSON.stringify(owner)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 }
    );
    return true;
  } catch (error) {
    await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function readVerifiableLockOwner(lockDir: string) {
  const owner = await readJsonFileOptional<unknown>(path.join(lockDir, "owner.json"));
  if (!isMutationLockOwner(owner)) {
    throw new Error(`Refusing to recover mutation lock without verifiable owner metadata: ${lockDir}`);
  }
  return owner;
}

async function assertCanonicalLockDirectory(lockDir: string, canonicalParent: string, symlinkMessage: string) {
  const entry = await lstat(lockDir);
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`${symlinkMessage}: ${lockDir}`);
  const canonicalLockDir = await realpath(lockDir);
  if (path.dirname(canonicalLockDir) !== canonicalParent) throw new Error(`${symlinkMessage}: ${lockDir}`);
  return canonicalLockDir;
}

async function recoverStaleMutationLocksAtStartup() {
  const runsDir = path.join(workspaceDir, "runs");
  const canonicalRunsDir = await realpath(runsDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!canonicalRunsDir) return;
  let runEntries;
  try {
    runEntries = await readdir(runsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  for (const runEntry of runEntries) {
    if (!runEntry.isDirectory()) continue;
    const runDir = path.join(runsDir, runEntry.name);
    const canonicalRunDir = await realpath(runDir);
    if (path.dirname(canonicalRunDir) !== canonicalRunsDir) {
      throw new Error(`Refusing non-canonical Run directory during mutation lock recovery: ${runDir}`);
    }
    const locksDir = path.join(runDir, "locks");
    let locksEntry;
    try {
      locksEntry = await lstat(locksDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (locksEntry.isSymbolicLink() || !locksEntry.isDirectory()) {
      throw new Error(`Refusing symlinked mutation locks directory: ${locksDir}`);
    }
    const canonicalLocksDir = await realpath(locksDir);
    if (path.dirname(canonicalLocksDir) !== canonicalRunDir) {
      throw new Error(`Refusing symlinked mutation locks directory: ${locksDir}`);
    }
    let lockEntries;
    try {
      lockEntries = await readdir(locksDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }

    for (const lockEntry of lockEntries) {
      const expectedName = `${safeId(runEntry.name)}.mutation.lock`;
      if (lockEntry.name !== expectedName) continue;
      const lockDir = path.join(locksDir, lockEntry.name);
      const canonicalLockDir = await assertCanonicalLockDirectory(
        lockDir,
        canonicalLocksDir,
        "Refusing non-canonical mutation lock directory"
      );
      const owner = await readVerifiableLockOwner(canonicalLockDir);
      if (isProcessAlive(owner.pid)) {
        throw new Error(`Workspace is already locked by active Sidecar process ${owner.pid}: ${lockDir}`);
      }
      await rm(canonicalLockDir, { recursive: true, force: true });
    }
  }
}

async function acquireRunMutationLock(runId: string) {
  const requestedLockDir = runMutationLockPath(runId);
  const lockDir = await resolveCanonicalLockTarget(
    requestedLockDir,
    path.join(workspaceDir, "runs", runId),
    "Refusing non-canonical Run mutation lock parent"
  );
  const ownerToken = randomUUID();
  const owner: MutationLockOwner = {
    instance_id: serverInstanceId,
    owner_token: ownerToken,
    pid: process.pid,
    created_at: new Date().toISOString()
  };
  if (!(await publishOwnedLockDirectory(lockDir, owner))) return undefined;
  return {
    path: lockDir,
    release: async () => {
      const currentOwner = await readJsonFileOptional<unknown>(path.join(lockDir, "owner.json"));
      if (isMutationLockOwner(currentOwner) && currentOwner.instance_id === serverInstanceId && currentOwner.owner_token === ownerToken) {
        await rm(lockDir, { recursive: true, force: true });
      }
    }
  };
}

function workspaceInstanceLockPath() {
  return path.join(workspaceDir, "locks", "sidecar.instance.lock");
}

async function acquireWorkspaceInstanceLock() {
  const lockDir = await resolveCanonicalLockTarget(
    workspaceInstanceLockPath(),
    workspaceDir,
    "Refusing non-canonical Sidecar instance lock parent"
  );
  const ownerToken = randomUUID();
  const owner: MutationLockOwner = {
    instance_id: serverInstanceId,
    owner_token: ownerToken,
    pid: process.pid,
    created_at: new Date().toISOString()
  };
  if (!(await publishOwnedLockDirectory(lockDir, owner))) {
    const parent = await realpath(path.dirname(lockDir));
    const canonicalLockDir = await assertCanonicalLockDirectory(
      lockDir,
      parent,
      "Refusing non-canonical Sidecar instance lock"
    );
    const existingOwner = await readVerifiableLockOwner(canonicalLockDir);
    if (isProcessAlive(existingOwner.pid)) {
      throw new Error(`Workspace is already owned by active Sidecar process ${existingOwner.pid}: ${lockDir}`);
    }
    throw new Error(
      `Remove the stale Sidecar instance lock only after confirming no process uses this workspace: ${lockDir}`
    );
  }
  return {
    path: lockDir,
    release: async () => {
      const currentOwner = await readJsonFileOptional<unknown>(path.join(lockDir, "owner.json"));
      if (isMutationLockOwner(currentOwner) && currentOwner.instance_id === serverInstanceId && currentOwner.owner_token === ownerToken) {
        await rm(lockDir, { recursive: true, force: true });
      }
    }
  };
}

async function readJsonFileOptional<T>(target: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(target, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function applyNodeCommitTransaction(runId: string, transaction: NodeCommitTransaction) {
  const [runSpec, currentNodes, currentAttempts, currentArtifacts, currentGates] = await Promise.all([
    readJson<RunSpec>(`runs/${runId}/run_spec.json`),
    readJson<NodeRun[]>(`runs/${runId}/nodes.json`),
    readJson<NodeAttempt[]>(`runs/${runId}/attempts.json`),
    readJson<ArtifactManifest[]>(`runs/${runId}/artifacts.json`),
    readJson<GateInstance[]>(`runs/${runId}/gates.json`)
  ]);
  const upsertMissing = <T>(current: T[], additions: T[], identity: (value: T) => string) => {
    const existing = new Set(current.map(identity));
    return [...current, ...additions.filter((value) => !existing.has(identity(value)))];
  };
  const nodesById = new Map(currentNodes.map((node) => [node.node_run_id, node]));
  for (const update of transaction.node_updates) {
    const current = nodesById.get(update.node_run_id);
    if (!current || Date.parse(current.updated_at) <= Date.parse(update.updated_at)) nodesById.set(update.node_run_id, update);
  }
  if (["created", "queued", "running"].includes(runSpec.status)) {
    runSpec.status = "running";
    await writeJsonAtomically(`runs/${runId}/run_spec.json`, runSpec);
  }
  await writeJsonAtomically(
    `runs/${runId}/attempts.json`,
    upsertMissing(currentAttempts, [transaction.attempt], (attempt) => attempt.attempt_id)
  );
  await writeJsonAtomically(
    `runs/${runId}/artifacts.json`,
    upsertMissing(currentArtifacts, transaction.artifacts, (artifact) => artifact.artifact_id)
  );
  await writeJsonAtomically(
    `runs/${runId}/gates.json`,
    upsertMissing(currentGates, transaction.gates, (gate) => gate.gate_instance_id)
  );
  const existingEventIds = new Set((await readEvents(runId)).map((event) => String(event.event_id ?? "")));
  for (const event of transaction.events) {
    if (!existingEventIds.has(event.event_id)) await appendEvent(runId, event);
  }
  await writeJsonAtomically(`runs/${runId}/nodes.json`, Array.from(nodesById.values()));
  if (transaction.dispatch_intent_relative_path) {
    await rm(path.join(workspaceDir, transaction.dispatch_intent_relative_path), { force: true });
  }
  await rm(path.join(workspaceDir, nodeCommitTransactionRelativePath(runId, transaction.node_run_id)), { force: true });
}

async function recoverPendingNodeCommitTransactions(runId: string) {
  const lock = await acquireRunMutationLock(runId);
  if (!lock) return;
  try {
    const transactionDir = path.join(workspaceDir, "runs", runId, "transactions");
    const names = await readdir(transactionDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const name of names.filter((value) => value.endsWith(".json")).sort()) {
      const transaction = JSON.parse(await readFile(path.join(transactionDir, name), "utf8")) as NodeCommitTransaction;
      if (nodeCommitTransactionRelativePath(runId, transaction.node_run_id).endsWith(`/${name}`)) {
        await applyNodeCommitTransaction(runId, transaction);
      }
    }
  } finally {
    await lock.release();
  }
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

function boundedIdentitySegment(value: string, maxLength = 32) {
  const normalized = safeId(value).slice(0, maxLength);
  return normalized || "id";
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
  errorCode?: string;
  recoverable?: boolean;
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
      code: input.errorCode ?? "no_executable_adapter",
      message: input.message,
      recoverable: input.recoverable ?? true
    },
    received_at: input.receivedAt ?? new Date().toISOString()
  };
}

function blockedCodexHealthError(health: CodexCliHealth | undefined) {
  if (!health || health.status === "healthy") return undefined;
  const reasons = health.reasons.map((reason) => reason.toLowerCase());
  if (reasons.some((reason) => reason.includes("credential"))) {
    return { code: "credential_missing", recoverable: false };
  }
  if (reasons.some((reason) => reason.includes("permission") || reason.includes("access_denied"))) {
    return { code: "permission_denied", recoverable: false };
  }
  if (reasons.some((reason) => reason.includes("auth") || reason.includes("login"))) {
    return { code: "authentication_failed", recoverable: false };
  }
  return undefined;
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

function missingModelApiCredential(input: {
  manifests: AdapterManifest[];
  node: WorkflowSpec["nodes"][number];
  provider: string;
  availableCredentials: string[];
}) {
  const availableCredentials = new Set(input.availableCredentials);
  const candidate = input.manifests.find((manifest) =>
    manifest.kind === "model-api"
    && manifest.status !== "blocked"
    && manifest.runtime.can_execute
    && manifest.supported_providers.includes(input.provider)
    && input.node.capability_requirements.every((capability) => manifest.capabilities.includes(capability))
  );
  return candidate?.required_credentials.find((credential) =>
    credential.required
    && credential.source === "env"
    && (credential.providers === undefined || credential.providers.includes(input.provider))
    && !availableCredentials.has(credential.key)
  )?.key;
}

async function executeSidecarAdapter(input: {
  invocation: ReturnType<typeof createAdapterInvocation>;
  workflow: WorkflowSpec;
  nodeRun: NodeRun;
  adapter: AdapterRegistryEntry;
  receivedAt?: string;
}): Promise<AdapterResult> {
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
  if (input.adapter.kind === "model-api") {
    const catalogEntries = (await readProviderCatalogEntries())
      .filter((candidate) => candidate.profile.provider === input.invocation.provider);
    const manifestProfiles = (input.adapter.provider_profiles ?? [])
      .filter((candidate) => candidate.provider === input.invocation.provider);
    const requestedProfileId = input.invocation.provider_profile_id;
    const catalogEntry = requestedProfileId
      ? catalogEntries.find((candidate) => candidate.profile.id === requestedProfileId)
      : catalogEntries.length === 1 ? catalogEntries[0] : undefined;
    const manifestProfile = !requestedProfileId && catalogEntries.length === 0 && manifestProfiles.length === 1
      ? manifestProfiles[0]
      : undefined;
    const profile = catalogEntry?.profile ?? manifestProfile;
    if (!requestedProfileId && (catalogEntries.length > 1 || (catalogEntries.length === 0 && manifestProfiles.length > 1))) {
      return buildAdapterUnavailableResult({
        invocation: input.invocation,
        message: `Provider ${input.invocation.provider} has multiple profiles; an explicit provider_profile_id is required.`,
        errorCode: "provider_profile_ambiguous",
        recoverable: false,
        receivedAt
      });
    }
    if (!profile) {
      return buildAdapterUnavailableResult({
        invocation: input.invocation,
        message: `No ProviderProfile is configured for provider ${input.invocation.provider}.`,
        errorCode: "provider_profile_missing",
        recoverable: false,
        receivedAt
      });
    }
    if (!authorizeProviderCredential(input.adapter, profile).authorized) {
      return buildAdapterUnavailableResult({
        invocation: input.invocation,
        message: "Provider credential_ref is not authorized for this Model API Adapter.",
        errorCode: "credential_not_authorized",
        recoverable: false,
        receivedAt
      });
    }
    const driver = providerDriverRegistry.resolve({
      driver_id: catalogEntry?.driver_id,
      provider: profile.provider
    });
    if (!driver) {
      return buildAdapterUnavailableResult({
        invocation: input.invocation,
        message: `No registered ProviderDriver is available for provider ${profile.provider}.`,
        errorCode: "provider_driver_unregistered",
        recoverable: false,
        receivedAt
      });
    }
    if (profile.verification_status !== "healthy") {
      return buildAdapterUnavailableResult({
        invocation: input.invocation,
        message: `ProviderProfile ${profile.id} is not healthy and cannot execute.`,
        errorCode: "provider_not_healthy",
        recoverable: false,
        receivedAt
      });
    }
    try {
      await modelApiOperationReceiptRoot();
    } catch {
      return buildAdapterUnavailableResult({
        invocation: input.invocation,
        message: "Model API operation receipt storage is unavailable.",
        errorCode: "operation_receipt_unavailable",
        recoverable: false,
        receivedAt
      });
    }
    const credential = process.env[profile.credential_ref];
    if (!credential) {
      return buildAdapterUnavailableResult({
        invocation: input.invocation,
        message: `Credential reference ${profile.credential_ref} is not configured.`,
        errorCode: "credential_missing",
        recoverable: false,
        receivedAt
      });
    }
    const controller = new AbortController();
    modelApiOperations.set(input.invocation.operation_id, {
      operation_id: input.invocation.operation_id,
      attempt_id: input.invocation.attempt_id,
      run_id: input.invocation.run_id,
      node_run_id: input.invocation.node_run_id,
      adapter_id: input.invocation.adapter_id,
      provider: input.invocation.provider,
      provider_profile_id: profile.id,
      started_at: new Date().toISOString(),
      cancel_requested: false,
      controller
    });
    let result: AdapterResult | undefined;
    try {
      result = await new ModelApiAdapter({ driver }).execute({
        invocation: input.invocation,
        profile,
        credential,
        signal: controller.signal
      });
      return result;
    } finally {
      const tombstone: ModelApiOperationReceipt = {
        operation_id: input.invocation.operation_id,
        attempt_id: input.invocation.attempt_id,
        run_id: input.invocation.run_id,
        node_run_id: input.invocation.node_run_id,
        adapter_id: input.invocation.adapter_id,
        provider: input.invocation.provider,
        provider_profile_id: profile.id,
        status: result?.status ?? "unknown",
        completed_at: new Date().toISOString()
      };
      modelApiOperations.delete(input.invocation.operation_id);
      modelApiOperationTombstones.delete(tombstone.operation_id);
      modelApiOperationTombstones.set(tombstone.operation_id, tombstone);
      while (modelApiOperationTombstones.size > maxModelApiOperationTombstones) {
        const oldestOperationId = modelApiOperationTombstones.keys().next().value;
        if (oldestOperationId === undefined) break;
        modelApiOperationTombstones.delete(oldestOperationId);
      }
      await writeModelApiOperationReceipt(tombstone);
    }
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

function codexRealAdapterEntry(): AdapterRegistryEntry {
  return {
    ...codexCliRealAdapterManifest,
    runtime: { ...codexCliRealAdapterManifest.runtime, can_execute: true },
    credential_status: codexCliRealAdapterManifest.required_credentials.map((credential) => ({ ...credential, configured: true })),
    executable: true,
    unavailable_reasons: []
  };
}

function realCodexEnabled(runSpec: RunSpec) {
  return process.env.MIRACLE_ENABLE_REAL_CODEX === "1" && runSpec.resolved_components.includes("codex-cli-real");
}

function outputReviewStatus(workflow: WorkflowSpec, artifactSpecRef?: string) {
  const spec = workflow.artifacts.find((artifact) => artifact.id === artifactSpecRef);
  return spec?.review_policy.mode === "manual" ? "pending_review" as const : "none" as const;
}

function outputExtension(type: string) {
  return ["markdown", "document", "report", "script", "outline"].includes(type) ? "md" : "txt";
}

function outputArtifactIdentitySuffix(runId: string, nodeId: string, outputId: string) {
  return createHash("sha256").update(JSON.stringify([runId, nodeId, outputId])).digest("hex");
}

function allocateOutputIdentitySegments(expectedOutputs: ReturnType<typeof createAdapterInvocation>["expected_outputs"]) {
  const normalized = expectedOutputs.map((output) => ({
    output_id: output.output_id,
    segment: boundedIdentitySegment(output.output_id, 48)
  }));
  const normalizedCounts = new Map<string, number>();
  for (const output of normalized) {
    const key = output.segment.toLowerCase();
    normalizedCounts.set(key, (normalizedCounts.get(key) ?? 0) + 1);
  }

  const usedNames = new Set<string>();
  const allocated = new Map<string, string>();
  for (const output of normalized) {
    if (normalizedCounts.get(output.segment.toLowerCase()) !== 1) continue;
    allocated.set(output.output_id, output.segment);
    usedNames.add(output.segment.toLowerCase());
  }
  for (const output of normalized) {
    if (allocated.has(output.output_id)) continue;
    const base = `${output.segment.slice(0, 35)}_${createHash("sha256").update(output.output_id).digest("hex").slice(0, 12)}`;
    let candidate = base;
    let disambiguator = 2;
    while (usedNames.has(candidate.toLowerCase())) {
      candidate = `${base}_${disambiguator}`;
      disambiguator += 1;
    }
    allocated.set(output.output_id, candidate);
    usedNames.add(candidate.toLowerCase());
  }
  return allocated;
}

async function executeRealCodexAdapter(input: {
  invocation: ReturnType<typeof createAdapterInvocation>;
  workflow: WorkflowSpec;
  nodeRun: NodeRun;
  operationDeadlineAt?: string;
}) {
  const launchContextPath = path.join(workspaceDir, "runs", input.invocation.run_id, "launch_context.json");
  const nodeSpec = input.workflow.nodes.find((node) => node.id === input.nodeRun.node_id);
  const invocation = {
    ...input.invocation,
    adapter_kind: "codex" as const,
    adapter_id: "codex-cli-real"
  };
  if (!nodeSpec) return { invocation, result: codexPreflightFailure(invocation, new NodeOutputContractError("unsupported_codex_output_type", `NodeSpec not found: ${input.nodeRun.node_id}`)) };

  let contract: ReturnType<typeof buildNodeOutputContract>;
  let artifactFiles: Awaited<ReturnType<typeof resolveArtifactInputFiles>>;
  try {
    contract = buildNodeOutputContract(nodeSpec);
    artifactFiles = await resolveArtifactInputFiles({
      workspaceDir,
      runId: invocation.run_id,
      resolvedInputs: invocation.resolved_inputs
    });
    assertUniqueArtifactTargetPaths(artifactFiles);
  } catch (error) {
    return { invocation, result: codexPreflightFailure(invocation, error) };
  }

  let attempt: Awaited<ReturnType<typeof codexCliAdapter.createAttemptWorkspace>> | undefined;
  try {
    const launchContextHash = `sha256:${createHash("sha256").update(await readFile(launchContextPath)).digest("hex")}`;
    const inputSnapshot = `${JSON.stringify({
      resolved_inputs: invocation.resolved_inputs,
      artifact_files: artifactFiles.map(({ source_path: _sourcePath, ...file }) => file)
    }, null, 2)}\n`;
    const inputSnapshotHash = `sha256:${createHash("sha256").update(inputSnapshot).digest("hex")}`;
    attempt = await codexCliAdapter.createAttemptWorkspace({
      attempt_id: input.invocation.attempt_id,
      input_files: [
        { source_path: launchContextPath, target_path: "launch_context.json", expected_hash: launchContextHash },
        ...artifactFiles.map((file) => ({ source_path: file.source_path, target_path: file.target_path, expected_hash: file.hash }))
      ],
      inline_input_files: [
        { target_path: "resolved-inputs.json", content: inputSnapshot, expected_hash: inputSnapshotHash }
      ],
      allowed_input_roots: [workspaceDir],
      output_schema: contract.schema
    });
  } catch (error) {
    if (attempt) await codexCliAdapter.cleanupAttemptWorkspace(attempt).catch(() => undefined);
    return { invocation, result: codexPreflightFailure(invocation, error) };
  }
  const launchedInvocation = {
    ...invocation,
    runtime_control: { ...input.invocation.runtime_control, attempt_workspace: attempt.root_dir },
    prompt_path: path.join(attempt.input_dir, "launch_context.json"),
    output_schema_path: path.join(attempt.meta_dir, "output.schema.json")
  };
  const prompt = [
    `你正在执行 Miracle 工作流节点 ${input.nodeRun.node_id}（${nodeSpec?.name ?? input.nodeRun.node_id}）。`,
    "读取 ../input/launch_context.json 中的公开任务输入和 ../input/resolved-inputs.json 中的输入快照。",
    "上游 Artifact 仅可从 ../input/artifacts/ 读取，并且只能使用 resolved-inputs.json 中列出的文件。",
    "最终只返回符合 output schema 的 JSON。",
    "不要输出隐藏推理、凭证、环境变量或工作区外的内容。"
  ].join("\n");
  const processResult = await startCodexOperation({
    adapter: codexCliAdapter,
    invocation: launchedInvocation,
    attempt,
    prompt,
    operation_deadline_at: input.operationDeadlineAt
  });
  if (processResult.status !== "succeeded") return { invocation: launchedInvocation, result: processResult };

  try {
    const finalPath = await codexCliAdapter.validateOutputFile(attempt, "final.json");
    const finalStat = await stat(finalPath);
    if (finalStat.size < 1 || finalStat.size > contract.max_encoded_bytes) throw new Error("Codex final output size is outside the output contract range.");
    const finalBuffer = await readFile(finalPath);
    const finalText = new TextDecoder("utf-8", { fatal: true }).decode(finalBuffer);
    const finalValue = JSON.parse(finalText) as unknown;
    const outputs = contract.parse(finalValue);
    const outputSegments = allocateOutputIdentitySegments(launchedInvocation.expected_outputs);
    const plannedOutputs = outputs.map((output) => {
      const expectedOutput = launchedInvocation.expected_outputs.find((item) => item.output_id === output.output_id);
      if (!expectedOutput || expectedOutput.artifact_type !== output.artifact_type) throw new Error(`NodeSpec output ${output.output_id} does not match the Codex output contract.`);
      const outputSegment = outputSegments.get(expectedOutput.output_id);
      if (!outputSegment) throw new Error(`NodeSpec output ${output.output_id} has no allocated filesystem identity.`);
      const identitySuffix = outputArtifactIdentitySuffix(
        launchedInvocation.run_id,
        launchedInvocation.node_id,
        expectedOutput.output_id
      );
      const artifactId = `art_${boundedIdentitySegment(launchedInvocation.run_id)}_${boundedIdentitySegment(launchedInvocation.node_id)}_${outputSegment}_${identitySuffix}_v1`;
      const artifactFileName = `${outputSegment}.${outputExtension(output.artifact_type)}`;
      return {
        output,
        expectedOutput,
        artifactId,
        artifactFileName,
        artifactPath: `artifacts/${artifactId}.${outputExtension(output.artifact_type)}`
      };
    });
    const artifactIds = plannedOutputs.map((output) => output.artifactId.toLowerCase());
    const artifactPaths = plannedOutputs.map((output) => output.artifactPath.toLowerCase());
    if (new Set(artifactIds).size !== artifactIds.length || new Set(artifactPaths).size !== artifactPaths.length) {
      throw new Error("Codex output allocation produced duplicate Artifact IDs or paths.");
    }

    const artifactDescriptors: AdapterArtifactDescriptor[] = [];
    for (const planned of plannedOutputs) {
      const { output, expectedOutput, artifactId, artifactFileName, artifactPath } = planned;
      const validatedOutputPath = await codexCliAdapter.createValidatedOutputFile(attempt, artifactFileName, output.content);
      const content = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(validatedOutputPath));
      artifactDescriptors.push({
        artifact_id: artifactId,
        output_id: expectedOutput.output_id,
        artifact_spec_ref: expectedOutput.artifact_spec_ref,
        type: output.artifact_type,
        path: artifactPath,
        hash: `sha256:${createHash("sha256").update(content).digest("hex")}`,
        status: "created",
        review_status: outputReviewStatus(input.workflow, expectedOutput.artifact_spec_ref),
        content
      });
    }
    return {
      invocation: launchedInvocation,
      result: {
        ...processResult,
        artifact_descriptors: artifactDescriptors
      }
    };
  } catch (error) {
    return {
      invocation: launchedInvocation,
      result: {
        ...processResult,
        status: "aborted" as const,
        artifact_descriptors: [],
        error: {
          code: "invalid_codex_artifact_output",
          message: error instanceof Error ? error.message : "Codex output validation failed.",
          recoverable: true
        }
      }
    };
  } finally {
    await codexCliAdapter.cleanupAttemptWorkspace(attempt).catch(() => undefined);
  }
}

function retryPolicyForNode(node: NodeSpec): RetryPolicy {
  return resolveNodeRetryPolicy(node);
}

function retryScheduledEvent(runId: string, record: RetryScheduleRecord, createdAt: string) {
  return {
    event_id: `evt_${safeId(record.operation_id)}_retry_${record.attempt_number}_scheduled`,
    run_id: runId,
    type: "retry_scheduled",
    subject: { type: "NodeRun", id: record.node_run_id },
    message: `Retry attempt ${record.attempt_number} scheduled; reason_code=${record.reason_code}`,
    created_at: createdAt
  };
}

async function ensureRetryScheduledEvent(runId: string, record: RetryScheduleRecord, createdAt: string) {
  const event = retryScheduledEvent(runId, record, createdAt);
  return await appendEventIfMissing(runId, event) ? [event.event_id] : [];
}

function retryAttentionItem(input: {
  runId: string;
  nodeRun: NodeRun;
  attempt: NodeAttempt;
  error: { code: string; message: string; recoverable: boolean };
  decision: RetryDecision;
}): AttentionItem {
  const rootCauseKey = `run:${input.runId}:node:${input.nodeRun.node_run_id}:retry:${input.error.code}`;
  const budgetAction = input.decision.reason_code.endsWith("_budget_exhausted") ? ["increase_retry_budget"] : [];
  const credentialActions = ["credential_missing", "authentication_failed", "permission_denied"].includes(input.error.code)
    ? ["configure_credentials", "repair_permissions"]
    : [];
  return {
    attention_id: `att_${safeId(rootCauseKey)}`,
    root_cause_key: rootCauseKey,
    title: input.decision.action === "require_attention" ? "Retry 预算已耗尽" : "Adapter 错误不可自动重试",
    severity: "P0",
    status: "open",
    related_objects: [
      { type: "NodeRun", id: input.nodeRun.node_run_id, label: input.nodeRun.node_id },
      { type: "Operation", id: input.attempt.operation_id },
      { type: "NodeAttempt", id: input.attempt.attempt_id }
    ],
    impact: {
      blocked_nodes: [input.nodeRun.node_run_id],
      waiting_agents: input.nodeRun.agent_id ? [input.nodeRun.agent_id] : [],
      unaffected_paths: []
    },
    safe_actions: [
      "inspect_node_attempt",
      ...credentialActions,
      "fix_root_cause",
      ...budgetAction,
      "retry_manually"
    ]
  };
}

async function upsertRetryAttention(input: {
  runId: string;
  nodeRun: NodeRun;
  attempt: NodeAttempt;
  error: { code: string; message: string; recoverable: boolean };
  decision: RetryDecision;
  createdAt: string;
}) {
  const current = (await readJsonOptional<AttentionItem[]>(`runs/${input.runId}/attention.json`)) ?? [];
  const item = retryAttentionItem(input);
  const existingIndex = current.findIndex((candidate) => candidate.root_cause_key === item.root_cause_key);
  const existing = existingIndex >= 0 ? current[existingIndex] : undefined;
  const merged = existing ? {
    ...existing,
    title: item.title,
    severity: item.severity,
    status: "open" as const,
    related_objects: Array.from(
      new Map(
        [...existing.related_objects, ...item.related_objects]
          .map((object) => [`${object.type}:${object.id}`, object] as const)
      ).values()
    ),
    impact: {
      blocked_nodes: Array.from(new Set([...existing.impact.blocked_nodes, ...item.impact.blocked_nodes])),
      waiting_agents: Array.from(new Set([...existing.impact.waiting_agents, ...item.impact.waiting_agents])),
      unaffected_paths: Array.from(new Set([...existing.impact.unaffected_paths, ...item.impact.unaffected_paths]))
    },
    safe_actions: Array.from(new Set([...existing.safe_actions, ...item.safe_actions]))
  } : item;
  const next = [...current];
  if (existingIndex >= 0) next[existingIndex] = merged;
  else next.push(merged);
  await writeJsonAtomically(`runs/${input.runId}/attention.json`, next);
  const event = {
    event_id: existing
      ? `evt_${item.attention_id}_${safeId(input.attempt.attempt_id)}_reopened`
      : `evt_${item.attention_id}_created`,
    run_id: input.runId,
    type: existing ? "attention_item_reopened" : "attention_item_created",
    subject: { type: "AttentionItem", id: item.attention_id },
    message: `AttentionItem ${item.root_cause_key} ${existing ? "merged and reopened" : "opened"} by retry recovery`,
    created_at: input.createdAt
  };
  const createdEvent = await appendEventIfMissing(input.runId, event);
  return {
    attention_items: existing ? [] : [item],
    created_events: createdEvent ? [event.event_id] : []
  };
}

function isRetrySourceAttempt(attempt: NodeAttempt | undefined): attempt is NodeAttempt & {
  status: "failed" | "timed_out";
  error: NonNullable<NodeAttempt["error"]>;
} {
  return Boolean(
    attempt
    && ["failed", "timed_out"].includes(attempt.status)
    && attempt.error
    && attempt.error.recoverable
  );
}

function isBlockedSourceAttempt(nodeRun: NodeRun, attempt: NodeAttempt | undefined): attempt is NodeAttempt & {
  status: "failed" | "timed_out";
  error: NonNullable<NodeAttempt["error"]>;
} {
  return Boolean(
    nodeRun.status === "blocked"
    && attempt
    && ["failed", "timed_out"].includes(attempt.status)
    && attempt.error
  );
}

type ReplayableRetryState = Exclude<RetryStateRecord, { phase: "completed" }>;
type TerminalRetryState = ReplayableRetryState & { phase: "exhausted" | "blocked" };
const retryStateMigrationBlockedPrefix = "RetryStateMigration:";

function retryStateMigrationBlockedOperation(nodeRun: NodeRun) {
  return nodeRun.status === "blocked" && nodeRun.blocked_reason?.startsWith(retryStateMigrationBlockedPrefix)
    ? nodeRun.blocked_reason.slice(retryStateMigrationBlockedPrefix.length)
    : undefined;
}

async function reconcileRetryStateMigrationIssues(input: {
  runId: string;
  nodes: NodeRun[];
  issues: RetryStateMigrationIssue[];
  now: string;
}) {
  const issueByNode = new Map(input.issues.map((issue) => [issue.node_run_id, issue] as const));
  const activeRootCauses = new Set(
    input.issues.map((issue) =>
      `run:${input.runId}:node:${issue.node_run_id}:retry_state_migration:${issue.operation_id}`
    )
  );
  let nodesChanged = false;
  for (const nodeRun of input.nodes) {
    const issue = issueByNode.get(nodeRun.node_run_id);
    if (issue) {
      const blockedReason = `${retryStateMigrationBlockedPrefix}${issue.operation_id}`;
      if (nodeRun.status !== "blocked" || nodeRun.blocked_reason !== blockedReason) {
        nodeRun.status = "blocked";
        nodeRun.blocked_reason = blockedReason;
        nodeRun.updated_at = input.now;
        nodesChanged = true;
      }
      continue;
    }
    if (retryStateMigrationBlockedOperation(nodeRun)) {
      nodeRun.status = "failed";
      delete nodeRun.blocked_reason;
      nodeRun.updated_at = input.now;
      nodesChanged = true;
    }
  }
  if (nodesChanged) await writeJsonAtomically(`runs/${input.runId}/nodes.json`, input.nodes);

  const current = (await readJsonOptional<AttentionItem[]>(`runs/${input.runId}/attention.json`)) ?? [];
  const byRootCause = new Map(current.map((item) => [item.root_cause_key, item] as const));
  let attentionChanged = false;
  for (const issue of input.issues) {
    const nodeRun = input.nodes.find((node) => node.node_run_id === issue.node_run_id);
    const rootCauseKey = `run:${input.runId}:node:${issue.node_run_id}:retry_state_migration:${issue.operation_id}`;
    const next: AttentionItem = {
      attention_id: `att_${safeId(rootCauseKey)}`,
      root_cause_key: rootCauseKey,
      title: "RetryState 迁移需要人工处理",
      severity: "P0",
      status: "open",
      related_objects: [
        { type: "NodeRun", id: issue.node_run_id, ...(nodeRun ? { label: nodeRun.node_id } : {}) },
        { type: "Operation", id: issue.operation_id }
      ],
      impact: {
        blocked_nodes: [issue.node_run_id],
        waiting_agents: nodeRun?.agent_id ? [nodeRun.agent_id] : [],
        unaffected_paths: []
      },
      safe_actions: ["inspect_retry_state", "repair_retry_state"]
    };
    const existing = byRootCause.get(rootCauseKey);
    if (!existing || JSON.stringify(existing) !== JSON.stringify(next)) {
      byRootCause.set(rootCauseKey, next);
      attentionChanged = true;
    }
    if (!existing) {
      const event = {
        event_id: `evt_${next.attention_id}_created`,
        run_id: input.runId,
        type: "attention_item_created",
        subject: { type: "AttentionItem", id: next.attention_id },
        message: `AttentionItem ${rootCauseKey} opened because legacy RetryState facts could not be migrated`,
        created_at: input.now
      };
      await appendEventIfMissing(input.runId, event);
    }
  }
  for (const [rootCauseKey, item] of byRootCause) {
    if (!rootCauseKey.includes(":retry_state_migration:") || activeRootCauses.has(rootCauseKey) || item.status === "resolved") {
      continue;
    }
    byRootCause.set(rootCauseKey, { ...item, status: "resolved" });
    attentionChanged = true;
  }
  if (attentionChanged) {
    await writeJsonAtomically(`runs/${input.runId}/attention.json`, Array.from(byRootCause.values()));
  }
}

function retryAttemptFromState(state: ReplayableRetryState): NodeAttempt {
  return {
    attempt_id: state.attempt_id,
    node_run_id: state.node_run_id,
    operation_id: state.operation_id,
    attempt_number: state.attempt_number,
    attempt_kind: "execute",
    status: "failed",
    error: state.error,
    created_at: state.updated_at
  };
}

async function commitTerminalRetryEffects(input: {
  runId: string;
  nodeRun: NodeRun;
  state: TerminalRetryState;
  completedAt?: string;
}) {
  const createdAt = input.state.updated_at;
  await retryScheduleStore.remove(input.runId, input.state.operation_id);
  const exhaustedEvent = {
    event_id: `evt_${safeId(input.state.operation_id)}_retry_${input.state.attempt_number}_${safeId(input.state.reason_code)}_exhausted`,
    run_id: input.runId,
    type: "retry_exhausted",
    subject: { type: "NodeRun", id: input.nodeRun.node_run_id },
    message: `Retry stopped; reason_code=${input.state.reason_code}`,
    created_at: createdAt
  };
  const createdEvents = await appendEventIfMissing(input.runId, exhaustedEvent) ? [exhaustedEvent.event_id] : [];
  const attempt = retryAttemptFromState(input.state);
  const attention = await upsertRetryAttention({
    runId: input.runId,
    nodeRun: input.nodeRun,
    attempt,
    error: input.state.error,
    decision: input.state.decision,
    createdAt
  });
  await retryStateStore.upsert(input.runId, {
    ...input.state,
    effects_committed: true,
    updated_at: input.completedAt ?? new Date().toISOString()
  });
  return {
    decision: input.state.decision,
    attention_items: attention.attention_items,
    created_events: [...createdEvents, ...attention.created_events]
  };
}

async function persistRetryDecisionForAttempt(input: {
  runId: string;
  nodeRun: NodeRun;
  nodeSpec: NodeSpec;
  attempt: NodeAttempt;
  attempts: NodeAttempt[];
  now: string;
}) {
  const existingState = (await retryStateStore.list(input.runId))
    .find((state) => state.operation_id === input.attempt.operation_id);
  const existingSchedule = (await retryScheduleStore.list(input.runId))
    .find((schedule) => schedule.operation_id === input.attempt.operation_id);
  if (input.attempt.status === "succeeded") {
    if ((input.attempt.attempt_number ?? 1) > 1 || existingState || existingSchedule) {
      await retryStateStore.upsert(input.runId, {
        operation_id: input.attempt.operation_id,
        node_run_id: input.nodeRun.node_run_id,
        attempt_id: input.attempt.attempt_id,
        attempt_number: input.attempt.attempt_number ?? 1,
        phase: "completed",
        reason_code: "retry_completed",
        effects_committed: true,
        updated_at: input.now
      });
      await retryScheduleStore.remove(input.runId, input.attempt.operation_id);
    }
    return {
      decision: undefined,
      attention_items: [] as AttentionItem[],
      created_events: [] as string[]
    };
  }
  if (!isRetrySourceAttempt(input.attempt) && !isBlockedSourceAttempt(input.nodeRun, input.attempt)) {
    await retryScheduleStore.remove(input.runId, input.attempt.operation_id);
    if (existingState?.phase !== "completed") {
      await retryStateStore.remove(input.runId, input.attempt.operation_id);
    }
    return {
      decision: undefined,
      attention_items: [] as AttentionItem[],
      created_events: [] as string[]
    };
  }
  const operationAttempts = input.attempts.filter((attempt) => attempt.operation_id === input.attempt.operation_id);
  const decision = decideRetry({
    policy: retryPolicyForNode(input.nodeSpec),
    error: input.attempt.error,
    attempts: operationAttempts,
    now: input.now
  });
  if (decision.action === "schedule_retry") {
    const record: RetryScheduleRecord = {
      operation_id: decision.operation_id,
      node_run_id: input.nodeRun.node_run_id,
      attempt_number: decision.next_attempt_number!,
      reason_code: decision.reason_code,
      scheduled_for: decision.scheduled_for!,
      budget_snapshot: decision.budget_snapshot
    };
    await retryScheduleStore.upsert(input.runId, record);
    const waitingState: ReplayableRetryState = {
      operation_id: decision.operation_id,
      node_run_id: input.nodeRun.node_run_id,
      attempt_id: input.attempt.attempt_id,
      attempt_number: input.attempt.attempt_number ?? 1,
      phase: "waiting_for_retry",
      reason_code: decision.reason_code,
      decision,
      error: input.attempt.error,
      effects_committed: false,
      updated_at: input.now
    };
    await retryStateStore.upsert(input.runId, waitingState);
    const createdEvents = await ensureRetryScheduledEvent(input.runId, record, input.now);
    await retryStateStore.upsert(input.runId, {
      ...waitingState,
      effects_committed: true
    });
    return {
      decision,
      attention_items: [] as AttentionItem[],
      created_events: createdEvents
    };
  }

  const terminalState: TerminalRetryState = {
    operation_id: decision.operation_id,
    node_run_id: input.nodeRun.node_run_id,
    attempt_id: input.attempt.attempt_id,
    attempt_number: input.attempt.attempt_number ?? 1,
    phase: decision.action === "require_attention" ? "exhausted" : "blocked",
    reason_code: decision.reason_code,
    decision,
    error: input.attempt.error,
    effects_committed: false,
    updated_at: input.now
  };
  await retryStateStore.upsert(input.runId, terminalState);
  return commitTerminalRetryEffects({
    runId: input.runId,
    nodeRun: input.nodeRun,
    state: terminalState,
    completedAt: input.now
  });
}

async function reconcileRetryState(runId: string) {
  const lock = await acquireRunMutationLock(runId);
  if (!lock) {
    if (await retryStateStore.requiresMigration(runId)) throw new RetryStateReconciliationBusyError(runId);
    return;
  }
  try {
    const bundle = await readRunBundle(runId);
    const nodes = bundle.nodes as NodeRun[];
    const attempts = (await readJsonOptional<NodeAttempt[]>(`runs/${runId}/attempts.json`)) ?? [];
    const now = new Date().toISOString();
    const migration = await retryStateStore.migrateLegacy(runId, attempts);
    await reconcileRetryStateMigrationIssues({
      runId,
      nodes,
      issues: migration.issues,
      now
    });
    let retryStates = migration.records;

    for (const state of retryStates) {
      if (state.phase === "completed") {
        await retryScheduleStore.remove(runId, state.operation_id);
        continue;
      }
      const nodeRun = nodes.find((node) => node.node_run_id === state.node_run_id);
      if (!nodeRun) continue;
      if (state.phase !== "waiting_for_retry" && !state.effects_committed) {
        await commitTerminalRetryEffects({
          runId,
          nodeRun,
          state: state as TerminalRetryState,
          completedAt: now
        });
        continue;
      }
      if (state.phase === "waiting_for_retry" && !state.effects_committed) {
        const schedule = (await retryScheduleStore.list(runId))
          .find((record) => record.operation_id === state.operation_id);
        if (schedule) {
          await ensureRetryScheduledEvent(runId, schedule, state.updated_at);
          await retryStateStore.upsert(runId, {
            ...state,
            effects_committed: true,
            updated_at: now
          });
        }
      }
    }

    let activeSchedules = await retryScheduleStore.list(runId);
    retryStates = await retryStateStore.list(runId);
    for (const schedule of activeSchedules) {
      const durableState = retryStates.find((state) => state.operation_id === schedule.operation_id);
      if (durableState?.phase === "completed") {
        await retryScheduleStore.remove(runId, schedule.operation_id);
        continue;
      }
      if (durableState && durableState.phase !== "waiting_for_retry") {
        if (!durableState.effects_committed) {
          const nodeRun = nodes.find((node) => node.node_run_id === durableState.node_run_id);
          if (nodeRun) {
            await commitTerminalRetryEffects({
              runId,
              nodeRun,
              state: durableState as TerminalRetryState,
              completedAt: now
            });
          }
        } else {
          await retryScheduleStore.remove(runId, schedule.operation_id);
        }
        continue;
      }
      await ensureRetryScheduledEvent(runId, schedule, now);
      const nodeRun = nodes.find((node) => node.node_run_id === schedule.node_run_id);
      const nodeSpec = nodeRun ? bundle.workflow.nodes.find((node) => node.id === nodeRun.node_id) : undefined;
      if (!nodeRun || !nodeSpec) continue;
      const scheduledAttempt = attempts.find((attempt) =>
        attempt.operation_id === schedule.operation_id && (attempt.attempt_number ?? 1) === schedule.attempt_number
      );
      if (scheduledAttempt) {
        await persistRetryDecisionForAttempt({
          runId,
          nodeRun,
          nodeSpec,
          attempt: scheduledAttempt,
          attempts,
          now
        });
        continue;
      }
      if (Date.parse(schedule.scheduled_for) <= Date.parse(now)) {
        const operationAttempts = attempts.filter((attempt) => attempt.operation_id === schedule.operation_id);
        const latest = operationAttempts.sort((left, right) => (right.attempt_number ?? 1) - (left.attempt_number ?? 1))[0];
        if (isRetrySourceAttempt(latest)) {
          const currentDecision = decideRetry({
            policy: retryPolicyForNode(nodeSpec),
            error: latest.error,
            attempts: operationAttempts,
            now,
            mode: "consume"
          });
          if (currentDecision.action !== "schedule_retry") {
            await persistRetryDecisionForAttempt({ runId, nodeRun, nodeSpec, attempt: latest, attempts, now });
          }
        }
      }
    }

    activeSchedules = await retryScheduleStore.list(runId);
    const schedulesAfterRecovery = activeSchedules;
    const statesAfterRecovery = new Map(
      (await retryStateStore.list(runId)).map((record) => [record.operation_id, record] as const)
    );
    for (const nodeRun of nodes.filter((node) => ["failed", "blocked"].includes(node.status))) {
      if (retryStateMigrationBlockedOperation(nodeRun)) continue;
      if (schedulesAfterRecovery.some((schedule) => schedule.node_run_id === nodeRun.node_run_id)) continue;
      const intent = await readJsonOptional<unknown>(nodeDispatchIntentRelativePath(runId, nodeRun.node_run_id));
      if (isNodeDispatchIntent(intent) && ["dispatched_unknown", "invalid_result"].includes(intent.state)) continue;
      const nodeSpec = bundle.workflow.nodes.find((node) => node.id === nodeRun.node_id);
      const latest = attempts
        .filter((attempt) => attempt.node_run_id === nodeRun.node_run_id)
        .sort((left, right) => Date.parse(right.created_at ?? "") - Date.parse(left.created_at ?? ""))[0];
      if (!nodeSpec || !isRetrySourceAttempt(latest)) continue;
      const durableState = statesAfterRecovery.get(latest.operation_id);
      if (durableState?.phase === "completed" || (durableState && durableState.phase !== "waiting_for_retry")) continue;
      await persistRetryDecisionForAttempt({
        runId,
        nodeRun,
        nodeSpec,
        attempt: latest,
        attempts,
        now
      });
    }
  } finally {
    await lock.release();
  }
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
    safe_actions: ["inspect_node_attempt", "inspect_dispatch_intent", "retry_manually"]
  };
}

async function persistSchedulerFailureAttention(runId: string, failures: SchedulerFailure[]) {
  const unhandledFailures = failures.filter((failure) => failure.retry_decision === undefined);
  if (unhandledFailures.length === 0) return { attention_items: [] as AttentionItem[], created_events: [] as string[] };
  const bundle = await readRunBundle(runId);
  const nodes = bundle.nodes as NodeRun[];
  const currentAttention = Array.isArray(bundle.attention) ? (bundle.attention as AttentionItem[]) : [];
  const byRootCause = new Map(currentAttention.map((item) => [item.root_cause_key, item]));
  const createdAt = new Date().toISOString();
  const attentionByRootCause = new Map<string, AttentionItem>();
  for (const failure of unhandledFailures) {
    const item = buildSchedulerFailureAttentionItem({ failure, node: nodes.find((node) => node.node_run_id === failure.node_run_id) });
    if (!attentionByRootCause.has(item.root_cause_key)) attentionByRootCause.set(item.root_cause_key, item);
  }
  const attentionItems = Array.from(attentionByRootCause.values());
  const newlyCreatedItems = attentionItems.filter((item) => !byRootCause.has(item.root_cause_key));
  for (const item of newlyCreatedItems) byRootCause.set(item.root_cause_key, item);
  await writeJson(`runs/${runId}/attention.json`, Array.from(byRootCause.values()));

  const events = attentionItems.map((item) => ({
    event_id: `evt_${item.attention_id}_created`,
    run_id: runId,
    type: "attention_item_created",
    subject: { type: "AttentionItem", id: item.attention_id },
    message: `AttentionItem ${item.root_cause_key} opened by scheduler`,
    created_at: createdAt
  }));
  const createdEvents: string[] = [];
  for (const event of events) {
    if (await appendEventIfMissing(runId, event)) createdEvents.push(event.event_id);
  }
  return { attention_items: newlyCreatedItems, created_events: createdEvents };
}

async function persistRetryForCommittedNode(input: {
  runId: string;
  nodeRun: NodeRun;
  attempt: NodeAttempt;
}) {
  const bundle = await readRunBundle(input.runId);
  const nodeSpec = bundle.workflow.nodes.find((node) => node.id === input.nodeRun.node_id);
  if (!nodeSpec) throw new Error(`NodeSpec not found: ${input.nodeRun.node_id}`);
  const attempts = (await readJsonOptional<NodeAttempt[]>(`runs/${input.runId}/attempts.json`)) ?? [];
  return persistRetryDecisionForAttempt({
    runId: input.runId,
    nodeRun: input.nodeRun,
    nodeSpec,
    attempt: input.attempt,
    attempts,
    now: input.attempt.created_at ?? new Date().toISOString()
  });
}

function retryDeadlineAt(policy: RetryPolicy, attempts: NodeAttempt[]) {
  const firstAttempt = [...attempts]
    .sort((left, right) => (left.attempt_number ?? 1) - (right.attempt_number ?? 1))[0];
  const startedAt = firstAttempt?.started_at ?? firstAttempt?.dispatched_at ?? firstAttempt?.created_at;
  if (!startedAt || !Number.isFinite(Date.parse(startedAt))) return undefined;
  return new Date(Date.parse(startedAt) + policy.total_time_budget_ms).toISOString();
}

async function authorizeRetryConsumption(input: {
  runId: string;
  nodeRun: NodeRun;
  nodeSpec: NodeSpec;
  schedule: RetryScheduleRecord;
  attempts: NodeAttempt[];
  now: string;
}) {
  const operationAttempts = input.attempts
    .filter((attempt) => attempt.operation_id === input.schedule.operation_id)
    .sort((left, right) => (left.attempt_number ?? 1) - (right.attempt_number ?? 1));
  const latest = operationAttempts.at(-1);
  if (!isRetrySourceAttempt(latest)) {
    await retryScheduleStore.remove(input.runId, input.schedule.operation_id);
    await retryStateStore.remove(input.runId, input.schedule.operation_id);
    return {
      allowed: false as const,
      reason_code: "retry_source_not_failed",
      decision: undefined,
      attention_items: [] as AttentionItem[],
      created_events: [] as string[]
    };
  }
  const decision = decideRetry({
    policy: retryPolicyForNode(input.nodeSpec),
    error: latest.error,
    attempts: operationAttempts,
    now: input.now,
    mode: "consume"
  });
  if (decision.action === "schedule_retry" && decision.next_attempt_number === input.schedule.attempt_number) {
    return {
      allowed: true as const,
      reason_code: decision.reason_code,
      decision,
      attention_items: [] as AttentionItem[],
      created_events: [] as string[]
    };
  }
  const persisted = await persistRetryDecisionForAttempt({
    runId: input.runId,
    nodeRun: input.nodeRun,
    nodeSpec: input.nodeSpec,
    attempt: latest,
    attempts: operationAttempts,
    now: input.now
  });
  return {
    allowed: false as const,
    reason_code: persisted.decision?.reason_code ?? "retry_not_authorized",
    decision: persisted.decision,
    attention_items: persisted.attention_items,
    created_events: persisted.created_events
  };
}

async function executeNodeRunOnce(runId: string, nodeRunId: string): Promise<NodeExecutionResult> {
  await recoverPendingNodeCommitTransactions(runId);
  await reconcileRetryState(runId);
  await reconcileExecutionPlanState(runId);
  const lock = await acquireRunMutationLock(runId);
  if (!lock) {
    return {
      accepted: false,
      status_code: 409,
      error: { code: "operation_in_progress", message: "Run already has a node execution commit in progress." }
    };
  }

  try {
    const transactionPath = nodeCommitTransactionRelativePath(runId, nodeRunId);
    const pendingTransaction = await readJsonOptional<NodeCommitTransaction>(transactionPath);
    if (pendingTransaction) {
      await applyNodeCommitTransaction(runId, pendingTransaction);
      const retry = await persistRetryForCommittedNode({
        runId,
        nodeRun: pendingTransaction.committed.node_run,
        attempt: pendingTransaction.committed.attempt
      });
      return {
        accepted: true,
        invocation: pendingTransaction.invocation,
        adapter_result: pendingTransaction.adapter_result,
        committed: pendingTransaction.committed,
        retry_decision: retry.decision,
        retry_attention_items: retry.attention_items,
        retry_events: retry.created_events
      };
    }
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
    if (retryStateMigrationBlockedOperation(targetNodeRun)) {
      return {
        accepted: false,
        status_code: 409,
        error: {
          code: "retry_state_migration_failed",
          message: "Legacy RetryState facts could not be matched to a persisted NodeAttempt.",
          reason_code: "retry_state_migration_failed"
        }
      };
    }
    const nodeSpec = lockedBundle.workflow.nodes.find((node) => node.id === targetNodeRun.node_id);
    if (!nodeSpec) throw new Error(`NodeSpec not found: ${targetNodeRun.node_id}`);
    const dispatchIntentPath = nodeDispatchIntentRelativePath(runId, nodeRunId);
    const persistedIntentCandidate = await readJsonOptional<unknown>(dispatchIntentPath);
    const recoverableDispatchIntent = isNodeDispatchIntent(persistedIntentCandidate)
      && persistedIntentCandidate.node_run_id === nodeRunId
      ? persistedIntentCandidate
      : undefined;
    const dispatchedAt = new Date().toISOString();
    const activeRetry = (await retryScheduleStore.list(runId)).find((schedule) => schedule.node_run_id === nodeRunId);
    const durableRetryState = (await retryStateStore.list(runId)).find((state) => state.node_run_id === nodeRunId);
    let retryRemainingBudgetMs: number | undefined;
    let retryRuntimeDeadlineAt: string | undefined;
    if (!activeRetry && durableRetryState && ["exhausted", "blocked"].includes(durableRetryState.phase)) {
      const terminalRetryState = durableRetryState as ReplayableRetryState;
      return {
        accepted: false,
        status_code: 409,
        error: {
          code: durableRetryState.phase === "exhausted" ? "retry_budget_exhausted" : "retry_not_authorized",
          message: "The retry operation is durably terminal and cannot be dispatched.",
          reason_code: durableRetryState.reason_code
        },
        retry_decision: terminalRetryState.decision,
        retry_attention_items: [],
        retry_events: []
      };
    }
    if (activeRetry && Date.parse(activeRetry.scheduled_for) > Date.parse(dispatchedAt)) {
      return {
        accepted: false,
        status_code: 409,
        error: {
          code: "retry_not_due",
          message: "The active retry schedule is not due yet.",
          reason_code: "retry_not_due"
        }
      };
    }
    if (activeRetry) {
      await ensureRetryScheduledEvent(runId, activeRetry, dispatchedAt);
      const authorization = await authorizeRetryConsumption({
        runId,
        nodeRun: targetNodeRun,
        nodeSpec,
        schedule: activeRetry,
        attempts: lockedBundle.attempts as NodeAttempt[],
        now: dispatchedAt
      });
      if (!authorization.allowed) {
        return {
          accepted: false,
          status_code: 409,
          error: {
            code: authorization.decision?.action === "require_attention" ? "retry_budget_exhausted" : "retry_not_authorized",
            message: "The active retry no longer satisfies its authoritative policy budget.",
            reason_code: authorization.reason_code
          },
          retry_decision: authorization.decision,
          retry_attention_items: authorization.attention_items,
          retry_events: authorization.created_events
        };
      }
      retryRuntimeDeadlineAt = retryDeadlineAt(
        retryPolicyForNode(nodeSpec),
        (lockedBundle.attempts as NodeAttempt[]).filter((attempt) => attempt.operation_id === activeRetry.operation_id)
      );
      retryRemainingBudgetMs = retryRuntimeDeadlineAt
        ? Date.parse(retryRuntimeDeadlineAt) - Date.parse(dispatchedAt)
        : retryPolicyForNode(nodeSpec).total_time_budget_ms - authorization.decision.budget_snapshot.elapsed_ms;
    }
    const persistedAttemptNumber = recoverableDispatchIntent?.invocation.attempt_number ?? 1;
    if (!retryRuntimeDeadlineAt && recoverableDispatchIntent && persistedAttemptNumber > 1) {
      retryRuntimeDeadlineAt = retryDeadlineAt(
        retryPolicyForNode(nodeSpec),
        (lockedBundle.attempts as NodeAttempt[]).filter(
          (attempt) => attempt.operation_id === recoverableDispatchIntent.invocation.operation_id
        )
      );
    }
    const artifacts = lockedBundle.artifacts as ArtifactManifest[];
    const gates = lockedBundle.gates as GateInstance[];
    const planningNodeRuns = nodeRuns.map((node) =>
      node.node_run_id === nodeRunId && (activeRetry || recoverableDispatchIntent || executionPlanBlockedReason(node))
        ? { ...node, status: "queued" as const }
        : node
    );
    const executionPlan = calculateExecutionPlan({
      runId,
      workflowSnapshotId: runSpec.workflow_snapshot_id,
      workflow: lockedBundle.workflow,
      nodeRuns: planningNodeRuns,
      artifacts,
      gates,
      calculatedAt: dispatchedAt
    });
    const calculatedDecision = executionPlan.decisions.find((item) => item.node_run_id === targetNodeRun.node_run_id);
    const decision = calculatedDecision?.decision === "execute" && (activeRetry || recoverableDispatchIntent)
      ? {
          ...calculatedDecision,
          reason_code: activeRetry?.reason_code ?? recoverableDispatchIntent?.decision.reason_code ?? calculatedDecision.reason_code
        }
      : calculatedDecision;
    if (!decision || decision.decision !== "execute") {
      return {
        accepted: false,
        status_code: 409,
        error: {
          code: "node_not_executable",
          message: `ExecutionPlan decision is ${decision?.decision ?? "missing"}.`,
          reason_code: decision?.reason_code ?? "node_run_missing"
        }
      };
    }
    const resolvedInputs = decision.resolved_inputs;
    let fallbackContext: ProviderFallbackContext | undefined;
    if (activeRetry) {
      const routed = await buildProviderFallbackContext({
        runId,
        nodeRun: targetNodeRun,
        nodeSpec,
        runSpec,
        attempts: lockedBundle.attempts as NodeAttempt[],
        activeRetry,
        decidedAt: dispatchedAt
      });
      if (routed.confirmation_required && routed.context) {
        return {
          accepted: false,
          status_code: 409,
          error: {
            code: "fallback_confirmation_required",
            message: "Cross-kind Provider fallback requires a current operator confirmation.",
            reason_code: "cross_kind_fallback_requires_confirmation"
          }
        };
      }
      fallbackContext = routed.context;
      if (fallbackContext) {
        targetNodeRun.provider = fallbackContext.selected_provider;
        await appendEventIfMissing(runId, fallbackContext.started_event);
      }
    }
    const provider = fallbackContext?.selected_provider ?? targetNodeRun.provider ?? runSpec.resolved_provider_policy.default_provider;
    const manifests = await readAdapterManifests();
    const availableCredentials = availableCredentialKeys();
    const routeUsesRealCodex = realCodexEnabled(runSpec)
      && fallbackContext?.decision.selected_adapter_kind !== "model-api";
    const codexHealth = routeUsesRealCodex ? await codexCliAdapter.refreshHealth() : undefined;
    const useRealCodex = Boolean(
      codexHealth?.status === "healthy"
      && nodeSpec.capability_requirements.every((capability) => codexCliRealAdapterManifest.capabilities.includes(capability))
    );
    const adapter = routeUsesRealCodex
      ? (useRealCodex ? codexRealAdapterEntry() : undefined)
      : selectAdapterForNode({ manifests, node: nodeSpec, provider, availableCredentials });
    const missingProviderCredential = !adapter && !routeUsesRealCodex
      ? missingModelApiCredential({ manifests, node: nodeSpec, provider, availableCredentials })
      : undefined;
    const invocationAdapter = routeUsesRealCodex ? codexRealAdapterEntry() : adapter;
    let existingIntent = await readNodeDispatchIntent(dispatchIntentPath, {
      runId,
      nodeRunId,
      nodeId: targetNodeRun.node_id,
      runSpec,
      workflow: lockedBundle.workflow,
      nodeRun: targetNodeRun,
      nodeSpec,
      decision,
      adapter: invocationAdapter,
      providerProfileId: fallbackContext?.selected_profile_id,
      retryDeadlineAt: retryRuntimeDeadlineAt
    });
    if (existingIntent?.state === "dispatched_unknown") {
      if (activeRetry) await retryScheduleStore.remove(runId, activeRetry.operation_id);
      return {
        accepted: false,
        status_code: 409,
        error: {
          code: "node_dispatch_unknown",
          message: "NodeRun has a dispatched Adapter invocation with an unknown result; inspect the persisted dispatch intent before retrying.",
          reason_code: "dispatch_result_unknown"
        }
      };
    }
    if (existingIntent?.state === "invalid_result") {
      if (activeRetry) await retryScheduleStore.remove(runId, activeRetry.operation_id);
      return {
        accepted: false,
        status_code: 409,
        error: {
          code: "node_dispatch_invalid",
          message: "NodeRun has an invalid Adapter result recorded in its dispatch intent; inspect it before retrying.",
          reason_code: "adapter_result_invalid"
        }
      };
    }

    let invocation = existingIntent?.invocation ?? createAdapterInvocation({
      runSpec,
      workflow: lockedBundle.workflow,
      nodeRun: targetNodeRun,
      createdAt: dispatchedAt,
      adapterKind: invocationAdapter?.kind,
      adapterId: invocationAdapter?.id,
      resolvedInputs,
      operationId: activeRetry?.operation_id,
      attemptNumber: activeRetry?.attempt_number,
      providerProfileId: fallbackContext?.selected_profile_id,
      remainingTotalBudgetMs: retryRemainingBudgetMs
    });
    let dispatchIntent = existingIntent;
    if (!dispatchIntent) {
      const inputEvent = nodeInputsResolvedEvent({ runId, nodeRunId, invocation, reasonCode: decision.reason_code });
      dispatchIntent = {
        node_run_id: nodeRunId,
        invocation,
        decision: {
          reason_code: decision.reason_code,
          resolved_input_count: resolvedInputs.length,
          resolved_input_ids: resolvedInputs.map((input) => input.input_id)
        },
        event: inputEvent,
        state: "prepared",
        prepared_at: dispatchedAt,
        ...(retryRuntimeDeadlineAt ? { operation_deadline_at: retryRuntimeDeadlineAt } : {})
      };
      await writeJsonAtomically(dispatchIntentPath, dispatchIntent);
    }
    await appendEventIfMissing(runId, dispatchIntent.event);

    const previousNodeRun = structuredClone(targetNodeRun);
    dispatchIntent = { ...dispatchIntent, state: "dispatched_unknown", dispatched_at: dispatchedAt };
    await writeJsonAtomically(dispatchIntentPath, dispatchIntent);
    targetNodeRun.status = "running";
    targetNodeRun.started_at = targetNodeRun.started_at ?? dispatchedAt;
    targetNodeRun.updated_at = dispatchedAt;
    await writeJsonAtomically(`runs/${runId}/nodes.json`, nodeRuns);
    let rawResult: AdapterResult;
    if (adapter?.id === "codex-cli-real") {
      const executed = await executeRealCodexAdapter({
        invocation,
        workflow: lockedBundle.workflow,
        nodeRun: targetNodeRun,
        operationDeadlineAt: dispatchIntent.operation_deadline_at
      });
      invocation = executed.invocation;
      rawResult = executed.result;
    } else {
      rawResult = adapter
        ? await executeSidecarAdapter({ invocation, workflow: lockedBundle.workflow, nodeRun: targetNodeRun, adapter, receivedAt: new Date().toISOString() })
        : (() => {
          const blockedHealth = routeUsesRealCodex ? blockedCodexHealthError(codexHealth) : undefined;
          return buildAdapterUnavailableResult({
            invocation,
            message: missingProviderCredential
              ? `Credential reference ${missingProviderCredential} is not configured.`
              : routeUsesRealCodex && codexHealth?.status !== "healthy"
                ? `Codex CLI is not healthy: ${codexHealth?.reasons.join(", ") ?? "health unavailable"}`
                : `No executable adapter supports NodeSpec ${targetNodeRun.node_id} capabilities: ${nodeSpec?.capability_requirements.join(", ") ?? "unknown"}`,
            ...(missingProviderCredential
              ? { errorCode: "credential_missing", recoverable: false }
              : blockedHealth
                ? { errorCode: blockedHealth.code, recoverable: blockedHealth.recoverable }
                : {}),
            receivedAt: new Date().toISOString()
          });
        })();
    }
    let result: AdapterResult;
    try {
      result = parseAdapterResultForInvocation(invocation, rawResult);
    } catch (error) {
      Object.assign(targetNodeRun, previousNodeRun);
      await writeJsonAtomically(`runs/${runId}/nodes.json`, nodeRuns);
      await writeJsonAtomically(dispatchIntentPath, {
        ...dispatchIntent,
        state: "invalid_result",
        error: {
          code: "adapter_result_invalid",
          message: error instanceof Error ? error.message : "Adapter result did not match the dispatched invocation."
        }
      });
      throw error;
    }
    const attempt = createNodeAttemptFromAdapterResult(
      result,
      invocation.attempt_number ?? 1,
      { startedAt: invocation.dispatched_at, dispatchedAt: invocation.dispatched_at }
    );
    const createdArtifacts = createArtifactManifestsFromAdapterResult({
      result,
      runId,
      nodeRun: targetNodeRun,
      producer: targetNodeRun.agent_id ?? "mock-runner",
      createdAt: result.received_at
    });
    const rollbackArtifactFiles = await stageArtifactDescriptorFiles(result.artifact_descriptors);
    let factCommitStarted = false;
    try {
      const attempts = (await readJsonOptional<NodeAttempt[]>(`runs/${runId}/attempts.json`)) ?? [];
      const createdGates = buildGateInstancesForArtifacts({ workflow: lockedBundle.workflow, runId, artifacts: createdArtifacts, descriptors: result.artifact_descriptors });
      const outcome = classifyAdapterOutcome(result);
      const committedStatus: NodeRun["status"] = outcome.category === "succeeded"
        ? (createdGates.length > 0 ? "reviewing" : "done")
        : outcome.node_run_status;
      targetNodeRun.status = committedStatus;
      targetNodeRun.updated_at = result.received_at;
      targetNodeRun.output_artifacts = Array.from(new Set([...targetNodeRun.output_artifacts, ...createdArtifacts.map((artifact) => artifact.artifact_id)]));

      const nextAttempts = [...attempts, attempt];
      const nextArtifacts = [...artifacts, ...createdArtifacts];
      const nextGates = [...gates, ...createdGates];
      if (committedStatus === "done") advanceDownstreamNodes(lockedBundle.workflow, nodeRuns, nextArtifacts, targetNodeRun.node_id, result.received_at);
      runSpec.status = "running";

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
      const fallbackEvents = fallbackContext ? [{
        event_id: `evt_${safeId(fallbackContext.decision.operation_id)}_fallback_${fallbackContext.decision.target_attempt_number}_completed`,
        run_id: runId,
        type: "provider_fallback_completed",
        subject: { type: "NodeRun", id: nodeRunId },
        message: `Provider fallback completed with ${result.status}: ${fallbackContext.selected_provider}`,
        created_at: result.received_at
      }] : [];
      const events = [...runnerEvents, ...artifactEvents, ...gateEvents, ...fallbackEvents];
      const transaction: NodeCommitTransaction = {
        node_run_id: nodeRunId,
        invocation,
        adapter_result: result,
        node_updates: nodeRuns,
        attempt,
        artifacts: createdArtifacts,
        gates: createdGates,
        events,
        committed: {
          node_run: targetNodeRun,
          attempt,
          artifacts: createdArtifacts,
          gates: createdGates,
          created_events: [
            dispatchIntent.event.event_id,
            ...(fallbackContext ? [fallbackContext.started_event.event_id] : []),
            ...events.map((event) => event.event_id)
          ]
        },
        dispatch_intent_relative_path: dispatchIntentPath
      };
      await writeJsonAtomically(transactionPath, transaction);
      factCommitStarted = true;
      await applyNodeCommitTransaction(runId, transaction);
      const retry = await persistRetryForCommittedNode({ runId, nodeRun: targetNodeRun, attempt });
      return {
        accepted: true,
        invocation,
        adapter_result: result,
        committed: transaction.committed,
        retry_decision: retry.decision,
        retry_attention_items: retry.attention_items,
        retry_events: retry.created_events
      };
    } catch (error) {
      if (!factCommitStarted) await rollbackArtifactFiles();
      throw error;
    }
  } finally {
    await lock.release();
  }
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

const executionPlanBlockedPrefix = "ExecutionPlan:";

function executionPlanBlockedReason(nodeRun: NodeRun) {
  return nodeRun.status === "blocked" && nodeRun.blocked_reason?.startsWith(executionPlanBlockedPrefix)
    ? nodeRun.blocked_reason.slice(executionPlanBlockedPrefix.length)
    : undefined;
}

function nextActionsForNodeDecision(input: {
  decision: NodeExecutionDecision["decision"];
  reasonCode: string;
  retryDecision?: RetryDecision;
}) {
  if (input.decision === "execute") return ["run_scheduler_tick"];
  if (input.retryDecision?.phase === "waiting_for_retry") return ["wait_for_retry"];
  if (input.decision === "pause_for_gate") return ["review_pending_gates"];
  if (input.reasonCode === "required_gate_rejected") return ["inspect_gate", "create_rework"];
  if (input.reasonCode === "required_input_missing") {
    return ["restore_required_artifact", "rerun_upstream_node", "retry_manually"];
  }
  if (input.decision === "blocked") return ["inspect_attention", "retry_manually"];
  if (input.decision === "wait") return ["wait_for_upstream"];
  return ["refresh_run"];
}

async function calculateRetryAwareSchedulerPlan(
  runId: string,
  bundle: Awaited<ReturnType<typeof readRunBundle>>,
  maxNodes: number
) {
  const nodeRuns = bundle.nodes as NodeRun[];
  const statuses = new Map(nodeRuns.map((node) => [node.node_run_id, node.status]));
  const attempts = bundle.attempts as NodeAttempt[];
  const retryProjections = new Map(
    (await Promise.all(nodeRuns.map(async (nodeRun) => {
      const nodeSpec = bundle.workflow.nodes.find((node) => node.id === nodeRun.node_id);
      if (!nodeSpec) return [nodeRun.node_run_id, undefined] as const;
      return [
        nodeRun.node_run_id,
        await projectRetryDecision({
          runId,
          nodeRun,
          nodeSpec,
          attempts: attempts.filter((attempt) => attempt.node_run_id === nodeRun.node_run_id)
        })
      ] as const;
    })))
  );
  const planningNodeRuns = nodeRuns.map((nodeRun) => {
    const retryDecision = retryProjections.get(nodeRun.node_run_id);
    return retryDecision?.phase === "due" || executionPlanBlockedReason(nodeRun)
      ? { ...nodeRun, status: "queued" as const }
      : nodeRun;
  });
  const executionPlan = calculateExecutionPlan({
    runId,
    workflowSnapshotId: (bundle.run as unknown as RunSpec).workflow_snapshot_id,
    workflow: bundle.workflow,
    nodeRuns: planningNodeRuns,
    artifacts: bundle.artifacts as ArtifactManifest[],
    gates: bundle.gates as GateInstance[],
    calculatedAt: new Date().toISOString()
  });
  const decisions: SchedulerDecision[] = executionPlan.decisions.map((decision) => {
    const retryDecision = retryProjections.get(decision.node_run_id);
    const nodeRun = nodeRuns.find((node) => node.node_run_id === decision.node_run_id);
    const migrationBlocked = nodeRun ? retryStateMigrationBlockedOperation(nodeRun) : undefined;
    const retryOverride = migrationBlocked
      ? { decision: "blocked" as const, reason_code: "retry_state_migration_failed" }
      : retryDecision?.phase === "waiting_for_retry"
        ? { decision: "wait" as const, reason_code: "waiting_for_retry" }
        : retryDecision?.phase === "exhausted" || retryDecision?.phase === "blocked"
          ? { decision: "blocked" as const, reason_code: retryDecision.reason_code }
          : retryDecision?.phase === "due" && decision.decision === "execute"
            ? { decision: "execute" as const, reason_code: "retry_due" }
          : undefined;
    const projectedDecision = retryOverride?.decision ?? decision.decision;
    const projectedReasonCode = retryOverride?.reason_code ?? decision.reason_code;
    return {
      node_run_id: decision.node_run_id,
      node_id: decision.node_id,
      status: statuses.get(decision.node_run_id) ?? "waiting",
      decision: projectedDecision,
      reason_code: projectedReasonCode,
      ...(decision.gate_instance_id ? { gate_instance_id: decision.gate_instance_id } : {}),
      ...(retryDecision ? {
        retry_operation_id: retryDecision.operation_id,
        retry_attempt_number: retryDecision.next_attempt_number,
        retry_decision: retryDecision
      } : {})
    };
  });
  const decisionByNodeRunId = new Map(decisions.map((decision) => [decision.node_run_id, decision]));
  const unifiedDecisions = executionPlan.decisions.map((decision) => {
    const unified = decisionByNodeRunId.get(decision.node_run_id);
    return unified ? {
      ...decision,
      decision: unified.decision,
      reason_code: unified.reason_code
    } : decision;
  });
  const unifiedExecutionPlan = {
    ...executionPlan,
    decisions: unifiedDecisions,
    ready_node_run_ids: decisions.filter((decision) => decision.decision === "execute").map((decision) => decision.node_run_id),
    paused_node_run_ids: decisions.filter((decision) => decision.decision === "pause_for_gate").map((decision) => decision.node_run_id),
    blocked_node_run_ids: decisions.filter((decision) => decision.decision === "blocked").map((decision) => decision.node_run_id),
    terminal: !decisions.some((decision) => ["waiting_for_retry", "due"].includes(decision.retry_decision?.phase ?? ""))
      && unifiedDecisions.every((decision) => decision.decision === "skip")
      && (bundle.gates as GateInstance[]).every((gate) => gate.status !== "pending_review")
  };
  const executable = decisions.filter((decision) => decision.decision === "execute").slice(0, maxNodes);
  const paused = decisions.filter((decision) => decision.decision === "pause_for_gate");
  const skipped = decisions.filter((decision) => decision.decision !== "execute" && decision.decision !== "pause_for_gate");
  const openNonGateAttention = (Array.isArray(bundle.attention) ? bundle.attention as AttentionItem[] : [])
    .filter((item) => item.status === "open" && !item.root_cause_key.startsWith("gate:"));
  return { executionPlan: unifiedExecutionPlan, decisions, executable, paused, skipped, openNonGateAttention };
}

function executionPlanAttentionItem(runId: string, nodeRun: NodeRun, reasonCode: string): AttentionItem {
  const rootCauseKey = `run:${runId}:node:${nodeRun.node_run_id}:execution_plan:${reasonCode}`;
  return {
    attention_id: `att_${safeId(rootCauseKey)}`,
    root_cause_key: rootCauseKey,
    title: "Required Artifact 缺失",
    severity: "P0",
    status: "open",
    related_objects: [{ type: "NodeRun", id: nodeRun.node_run_id, label: nodeRun.node_id }],
    impact: {
      blocked_nodes: [nodeRun.node_run_id],
      waiting_agents: nodeRun.agent_id ? [nodeRun.agent_id] : [],
      unaffected_paths: []
    },
    safe_actions: ["restore_required_artifact", "rerun_upstream_node", "retry_manually"]
  };
}

async function reconcileExecutionPlanState(runId: string) {
  const lock = await acquireRunMutationLock(runId);
  if (!lock) return;
  try {
    const bundle = await readRunBundle(runId);
    const nodes = bundle.nodes as NodeRun[];
    const plan = await calculateRetryAwareSchedulerPlan(runId, bundle, Math.max(1, nodes.length));
    const attention = Array.isArray(bundle.attention) ? (bundle.attention as AttentionItem[]) : [];
    const attentionByRootCause = new Map(attention.map((item) => [item.root_cause_key, item]));
    const now = new Date().toISOString();
    let nodesChanged = false;
    let attentionChanged = false;

    for (const decision of plan.executionPlan.decisions) {
      const nodeRun = nodes.find((node) => node.node_run_id === decision.node_run_id);
      if (!nodeRun) continue;
      const ownedReason = executionPlanBlockedReason(nodeRun);
      if (decision.decision === "blocked" && decision.reason_code === "required_input_missing") {
        if (!["done", "running", "reviewing"].includes(nodeRun.status)) {
          const nextReason = `${executionPlanBlockedPrefix}${decision.reason_code}`;
          if (nodeRun.status !== "blocked" || nodeRun.blocked_reason !== nextReason) {
            nodeRun.status = "blocked";
            nodeRun.blocked_reason = nextReason;
            nodeRun.updated_at = now;
            nodesChanged = true;
          }
          const item = executionPlanAttentionItem(runId, nodeRun, decision.reason_code);
          const existing = attentionByRootCause.get(item.root_cause_key);
          const merged = existing ? {
            ...existing,
            title: item.title,
            severity: item.severity,
            status: "open" as const,
            related_objects: Array.from(new Map(
              [...existing.related_objects, ...item.related_objects]
                .map((object) => [`${object.type}:${object.id}`, object] as const)
            ).values()),
            impact: {
              blocked_nodes: Array.from(new Set([...existing.impact.blocked_nodes, ...item.impact.blocked_nodes])),
              waiting_agents: Array.from(new Set([...existing.impact.waiting_agents, ...item.impact.waiting_agents])),
              unaffected_paths: Array.from(new Set([...existing.impact.unaffected_paths, ...item.impact.unaffected_paths]))
            },
            safe_actions: Array.from(new Set([...existing.safe_actions, ...item.safe_actions]))
          } : item;
          if (!existing || JSON.stringify(existing) !== JSON.stringify(merged)) {
            attentionByRootCause.set(item.root_cause_key, merged);
            attentionChanged = true;
          }
        }
        continue;
      }
      if (!ownedReason) continue;
      nodeRun.status = decision.decision === "wait" ? "waiting" : "queued";
      nodeRun.upstream_artifacts = Array.from(new Set([
        ...nodeRun.upstream_artifacts,
        ...decision.resolved_inputs.flatMap((resolved) => resolved.artifact_id ? [resolved.artifact_id] : [])
      ]));
      delete nodeRun.blocked_reason;
      nodeRun.updated_at = now;
      nodesChanged = true;
      const rootCauseKey = `run:${runId}:node:${nodeRun.node_run_id}:execution_plan:${ownedReason}`;
      const existing = attentionByRootCause.get(rootCauseKey);
      if (existing && existing.status !== "resolved") {
        attentionByRootCause.set(rootCauseKey, { ...existing, status: "resolved" });
        attentionChanged = true;
      }
    }

    if (nodesChanged) await writeJsonAtomically(`runs/${runId}/nodes.json`, nodes);
    if (attentionChanged) {
      await writeJsonAtomically(`runs/${runId}/attention.json`, Array.from(attentionByRootCause.values()));
    }
  } finally {
    await lock.release();
  }
}

async function buildSchedulerPlan(runId: string, maxNodes: number) {
  await recoverPendingNodeCommitTransactions(runId);
  await reconcileRetryState(runId);
  await reconcileExecutionPlanState(runId);
  const bundle = await readRunBundle(runId);
  return calculateRetryAwareSchedulerPlan(runId, bundle, maxNodes);
}

async function commitSchedulerTick(runId: string, maxNodes: number) {
  const initialPlan = await buildSchedulerPlan(runId, maxNodes);
  const { executionPlan, executable: initialCandidates } = initialPlan;
  const tickId = `sched_${safeId(runId)}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const startedAt = new Date().toISOString();
  const planEvent = {
    event_id: `evt_${tickId}_execution_plan`,
    run_id: runId,
    type: "execution_plan_calculated",
    subject: { type: "RunSpec", id: runId },
    message: `ExecutionPlan ${runId} calculated: decisions=${executionPlan.decisions.length}; ready=${executionPlan.ready_node_run_ids.length}; paused=${executionPlan.paused_node_run_ids.length}; reason_codes=${Array.from(new Set(executionPlan.decisions.map((decision) => decision.reason_code))).sort().join(",")}`,
    created_at: startedAt
  };
  const startedEvent = {
    event_id: `evt_${tickId}_started`,
    run_id: runId,
    type: "scheduler_tick_started",
    subject: { type: "RunSpec", id: runId },
    message: `Scheduler tick started with ${initialCandidates.length} executable NodeRun(s)`,
    created_at: startedAt
  };
  await appendEvent(runId, planEvent);
  await appendEvent(runId, startedEvent);

  const executed = [];
  const failed: SchedulerFailure[] = [];
  const retryAttentionItems: AttentionItem[] = [];
  const retryEvents: string[] = [];
  const attemptedNodeRunIds = new Set<string>();
  for (let slot = 0; slot < maxNodes; slot += 1) {
    const latestPlan = await buildSchedulerPlan(runId, maxNodes);
    const decision = latestPlan.executable.find((candidate) => !attemptedNodeRunIds.has(candidate.node_run_id));
    if (!decision) break;
    attemptedNodeRunIds.add(decision.node_run_id);
    try {
      const result = await executeNodeRunOnce(runId, decision.node_run_id);
      if (!result.accepted) {
        retryAttentionItems.push(...(result.retry_attention_items ?? []));
        retryEvents.push(...(result.retry_events ?? []));
        failed.push({
          decision,
          node_run_id: decision.node_run_id,
          node_id: decision.node_id,
          error: { code: result.error.code, message: result.error.message, recoverable: result.status_code < 500 },
          retry_decision: result.retry_decision
        });
        break;
      }
      executed.push({ decision, result });
      retryAttentionItems.push(...result.retry_attention_items);
      retryEvents.push(...result.retry_events);
      if (["failed", "blocked"].includes(result.committed.node_run.status)) {
        failed.push({
          decision,
          node_run_id: decision.node_run_id,
          node_id: decision.node_id,
          error: result.adapter_result.error ?? { code: "adapter_failed", message: `AdapterResult ${result.adapter_result.status}`, recoverable: true },
          retry_decision: result.retry_decision
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
      break;
    }
  }

  const finalPlan = await buildSchedulerPlan(runId, maxNodes);
  const { decisions, executable, paused, skipped } = finalPlan;

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
    initial_candidates: initialCandidates,
    execution_plan: finalPlan.executionPlan,
    decisions,
    executable,
    executed,
    failed,
    paused,
    skipped,
    attention_items: [...retryAttentionItems, ...attention.attention_items],
    created_events: [planEvent.event_id, startedEvent.event_id, ...retryEvents, ...attention.created_events, completedEvent.event_id],
    next_suggested_actions: schedulerNextActions(finalPlan)
  };
}

function schedulerNextActions(plan: Awaited<ReturnType<typeof buildSchedulerPlan>>) {
  if (plan.executable.length > 0) {
    const executable = plan.executable[0]!;
    return nextActionsForNodeDecision({
      decision: executable.decision,
      reasonCode: executable.reason_code,
      retryDecision: executable.retry_decision
    });
  }
  const nonGateBlocker = plan.decisions.find((decision) =>
    decision.decision === "blocked" && decision.reason_code !== "required_gate_rejected"
  );
  if (nonGateBlocker) {
    const actions = nextActionsForNodeDecision({
      decision: nonGateBlocker.decision,
      reasonCode: nonGateBlocker.reason_code,
      retryDecision: nonGateBlocker.retry_decision
    });
    const hasRejectedGate = plan.decisions.some((decision) =>
      decision.decision === "blocked" && decision.reason_code === "required_gate_rejected"
    );
    return hasRejectedGate && plan.openNonGateAttention.length > 0
      ? Array.from(new Set(["inspect_attention", ...actions]))
      : actions;
  }
  const rejectedGate = plan.decisions.find((decision) =>
    decision.decision === "blocked" && decision.reason_code === "required_gate_rejected"
  );
  if (rejectedGate && plan.openNonGateAttention.length > 0) return ["inspect_attention", "retry_manually"];
  const primary = rejectedGate
    ?? plan.decisions.find((decision) => decision.retry_decision?.phase === "waiting_for_retry")
    ?? plan.decisions.find((decision) => decision.decision === "pause_for_gate")
    ?? plan.decisions.find((decision) => decision.decision === "wait");
  return primary ? nextActionsForNodeDecision({
    decision: primary.decision,
    reasonCode: primary.reason_code,
    retryDecision: primary.retry_decision
  }) : ["refresh_run"];
}

function observabilityNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function observabilityUsage(receipt: Record<string, unknown>) {
  const usage = receipt.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  const value = usage as Record<string, unknown>;
  return {
    ...(observabilityNumber(value.input_tokens) !== undefined ? { input_tokens: observabilityNumber(value.input_tokens) } : {}),
    ...(observabilityNumber(value.output_tokens) !== undefined ? { output_tokens: observabilityNumber(value.output_tokens) } : {}),
    ...(observabilityNumber(value.total_tokens) !== undefined ? { total_tokens: observabilityNumber(value.total_tokens) } : {})
  };
}

function observabilityAttempt(attempt: NodeAttempt, estimatedCost?: { currency: string; min: number; max: number }) {
  const receipt = attempt.provider_receipt ?? {};
  return {
    attempt_id: attempt.attempt_id,
    node_run_id: attempt.node_run_id,
    operation_id: attempt.operation_id,
    attempt_number: attempt.attempt_number ?? 1,
    attempt_kind: attempt.attempt_kind ?? "execute",
    status: attempt.status,
    ...(typeof receipt.adapter_kind === "string" ? { adapter_kind: receipt.adapter_kind } : {}),
    ...(typeof receipt.adapter_id === "string" ? { adapter_id: receipt.adapter_id } : {}),
    ...(typeof receipt.provider === "string" ? { provider: receipt.provider } : {}),
    ...(typeof receipt.provider_profile_id === "string" ? { provider_profile_id: receipt.provider_profile_id } : {}),
    ...(typeof receipt.model === "string" ? { model: receipt.model } : {}),
    ...(observabilityNumber(receipt.latency_ms) !== undefined ? { latency_ms: observabilityNumber(receipt.latency_ms) } : {}),
    ...(observabilityUsage(receipt) ? { usage: observabilityUsage(receipt) } : {}),
    ...(estimatedCost ? { estimated_cost: estimatedCost } : {}),
    actual_cost: providerCostFromAttempt(attempt),
    ...(attempt.error ? { error: { code: attempt.error.code, recoverable: attempt.error.recoverable } } : {}),
    created_at: attempt.created_at ?? attempt.dispatched_at ?? attempt.started_at
  };
}

async function buildRunObservabilityProjection(runId: string) {
  const bundle = await readRunBundle(runId);
  const attempts = bundle.attempts as NodeAttempt[];
  const routingDecisions = await readRoutingDecisions(runId);
  const routingByOperation = new Map(routingDecisions.map((decision) => [decision.operation_id, decision]));
  const operations = Array.from(new Set(attempts.map((attempt) => attempt.operation_id))).map((operationId) => ({
    operation_id: operationId,
    attempts: attempts
      .filter((attempt) => attempt.operation_id === operationId)
      .sort((left, right) => (left.attempt_number ?? 1) - (right.attempt_number ?? 1))
      .map((attempt) => observabilityAttempt(attempt, routingByOperation.get(operationId)?.estimated_cost))
  }));
  const schedulerPlan = await calculateRetryAwareSchedulerPlan(runId, bundle, Math.max(1, (bundle.nodes as NodeRun[]).length));
  const events = await readEvents(runId);
  const latestTick = events
    .filter((event) => event.type === "scheduler_tick_started" || event.type === "scheduler_tick_completed")
    .sort((left, right) => Date.parse(String(left.created_at)) - Date.parse(String(right.created_at)))
    .at(-1);
  const artifactSpecs = new Map(bundle.workflow.artifacts.map((artifact) => [artifact.id, artifact]));
  return {
    run_id: runId,
    operations,
    routing_decisions: routingDecisions.map((decision) => ({
      decision_id: decision.decision_id,
      revision: decision.revision,
      operation_id: decision.operation_id,
      node_run_id: decision.node_run_id,
      target_attempt_number: decision.target_attempt_number,
      current_adapter_kind: decision.current_adapter_kind,
      selected_adapter_kind: decision.selected_adapter_kind,
      selected_provider_profile_id: decision.selected_provider_profile_id,
      reason_codes: decision.reason_codes,
      estimated_cost: decision.estimated_cost,
      requires_confirmation: decision.requires_confirmation
    })),
    retry_schedules: (await retryScheduleStore.list(runId)).map((schedule) => ({
      operation_id: schedule.operation_id,
      node_run_id: schedule.node_run_id,
      attempt_number: schedule.attempt_number,
      reason_code: schedule.reason_code,
      scheduled_for: schedule.scheduled_for,
      budget_snapshot: schedule.budget_snapshot
    })),
    artifacts: (bundle.artifacts as ArtifactManifest[]).map((artifact) => ({
      artifact_id: artifact.artifact_id,
      node_run_id: artifact.node_run_id,
      type: artifact.type,
      version: artifact.version,
      hash: artifact.hash,
      status: artifact.status,
      review_status: artifact.review_status,
      consumers: artifactSpecs.get(artifact.artifact_spec_ref ?? "")?.required_for ?? []
    })),
    scheduler: {
      ...(latestTick ? { last_tick_id: String(latestTick.event_id).replace(/^evt_/, "").replace(/_(started|completed)$/, ""), last_tick_at: latestTick.created_at } : {}),
      ready_node_run_ids: schedulerPlan.executionPlan.ready_node_run_ids,
      paused: schedulerPlan.decisions
        .filter((decision) => decision.decision === "pause_for_gate" || decision.decision === "blocked")
        .map((decision) => ({ node_run_id: decision.node_run_id, node_id: decision.node_id, reason_code: decision.reason_code })),
      next_suggested_actions: schedulerNextActions(schedulerPlan)
    }
  };
}

function schedulerStopReason(plan: Awaited<ReturnType<typeof buildSchedulerPlan>>): "no_executable_nodes" | "paused_for_gate" | "waiting_for_retry" | "attention_required" {
  const blocked = plan.decisions.filter((decision) => decision.decision === "blocked");
  if (blocked.some((decision) => decision.reason_code !== "required_gate_rejected")) return "attention_required";
  const hasRejectedGate = blocked.some((decision) => decision.reason_code === "required_gate_rejected");
  if (hasRejectedGate && plan.openNonGateAttention.length > 0) return "attention_required";
  if (hasRejectedGate) return "paused_for_gate";
  if (plan.decisions.some((decision) => decision.retry_decision?.phase === "waiting_for_retry")) return "waiting_for_retry";
  return plan.paused.length > 0
    ? "paused_for_gate"
    : "no_executable_nodes";
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
  let stopReason: "no_executable_nodes" | "paused_for_gate" | "waiting_for_retry" | "attention_required" | "execution_failed" | "max_ticks_reached" = "max_ticks_reached";
  let lastExecutionPlan: Awaited<ReturnType<typeof buildSchedulerPlan>>["executionPlan"] | undefined;
  let lastProjectedPlan: Awaited<ReturnType<typeof buildSchedulerPlan>> | undefined;
  for (let index = 0; index < maxTicks; index += 1) {
    const plan = await buildSchedulerPlan(runId, maxNodesPerTick);
    lastProjectedPlan = plan;
    lastExecutionPlan = plan.executionPlan;
    if (plan.executable.length === 0) {
      stopReason = schedulerStopReason(plan);
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
    lastExecutionPlan = tick.execution_plan;
    ticks.push({ tick_index: index + 1, ...tick });
    if (tick.failed.some((failure) => failure.retry_decision?.action !== "schedule_retry")) {
      const failurePlan = await buildSchedulerPlan(runId, maxNodesPerTick);
      lastProjectedPlan = failurePlan;
      lastExecutionPlan = failurePlan.executionPlan;
      const projectedStopReason = schedulerStopReason(failurePlan);
      stopReason = projectedStopReason === "no_executable_nodes" ? "execution_failed" : projectedStopReason;
      break;
    }
  }
  if (stopReason === "max_ticks_reached") {
    const terminalPlan = await buildSchedulerPlan(runId, maxNodesPerTick);
    lastProjectedPlan = terminalPlan;
    lastExecutionPlan = terminalPlan.executionPlan;
    if (terminalPlan.executable.length === 0) {
      stopReason = schedulerStopReason(terminalPlan);
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
    execution_plan: lastExecutionPlan,
    stop_reason: stopReason,
    ticks,
    summary: {
      ticks_committed: ticks.filter((tick) => (tick as Record<string, unknown>).mode === "commit").length,
      nodes_executed: executedCount,
      failures: failedCount,
      attention_items_created: attentionCount
    },
    created_events: [startedEvent.event_id, completedEvent.event_id],
    next_suggested_actions: stopReason === "max_ticks_reached"
      ? ["run_scheduler_again_or_increase_limit"]
      : lastProjectedPlan
        ? schedulerNextActions(lastProjectedPlan)
        : ["refresh_run"]
  };
}

async function projectRetryDecision(input: {
  runId: string;
  nodeRun: NodeRun;
  nodeSpec: NodeSpec;
  attempts: NodeAttempt[];
}) {
  const active = (await retryScheduleStore.list(input.runId)).find((schedule) => schedule.node_run_id === input.nodeRun.node_run_id);
  const durable = (await retryStateStore.list(input.runId)).find((state) => state.node_run_id === input.nodeRun.node_run_id);
  const latest = input.attempts
    .filter((attempt) => attempt.node_run_id === input.nodeRun.node_run_id)
    .sort((left, right) => Date.parse(right.created_at ?? "") - Date.parse(left.created_at ?? ""))[0];
  const policy = retryPolicyForNode(input.nodeSpec);
  const currentAuthorization = isRetrySourceAttempt(latest)
    ? decideRetry({
      policy,
      error: latest.error,
      attempts: input.attempts.filter((attempt) => attempt.operation_id === latest.operation_id),
      now: new Date().toISOString(),
      mode: "consume"
    })
    : undefined;
  const derived = isRetrySourceAttempt(latest)
    ? decideRetry({
      policy,
      error: latest.error,
      attempts: input.attempts.filter((attempt) => attempt.operation_id === latest.operation_id),
      now: new Date().toISOString()
    })
    : undefined;
  const budgetSnapshot = active?.budget_snapshot ?? derived?.budget_snapshot ?? {
    attempts_used: input.attempts.length,
    elapsed_ms: 0,
    cost_used: 0,
    max_attempts: policy.max_attempts,
    total_time_budget_ms: policy.total_time_budget_ms,
    cost_budget: policy.cost_budget
  };
  if (durable?.phase === "completed") return undefined;
  const intent = await readJsonOptional<unknown>(nodeDispatchIntentRelativePath(input.runId, input.nodeRun.node_run_id));
  if (isNodeDispatchIntent(intent) && intent.state === "dispatched_unknown") {
    return {
      action: "require_attention" as const,
      phase: "blocked" as const,
      reason_code: "dispatch_result_unknown",
      operation_id: intent.invocation.operation_id,
      budget_snapshot: budgetSnapshot
    };
  }
  if (isNodeDispatchIntent(intent) && intent.state === "invalid_result") {
    return {
      action: "fail_terminal" as const,
      phase: "blocked" as const,
      reason_code: "adapter_result_invalid",
      operation_id: intent.invocation.operation_id,
      budget_snapshot: budgetSnapshot
    };
  }
  if (!active && durable) {
    if (durable.phase === "waiting_for_retry") {
      return {
        ...durable.decision,
        phase: Date.parse(durable.decision.scheduled_for ?? "") <= Date.now()
          ? "due" as const
          : "waiting_for_retry" as const
      };
    }
    return {
      ...durable.decision,
      phase: durable.phase === "exhausted" ? "exhausted" as const : "blocked" as const
    };
  }
  if (active) {
    if (currentAuthorization && currentAuthorization.action !== "schedule_retry") {
      return {
        ...currentAuthorization,
        phase: currentAuthorization.action === "require_attention" ? "exhausted" as const : "blocked" as const
      };
    }
    const phase = Date.parse(active.scheduled_for) <= Date.now() ? "due" as const : "waiting_for_retry" as const;
    return {
      action: "schedule_retry" as const,
      phase,
      reason_code: active.reason_code,
      operation_id: active.operation_id,
      next_attempt_number: active.attempt_number,
      delay_ms: Math.max(0, Date.parse(active.scheduled_for) - Date.now()),
      scheduled_for: active.scheduled_for,
      budget_snapshot: currentAuthorization?.budget_snapshot ?? active.budget_snapshot
    };
  }
  if (!derived) return undefined;
  return {
    ...derived,
    phase: derived.action === "schedule_retry"
      ? (Date.parse(derived.scheduled_for ?? "") <= Date.now() ? "due" as const : "waiting_for_retry" as const)
      : derived.action === "require_attention"
        ? "exhausted" as const
        : "blocked" as const
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

  if (req.method === "GET" && url.pathname === "/api/v0/adapters/codex-cli/health") {
    return sendJson(res, 200, await codexCliAdapter.getHealth());
  }

  if (req.method === "POST" && url.pathname === "/api/v0/adapters/codex-cli/health/refresh") {
    return sendJson(res, 200, await codexCliAdapter.refreshHealth());
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "v0" && parts[2] === "operations" && parts[3] && parts[4] === "cancel") {
    const operationId = getId(parts, 3);
    const modelApiOperation = modelApiOperations.get(operationId);
    if (modelApiOperation) {
      if (modelApiOperation.cancel_requested) {
        return sendJson(res, 200, { operation_id: operationId, status: "already_finished" });
      }
      modelApiOperation.cancel_requested = true;
      modelApiOperation.controller.abort();
      return sendJson(res, 200, { operation_id: operationId, status: "cancelled" });
    }
    if (modelApiOperationTombstones.has(operationId) || await readModelApiOperationReceipt(operationId)) {
      return sendJson(res, 200, { operation_id: operationId, status: "already_finished" });
    }
    const result = await codexCliAdapter.cancelOperation(operationId);
    return sendJson(res, 200, { operation_id: operationId, status: result });
  }

  if (req.method === "GET" && url.pathname === "/api/v0/operations") {
    const runId = url.searchParams.get("run_id") ?? undefined;
    const activeModelApiOperations = Array.from(modelApiOperations.values())
      .filter((operation) => runId === undefined || operation.run_id === runId)
      .map(({ controller: _controller, cancel_requested, ...operation }) => ({ ...operation, status: cancel_requested ? "cancel_requested" : "running" }));
    return sendJson(res, 200, { operations: [...codexCliAdapter.listActiveOperations(runId), ...activeModelApiOperations] });
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
    const codexHealth = await codexCliAdapter.getHealth();
    const projectedAdapters = adapters.map((adapter) => adapter.id === "codex-cli-real"
      ? {
          ...adapter,
          health: {
            ready: codexHealth.status === "healthy" && codexHealth.authenticated,
            status: codexHealth.status,
            authenticated: codexHealth.authenticated,
            reasons: codexHealth.reasons
          }
        }
      : adapter);
    return sendJson(res, 200, {
      adapters: projectedAdapters,
      summary: {
        total: projectedAdapters.length,
        executable: projectedAdapters.filter((adapter) => adapter.executable).length,
        blocked: projectedAdapters.filter((adapter) => adapter.status === "blocked").length,
        missing_credentials: projectedAdapters.flatMap((adapter) => adapter.credential_status.filter((credential) => credential.required && !credential.configured).map((credential) => credential.key))
      }
    });
  }

  if (req.method === "GET" && url.pathname === "/api/v0/providers") {
    const providers = buildProviderHealthProjection(await readProviderCatalogEntries(), {
      credentialKeys: availableCredentialKeys(),
      driverProviderBindings: providerDriverRegistry.registeredDriverBindings()
    });
    return sendJson(res, 200, { providers });
  }

  if (req.method === "POST" && url.pathname === "/api/v0/run-drafts") {
    const body = await parseBody(req);
    const workflowId = String(body.workflow_id ?? "");
    if (!workflowId) return sendError(res, 400, "workflow_required", "workflow_id is required");
    const workflowValidation = validateWorkflowSpec(await readWorkflow(workflowId));
    if (!workflowValidation.valid) {
      return sendJson(res, 422, { error: { code: "invalid_workflow_spec", message: "WorkflowSpec must be valid before creating a RunDraft.", recoverable: true }, validation: workflowValidation });
    }
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
      const health = await codexCliAdapter.refreshHealth();
      const launched = await runDraftStore.requestLaunch({
        draft_id: String(body.draft_id),
        draft_plan_id: String(body.draft_plan_id ?? ""),
        plan_hash: String(body.plan_hash ?? ""),
        confirmation_id: String(body.confirmation_id ?? ""),
        actor: String(body.actor ?? "operator"),
        adapter_ready: process.env.MIRACLE_ENABLE_REAL_CODEX === "1" && health.status === "healthy",
        launch: async (bundle) => {
          const nodes = bundle.snapshot.workflow.nodes;
          if (
            nodes.length === 0 ||
            !nodes.every((node) => node.capability_requirements.every((capability) => codexCliRealAdapterManifest.capabilities.includes(capability)))
          ) {
            throw new RunDraftStoreError("launch_handoff_required", "Workflow nodes must be supported by the Codex CLI adapter before launch.");
          }
          return stageRunFromDraft({
            workflow: bundle.snapshot.workflow,
            executionPolicy: bundle.draft.execution_policy,
            inputs: bundle.draft.inputs,
            draftId: bundle.draft.draft_id,
            planHash: bundle.plan.plan_hash
          });
        }
      });
      return sendJson(res, launched.reused ? 200 : 201, launched);
    }
    const workflowId = String(body.workflow_id ?? "content-production-v0");
    const workflow = await readWorkflow(workflowId);
    const validation = validateWorkflowSpec(workflow);
    if (!validation.valid) {
      return sendJson(res, 422, { error: { code: "invalid_workflow_spec", message: "WorkflowSpec must be valid before creating a Run.", recoverable: true }, validation });
    }
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
    await writeJson(`runs/${runId}/routing_decisions.json`, []);
    await writeJson(`runs/${runId}/fallback_confirmations.json`, []);
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
    if (req.method === "GET" && parts[4] === "routing-decisions") {
      return sendJson(res, 200, {
        run_id: runId,
        routing_decisions: await readRoutingDecisions(runId),
        fallback_confirmations: await readFallbackConfirmations(runId)
      });
    }
    if (req.method === "GET" && parts[4] === "observability") {
      return sendJson(res, 200, await buildRunObservabilityProjection(runId));
    }
    if (req.method === "GET" && parts[4] === "dag") {
      const bundle = await readRunBundle(runId);
      return sendJson(res, 200, { dag: buildDagProjection(bundle.workflow, bundle.nodes as NodeRun[]) });
    }
    if (req.method === "POST" && (await isHistoricalReadOnlyRun(runId))) {
      return sendError(res, 409, "historical_run_read_only", "Historical run is read-only and cannot execute scheduler or node commands.");
    }
    if (req.method === "POST" && parts[4] === "nodes" && parts[5] && parts[6] === "fallback-confirmation") {
      const nodeRunId = getId(parts, 5);
      const body = await parseBody(req);
      const decisionId = typeof body.decision_id === "string" ? body.decision_id : "";
      const operationId = typeof body.operation_id === "string" ? body.operation_id : "";
      const expectedKind = body.expected_current_adapter_kind === "codex" || body.expected_current_adapter_kind === "model-api"
        ? body.expected_current_adapter_kind
        : undefined;
      const targetProfileId = typeof body.target_provider_profile_id === "string" ? body.target_provider_profile_id : "";
      const actor = typeof body.actor === "string" ? body.actor.trim() : "";
      if (!decisionId || !operationId || !expectedKind || !targetProfileId || !actor) {
        return sendError(res, 400, "fallback_confirmation_invalid", "decision_id, operation_id, expected_current_adapter_kind, target_provider_profile_id and actor are required.");
      }
      const lock = await acquireRunMutationLock(runId);
      if (!lock) return sendError(res, 409, "operation_in_progress", "Run already has a state mutation in progress.");
      let responseStatus = 500;
      let responseBody: Record<string, unknown> = {
        error: { code: "fallback_confirmation_failed", message: "Fallback confirmation did not complete." }
      };
      try {
        const [nodes, attempts, decisions, confirmations, schedules] = await Promise.all([
          readJson<NodeRun[]>(`runs/${runId}/nodes.json`),
          readJson<NodeAttempt[]>(`runs/${runId}/attempts.json`),
          readRoutingDecisions(runId),
          readFallbackConfirmations(runId),
          retryScheduleStore.list(runId)
        ]);
        if (!nodes.some((node) => node.node_run_id === nodeRunId)) {
          responseStatus = 404;
          responseBody = { error: { code: "not_found", message: "NodeRun not found" } };
        } else {
          const currentDecision = decisions
            .filter((decision) => decision.node_run_id === nodeRunId)
            .sort((left, right) => left.revision - right.revision)
            .at(-1);
          const operationAttempts = attempts
            .filter((attempt) => attempt.node_run_id === nodeRunId && attempt.operation_id === operationId)
            .sort((left, right) => (left.attempt_number ?? 1) - (right.attempt_number ?? 1));
          const currentKind = operationAttempts.length > 0 ? adapterKindFromAttempt(operationAttempts.at(-1)!) : undefined;
          const currentSchedule = schedules.find((schedule) =>
            schedule.operation_id === operationId
            && schedule.node_run_id === nodeRunId
            && schedule.attempt_number === currentDecision?.target_attempt_number
          );
          if (
            !currentDecision
            || currentDecision.decision_id !== decisionId
            || currentDecision.operation_id !== operationId
            || currentDecision.requires_confirmation !== true
            || currentDecision.selected_adapter_kind !== "model-api"
            || currentDecision.current_adapter_kind !== expectedKind
            || currentKind !== expectedKind
            || currentDecision.selected_provider_profile_id !== targetProfileId
            || !currentSchedule
          ) {
            responseStatus = 409;
            responseBody = {
              error: {
                code: "routing_decision_not_current",
                message: "Fallback confirmation does not match the current routing decision, active RetrySchedule and Attempt facts."
              }
            };
          } else {
            const existing = confirmations.find((confirmation) =>
              confirmation.decision_id === decisionId
              && confirmation.operation_id === operationId
              && confirmation.node_run_id === nodeRunId
              && confirmation.expected_current_adapter_kind === expectedKind
              && confirmation.target_provider_profile_id === targetProfileId
              && confirmation.target_attempt_number === currentDecision.target_attempt_number
              && confirmation.status === "confirmed"
            );
            if (existing) {
              responseStatus = 200;
              responseBody = { confirmation: existing, reused: true };
            } else {
              const confirmedAt = new Date().toISOString();
              const confirmation: FallbackConfirmation = {
                confirmation_id: `fallback_confirmation_${safeId(operationId)}_${Date.now()}`,
                decision_id: decisionId,
                operation_id: operationId,
                node_run_id: nodeRunId,
                expected_current_adapter_kind: expectedKind,
                target_provider_profile_id: targetProfileId,
                target_attempt_number: currentDecision.target_attempt_number,
                actor,
                status: "confirmed",
                confirmed_at: confirmedAt
              };
              await writeJsonAtomically(fallbackConfirmationsPath(runId), [...confirmations, confirmation]);
              await appendEventIfMissing(runId, {
                event_id: `evt_${confirmation.confirmation_id}`,
                run_id: runId,
                type: "provider_fallback_confirmed",
                subject: { type: "NodeRun", id: nodeRunId },
                message: `Provider fallback confirmed by ${actor} for ${targetProfileId}`,
                created_at: confirmedAt
              });
              responseStatus = 201;
              responseBody = { confirmation, reused: false };
            }
          }
        }
      } finally {
        await lock.release();
      }
      return sendJson(res, responseStatus, responseBody);
    }
    if (req.method === "POST" && parts[4] === "nodes" && parts[5] && parts[6] === "retry" && parts[7] === "stop") {
      const nodeRunId = getId(parts, 5);
      const lock = await acquireRunMutationLock(runId);
      if (!lock) return sendError(res, 409, "operation_in_progress", "Run already has a state mutation in progress.");
      try {
        const bundle = await readRunBundle(runId);
        const nodeRun = (bundle.nodes as NodeRun[]).find((node) => node.node_run_id === nodeRunId);
        const schedule = (await retryScheduleStore.list(runId)).find((item) => item.node_run_id === nodeRunId);
        if (!nodeRun || !schedule) return sendError(res, 409, "retry_not_active", "NodeRun has no active automatic retry to stop.");
        const latestAttempt = (bundle.attempts as NodeAttempt[])
          .filter((attempt) => attempt.operation_id === schedule.operation_id && attempt.node_run_id === nodeRunId)
          .sort((left, right) => (right.attempt_number ?? 1) - (left.attempt_number ?? 1))
          .at(0);
        if (!latestAttempt?.error) return sendError(res, 409, "retry_not_active", "Active retry has no failed NodeAttempt fact.");
        const now = new Date().toISOString();
        const decision: RetryDecision = {
          action: "require_attention",
          reason_code: "auto_retry_stopped",
          operation_id: schedule.operation_id,
          next_attempt_number: schedule.attempt_number,
          budget_snapshot: schedule.budget_snapshot
        };
        const terminalState: TerminalRetryState = {
          operation_id: schedule.operation_id,
          node_run_id: nodeRunId,
          attempt_id: latestAttempt.attempt_id,
          attempt_number: latestAttempt.attempt_number ?? 1,
          phase: "exhausted",
          reason_code: "auto_retry_stopped",
          decision,
          error: latestAttempt.error,
          effects_committed: false,
          updated_at: now
        };
        await retryStateStore.upsert(runId, terminalState);
        const committed = await commitTerminalRetryEffects({ runId, nodeRun, state: terminalState, completedAt: now });
        return sendJson(res, 200, {
          status: "stopped",
          operation_id: schedule.operation_id,
          reason_code: "auto_retry_stopped",
          attention_items: committed.attention_items,
          created_events: committed.created_events
        });
      } finally {
        await lock.release();
      }
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
          initial_candidates: plan.executable,
          execution_plan: plan.executionPlan,
          decisions: plan.decisions,
          executable: plan.executable,
          paused: plan.paused,
          skipped: plan.skipped,
          next_suggested_actions: schedulerNextActions(plan)
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
      if (req.method === "GET" && parts.length === 6) await reconcileRetryState(runId);
      const bundle = await readRunBundle(runId);
      const runSpec = bundle.run as unknown as RunSpec;
      const nodeRunId = getId(parts, 5);
      const nodes = bundle.nodes as NodeRun[];
      const node = nodes.find((item) => item.node_run_id === nodeRunId);
      if (!node) return sendError(res, 404, "not_found", "NodeRun not found");
      const attempts = (await readJsonOptional<NodeAttempt[]>(`runs/${runId}/attempts.json`)) ?? [];
      if (parts.length === 6) {
        const nodeAttempts = attempts.filter((attempt) => attempt.node_run_id === nodeRunId);
        const projectedPlan = runSpec.run_mode === "executable"
          ? await calculateRetryAwareSchedulerPlan(runId, bundle, Math.max(1, nodes.length))
          : undefined;
        const executionDecision = projectedPlan?.decisions.find((decision) => decision.node_run_id === nodeRunId);
        return sendJson(res, 200, {
          node,
          attempts: nodeAttempts,
          retry_decision: executionDecision?.retry_decision,
          execution_decision: executionDecision,
          next_suggested_actions: executionDecision ? nextActionsForNodeDecision({
            decision: executionDecision.decision,
            reasonCode: executionDecision.reason_code,
            retryDecision: executionDecision.retry_decision
          }) : []
        });
      }
      if (req.method === "POST" && parts[6] === "execute") {
        const result = await executeNodeRunOnce(runId, nodeRunId);
        if (!result.accepted) return sendJson(res, result.status_code, { error: { ...result.error, recoverable: result.status_code < 500 } });
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
      const lock = await acquireRunMutationLock(runId);
      if (!lock) {
        return sendError(res, 409, "operation_in_progress", "Run already has a fact mutation in progress.");
      }
      let released = false;
      const releaseOnce = async () => {
        if (released) return;
        await lock.release();
        released = true;
      };
      const sendErrorAfterRelease = async (status: number, code: string, message: string) => {
        await releaseOnce();
        sendError(res, status, code, message);
      };

      try {
        const lockedBundle = await readRunBundle(runId);
        const runSpec = lockedBundle.run as unknown as RunSpec;
        const lockedGates = lockedBundle.gates as GateInstance[];
        const lockedGate = lockedGates.find((item) => item.gate_instance_id === gateId);
        if (!lockedGate) return await sendErrorAfterRelease(404, "not_found", "Gate not found");
        const latestDecision = lockedGate.decisions.at(-1);
        if (lockedGate.status !== "decided" || !latestDecision || !["reject", "request_changes"].includes(latestDecision.decision)) {
          return await sendErrorAfterRelease(409, "gate_not_reworkable", "Only a rejected or request_changes GateInstance can create a rework attempt.");
        }

        const lockedArtifacts = lockedBundle.artifacts as ArtifactManifest[];
        const nodes = lockedBundle.nodes as NodeRun[];
        const targetArtifact = lockedArtifacts.find((artifact) => artifact.artifact_id === lockedGate.target.id);
        if (!targetArtifact) return await sendErrorAfterRelease(404, "not_found", "Target ArtifactManifest not found");
        const producerNode = nodes.find((node) => node.node_run_id === targetArtifact.node_run_id);
        if (!producerNode) return await sendErrorAfterRelease(404, "not_found", "Producer NodeRun not found");

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

        await releaseOnce();
        return sendJson(res, 201, {
          accepted: true,
          rework_attempt_id: attempt.attempt_id,
          artifact: nextArtifact,
          gate: nextGate,
          created_events: events.map((event) => event.event_id),
          next_suggested_actions: ["review_rework_gate"]
        });
      } finally {
        await releaseOnce();
      }
    }
    if (req.method === "POST" && parts[4] === "decision") {
      const body = await parseBody(req);
      const decisionValue = body.decision === "reject" || body.decision === "request_changes" ? body.decision : "approve";
      const lock = await acquireRunMutationLock(runId);
      if (!lock) {
        return sendError(res, 409, "operation_in_progress", "Run already has a fact mutation in progress.");
      }
      let released = false;
      const releaseOnce = async () => {
        if (released) return;
        await lock.release();
        released = true;
      };
      const sendErrorAfterRelease = async (status: number, code: string, message: string) => {
        await releaseOnce();
        sendError(res, status, code, message);
      };

      try {
        const lockedBundle = await readRunBundle(runId);
        const lockedGates = lockedBundle.gates as GateInstance[];
        const lockedGate = lockedGates.find((item) => item.gate_instance_id === gateId);
        if (!lockedGate) return await sendErrorAfterRelease(404, "not_found", "Gate not found");
        if (lockedGate.status !== "pending_review") {
          return await sendErrorAfterRelease(409, "gate_already_decided", "GateInstance is already decided. Create a new review cycle before adding another decision.");
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
        await releaseOnce();
        return sendJson(res, 200, {
          accepted: true,
          gate_decision_id: decision.decision_id,
          created_events: [event.event_id],
          projection: buildGateDecisionProjection(lockedGate, bundle.workflow, bundle.nodes as NodeRun[], decision.decision, true),
          next_suggested_actions: decision.decision === "approve" ? ["continue_downstream"] : ["create_rework_attempt"]
        });
      } finally {
        await releaseOnce();
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
    if (error instanceof RetryStateReconciliationBusyError) {
      return sendError(res, 409, error.code, error.message);
    }
    if (error instanceof ProviderCredentialAuthorizationError) {
      return sendError(res, 422, error.code, error.message);
    }
    if (error instanceof CodexCliAdapterError) {
      const status = error.code === "operation_not_found"
        ? 404
        : error.code === "input_path_not_allowed" || error.code === "workspace_escape_detected" || error.code === "invalid_attempt_id"
          ? 400
          : 409;
      return sendError(res, status, error.code, error.message);
    }
    const message = error instanceof Error ? error.message : "Unknown sidecar error";
    sendError(res, 500, "sidecar_error", message);
  });
});

const workspaceInstanceLock = await acquireWorkspaceInstanceLock();
try {
  await recoverStaleMutationLocksAtStartup();
} catch (error) {
  await workspaceInstanceLock.release();
  throw error;
}

server.listen(port, "127.0.0.1", () => {
  console.log(`Miracle Local Sidecar listening on http://127.0.0.1:${port}`);
  console.log(`Workspace: ${workspaceDir}`);
  console.log(`Runtime workspace: ${runtimeWorkspaceDir}`);
});

let shutdownStarted = false;
const shutdown = () => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  server.close(() => {
    workspaceInstanceLock.release()
      .catch((error) => console.error("Failed to release Sidecar instance lock", error))
      .finally(() => process.exit(0));
  });
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

import type { AdapterInvocation, AdapterResult } from "@miracle/core";
import type { AttemptWorkspace, CodexProcessHandle } from "./codex-cli-adapter";
import { ArtifactInputResolverError } from "./artifact-input-resolver";
import { NodeOutputContractError } from "./node-output-contract";

type CodexOperationStarter = {
  startOperation(input: {
    invocation: AdapterInvocation;
    attempt_workspace: AttemptWorkspace;
    timeout_ms?: number;
    operation_deadline_at?: string;
    prompt?: string;
  }): Promise<CodexProcessHandle>;
  cleanupAttemptWorkspace(attempt: AttemptWorkspace): Promise<void>;
};

export function codexPreflightFailure(invocation: AdapterInvocation, error: unknown): AdapterResult {
  const code = error instanceof ArtifactInputResolverError || error instanceof NodeOutputContractError ? error.code : "codex_preflight_failed";
  return {
    operation_id: invocation.operation_id,
    attempt_id: invocation.attempt_id,
    node_run_id: invocation.node_run_id,
    status: "failed",
    provider_receipt: {
      provider: invocation.provider,
      adapter_kind: invocation.adapter_kind,
      adapter_id: invocation.adapter_id,
      operation_id: invocation.operation_id,
      raw_receipt_id: `receipt_${invocation.operation_id}`
    },
    artifact_descriptors: [],
    error: {
      code,
      message: error instanceof Error ? error.message : "Codex input or output preflight validation failed.",
      recoverable: false
    },
    received_at: new Date().toISOString()
  };
}

export async function startCodexOperation(input: {
  adapter: CodexOperationStarter;
  invocation: AdapterInvocation;
  attempt: AttemptWorkspace;
  prompt: string;
  operation_deadline_at?: string;
}): Promise<AdapterResult> {
  try {
    const handle = await input.adapter.startOperation({
      invocation: input.invocation,
      attempt_workspace: input.attempt,
      prompt: input.prompt,
      operation_deadline_at: input.operation_deadline_at
    });
    return await handle.result;
  } catch (error) {
    await input.adapter.cleanupAttemptWorkspace(input.attempt).catch(() => undefined);
    return codexPreflightFailure(input.invocation, error);
  }
}

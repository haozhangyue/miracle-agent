import { describe, expect, it } from "vitest";
import type { AdapterInvocation } from "@miracle/core";
import type { AttemptWorkspace } from "../src/codex-cli-adapter";
import { startCodexOperation } from "../src/codex-real-adapter";

const attempt: AttemptWorkspace = {
  attempt_id: "attempt_pre_spawn",
  root_dir: "/runtime/attempts/attempt_pre_spawn",
  input_dir: "/runtime/attempts/attempt_pre_spawn/input",
  work_dir: "/runtime/attempts/attempt_pre_spawn/work",
  output_dir: "/runtime/attempts/attempt_pre_spawn/output",
  meta_dir: "/runtime/attempts/attempt_pre_spawn/meta"
};

const invocation: AdapterInvocation = {
  operation_id: "op_pre_spawn",
  attempt_id: attempt.attempt_id,
  node_run_id: "nr_pre_spawn",
  node_id: "node_pre_spawn",
  run_id: "run_pre_spawn",
  adapter_kind: "codex",
  adapter_id: "codex-cli-real",
  provider: "codex-local",
  capability_requirements: [],
  input_artifacts: [],
  resolved_inputs: [],
  expected_outputs: [],
  runtime_control: { timeout_ms: 1_000, cancellation_token_id: "cancel_pre_spawn", attempt_workspace: attempt.root_dir, sandbox: "workspace-write" },
  prompt_path: `${attempt.input_dir}/launch_context.json`,
  output_schema_path: `${attempt.meta_dir}/output.schema.json`,
  dispatched_at: "2026-07-24T00:00:00.000Z"
};

describe("real Codex pre-spawn boundary", () => {
  it("converts a second workspace validation error into an identity-preserving failed result", async () => {
    let cleaned = false;
    const result = await startCodexOperation({
      adapter: {
        async startOperation() {
          throw Object.assign(new Error("Attempt output directory changed before spawn"), { code: "workspace_escape_detected" });
        },
        async cleanupAttemptWorkspace() {
          cleaned = true;
        }
      },
      invocation,
      attempt,
      prompt: "test"
    });

    expect(cleaned).toBe(true);
    expect(result).toMatchObject({
      operation_id: invocation.operation_id,
      attempt_id: invocation.attempt_id,
      node_run_id: invocation.node_run_id,
      status: "failed",
      artifact_descriptors: [],
      error: { code: "codex_preflight_failed", recoverable: false }
    });
  });
});

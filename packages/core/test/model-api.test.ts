import { describe, expect, it } from "vitest";
import { adapterInvocationSchema, adapterManifestSchema } from "../src/schemas";
import { createAdapterInvocation } from "../src/runner";
import type { NodeRun, RunSpec, WorkflowSpec } from "../src/types";

const invocation = {
  operation_id: "op_model_api_contract",
  attempt_id: "attempt_model_api_contract",
  attempt_number: 1,
  run_id: "run_model_api_contract",
  node_run_id: "nr_model_api_contract",
  node_id: "node_model_api_contract",
  adapter_kind: "model-api",
  adapter_id: "model-api-compatible-adapter",
  provider: "fixture-compatible",
  capability_requirements: ["model.call"],
  input_artifacts: [],
  resolved_inputs: [],
  expected_outputs: [],
  runtime_control: {
    timeout_ms: 1_000,
    cancellation_token_id: "cancel_model_api_contract",
    attempt_workspace: "runtime/run_model_api_contract/nr_model_api_contract/attempt_model_api_contract",
    sandbox: "workspace-write"
  },
  prompt_path: "input/prompt.txt",
  output_schema_path: "meta/output.schema.json",
  dispatched_at: "2026-07-31T00:00:00.000Z"
};

describe("model API contract", () => {
  it("accepts the executable model-api invocation kind", () => {
    expect(adapterInvocationSchema.parse(invocation).adapter_kind).toBe("model-api");
  });

  it("retains only the credential reference in a model API provider profile", () => {
    const manifest = adapterManifestSchema.parse({
      id: "model-api-compatible-adapter",
      kind: "model-api",
      display_name: "Model API Compatible Adapter",
      version: "0.1.0",
      status: "experimental",
      description: "A generic compatible transport contract.",
      execution_mode: "external",
      capabilities: ["model.call"],
      supported_providers: ["fixture-compatible"],
      default_provider: "fixture-compatible",
      required_credentials: [
        { key: "MODEL_API_FIXTURE_CREDENTIAL", label: "Fixture credential", source: "env", required: true }
      ],
      provider_profiles: [
        {
          id: "fixture-compatible-default",
          provider: "fixture-compatible",
          model: "fixture-chat",
          base_url: "http://127.0.0.1:9999",
          api_path: "/v1/chat/completions",
          credential_ref: "MODEL_API_FIXTURE_CREDENTIAL",
          verification_status: "configured_unverified"
        }
      ],
      runtime: { local_executor: "external-api", can_execute: true }
    }) as unknown as Record<string, unknown>;

    expect(manifest.provider_profiles).toEqual([
      expect.objectContaining({
        provider: "fixture-compatible",
        model: "fixture-chat",
        credential_ref: "MODEL_API_FIXTURE_CREDENTIAL",
        verification_status: "configured_unverified"
      })
    ]);
    expect(JSON.stringify(manifest)).not.toContain("fixture-secret");
  });

  it("rejects a provider profile whose credential_ref is not declared by its manifest", () => {
    const manifest = {
      id: "model-api-compatible-adapter",
      kind: "model-api",
      display_name: "Model API Compatible Adapter",
      version: "0.1.0",
      status: "experimental",
      description: "A generic compatible transport contract.",
      execution_mode: "external",
      capabilities: ["model.call"],
      supported_providers: ["fixture-compatible"],
      default_provider: "fixture-compatible",
      required_credentials: [],
      provider_profiles: [{
        id: "fixture-compatible-default",
        provider: "fixture-compatible",
        model: "fixture-chat",
        base_url: "https://provider.example",
        credential_ref: "AWS_SECRET_ACCESS_KEY",
        verification_status: "configured_unverified"
      }],
      runtime: { local_executor: "external-api", can_execute: true }
    };

    expect(() => adapterManifestSchema.parse(manifest)).toThrow(/credential_ref/i);
  });

  it("rejects a provider profile outside its credential providers scope", () => {
    const manifest = {
      id: "model-api-compatible-adapter",
      kind: "model-api",
      display_name: "Model API Compatible Adapter",
      version: "0.1.0",
      status: "experimental",
      description: "A generic compatible transport contract.",
      execution_mode: "external",
      capabilities: ["model.call"],
      supported_providers: ["provider-b"],
      default_provider: "provider-b",
      required_credentials: [{ key: "MODEL_API_FIXTURE_CREDENTIAL", label: "Fixture credential", source: "env", required: true, providers: ["provider-a"] }],
      provider_profiles: [{
        id: "provider-b-default",
        provider: "provider-b",
        model: "fixture-chat",
        base_url: "https://provider.example",
        credential_ref: "MODEL_API_FIXTURE_CREDENTIAL",
        verification_status: "configured_unverified"
      }],
      runtime: { local_executor: "external-api", can_execute: true }
    };

    expect(() => adapterManifestSchema.parse(manifest)).toThrow(/providers/i);
  });

  it.each(["blob:https://provider.example/opaque", "ftp://provider.example"])('rejects non-HTTP provider base_url %s', (baseUrl) => {
    const manifest = {
      id: "model-api-compatible-adapter",
      kind: "model-api",
      display_name: "Model API Compatible Adapter",
      version: "0.1.0",
      status: "experimental",
      description: "A generic compatible transport contract.",
      execution_mode: "external",
      capabilities: ["model.call"],
      supported_providers: ["fixture-compatible"],
      default_provider: "fixture-compatible",
      required_credentials: [{ key: "MODEL_API_FIXTURE_CREDENTIAL", label: "Fixture credential", source: "env", required: true }],
      provider_profiles: [{
        id: "fixture-compatible-default",
        provider: "fixture-compatible",
        model: "fixture-chat",
        base_url: baseUrl,
        credential_ref: "MODEL_API_FIXTURE_CREDENTIAL",
        verification_status: "configured_unverified"
      }],
      runtime: { local_executor: "external-api", can_execute: true }
    };

    expect(() => adapterManifestSchema.parse(manifest)).toThrow(/base_url/i);
  });

  it.each(["//provider.example/v1/chat", "//user@provider.example/v1/chat", "https://provider.example/v1/chat", "v1/chat/completions"])("rejects unsafe provider api_path %s", (apiPath) => {
    const manifest = {
      id: "model-api-compatible-adapter",
      kind: "model-api",
      display_name: "Model API Compatible Adapter",
      version: "0.1.0",
      status: "experimental",
      description: "A generic compatible transport contract.",
      execution_mode: "external",
      capabilities: ["model.call"],
      supported_providers: ["fixture-compatible"],
      default_provider: "fixture-compatible",
      required_credentials: [],
      provider_profiles: [{
        id: "fixture-compatible-default",
        provider: "fixture-compatible",
        model: "fixture-chat",
        base_url: "https://provider.example",
        api_path: apiPath,
        credential_ref: "MODEL_API_FIXTURE_CREDENTIAL",
        verification_status: "configured_unverified"
      }],
      runtime: { local_executor: "external-api", can_execute: true }
    };

    expect(() => adapterManifestSchema.parse(manifest)).toThrow(/api_path/i);
  });

  it("uses the compatible adapter identity when an invocation selects model-api", () => {
    const workflow = {
      id: "model-api-workflow",
      name: "Model API workflow",
      version: "0.1.0",
      domain: "test",
      category: "test",
      nodes: [{
        id: "model-node",
        name: "Model node",
        type: "agent",
        capability_requirements: ["model.call"],
        recommended_libraries: [],
        agent_candidates: [],
        inputs: [],
        outputs: [],
        failure_policy: { retry: 0, on_missing_input: "blocked", on_provider_failure: "failed" }
      }],
      edges: [],
      gates: [],
      artifacts: [],
      provider_policy: { default_provider: "fixture-compatible", allowed_providers: ["fixture-compatible"], required_credentials: [], fallback_providers: [] },
      layouts: { dag: { "model-node": { x: 0, y: 0 } } },
      registry_meta: { source: "test", status: "experimental" }
    } satisfies WorkflowSpec;
    const runSpec: RunSpec = {
      run_id: "run_model_api_contract",
      workflow_id: workflow.id,
      workflow_version: workflow.version,
      workflow_snapshot_id: "snapshot_model_api_contract",
      status: "running",
      role_profile: "test",
      resolved_components: [],
      resolved_provider_policy: workflow.provider_policy,
      created_at: "2026-07-31T00:00:00.000Z",
      run_mode: "executable",
      execution_policy: "auto"
    };
    const nodeRun: NodeRun = {
      node_run_id: "nr_model_api_contract",
      run_id: runSpec.run_id,
      node_id: "model-node",
      status: "queued",
      provider: "fixture-compatible",
      updated_at: "2026-07-31T00:00:00.000Z",
      upstream_artifacts: [],
      output_artifacts: []
    };

    expect(createAdapterInvocation({ runSpec, workflow, nodeRun, adapterKind: "model-api" }).adapter_id).toBe("model-api-compatible-adapter");
  });
});

import { z } from "zod";

const nodePortSchema = z.object({
  id: z.string(),
  kind: z.enum(["artifact", "parameter"]),
  artifact_type: z.string().optional(),
  required: z.boolean(),
  artifact_spec_ref: z.string().optional()
});

export const nodeSpecSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["start", "source", "transform", "agent", "tool", "mcp_tool", "branch", "loop", "review_gate", "artifact", "subworkflow", "end", "terminate"]),
  domain_tags: z.array(z.string()).optional(),
  capability_requirements: z.array(z.string()),
  recommended_libraries: z.array(z.string()),
  agent_candidates: z.array(z.string()),
  inputs: z.array(nodePortSchema),
  outputs: z.array(nodePortSchema),
  review_gate_ref: z.string().optional(),
  failure_policy: z.object({
    retry: z.number().int().min(0),
    on_missing_input: z.enum(["blocked", "failed"]),
    on_provider_failure: z.enum(["blocked", "failed"])
  })
});

export const edgeSpecSchema = z.object({
  from: z.string(),
  to: z.string(),
  required: z.boolean(),
  artifact_selector: z
    .object({
      artifact_type: z.string().optional(),
      review_status: z.enum(["none", "pending_review", "approved", "rejected"]).optional()
    })
    .optional(),
  join_policy: z.object({
    wait_if_active: z.boolean(),
    max_wait: z.string().optional(),
    on_timeout: z.enum(["continue_if_required_inputs_ready", "blocked", "failed", "require_decision"]),
    on_no_qualified_artifact: z.enum(["ignore_optional", "block_downstream", "require_decision"])
  })
});

export const artifactSpecSchema = z.object({
  id: z.string(),
  type: z.string(),
  produced_by: z.string(),
  review_policy: z.object({
    mode: z.enum(["none", "auto", "manual", "conditional"]),
    gate_spec_id: z.string().optional()
  }),
  required_for: z.array(z.string()),
  versioning: z.object({
    immutable: z.boolean(),
    compare_by: z.enum(["hash", "path", "version"])
  })
});

export const gateSpecSchema = z.object({
  id: z.string(),
  name: z.string(),
  target_artifact_ref: z.string(),
  required_before: z.array(z.string()),
  actions: z.array(z.string())
});

export const workflowSpecSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  domain: z.string(),
  category: z.string(),
  nodes: z.array(nodeSpecSchema),
  edges: z.array(edgeSpecSchema),
  gates: z.array(gateSpecSchema),
  artifacts: z.array(artifactSpecSchema),
  provider_policy: z.object({
    default_provider: z.string(),
    allowed_providers: z.array(z.string()),
    required_credentials: z.array(z.string()),
    fallback_providers: z.array(z.string())
  }),
  layouts: z.object({
    dag: z.record(z.string(), z.object({ x: z.number(), y: z.number(), stage: z.string().optional() })),
    canvas: z.object({ zones: z.array(z.object({ id: z.string(), name: z.string(), node_ids: z.array(z.string()) })) }).optional()
  }),
  registry_meta: z.object({
    source: z.string(),
    status: z.string()
  })
});

export const domainPackSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  status: z.enum(["draft", "experimental", "stable", "deprecated", "blocked"]),
  categories: z.array(z.string()),
  artifact_types: z.array(z.string()),
  role_profiles: z.array(z.string()),
  workflow_templates: z.array(z.string()),
  component_libraries: z.array(z.string()),
  default_views: z.record(z.string(), z.string())
});

export const roleProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  default_landing: z.string(),
  visible_modules: z.array(z.string()),
  primary_objects: z.array(z.string()),
  default_filters: z.record(z.string(), z.unknown()),
  actions: z.array(z.string())
});

export const workflowTemplateSchema = z.object({
  template_id: z.string(),
  workflow_id: z.string(),
  domain: z.string(),
  name: z.string(),
  version: z.string(),
  status: z.enum(["draft", "experimental", "stable", "deprecated", "blocked"]),
  source: z.enum(["builtin_template", "local_project", "local_registry", "github_repo"]),
  tags: z.array(z.string())
});

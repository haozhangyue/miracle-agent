import type { NodeSpec } from "@miracle/core";

const supportedArtifactTypes = new Set(["markdown", "document", "report", "script", "outline"]);
const maxContentLength = 2_000_000;

export class NodeOutputContractError extends Error {
  constructor(public readonly code: "unsupported_codex_output_type" | "invalid_codex_artifact_output", message: string) {
    super(message);
  }
}

export interface NodeOutputContract {
  schema: Record<string, unknown>;
  parse(value: unknown): Array<{ output_id: string; artifact_type: string; content: string }>;
}

type ArtifactOutput = { id: string; artifact_type: string; required: boolean };

function outputSchema(output: ArtifactOutput) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["output_id", "artifact_type", "content"],
    properties: {
      output_id: { const: output.id },
      artifact_type: { const: output.artifact_type },
      content: { type: "string", minLength: 1, maxLength: maxContentLength }
    }
  };
}

function parseOutput(value: unknown, outputs: ArtifactOutput[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NodeOutputContractError("invalid_codex_artifact_output", "Codex output must be a JSON object.");
  const record = value as Record<string, unknown>;
  if (typeof record.output_id !== "string" || typeof record.artifact_type !== "string" || typeof record.content !== "string") {
    throw new NodeOutputContractError("invalid_codex_artifact_output", "Codex output descriptor is incomplete.");
  }
  if (record.content.trim().length === 0 || record.content.length > maxContentLength) {
    throw new NodeOutputContractError("invalid_codex_artifact_output", "Codex output content is outside the allowed range.");
  }
  const expected = outputs.find((output) => output.id === record.output_id);
  if (!expected || expected.artifact_type !== record.artifact_type) {
    throw new NodeOutputContractError("invalid_codex_artifact_output", "Codex output descriptor does not match the NodeSpec output contract.");
  }
  return { output_id: record.output_id, artifact_type: record.artifact_type, content: record.content };
}

export function buildNodeOutputContract(nodeSpec: NodeSpec): NodeOutputContract {
  const outputs: ArtifactOutput[] = nodeSpec.outputs
    .filter((output) => output.kind === "artifact")
    .map((output) => ({ id: output.id, artifact_type: output.artifact_type ?? "document", required: output.required }));
  const unsupported = outputs.find((output) => !supportedArtifactTypes.has(output.artifact_type));
  if (unsupported) throw new NodeOutputContractError("unsupported_codex_output_type", `Codex output type ${unsupported.artifact_type} is not supported for ${unsupported.id}.`);
  if (outputs.length === 0) throw new NodeOutputContractError("unsupported_codex_output_type", `NodeSpec ${nodeSpec.id} does not declare an artifact output supported by Codex.`);

  if (outputs.length === 1) {
    const output = outputs[0]!;
    return {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["artifact_type", "content"],
        properties: {
          artifact_type: { type: "string", enum: [output.artifact_type] },
          content: { type: "string", minLength: 1, maxLength: maxContentLength }
        }
      },
      parse(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new NodeOutputContractError("invalid_codex_artifact_output", "Codex output must be a JSON object.");
        const record = value as Record<string, unknown>;
        if (Object.keys(record).sort().join(",") !== "artifact_type,content") throw new NodeOutputContractError("invalid_codex_artifact_output", "Codex output has unexpected fields.");
        return [parseOutput({ ...record, output_id: output.id }, outputs)];
      }
    };
  }

  return {
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["outputs"],
      properties: {
        outputs: {
          type: "array",
          minItems: outputs.filter((output) => output.required).length,
          maxItems: outputs.length,
          items: { oneOf: outputs.map(outputSchema) }
        }
      }
    },
    parse(value) {
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "outputs") {
        throw new NodeOutputContractError("invalid_codex_artifact_output", "Codex multi-output response must contain only outputs.");
      }
      const values = (value as { outputs?: unknown }).outputs;
      if (!Array.isArray(values)) throw new NodeOutputContractError("invalid_codex_artifact_output", "Codex multi-output response must include an outputs array.");
      const parsed = values.map((item) => parseOutput(item, outputs));
      const ids = new Set(parsed.map((item) => item.output_id));
      if (ids.size !== parsed.length || outputs.some((output) => output.required && !ids.has(output.id))) {
        throw new NodeOutputContractError("invalid_codex_artifact_output", "Codex multi-output response is missing a required output or contains duplicates.");
      }
      return outputs.flatMap((output) => parsed.filter((item) => item.output_id === output.id));
    }
  };
}

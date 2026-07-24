import type { NodeSpec } from "@miracle/core";

const supportedArtifactTypes = new Set(["markdown", "document", "report", "script", "outline"]);
const maxTotalContentCharacters = 2_000_000;
const maxStructuredOutputProperties = 5_000;
const maxStructuredOutputStringCharacters = 120_000;
const maxStructuredOutputDepth = 10;

export class NodeOutputContractError extends Error {
  constructor(public readonly code: "unsupported_codex_output_type" | "invalid_codex_artifact_output", message: string) {
    super(message);
  }
}

function schemaValueCharacters(value: unknown) {
  if (typeof value === "string") return value.length;
  const encoded = JSON.stringify(value);
  return encoded?.length ?? 0;
}

export function assertStructuredOutputSchemaLimits(schema: Record<string, unknown>) {
  let propertyCount = 0;
  let stringCharacters = 0;

  const addStringCharacters = (value: unknown) => {
    stringCharacters += schemaValueCharacters(value);
    if (stringCharacters > maxStructuredOutputStringCharacters) {
      throw new NodeOutputContractError(
        "invalid_codex_artifact_output",
        `Codex Structured Outputs schema exceeds 120000 total characters across property names, definition names, enum values, and const values.`
      );
    }
  };

  const visit = (value: unknown, depth: number): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    if (depth > maxStructuredOutputDepth) {
      throw new NodeOutputContractError(
        "invalid_codex_artifact_output",
        "Codex Structured Outputs schema exceeds maximum nesting depth 10."
      );
    }
    const record = value as Record<string, unknown>;
    if (record.properties && typeof record.properties === "object" && !Array.isArray(record.properties)) {
      for (const [name, child] of Object.entries(record.properties as Record<string, unknown>)) {
        propertyCount += 1;
        if (propertyCount > maxStructuredOutputProperties) {
          throw new NodeOutputContractError(
            "invalid_codex_artifact_output",
            "Codex Structured Outputs schema exceeds 5000 total object properties."
          );
        }
        addStringCharacters(name);
        visit(child, depth + 1);
      }
    }
    for (const definitionKeyword of ["$defs", "definitions"]) {
      const definitions = record[definitionKeyword];
      if (!definitions || typeof definitions !== "object" || Array.isArray(definitions)) continue;
      for (const [name, child] of Object.entries(definitions as Record<string, unknown>)) {
        addStringCharacters(name);
        visit(child, depth + 1);
      }
    }
    if (record.items) {
      if (Array.isArray(record.items)) {
        for (const child of record.items) visit(child, depth + 1);
      } else {
        visit(record.items, depth + 1);
      }
    }
    for (const unionKeyword of ["anyOf", "allOf", "oneOf"]) {
      const options = record[unionKeyword];
      if (Array.isArray(options)) {
        for (const child of options) visit(child, depth + 1);
      }
    }
    if (Array.isArray(record.enum)) {
      for (const item of record.enum) addStringCharacters(item);
    }
    if (Object.hasOwn(record, "const")) addStringCharacters(record.const);
  };

  visit(schema, 1);
}

export interface NodeOutputContract {
  schema: Record<string, unknown>;
  max_encoded_bytes: number;
  parse(value: unknown): Array<{ output_id: string; artifact_type: string; content: string }>;
}

type ArtifactOutput = { id: string; artifact_type: string; required: boolean };

function outputSchema(output: ArtifactOutput, maxContentLength: number) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["output_id", "artifact_type", "content"],
    properties: {
      output_id: { const: output.id },
      artifact_type: { const: output.artifact_type },
      content: { type: "string" }
    }
  };
}

function parseOutput(value: unknown, outputs: ArtifactOutput[], maxContentLength: number) {
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

function maxEncodedBytes(outputs: ArtifactOutput[], maxContentLength: number, legacySingleOutput: boolean) {
  const contentCharacters = maxContentLength * outputs.length;
  const metadataCharacters = outputs.reduce((total, output) => total + output.id.length + output.artifact_type.length, 0);
  const structuralCharacters = legacySingleOutput ? 40 : 48 + outputs.length * 56;
  return 6 * (contentCharacters + metadataCharacters + structuralCharacters);
}

export function buildNodeOutputContract(nodeSpec: NodeSpec): NodeOutputContract {
  const outputIds = new Set<string>();
  const duplicate = nodeSpec.outputs.find((output) => {
    if (outputIds.has(output.id)) return true;
    outputIds.add(output.id);
    return false;
  });
  if (duplicate) throw new NodeOutputContractError("invalid_codex_artifact_output", `NodeSpec ${nodeSpec.id} declares duplicate output ID ${duplicate.id}.`);

  const outputs: ArtifactOutput[] = nodeSpec.outputs
    .filter((output) => output.kind === "artifact")
    .map((output) => ({ id: output.id, artifact_type: output.artifact_type ?? "document", required: output.required }));
  const unsupported = outputs.find((output) => !supportedArtifactTypes.has(output.artifact_type));
  if (unsupported) throw new NodeOutputContractError("unsupported_codex_output_type", `Codex output type ${unsupported.artifact_type} is not supported for ${unsupported.id}.`);
  if (outputs.length === 0) throw new NodeOutputContractError("unsupported_codex_output_type", `NodeSpec ${nodeSpec.id} does not declare an artifact output supported by Codex.`);

  const legacySingleOutput = outputs.length === 1 && outputs[0]!.required;
  const maxContentLength = legacySingleOutput ? maxTotalContentCharacters : Math.floor(maxTotalContentCharacters / outputs.length);
  const max_encoded_bytes = maxEncodedBytes(outputs, maxContentLength, legacySingleOutput);

  if (legacySingleOutput) {
    const output = outputs[0]!;
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["artifact_type", "content"],
      properties: {
        artifact_type: { type: "string", enum: [output.artifact_type] },
        content: { type: "string" }
      }
    };
    assertStructuredOutputSchemaLimits(schema);
    return {
      schema,
      max_encoded_bytes,
      parse(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new NodeOutputContractError("invalid_codex_artifact_output", "Codex output must be a JSON object.");
        const record = value as Record<string, unknown>;
        if (Object.keys(record).sort().join(",") !== "artifact_type,content") throw new NodeOutputContractError("invalid_codex_artifact_output", "Codex output has unexpected fields.");
        return [parseOutput({ ...record, output_id: output.id }, outputs, maxContentLength)];
      }
    };
  }

  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["outputs"],
    properties: {
      outputs: {
        type: "array",
        items: { anyOf: outputs.map((output) => outputSchema(output, maxContentLength)) }
      }
    }
  };
  assertStructuredOutputSchemaLimits(schema);
  return {
    schema,
    max_encoded_bytes,
    parse(value) {
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "outputs") {
        throw new NodeOutputContractError("invalid_codex_artifact_output", "Codex multi-output response must contain only outputs.");
      }
      const values = (value as { outputs?: unknown }).outputs;
      if (!Array.isArray(values)) throw new NodeOutputContractError("invalid_codex_artifact_output", "Codex multi-output response must include an outputs array.");
      const parsed = values.map((item) => parseOutput(item, outputs, maxContentLength));
      const ids = new Set(parsed.map((item) => item.output_id));
      if (ids.size !== parsed.length || outputs.some((output) => output.required && !ids.has(output.id))) {
        throw new NodeOutputContractError("invalid_codex_artifact_output", "Codex multi-output response is missing a required output or contains duplicates.");
      }
      return outputs.flatMap((output) => parsed.filter((item) => item.output_id === output.id));
    }
  };
}

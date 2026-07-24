import { describe, expect, it } from "vitest";
import type { NodeSpec } from "@miracle/core";
import {
  assertStructuredOutputSchemaLimits,
  NodeOutputContractError,
  buildNodeOutputContract
} from "../src/node-output-contract";

function node(outputs: NodeSpec["outputs"]): NodeSpec {
  return {
    id: "D_platform_summary",
    name: "Platform summary",
    type: "agent",
    capability_requirements: [],
    recommended_libraries: [],
    agent_candidates: [],
    inputs: [],
    outputs,
    failure_policy: { retry: 0, on_missing_input: "blocked", on_provider_failure: "failed" }
  };
}

const supportedSchemaKeywords = new Set([
  "type",
  "additionalProperties",
  "required",
  "properties",
  "items",
  "anyOf",
  "enum",
  "const"
]);
const supportedSchemaTypes = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

function expectSupportedStructuredOutputSchema(schema: unknown, location = "$"): void {
  expect(schema && typeof schema === "object" && !Array.isArray(schema), `${location} must be a schema object`).toBe(true);
  const record = schema as Record<string, unknown>;
  if (location === "$") expect(record.type, "structured-output root type").toBe("object");
  if (record.type !== undefined) expect(supportedSchemaTypes.has(String(record.type)), `${location}.type`).toBe(true);
  for (const keyword of Object.keys(record)) {
    expect(supportedSchemaKeywords.has(keyword), `${location} uses unsupported keyword ${keyword}`).toBe(true);
  }
  if (record.type === "object") {
    expect(record.additionalProperties, `${location}.additionalProperties`).toBe(false);
    const properties = record.properties as Record<string, unknown>;
    expect(Array.isArray(record.required), `${location}.required`).toBe(true);
    expect([...(record.required as string[])].sort(), `${location} must require every property`).toEqual(Object.keys(properties).sort());
    for (const [name, child] of Object.entries(properties)) expectSupportedStructuredOutputSchema(child, `${location}.properties.${name}`);
  }
  if (record.items) expectSupportedStructuredOutputSchema(record.items, `${location}.items`);
  if (record.anyOf) {
    expect(Array.isArray(record.anyOf), `${location}.anyOf`).toBe(true);
    for (const [index, child] of (record.anyOf as unknown[]).entries()) expectSupportedStructuredOutputSchema(child, `${location}.anyOf[${index}]`);
  }
}

describe("node output contract", () => {
  it.each(["markdown", "document", "report", "script", "outline"])("builds and parses the supported %s output", (artifactType) => {
    const contract = buildNodeOutputContract(node([{ id: "primary", kind: "artifact", artifact_type: artifactType, required: true }]));

    expect(contract.schema).toMatchObject({ properties: { artifact_type: { enum: [artifactType] } } });
    expect(contract.parse({ artifact_type: artifactType, content: "# generated" })).toEqual([
      { output_id: "primary", artifact_type: artifactType, content: "# generated" }
    ]);
  });

  it("requires every declared output and produces them in NodeSpec order", () => {
    const contract = buildNodeOutputContract(node([
      { id: "summary", kind: "artifact", artifact_type: "markdown", required: true },
      { id: "script", kind: "artifact", artifact_type: "script", required: true }
    ]));

    expect(contract.parse({
      outputs: [
        { output_id: "script", artifact_type: "script", content: "voiceover" },
        { output_id: "summary", artifact_type: "markdown", content: "# summary" }
      ]
    })).toEqual([
      { output_id: "summary", artifact_type: "markdown", content: "# summary" },
      { output_id: "script", artifact_type: "script", content: "voiceover" }
    ]);
  });

  it("uses only the conservative strict structured-output subset while the parser enforces semantics", () => {
    const contract = buildNodeOutputContract(node([
      { id: "summary", kind: "artifact", artifact_type: "markdown", required: true },
      { id: "optional_script", kind: "artifact", artifact_type: "script", required: false }
    ]));

    expect(contract.schema).toMatchObject({
      properties: {
        outputs: {
          type: "array",
          items: { anyOf: expect.any(Array) }
        }
      }
    });
    expectSupportedStructuredOutputSchema(contract.schema);
    expectSupportedStructuredOutputSchema(buildNodeOutputContract(node([
      { id: "legacy", kind: "artifact", artifact_type: "document", required: true }
    ])).schema);
    expectSupportedStructuredOutputSchema(buildNodeOutputContract(node([
      { id: "optional", kind: "artifact", artifact_type: "outline", required: false }
    ])).schema);
    expect(contract.parse({ outputs: [{ output_id: "summary", artifact_type: "markdown", content: "required only" }] })).toEqual([
      { output_id: "summary", artifact_type: "markdown", content: "required only" }
    ]);
    for (const invalid of [
      { outputs: [{ output_id: "summary", artifact_type: "markdown", content: "   " }] },
      { outputs: [{ output_id: "optional_script", artifact_type: "script", content: "optional" }] },
      { outputs: [{ output_id: "summary", artifact_type: "markdown", content: "one" }, { output_id: "summary", artifact_type: "markdown", content: "two" }] },
      { outputs: [{ output_id: "summary", artifact_type: "markdown", content: "one" }, { output_id: "optional_script", artifact_type: "script", content: "one" }, { output_id: "optional_script", artifact_type: "script", content: "two" }] }
    ]) {
      expect(() => contract.parse(invalid)).toThrowError(expect.objectContaining({ code: "invalid_codex_artifact_output" }));
    }
  });

  it("uses an omission-capable envelope for a single optional Artifact output", () => {
    const contract = buildNodeOutputContract(node([
      { id: "optional_summary", kind: "artifact", artifact_type: "report", required: false }
    ]));

    expect(contract.schema).toMatchObject({
      required: ["outputs"],
      properties: { outputs: { type: "array", items: { anyOf: [expect.any(Object)] } } }
    });
    expect(contract.parse({ outputs: [] })).toEqual([]);
    expect(contract.parse({ outputs: [{ output_id: "optional_summary", artifact_type: "report", content: "available" }] })).toEqual([
      { output_id: "optional_summary", artifact_type: "report", content: "available" }
    ]);
  });

  it("publishes a bounded encoded-byte ceiling that admits a schema-valid multi-output near its content limit", () => {
    const contract = buildNodeOutputContract(node([
      { id: "summary", kind: "artifact", artifact_type: "report", required: true },
      { id: "voiceover", kind: "artifact", artifact_type: "script", required: true }
    ]));
    const perOutputLimit = 1_000_000;
    const value = {
      outputs: [
        { output_id: "summary", artifact_type: "report", content: "x".repeat(perOutputLimit) },
        { output_id: "voiceover", artifact_type: "script", content: "y".repeat(perOutputLimit) }
      ]
    };

    expect(contract.parse(value)).toHaveLength(2);
    expect(Buffer.byteLength(JSON.stringify(value))).toBeGreaterThan(2_000_000);
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(contract.max_encoded_bytes);
  });

  it("blocks unsupported artifact types before a Codex process can start", () => {
    expect(() => buildNodeOutputContract(node([{ id: "data", kind: "artifact", artifact_type: "json", required: true }]))).toThrowError(
      expect.objectContaining({ code: "unsupported_codex_output_type" })
    );
    expect(NodeOutputContractError).toBeDefined();
  });

  it("rejects duplicate NodeSpec artifact output IDs even when their types match", () => {
    expect(() => buildNodeOutputContract(node([
      { id: "summary", kind: "artifact", artifact_type: "report", required: true },
      { id: "summary", kind: "artifact", artifact_type: "report", required: false }
    ]))).toThrowError(expect.objectContaining({
      code: "invalid_codex_artifact_output",
      message: expect.stringContaining("duplicate")
    }));
  });

  it("rejects duplicate output IDs across Artifact and parameter ports before filtering", () => {
    expect(() => buildNodeOutputContract(node([
      { id: "summary", kind: "artifact", artifact_type: "report", required: true },
      { id: "summary", kind: "parameter", required: false }
    ]))).toThrowError(expect.objectContaining({
      code: "invalid_codex_artifact_output",
      message: expect.stringContaining("duplicate")
    }));
  });

  it("rejects a generated schema with more than 5000 object properties", () => {
    const outputs: NodeSpec["outputs"] = Array.from({ length: 1_667 }, (_, index) => ({
      id: `output_${index}`,
      kind: "artifact",
      artifact_type: "report",
      required: true
    }));

    expect(() => buildNodeOutputContract(node(outputs))).toThrowError(expect.objectContaining({
      code: "invalid_codex_artifact_output",
      message: expect.stringContaining("5000")
    }));
  });

  it("rejects generated schema names and const values exceeding 120000 total characters", () => {
    expect(() => buildNodeOutputContract(node([
      { id: "x".repeat(120_000), kind: "artifact", artifact_type: "report", required: true },
      { id: "tail", kind: "artifact", artifact_type: "script", required: true }
    ]))).toThrowError(expect.objectContaining({
      code: "invalid_codex_artifact_output",
      message: expect.stringContaining("120000")
    }));
  });

  it("calculates schema nesting recursively and rejects depth greater than 10", () => {
    let schema: Record<string, unknown> = { type: "string" };
    for (let depth = 0; depth < 10; depth += 1) {
      schema = {
        type: "object",
        additionalProperties: false,
        required: ["value"],
        properties: { value: schema }
      };
    }

    expect(() => assertStructuredOutputSchemaLimits(schema)).toThrowError(expect.objectContaining({
      code: "invalid_codex_artifact_output",
      message: expect.stringContaining("depth 10")
    }));
  });
});

import { describe, expect, it } from "vitest";
import type { NodeSpec } from "@miracle/core";
import { NodeOutputContractError, buildNodeOutputContract } from "../src/node-output-contract";

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

  it("keeps schema and parser aligned for whitespace, missing outputs, and duplicate output IDs", () => {
    const contract = buildNodeOutputContract(node([
      { id: "summary", kind: "artifact", artifact_type: "markdown", required: true },
      { id: "optional_script", kind: "artifact", artifact_type: "script", required: false }
    ]));

    expect(contract.schema).toMatchObject({
      properties: {
        outputs: {
          items: { oneOf: expect.any(Array) },
          allOf: expect.arrayContaining([
            expect.objectContaining({ minContains: 1, maxContains: 1 }),
            expect.objectContaining({ minContains: 0, maxContains: 1 })
          ])
        }
      }
    });
    expect(JSON.stringify(contract.schema)).toContain('"pattern":"\\\\S"');
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
      properties: { outputs: { type: "array", minItems: 0, maxItems: 1 } }
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
    const perOutputLimit = (contract.schema.properties as { outputs: { items: { oneOf: Array<{ properties: { content: { maxLength: number } } }> } } }).outputs.items.oneOf[0]!.properties.content.maxLength;
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
});

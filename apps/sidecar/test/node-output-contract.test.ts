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

  it("blocks unsupported artifact types before a Codex process can start", () => {
    expect(() => buildNodeOutputContract(node([{ id: "data", kind: "artifact", artifact_type: "json", required: true }]))).toThrowError(
      expect.objectContaining({ code: "unsupported_codex_output_type" })
    );
    expect(NodeOutputContractError).toBeDefined();
  });
});

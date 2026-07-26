import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ArtifactManifest, ResolvedNodeInput } from "@miracle/core";
import { assertUniqueArtifactTargetPaths, resolveArtifactInputFiles } from "../src/artifact-input-resolver";

const runId = "run_p7_03";
const resolvedAt = "2026-07-24T08:00:00.000Z";
const workspaces: string[] = [];

function sha256(content: string) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function resolvedInput(overrides: Partial<ResolvedNodeInput> = {}): ResolvedNodeInput {
  return {
    input_id: "content_plan",
    source_kind: "artifact",
    source_ref: "artifacts/art_plan_v2.md",
    artifact_id: "art_plan_v2",
    artifact_version: 2,
    artifact_hash: sha256("approved plan"),
    media_type: "markdown",
    required: true,
    resolved_at: resolvedAt,
    ...overrides
  };
}

function artifact(overrides: Partial<ArtifactManifest> = {}): ArtifactManifest {
  return {
    artifact_id: "art_plan_v2",
    artifact_spec_ref: "content_plan_artifact",
    run_id: runId,
    node_run_id: "nr_B_content_plan",
    type: "markdown",
    version: 2,
    path: "artifacts/art_plan_v2.md",
    hash: sha256("approved plan"),
    status: "created",
    review_status: "approved",
    producer: "content-agent",
    created_at: resolvedAt,
    ...overrides
  };
}

async function fixture(input: {
  resolved?: ResolvedNodeInput[];
  manifests?: ArtifactManifest[];
  sourceContent?: string;
  writeSource?: boolean;
}) {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), "miracle-p7-03-resolver-"));
  workspaces.push(workspaceDir);
  const sourceContent = input.sourceContent ?? "approved plan";
  await mkdir(path.join(workspaceDir, "runs", runId), { recursive: true });
  await mkdir(path.join(workspaceDir, "artifacts"), { recursive: true });
  if (input.writeSource ?? true) await writeFile(path.join(workspaceDir, "artifacts", "art_plan_v2.md"), sourceContent, "utf8");
  await writeFile(path.join(workspaceDir, "runs", runId, "artifacts.json"), `${JSON.stringify(input.manifests ?? [artifact()], null, 2)}\n`, "utf8");
  return { workspaceDir, resolvedInputs: input.resolved ?? [resolvedInput()] };
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => rm(workspace, { recursive: true, force: true })));
});

describe("artifact input resolver", () => {
  it("copies only the exact artifact version and hash selected by the execution plan", async () => {
    const { workspaceDir, resolvedInputs } = await fixture({});

    await expect(resolveArtifactInputFiles({ workspaceDir, runId, resolvedInputs })).resolves.toEqual([
      expect.objectContaining({
        artifact_id: "art_plan_v2",
        artifact_version: 2,
        hash: sha256("approved plan"),
        target_path: "artifacts/art_plan_v2.md"
      })
    ]);
  });

  it.each([
    ["hash_mismatch", { sourceContent: "tampered plan" }],
    ["artifact_missing", { manifests: [] }],
    ["artifact_missing", { manifests: [artifact({ status: "missing" })] }],
    ["media_type_mismatch", { resolved: [resolvedInput({ media_type: "document" })] }],
    ["version_mismatch", { resolved: [resolvedInput({ artifact_version: 1 })] }],
    ["workspace_escape", { resolved: [resolvedInput({ source_ref: "../outside.md" })], manifests: [artifact({ path: "../outside.md" })] }]
  ])("blocks invalid artifact handoff: %s", async (reason, input) => {
    const { workspaceDir, resolvedInputs } = await fixture(input);

    await expect(resolveArtifactInputFiles({ workspaceDir, runId, resolvedInputs })).rejects.toMatchObject({ code: reason });
  });

  it("rejects symbolic links even when their resolved target is inside the workspace", async () => {
    const { workspaceDir, resolvedInputs } = await fixture({});
    const source = path.join(workspaceDir, "artifacts", "art_plan_v2.md");
    const target = path.join(workspaceDir, "artifacts", "source.md");
    await writeFile(target, "approved plan", "utf8");
    await rm(source);
    await symlink("source.md", source);

    await expect(resolveArtifactInputFiles({ workspaceDir, runId, resolvedInputs })).rejects.toMatchObject({ code: "workspace_escape" });
  });

  it("allocates every target in one deterministic case-insensitive global pass", async () => {
    const workspaceDir = await mkdtemp(path.join(tmpdir(), "miracle-p7-03-resolver-collisions-"));
    workspaces.push(workspaceDir);
    await mkdir(path.join(workspaceDir, "runs", runId), { recursive: true });
    await mkdir(path.join(workspaceDir, "artifacts"), { recursive: true });

    const slashHash = sha256("content-0");
    const slashSuffix = createHash("sha256").update(`A/B:1:${slashHash}`).digest("hex").slice(0, 12);
    const artifactIds = ["A/B", "A?B", `A_B-${slashSuffix}`, "Summary", "summary"];
    const manifests: ArtifactManifest[] = [];
    const resolvedInputs: ResolvedNodeInput[] = [];
    for (const [index, artifactId] of artifactIds.entries()) {
      const content = `content-${index}`;
      const sourceRef = `artifacts/source-${index}.md`;
      const hash = sha256(content);
      await writeFile(path.join(workspaceDir, sourceRef), content, "utf8");
      manifests.push(artifact({
        artifact_id: artifactId,
        version: 1,
        path: sourceRef,
        hash
      }));
      resolvedInputs.push(resolvedInput({
        input_id: `input-${index}`,
        source_ref: sourceRef,
        artifact_id: artifactId,
        artifact_version: 1,
        artifact_hash: hash
      }));
    }
    await writeFile(path.join(workspaceDir, "runs", runId, "artifacts.json"), `${JSON.stringify(manifests, null, 2)}\n`, "utf8");

    const forward = await resolveArtifactInputFiles({ workspaceDir, runId, resolvedInputs });
    const reversed = await resolveArtifactInputFiles({ workspaceDir, runId, resolvedInputs: [...resolvedInputs].reverse() });
    const forwardTargets = new Map(forward.map((file) => [file.artifact_id, file.target_path]));
    const reversedTargets = new Map(reversed.map((file) => [file.artifact_id, file.target_path]));
    const caseFoldedTargets = forward.map((file) => file.target_path.toLowerCase());

    expect(reversedTargets).toEqual(forwardTargets);
    expect(new Set(caseFoldedTargets).size).toBe(forward.length);
    expect(caseFoldedTargets).toContain(`artifacts/a_b-${slashSuffix}.md`.toLowerCase());
  });

  it("fails preflight explicitly when resolved target paths are not case-insensitively unique", () => {
    expect(() => assertUniqueArtifactTargetPaths([
      { target_path: "artifacts/Summary.md" },
      { target_path: "artifacts/summary.MD" }
    ])).toThrowError(expect.objectContaining({
      code: "artifact_target_collision",
      message: expect.stringContaining("case-insensitively unique")
    }));
  });
});

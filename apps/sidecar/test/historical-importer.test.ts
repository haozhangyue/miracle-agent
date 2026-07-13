import { beforeEach, describe, expect, it } from "vitest";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { commitHistoricalImport, previewHistoricalImport } from "../src/historical-importer";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const sourceFixtures = path.join(repoRoot, "apps/sidecar/test/fixtures/historical");
const workflowPath = path.join(repoRoot, "fixtures/mvp-workspace/.miracle/workflows/content-production-real-v0.json");

let tempRoot = "";
let workspaceDir = "";
let importRoot = "";

beforeEach(async () => {
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = await mkdtemp(path.join(tmpdir(), "miracle-historical-"));
  workspaceDir = path.join(tempRoot, ".miracle");
  importRoot = path.join(tempRoot, "sources");
  await cp(sourceFixtures, importRoot, { recursive: true });
});

describe("historical importer", () => {
  it("previews W24 without writing a run and rejects sources outside allowed roots", async () => {
    const sourceRunDir = path.join(importRoot, "w24-minimal");
    const beforeMtime = (await stat(path.join(sourceRunDir, "00_任务控制/task_events.jsonl"))).mtimeMs;
    const preview = await previewHistoricalImport(
      { source_run_dir: sourceRunDir, workflow_id: "content-production-real-v0", sample_kind: "w24" },
      { workspaceDir, allowedRoots: [importRoot], workflowPath, repositoryRoot: repoRoot, now: "2026-07-11T00:00:00.000Z" }
    );

    expect(preview.preview.valid).toBe(true);
    expect(preview.preview.projected_counts).toMatchObject({ nodes: 8, gates: 3 });
    expect(preview.projection.nodeRuns.find((node) => node.node_id === "F_final_render")?.status).toBe("reviewing");
    expect(preview.projection.artifacts.find((artifact) => artifact.node_run_id.endsWith("_B_md_master"))?.review_status).toBe("none");
    expect(preview.projection.gates.some((gate) => gate.gate_spec_id === "B_md_master_gate")).toBe(false);
    expect(preview.projection.gates.find((gate) => gate.gate_spec_id === "C_ppt_storyboard_gate")).toMatchObject({ status: "decided", decisions: [{ decision: "approve" }] });
    expect(preview.projection.gates.find((gate) => gate.gate_spec_id === "F_final_render_gate")).toMatchObject({ status: "pending_review", decisions: [] });
    await expect(readdir(path.join(workspaceDir, "runs"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(path.join(sourceRunDir, "00_任务控制/task_events.jsonl"))).mtimeMs).toBe(beforeMtime);

    await expect(
      previewHistoricalImport(
        { source_run_dir: tempRoot, workflow_id: "content-production-real-v0", sample_kind: "w24" },
        { workspaceDir, allowedRoots: [importRoot], workflowPath, repositoryRoot: repoRoot }
      )
    ).rejects.toMatchObject({ code: "source_path_not_allowed" });
  });

  it("commits W24 atomically and reuses the run for the same fingerprint", async () => {
    const sourceRunDir = path.join(importRoot, "w24-minimal");
    const options = { workspaceDir, allowedRoots: [importRoot], workflowPath, repositoryRoot: repoRoot, now: "2026-07-11T00:00:00.000Z" };
    const first = await commitHistoricalImport({ source_run_dir: sourceRunDir, workflow_id: "content-production-real-v0", sample_kind: "w24" }, options);
    const second = await commitHistoricalImport({ source_run_dir: sourceRunDir, workflow_id: "content-production-real-v0", sample_kind: "w24" }, options);

    expect(first.reused).toBe(false);
    expect(second).toMatchObject({ reused: true, run_id: first.run_id, import_id: first.import_id });
    const runDir = path.join(workspaceDir, "runs", first.run_id);
    expect(JSON.parse(await readFile(path.join(runDir, "run_spec.json"), "utf8"))).toMatchObject({ run_mode: "historical_readonly", execution_policy: null });
    expect(JSON.parse(await readFile(path.join(runDir, "source_meta.json"), "utf8"))).toMatchObject({ source_fingerprint: first.source_fingerprint, mode: "historical_readonly" });
    expect(await readFile(path.join(runDir, "events.jsonl"), "utf8")).toContain("historical_source_event");
    await expect(stat(path.join(workspaceDir, "runs", ".staging", first.import_id))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("changes the fingerprint when content changes with the same path, size and mtime", async () => {
    const sourceRunDir = path.join(importRoot, "w24-minimal");
    const target = path.join(sourceRunDir, "00_任务控制/task_events.jsonl");
    const metadata = await stat(target);
    const first = await previewHistoricalImport(
      { source_run_dir: sourceRunDir, workflow_id: "content-production-real-v0", sample_kind: "w24" },
      { workspaceDir, allowedRoots: [importRoot], workflowPath, repositoryRoot: repoRoot }
    );
    const original = await readFile(target, "utf8");
    const changed = original.replace("start timeline", "start timelinE");
    expect(Buffer.byteLength(changed)).toBe(Buffer.byteLength(original));
    await writeFile(target, changed, "utf8");
    await utimes(target, metadata.atime, metadata.mtime);

    const second = await previewHistoricalImport(
      { source_run_dir: sourceRunDir, workflow_id: "content-production-real-v0", sample_kind: "w24" },
      { workspaceDir, allowedRoots: [importRoot], workflowPath, repositoryRoot: repoRoot }
    );
    expect(second.preview.source_fingerprint).not.toBe(first.preview.source_fingerprint);
  });

  it("repairs a missing receipt on retry and serializes concurrent commits", async () => {
    const sourceRunDir = path.join(importRoot, "w24-minimal");
    const request = { source_run_dir: sourceRunDir, workflow_id: "content-production-real-v0", sample_kind: "w24" as const };
    const options = { workspaceDir, allowedRoots: [importRoot], workflowPath, repositoryRoot: repoRoot, now: "2026-07-11T00:00:00.000Z" };
    const concurrent = await Promise.all([commitHistoricalImport(request, options), commitHistoricalImport(request, options)]);
    expect(concurrent.filter((result) => !result.reused)).toHaveLength(1);
    expect(concurrent.filter((result) => result.reused)).toHaveLength(1);

    const receiptPath = path.join(workspaceDir, "imports", `${concurrent[0].import_id}.json`);
    await unlink(receiptPath);
    const repaired = await commitHistoricalImport(request, options);
    expect(repaired.reused).toBe(true);
    expect(JSON.parse(await readFile(receiptPath, "utf8"))).toMatchObject({ import_id: repaired.import_id, run_id: repaired.run_id, status: "committed" });
  });

  it("refuses to commit historical data into the repository workspace", async () => {
    await expect(
      commitHistoricalImport(
        { source_run_dir: path.join(importRoot, "w24-minimal"), workflow_id: "content-production-real-v0", sample_kind: "w24" },
        { workspaceDir: path.join(repoRoot, "fixtures/mvp-workspace/.miracle"), allowedRoots: [importRoot], workflowPath, repositoryRoot: repoRoot }
      )
    ).rejects.toMatchObject({ code: "runtime_workspace_required" });
  });

  it("refuses a symlinked workspace that resolves inside the repository", async () => {
    const repositoryRoot = path.join(tempRoot, "repository");
    const repositoryWorkspace = path.join(repositoryRoot, "runtime", ".miracle");
    const linkedWorkspace = path.join(tempRoot, "external-workspace-link");
    await mkdir(repositoryWorkspace, { recursive: true });
    await symlink(repositoryWorkspace, linkedWorkspace, "dir");

    await expect(
      commitHistoricalImport(
        { source_run_dir: path.join(importRoot, "w24-minimal"), workflow_id: "content-production-real-v0", sample_kind: "w24" },
        { workspaceDir: linkedWorkspace, allowedRoots: [importRoot], workflowPath, repositoryRoot }
      )
    ).rejects.toMatchObject({ code: "runtime_workspace_required" });
  });

  it("recovers a stale import lock whose owner process no longer exists", async () => {
    const sourceRunDir = path.join(importRoot, "w24-minimal");
    const request = { source_run_dir: sourceRunDir, workflow_id: "content-production-real-v0", sample_kind: "w24" as const };
    const options = { workspaceDir, allowedRoots: [importRoot], workflowPath, repositoryRoot: repoRoot, now: "2026-07-11T00:00:00.000Z" };
    const preview = await previewHistoricalImport(request, options);
    const lockDir = path.join(workspaceDir, "imports", ".locks", `${preview.preview.import_id}.lock`);
    await mkdir(lockDir, { recursive: true });
    await writeFile(path.join(lockDir, "owner.json"), JSON.stringify({ pid: 999_999_999, created_at: "2000-01-01T00:00:00.000Z" }), "utf8");
    const old = new Date("2000-01-01T00:00:00.000Z");
    await utimes(lockDir, old, old);

    await expect(commitHistoricalImport(request, options)).resolves.toMatchObject({ reused: false });
  }, 7_000);

  it("recovers a stale import lock with incomplete owner metadata", async () => {
    const sourceRunDir = path.join(importRoot, "w24-minimal");
    const request = { source_run_dir: sourceRunDir, workflow_id: "content-production-real-v0", sample_kind: "w24" as const };
    const options = { workspaceDir, allowedRoots: [importRoot], workflowPath, repositoryRoot: repoRoot };
    const preview = await previewHistoricalImport(request, options);
    const lockDir = path.join(workspaceDir, "imports", ".locks", `${preview.preview.import_id}.lock`);
    await mkdir(lockDir, { recursive: true });
    await writeFile(path.join(lockDir, "owner.json"), "{incomplete", "utf8");
    const old = new Date("2000-01-01T00:00:00.000Z");
    await utimes(lockDir, old, old);

    await expect(commitHistoricalImport(request, options)).resolves.toMatchObject({ reused: false });
  });

  it("reports malformed control JSON as invalid source data", async () => {
    const sourceRunDir = path.join(importRoot, "w24-minimal");
    await writeFile(path.join(sourceRunDir, "00_任务控制/task_trace.json"), "{not-json", "utf8");

    await expect(
      previewHistoricalImport(
        { source_run_dir: sourceRunDir, workflow_id: "content-production-real-v0", sample_kind: "w24" },
        { workspaceDir, allowedRoots: [importRoot], workflowPath, repositoryRoot: repoRoot }
      )
    ).rejects.toMatchObject({ code: "invalid_source_data" });
  });

  it("rejects unsupported control-file schema versions", async () => {
    const sourceRunDir = path.join(importRoot, "w24-minimal");
    const decisionsPath = path.join(sourceRunDir, "00_任务控制/approval_decisions.jsonl");
    const decisions = await readFile(decisionsPath, "utf8");
    await writeFile(decisionsPath, decisions.replace('"schema_version":1', '"schema_version":999'), "utf8");

    await expect(
      previewHistoricalImport(
        { source_run_dir: sourceRunDir, workflow_id: "content-production-real-v0", sample_kind: "w24" },
        { workspaceDir, allowedRoots: [importRoot], workflowPath, repositoryRoot: repoRoot }
      )
    ).rejects.toMatchObject({ code: "invalid_source_data" });
  });

  it("degrades W23 to inferred artifacts and gap attention without source events or attempts", async () => {
    const result = await commitHistoricalImport(
      { source_run_dir: path.join(importRoot, "w23-minimal"), workflow_id: "content-production-real-v0", sample_kind: "w23" },
      { workspaceDir, allowedRoots: [importRoot], workflowPath, repositoryRoot: repoRoot, now: "2026-07-11T00:00:00.000Z" }
    );
    const runDir = path.join(workspaceDir, "runs", result.run_id);
    const sourceMeta = JSON.parse(await readFile(path.join(runDir, "source_meta.json"), "utf8")) as { gaps: Array<{ code: string }> };
    const attempts = JSON.parse(await readFile(path.join(runDir, "attempts.json"), "utf8")) as unknown[];
    const events = (await readFile(path.join(runDir, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string });

    expect(sourceMeta.gaps.some((gap) => gap.code === "control_files_missing")).toBe(true);
    expect(attempts).toEqual([]);
    expect(events.map((event) => event.type)).toEqual(["historical_run_imported"]);
  });

  it("keeps artifact ids unique when non-ASCII media names normalize to the same safe id", async () => {
    const sourceRunDir = path.join(importRoot, "w24-minimal");
    await mkdir(path.join(sourceRunDir, "media"), { recursive: true });
    await writeFile(path.join(sourceRunDir, "media/版本甲.mp4"), "video-a", "utf8");
    await writeFile(path.join(sourceRunDir, "media/版本乙.mp4"), "video-b", "utf8");

    const result = await commitHistoricalImport(
      { source_run_dir: sourceRunDir, workflow_id: "content-production-real-v0", sample_kind: "w24" },
      { workspaceDir, allowedRoots: [importRoot], workflowPath, repositoryRoot: repoRoot }
    );
    const artifacts = JSON.parse(await readFile(path.join(workspaceDir, "runs", result.run_id, "artifacts.json"), "utf8")) as Array<{ artifact_id: string }>;
    expect(new Set(artifacts.map((artifact) => artifact.artifact_id)).size).toBe(artifacts.length);
  });
});

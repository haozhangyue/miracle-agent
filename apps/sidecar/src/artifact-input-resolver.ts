import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { ArtifactManifest, ResolvedNodeInput } from "@miracle/core";

type ArtifactInputResolverErrorCode =
  | "artifact_missing"
  | "hash_mismatch"
  | "media_type_mismatch"
  | "version_mismatch"
  | "workspace_escape"
  | "run_ownership_mismatch"
  | "artifact_reference_invalid"
  | "artifact_target_collision";

export class ArtifactInputResolverError extends Error {
  constructor(public readonly code: ArtifactInputResolverErrorCode, message: string) {
    super(message);
  }
}

export interface ResolvedArtifactFile {
  input_id: string;
  artifact_id: string;
  artifact_version: number;
  hash: string;
  media_type: string;
  source_path: string;
  target_path: string;
}

export function assertUniqueArtifactTargetPaths(files: Array<Pick<ResolvedArtifactFile, "target_path">>) {
  const targets = files.map((file) => file.target_path.toLowerCase());
  if (new Set(targets).size !== targets.length) {
    throw new ArtifactInputResolverError(
      "artifact_target_collision",
      "Resolved Artifact target paths must be case-insensitively unique."
    );
  }
}

function isWithin(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function safeTargetStem(value: string) {
  const normalized = value.replace(/[^A-Za-z0-9_-]/g, "_");
  return normalized.length > 0 ? normalized : "artifact";
}

function extensionForArtifact(artifact: ArtifactManifest) {
  const extension = path.extname(artifact.path);
  return /^\.[A-Za-z0-9]{1,12}$/.test(extension) ? extension.toLowerCase() : ".txt";
}

function collisionSuffix(artifact: ArtifactManifest) {
  return createHash("sha256").update(`${artifact.artifact_id}:${artifact.version}:${artifact.hash}`).digest("hex");
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function allocateTargetFileNames(candidates: Array<{ resolved: ResolvedNodeInput; artifact: ArtifactManifest }>) {
  const entries = candidates.map(({ resolved, artifact }, index) => {
    const extension = extensionForArtifact(artifact);
    const stem = safeTargetStem(artifact.artifact_id);
    return {
      index,
      resolved,
      artifact,
      extension,
      stem,
      base: `${stem}${extension}`,
      identity: [artifact.artifact_id, String(artifact.version), artifact.hash, resolved.input_id, resolved.source_ref].join("\0")
    };
  });
  const baseOwners = new Map<string, typeof entries>();
  for (const entry of entries) {
    const key = entry.base.toLowerCase();
    const owners = baseOwners.get(key) ?? [];
    owners.push(entry);
    baseOwners.set(key, owners);
  }

  const reserved = new Set(baseOwners.keys());
  const allocated = new Map<number, string>();
  for (const owners of baseOwners.values()) {
    if (owners.length === 1) allocated.set(owners[0]!.index, owners[0]!.base);
  }

  const colliding = entries
    .filter((entry) => (baseOwners.get(entry.base.toLowerCase())?.length ?? 0) > 1)
    .sort((left, right) => compareText(left.identity, right.identity));
  for (const entry of colliding) {
    const suffix = collisionSuffix(entry.artifact);
    let suffixLength = 12;
    let candidate = `${entry.stem}-${suffix.slice(0, suffixLength)}${entry.extension}`;
    while (reserved.has(candidate.toLowerCase()) && suffixLength < suffix.length) {
      suffixLength = Math.min(suffixLength + 4, suffix.length);
      candidate = `${entry.stem}-${suffix.slice(0, suffixLength)}${entry.extension}`;
    }
    let disambiguator = 2;
    const candidateBase = candidate.slice(0, -entry.extension.length);
    while (reserved.has(candidate.toLowerCase())) {
      candidate = `${candidateBase}-${disambiguator}${entry.extension}`;
      disambiguator += 1;
    }
    allocated.set(entry.index, candidate);
    reserved.add(candidate.toLowerCase());
  }
  return entries.map((entry) => allocated.get(entry.index)!);
}

async function readRunArtifacts(workspaceDir: string, runId: string): Promise<ArtifactManifest[]> {
  const artifactIndexPath = path.join(workspaceDir, "runs", runId, "artifacts.json");
  try {
    const value = JSON.parse(await readFile(artifactIndexPath, "utf8")) as unknown;
    if (!Array.isArray(value)) throw new Error("Artifact index must be an array.");
    return value as ArtifactManifest[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    if (error instanceof SyntaxError) throw new ArtifactInputResolverError("artifact_reference_invalid", "Run artifact index is not valid JSON.");
    throw error;
  }
}

function artifactForResolvedInput(resolved: ResolvedNodeInput, manifests: ArtifactManifest[], runId: string) {
  if (!resolved.artifact_id || !resolved.artifact_version || !resolved.artifact_hash) {
    throw new ArtifactInputResolverError("artifact_reference_invalid", `Resolved artifact input ${resolved.input_id} is incomplete.`);
  }
  const artifact = manifests.find((candidate) => candidate.artifact_id === resolved.artifact_id);
  if (!artifact) throw new ArtifactInputResolverError("artifact_missing", `Artifact ${resolved.artifact_id} is not present in the Run manifest.`);
  if (artifact.run_id !== runId) throw new ArtifactInputResolverError("run_ownership_mismatch", `Artifact ${artifact.artifact_id} does not belong to Run ${runId}.`);
  if (artifact.status !== "created") throw new ArtifactInputResolverError("artifact_missing", `Artifact ${artifact.artifact_id} is not available for input handoff.`);
  if (artifact.version !== resolved.artifact_version) throw new ArtifactInputResolverError("version_mismatch", `Artifact ${artifact.artifact_id} version does not match the execution plan.`);
  if (artifact.hash !== resolved.artifact_hash) throw new ArtifactInputResolverError("hash_mismatch", `Artifact ${artifact.artifact_id} hash does not match the execution plan.`);
  if (artifact.type !== resolved.media_type) throw new ArtifactInputResolverError("media_type_mismatch", `Artifact ${artifact.artifact_id} media type does not match the execution plan.`);
  if (artifact.path !== resolved.source_ref) throw new ArtifactInputResolverError("workspace_escape", `Artifact ${artifact.artifact_id} source path does not match the execution plan.`);
  return artifact;
}

async function verifyArtifactSource(workspaceRoot: string, artifact: ArtifactManifest) {
  const sourcePath = path.resolve(workspaceRoot, artifact.path);
  if (!isWithin(workspaceRoot, sourcePath)) throw new ArtifactInputResolverError("workspace_escape", `Artifact ${artifact.artifact_id} path escapes the workspace.`);
  let sourceEntry: Awaited<ReturnType<typeof lstat>>;
  try {
    sourceEntry = await lstat(sourcePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ArtifactInputResolverError("artifact_missing", `Artifact ${artifact.artifact_id} source file is missing.`);
    throw error;
  }
  if (sourceEntry.isSymbolicLink() || !sourceEntry.isFile()) throw new ArtifactInputResolverError("workspace_escape", `Artifact ${artifact.artifact_id} source must be a regular non-symbolic file.`);
  const canonicalSource = await realpath(sourcePath);
  if (!isWithin(workspaceRoot, canonicalSource)) throw new ArtifactInputResolverError("workspace_escape", `Artifact ${artifact.artifact_id} source escapes the canonical workspace.`);
  const sourceStat = await stat(canonicalSource);
  if (!sourceStat.isFile()) throw new ArtifactInputResolverError("workspace_escape", `Artifact ${artifact.artifact_id} source must be a regular file.`);
  const hash = `sha256:${createHash("sha256").update(await readFile(canonicalSource)).digest("hex")}`;
  if (hash !== artifact.hash) throw new ArtifactInputResolverError("hash_mismatch", `Artifact ${artifact.artifact_id} source hash does not match its manifest.`);
  return canonicalSource;
}

export async function resolveArtifactInputFiles(input: {
  workspaceDir: string;
  runId: string;
  resolvedInputs: ResolvedNodeInput[];
}): Promise<ResolvedArtifactFile[]> {
  const workspaceRoot = await realpath(input.workspaceDir);
  const manifests = await readRunArtifacts(workspaceRoot, input.runId);
  const candidates = input.resolvedInputs
    .filter((resolved) => resolved.source_kind === "artifact")
    .map((resolved) => ({ resolved, artifact: artifactForResolvedInput(resolved, manifests, input.runId) }));
  const targetFileNames = allocateTargetFileNames(candidates);

  const resolvedFiles: ResolvedArtifactFile[] = [];
  for (const [index, { resolved, artifact }] of candidates.entries()) {
    const sourcePath = await verifyArtifactSource(workspaceRoot, artifact);
    resolvedFiles.push({
      input_id: resolved.input_id,
      artifact_id: artifact.artifact_id,
      artifact_version: artifact.version,
      hash: artifact.hash,
      media_type: artifact.type,
      source_path: sourcePath,
      target_path: path.posix.join("artifacts", targetFileNames[index]!)
    });
  }
  return resolvedFiles;
}

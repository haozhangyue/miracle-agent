import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

export type HelpRole = "all" | "user" | "administrator" | "developer";

export type HelpArticleManifest = {
  id: string;
  title: string;
  role: HelpRole;
  source: string;
  order: number;
  summary: string;
  tags: string[];
};

export type HelpAssetManifest = {
  id: string;
  source: string;
  media_type: "image/png" | "image/jpeg" | "image/webp";
};

export type HelpManifest = {
  schema_version: "1.0";
  product_version: string;
  verified_at: string;
  articles: HelpArticleManifest[];
  assets: HelpAssetManifest[];
};

export type HelpCenterOptions = {
  manuals_dir: string;
  assets_dir: string;
};

export type HelpHeading = {
  depth: 2 | 3;
  text: string;
  anchor: string;
};

export class HelpCenterError extends Error {
  constructor(
    readonly code:
      | "help_manifest_invalid"
      | "help_article_not_found"
      | "help_asset_not_allowed"
      | "help_content_unavailable"
      | "help_query_invalid",
    message: string
  ) {
    super(message);
    this.name = "HelpCenterError";
  }
}

const allowedRoles = new Set<HelpRole>(["all", "user", "administrator", "developer"]);
const allowedMediaTypes = new Set<HelpAssetManifest["media_type"]>(["image/png", "image/jpeg", "image/webp"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSafeRelativePath(value: string) {
  if (path.isAbsolute(value) || value.includes("\0")) return false;
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  return normalized !== ".." && !normalized.startsWith("../") && normalized === value.replaceAll("\\", "/");
}

function assertUnique(values: string[], label: string) {
  if (new Set(values).size !== values.length) {
    throw new HelpCenterError("help_manifest_invalid", `Help manifest contains duplicate ${label}.`);
  }
}

function parseManifest(value: unknown): HelpManifest {
  if (!isRecord(value) || value.schema_version !== "1.0" || !isNonEmptyString(value.product_version) || !isNonEmptyString(value.verified_at)) {
    throw new HelpCenterError("help_manifest_invalid", "Help manifest metadata is invalid.");
  }
  if (!Array.isArray(value.articles) || !Array.isArray(value.assets)) {
    throw new HelpCenterError("help_manifest_invalid", "Help manifest articles and assets must be arrays.");
  }

  const articles = value.articles.map((item): HelpArticleManifest => {
    if (!isRecord(item) || !isNonEmptyString(item.id) || !isNonEmptyString(item.title) || !isNonEmptyString(item.source)
      || !isNonEmptyString(item.summary) || !allowedRoles.has(item.role as HelpRole) || typeof item.order !== "number" || !Number.isFinite(item.order)
      || !Array.isArray(item.tags) || !item.tags.every(isNonEmptyString) || !isSafeRelativePath(item.source)) {
      throw new HelpCenterError("help_manifest_invalid", "Help manifest contains an invalid article.");
    }
    return {
      id: item.id,
      title: item.title,
      role: item.role as HelpRole,
      source: item.source,
      order: item.order as number,
      summary: item.summary,
      tags: item.tags as string[]
    };
  });

  const assets = value.assets.map((item): HelpAssetManifest => {
    if (!isRecord(item) || !isNonEmptyString(item.id) || !isNonEmptyString(item.source)
      || !allowedMediaTypes.has(item.media_type as HelpAssetManifest["media_type"]) || !isSafeRelativePath(item.source)) {
      throw new HelpCenterError("help_manifest_invalid", "Help manifest contains an invalid asset.");
    }
    return { id: item.id, source: item.source, media_type: item.media_type as HelpAssetManifest["media_type"] };
  });

  assertUnique(articles.map((item) => item.id), "article IDs");
  assertUnique(articles.map((item) => item.source), "article sources");
  assertUnique(assets.map((item) => item.id), "asset IDs");
  assertUnique(assets.map((item) => item.source), "asset sources");

  return {
    schema_version: "1.0",
    product_version: value.product_version,
    verified_at: value.verified_at,
    articles: articles.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id)),
    assets
  };
}

async function resolveAllowlistedFile(root: string, source: string, notFoundCode: HelpCenterError["code"]) {
  if (!isSafeRelativePath(source)) throw new HelpCenterError(notFoundCode, "Help content path is not allowed.");
  try {
    const rootRealPath = await realpath(root);
    const candidate = path.resolve(rootRealPath, source);
    const candidateRealPath = await realpath(candidate);
    const relative = path.relative(rootRealPath, candidateRealPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new HelpCenterError(notFoundCode, "Help content resolves outside its allowlisted root.");
    }
    const metadata = await lstat(candidateRealPath);
    if (!metadata.isFile()) throw new HelpCenterError(notFoundCode, "Help content is not a regular file.");
    return candidateRealPath;
  } catch (error) {
    if (error instanceof HelpCenterError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") {
      throw new HelpCenterError(notFoundCode, "Help content is unavailable.");
    }
    throw new HelpCenterError("help_content_unavailable", "Help content could not be read.");
  }
}

export async function loadHelpManifest(options: HelpCenterOptions): Promise<HelpManifest> {
  try {
    const manifestPath = await resolveAllowlistedFile(options.manuals_dir, "help-manifest.json", "help_manifest_invalid");
    return parseManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  } catch (error) {
    if (error instanceof HelpCenterError) throw error;
    throw new HelpCenterError("help_manifest_invalid", "Help manifest is not valid JSON.");
  }
}

export async function listHelp(options: HelpCenterOptions) {
  const manifest = await loadHelpManifest(options);
  return {
    schema_version: manifest.schema_version,
    product_version: manifest.product_version,
    verified_at: manifest.verified_at,
    roles: ["all", "user", "administrator", "developer"] as HelpRole[],
    articles: manifest.articles.map(({ source: _source, ...article }) => article)
  };
}

function slugifyHeading(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s/]+/g, "-")
    .replace(/[^\p{L}\p{N}_-]/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function extractHeadings(markdown: string): HelpHeading[] {
  const counts = new Map<string, number>();
  const headings: HelpHeading[] = [];
  let inFence = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^(##|###)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const text = match[2].replace(/\s+#+$/, "").trim();
    const base = slugifyHeading(text) || "section";
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    headings.push({ depth: match[1].length as 2 | 3, text, anchor: count === 0 ? base : `${base}-${count}` });
  }
  return headings;
}

function assetUrlMap(markdown: string, manifest: HelpManifest) {
  const map: Record<string, string> = {};
  for (const asset of manifest.assets) {
    const marker = `assets/manual/${asset.source}`;
    if (markdown.includes(marker)) map[marker] = `/api/v0/help/assets/${encodeURIComponent(asset.id)}`;
  }
  return map;
}

export async function readHelpArticle(articleId: string, options: HelpCenterOptions) {
  const manifest = await loadHelpManifest(options);
  const article = manifest.articles.find((item) => item.id === articleId);
  if (!article) throw new HelpCenterError("help_article_not_found", "Help article was not found.");
  const articlePath = await resolveAllowlistedFile(options.manuals_dir, article.source, "help_article_not_found");
  const markdown = await readFile(articlePath, "utf8");
  const { source: _source, ...metadata } = article;
  return { article: metadata, markdown, headings: extractHeadings(markdown), asset_url_map: assetUrlMap(markdown, manifest) };
}

function searchSnippet(markdown: string, query: string) {
  const normalized = markdown.replace(/[`#>*_|\[\]()-]/g, " ").replace(/\s+/g, " ").trim();
  const index = normalized.toLocaleLowerCase("zh-CN").indexOf(query.toLocaleLowerCase("zh-CN"));
  if (index < 0) return normalized.slice(0, 140);
  const start = Math.max(0, index - 45);
  const end = Math.min(normalized.length, index + query.length + 75);
  return `${start > 0 ? "…" : ""}${normalized.slice(start, end)}${end < normalized.length ? "…" : ""}`;
}

export async function searchHelp(query: string, role: string | null, options: HelpCenterOptions) {
  const trimmed = query.trim();
  if (trimmed.length > 120) throw new HelpCenterError("help_query_invalid", "Help search query is too long.");
  if (role && !allowedRoles.has(role as HelpRole)) throw new HelpCenterError("help_query_invalid", "Help role filter is invalid.");
  if (!trimmed) return { query: "", role: role ?? "all", results: [] };

  const manifest = await loadHelpManifest(options);
  const needle = trimmed.toLocaleLowerCase("zh-CN");
  const results = [];
  for (const article of manifest.articles) {
    if (role && role !== "all" && article.role !== "all" && article.role !== role) continue;
    const articlePath = await resolveAllowlistedFile(options.manuals_dir, article.source, "help_article_not_found");
    const markdown = await readFile(articlePath, "utf8");
    const haystack = [article.title, article.summary, ...article.tags, markdown].join("\n").toLocaleLowerCase("zh-CN");
    if (!haystack.includes(needle)) continue;
    const { source: _source, ...metadata } = article;
    results.push({ article: metadata, snippet: searchSnippet(markdown, trimmed) });
  }
  return { query: trimmed, role: role ?? "all", results };
}

export async function readHelpAsset(assetId: string, options: HelpCenterOptions) {
  const manifest = await loadHelpManifest(options);
  const asset = manifest.assets.find((item) => item.id === assetId);
  if (!asset) throw new HelpCenterError("help_asset_not_allowed", "Help asset is not allowlisted.");
  const assetPath = await resolveAllowlistedFile(options.assets_dir, asset.source, "help_asset_not_allowed");
  return { data: await readFile(assetPath), media_type: asset.media_type, asset_id: asset.id };
}

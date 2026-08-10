import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  HelpCenterError,
  listHelp,
  loadHelpManifest,
  readHelpArticle,
  readHelpAsset,
  searchHelp,
  type HelpCenterOptions
} from "../src/help-center";

const roots: string[] = [];

async function fixture(): Promise<HelpCenterOptions> {
  const root = await mkdtemp(path.join(tmpdir(), "miracle-help-"));
  roots.push(root);
  const manualsDir = path.join(root, "manuals");
  const assetsDir = path.join(root, "assets");
  await mkdir(path.join(manualsDir, "user"), { recursive: true });
  await mkdir(path.join(assetsDir, "v0.9.0"), { recursive: true });
  await writeFile(path.join(manualsDir, "README.md"), "# 帮助中心\n\n## 快速开始\n\n选择手册。\n", "utf8");
  await writeFile(path.join(manualsDir, "user/guide.md"), "# 使用者手册\n\n## 新任务\n\n创建 RunDraft。\n\n### Dry-run\n\n检查 Gate 和 Provider。\n\n![首页](../../assets/manual/v0.9.0/home.png)\n", "utf8");
  await writeFile(path.join(assetsDir, "v0.9.0/home.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(path.join(manualsDir, "help-manifest.json"), JSON.stringify({
    schema_version: "1.0",
    product_version: "0.9.0",
    verified_at: "2026-08-10",
    articles: [
      { id: "home", title: "帮助中心", role: "all", source: "README.md", order: 0, summary: "入口", tags: ["帮助"] },
      { id: "user", title: "使用者手册", role: "user", source: "user/guide.md", order: 10, summary: "新任务", tags: ["RunDraft", "Gate"] }
    ],
    assets: [{ id: "home-image", source: "v0.9.0/home.png", media_type: "image/png" }]
  }, null, 2), "utf8");
  return { manuals_dir: manualsDir, assets_dir: assetsDir };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("help center content", () => {
  it("loads and sorts a valid manifest without exposing sources", async () => {
    const options = await fixture();
    const manifest = await loadHelpManifest(options);
    expect(manifest.articles.map((article) => article.id)).toEqual(["home", "user"]);
    const listed = await listHelp(options);
    expect(listed).toMatchObject({ product_version: "0.9.0", verified_at: "2026-08-10" });
    expect(listed.articles[0]).not.toHaveProperty("source");
  });

  it("returns markdown headings and an allowlisted asset map", async () => {
    const article = await readHelpArticle("user", await fixture());
    expect(article.headings).toEqual([
      { depth: 2, text: "新任务", anchor: "新任务" },
      { depth: 3, text: "Dry-run", anchor: "dry-run" }
    ]);
    expect(article.asset_url_map).toEqual({
      "assets/manual/v0.9.0/home.png": "/api/v0/help/assets/home-image"
    });
  });

  it("searches title, tags and markdown with a role filter", async () => {
    const options = await fixture();
    const result = await searchHelp("Gate", "user", options);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].article.id).toBe("user");
    expect((await searchHelp("Gate", "administrator", options)).results).toHaveLength(0);
    expect((await searchHelp("", null, options)).results).toEqual([]);
  });

  it("returns only allowlisted image assets", async () => {
    const options = await fixture();
    const asset = await readHelpAsset("home-image", options);
    expect(asset.media_type).toBe("image/png");
    expect([...asset.data]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    await expect(readHelpAsset("missing", options)).rejects.toMatchObject({ code: "help_asset_not_allowed" });
  });

  it("rejects duplicate IDs and unsafe manifest paths", async () => {
    const options = await fixture();
    const manifestPath = path.join(options.manuals_dir, "help-manifest.json");
    const base = JSON.parse(await readFile(manifestPath, "utf8"));
    base.articles[1].id = "home";
    await writeFile(manifestPath, JSON.stringify(base), "utf8");
    await expect(loadHelpManifest(options)).rejects.toMatchObject({ code: "help_manifest_invalid" });

    base.articles[1].id = "user";
    base.articles[1].source = "../secret.md";
    await writeFile(manifestPath, JSON.stringify(base), "utf8");
    await expect(loadHelpManifest(options)).rejects.toMatchObject({ code: "help_manifest_invalid" });
  });

  it("rejects symlink escapes even when the source is allowlisted", async () => {
    const options = await fixture();
    const outside = path.join(path.dirname(options.manuals_dir), "outside.md");
    await writeFile(outside, "secret", "utf8");
    await symlink(outside, path.join(options.manuals_dir, "user/escape.md"));
    const manifestPath = path.join(options.manuals_dir, "help-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.articles[1].source = "user/escape.md";
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
    await expect(readHelpArticle("user", options)).rejects.toMatchObject({ code: "help_article_not_found" });
  });

  it("returns stable errors for missing articles and invalid queries", async () => {
    const options = await fixture();
    await expect(readHelpArticle("missing", options)).rejects.toMatchObject({ code: "help_article_not_found" });
    await expect(searchHelp("x".repeat(121), null, options)).rejects.toMatchObject({ code: "help_query_invalid" });
    await expect(searchHelp("Gate", "owner", options)).rejects.toBeInstanceOf(HelpCenterError);
  });
});

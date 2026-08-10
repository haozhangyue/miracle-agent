import { describe, expect, it } from "vitest";
import {
  articleIdForManualHref,
  buildHelpUrl,
  initialHelpArticle,
  isSafeExternalHref,
  resolveHelpAssetUrl,
  slugifyHelpHeading,
  type HelpArticleSummary
} from "./help-center";

const articles: HelpArticleSummary[] = [
  { id: "help-home", title: "帮助", role: "all", order: 0, summary: "入口", tags: [] },
  { id: "user-guide", title: "使用者", role: "user", order: 10, summary: "操作", tags: [] }
];

describe("help center navigation", () => {
  it("uses a valid deep-linked article and falls back to the help home", () => {
    expect(initialHelpArticle("?page=help&article=user-guide", articles)).toBe("user-guide");
    expect(initialHelpArticle("?page=help&article=missing", articles)).toBe("help-home");
  });

  it("builds shareable article and heading links", () => {
    expect(buildHelpUrl("user-guide", "创建-run")).toBe("?page=help&article=user-guide#%E5%88%9B%E5%BB%BA-run");
  });

  it("maps only allowlisted manual articles and assets", () => {
    expect(articleIdForManualHref("../user/61_Miracle使用者操作手册.md")).toBe("user-guide");
    expect(articleIdForManualHref("../../../README.md")).toBeUndefined();
    expect(resolveHelpAssetUrl("../../../assets/manual/v0.9.0/01-home.png", {
      "assets/manual/v0.9.0/01-home.png": "/api/v0/help/assets/v0.9.0-home"
    })).toBe("/api/v0/help/assets/v0.9.0-home");
    expect(resolveHelpAssetUrl("https://example.com/image.png", {})).toBe("");
  });

  it("allows only http(s) external links", () => {
    expect(isSafeExternalHref("https://example.com/manual")).toBe(true);
    expect(isSafeExternalHref("javascript:alert(1)")).toBe(false);
    expect(isSafeExternalHref("file:///etc/passwd")).toBe(false);
  });

  it("creates stable Chinese heading anchors", () => {
    expect(slugifyHelpHeading("  创建 Run / Dry-run  ")).toBe("创建-run-dry-run");
  });
});

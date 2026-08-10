export type HelpRole = "all" | "user" | "administrator" | "developer";

export type HelpArticleSummary = {
  id: string;
  title: string;
  role: HelpRole;
  order: number;
  summary: string;
  tags: string[];
};

export type HelpHeading = {
  depth: 2 | 3;
  text: string;
  anchor: string;
};

export type HelpIndex = {
  product_version: string;
  verified_at: string;
  roles: HelpRole[];
  articles: HelpArticleSummary[];
};

export type HelpArticle = {
  article: HelpArticleSummary;
  markdown: string;
  headings: HelpHeading[];
  asset_url_map: Record<string, string>;
};

export type HelpSearchResult = {
  article: HelpArticleSummary;
  snippet: string;
};

export const helpRoleLabels: Record<HelpRole, string> = {
  all: "全部",
  user: "使用者",
  administrator: "管理员",
  developer: "开发维护"
};

export function initialHelpArticle(search: string, articles: HelpArticleSummary[]) {
  const requested = new URLSearchParams(search).get("article");
  if (requested && articles.some((article) => article.id === requested)) return requested;
  return articles.find((article) => article.id === "help-home")?.id ?? articles[0]?.id ?? "";
}

export function buildHelpUrl(articleId: string, anchor?: string) {
  const params = new URLSearchParams({ page: "help", article: articleId });
  return `?${params.toString()}${anchor ? `#${encodeURIComponent(anchor)}` : ""}`;
}

export function replaceHelpLocation(articleId: string, anchor?: string) {
  if (typeof window === "undefined") return;
  window.history.replaceState({}, "", buildHelpUrl(articleId, anchor));
}

export function resolveHelpAssetUrl(source: string | undefined, assetMap: Record<string, string>) {
  if (!source) return "";
  for (const [marker, url] of Object.entries(assetMap)) {
    if (source.includes(marker)) return url;
  }
  return "";
}

export function articleIdForManualHref(href: string | undefined) {
  if (!href || href.startsWith("#")) return undefined;
  const map: Array<[string, string]> = [
    ["61_Miracle", "user-guide"],
    ["62_Miracle", "administrator-guide"],
    ["63_Miracle", "developer-guide"],
    ["64_Miracle", "troubleshooting"],
    ["65_Miracle", "release-notes"],
    ["manuals/README.md", "help-home"]
  ];
  return map.find(([marker]) => href.includes(marker))?.[1];
}

export function isSafeExternalHref(href: string | undefined) {
  if (!href) return false;
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function slugifyHelpHeading(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s/]+/g, "-")
    .replace(/[^\p{L}\p{N}_-]/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "section";
}

import { AlertTriangle, BookOpen, ChevronLeft, ChevronRight, FileText, Loader2, Search } from "lucide-react";
import { Children, isValidElement, useEffect, useId, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  articleIdForManualHref,
  buildHelpUrl,
  helpRoleLabels,
  initialHelpArticle,
  isSafeExternalHref,
  replaceHelpLocation,
  resolveHelpAssetUrl,
  slugifyHelpHeading,
  type HelpArticle,
  type HelpArticleSummary,
  type HelpIndex,
  type HelpRole,
  type HelpSearchResult
} from "./help-center";

const apiBase = "/api/v0";

async function fetchHelp<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, { headers: { accept: "application/json" } });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

function MermaidDiagram({ source }: { source: string }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [svg, setSvg] = useState("");
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    setSvg("");
    setError(false);
    void import("mermaid")
      .then(({ default: mermaid }) => {
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral", fontFamily: "Inter, system-ui, sans-serif" });
        return mermaid.render(`miracle-help-${id}`, source);
      })
      .then((result) => {
        if (active) setSvg(result.svg);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [id, source]);

  if (error) return <pre className="helpCode"><code>{source}</code></pre>;
  if (!svg) return <div className="helpDiagramLoading"><Loader2 className="spin" size={16} /> 正在生成流程图</div>;
  return <div className="helpDiagram" role="img" aria-label="手册流程图" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function textFromChildren(children: unknown): string {
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(textFromChildren).join("");
  if (children && typeof children === "object" && "props" in children) {
    return textFromChildren((children as { props?: { children?: unknown } }).props?.children);
  }
  return "";
}

function ArticleMarkdown({ article, navigateArticle }: { article: HelpArticle; navigateArticle: (id: string) => void }) {
  const headingCounts = new Map<string, number>();
  function headingAnchor(children: unknown) {
    const base = slugifyHelpHeading(textFromChildren(children));
    const count = headingCounts.get(base) ?? 0;
    headingCounts.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  }

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{
        h2: ({ children }) => <h2 id={headingAnchor(children)}>{children}</h2>,
        h3: ({ children }) => <h3 id={headingAnchor(children)}>{children}</h3>,
        pre: ({ children }) => {
          const child = Children.toArray(children)[0];
          if (isValidElement(child) && child.type === MermaidDiagram) return child;
          return <pre className="helpCode">{children}</pre>;
        },
        code: ({ className, children, ...props }) => {
          const language = /language-([^\s]+)/.exec(className ?? "")?.[1];
          const source = String(children).replace(/\n$/, "");
          if (language === "mermaid") return <MermaidDiagram source={source} />;
          return <code className={className} {...props}>{children}</code>;
        },
        img: ({ src, alt }) => {
          const safeSrc = resolveHelpAssetUrl(src, article.asset_url_map);
          return safeSrc
            ? <img className="helpImage" src={safeSrc} alt={alt ?? "Miracle 操作截图"} loading="lazy" />
            : <span className="helpImageUnavailable"><AlertTriangle size={15} /> 图片尚未登记或不可用</span>;
        },
        a: ({ href, children }) => {
          const articleId = articleIdForManualHref(href);
          if (articleId) return <button className="helpInlineLink" onClick={() => navigateArticle(articleId)}>{children}</button>;
          if (href?.startsWith("#")) return <a href={href}>{children}</a>;
          if (isSafeExternalHref(href)) return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
          return <span className="helpMutedLink" title="该仓库文档未在应用帮助中开放">{children}</span>;
        }
      }}
    >
      {article.markdown}
    </ReactMarkdown>
  );
}

export function HelpCenter() {
  const [index, setIndex] = useState<HelpIndex>();
  const [selectedRole, setSelectedRole] = useState<HelpRole>("all");
  const [selectedArticle, setSelectedArticle] = useState("");
  const [article, setArticle] = useState<HelpArticle>();
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<HelpSearchResult[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const articleTitleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let active = true;
    fetchHelp<HelpIndex>("/help")
      .then((data) => {
        if (!active) return;
        setIndex(data);
        setSelectedArticle(initialHelpArticle(window.location.search, data.articles));
        setLoading(false);
      })
      .catch((reason: Error) => {
        if (!active) return;
        setError(reason.message);
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!selectedArticle) return;
    let active = true;
    setLoading(true);
    setError("");
    fetchHelp<HelpArticle>(`/help/articles/${encodeURIComponent(selectedArticle)}`)
      .then((data) => {
        if (!active) return;
        setArticle(data);
        replaceHelpLocation(selectedArticle, window.location.hash.slice(1) || undefined);
        setLoading(false);
        requestAnimationFrame(() => articleTitleRef.current?.focus());
      })
      .catch((reason: Error) => {
        if (!active) return;
        setError(reason.message);
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selectedArticle]);

  const visibleArticles = useMemo(() => {
    if (!index) return [];
    return index.articles.filter((item) => selectedRole === "all" || item.role === "all" || item.role === selectedRole);
  }, [index, selectedRole]);

  const currentPosition = index?.articles.findIndex((item) => item.id === selectedArticle) ?? -1;
  const previous = currentPosition > 0 ? index?.articles[currentPosition - 1] : undefined;
  const next = index && currentPosition >= 0 && currentPosition < index.articles.length - 1 ? index.articles[currentPosition + 1] : undefined;

  function navigateArticle(id: string) {
    setSearchResults(null);
    setQuery("");
    setSelectedArticle(id);
    window.history.replaceState({}, "", buildHelpUrl(id));
  }

  function selectRole(role: HelpRole) {
    setSelectedRole(role);
    setSearchResults(null);
    if (!index || role === "all") return;
    const current = index.articles.find((item) => item.id === selectedArticle);
    if (current?.role === role || current?.role === "all") return;
    const firstForRole = index.articles.find((item) => item.role === role);
    if (firstForRole) navigateArticle(firstForRole.id);
  }

  async function submitSearch(event: React.FormEvent) {
    event.preventDefault();
    if (!query.trim()) {
      setSearchResults(null);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await fetchHelp<{ results: HelpSearchResult[] }>(`/help/search?q=${encodeURIComponent(query)}&role=${encodeURIComponent(selectedRole)}`);
      setSearchResults(response.results);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "帮助搜索失败");
    } finally {
      setLoading(false);
    }
  }

  if (loading && !index) return <section className="page"><div className="helpFullState"><Loader2 className="spin" size={24} /> 正在加载帮助中心</div></section>;
  if (error && !index) return <section className="page"><div className="helpFullState danger"><AlertTriangle size={24} /> 帮助内容暂时不可用，运行功能不受影响。<small>{error}</small></div></section>;

  return (
    <section className="page helpPage">
      <div className="helpHeader">
        <div>
          <span>Help Center</span>
          <h1>帮助与手册</h1>
          <p>按角色阅读与当前版本一致的操作、运维、开发和故障资料。</p>
        </div>
        <div className="helpVersion"><strong>v{index?.product_version}</strong><span>验证于 {index?.verified_at}</span></div>
      </div>

      <form className="helpSearch" onSubmit={submitSearch} role="search">
        <Search size={17} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索新任务、Gate、Provider、blocked..." aria-label="搜索帮助" />
        <button type="submit">搜索</button>
      </form>

      <div className="helpRoleTabs" role="tablist" aria-label="帮助角色分类">
        {(index?.roles ?? []).map((role) => (
          <button
            key={role}
            type="button"
            role="tab"
            aria-selected={selectedRole === role}
            className={selectedRole === role ? "active" : ""}
            onClick={() => selectRole(role)}
          >
            {helpRoleLabels[role]}
          </button>
        ))}
      </div>

      {error && <div className="inlineError"><AlertTriangle size={14} /> {error}</div>}

      {searchResults ? (
        <div className="helpSearchResults">
          <header><h2>“{query}”的搜索结果</h2><span>{searchResults.length} 篇</span></header>
          {searchResults.length === 0
            ? <div className="helpEmpty"><FileText size={30} /><strong>没有找到匹配内容</strong><span>尝试使用 Run、Gate、Artifact、凭证或故障状态名称。</span></div>
            : searchResults.map((result) => (
              <button key={result.article.id} onClick={() => navigateArticle(result.article.id)}>
                <BookOpen size={18} />
                <span><strong>{result.article.title}</strong><small>{result.snippet}</small></span>
                <ChevronRight size={17} />
              </button>
            ))}
        </div>
      ) : (
        <div className="helpLayout">
          <aside className="helpArticleNav" aria-label="帮助文章">
            {visibleArticles.map((item) => (
              <button key={item.id} className={selectedArticle === item.id ? "active" : ""} onClick={() => navigateArticle(item.id)}>
                <BookOpen size={16} />
                <span><strong>{item.title}</strong><small>{item.summary}</small></span>
              </button>
            ))}
          </aside>

          <article className="helpArticle">
            {loading && <div className="refreshHint"><Loader2 className="spin" size={14} /> 正在加载文章</div>}
            {article && (
              <>
                <header className="helpArticleMeta">
                  <div>
                    <span>{helpRoleLabels[article.article.role]}</span>
                    <h2 ref={articleTitleRef} tabIndex={-1}>{article.article.title}</h2>
                    <p>{article.article.summary}</p>
                  </div>
                  <div>{article.article.tags.slice(0, 4).map((tag) => <span key={tag}>{tag}</span>)}</div>
                </header>
                <div className="helpMarkdown"><ArticleMarkdown article={article} navigateArticle={navigateArticle} /></div>
                <footer className="helpPager">
                  {previous ? <button onClick={() => navigateArticle(previous.id)}><ChevronLeft size={16} /> {previous.title}</button> : <span />}
                  {next && <button onClick={() => navigateArticle(next.id)}>{next.title} <ChevronRight size={16} /></button>}
                </footer>
              </>
            )}
          </article>

          <aside className="helpToc" aria-label="当前文章目录">
            <strong>本页目录</strong>
            {(article?.headings ?? []).map((heading) => (
              <a key={`${heading.anchor}-${heading.depth}`} className={heading.depth === 3 ? "nested" : ""} href={`#${heading.anchor}`} onClick={() => replaceHelpLocation(selectedArticle, heading.anchor)}>
                {heading.text}
              </a>
            ))}
          </aside>
        </div>
      )}
    </section>
  );
}

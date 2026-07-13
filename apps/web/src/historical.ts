export interface HistoricalRunMeta {
  origin: "native" | "historical_import";
  mode: "executable" | "historical_readonly";
  source_confidence: "high" | "mixed" | "low";
  source_meta_available: boolean;
}

export interface HistoricalGap {
  code: string;
  message: string;
}

export function isHistoricalRun(run?: { run_mode?: string }, meta?: HistoricalRunMeta) {
  return run?.run_mode === "historical_readonly" || meta?.mode === "historical_readonly";
}

export function confidenceLabel(confidence?: string) {
  if (confidence === "high") return "高证据";
  if (confidence === "mixed") return "混合证据";
  if (confidence === "low") return "低证据";
  return "未标注";
}

export function eventSortDescending<T extends { created_at?: string }>(events: T[]) {
  return [...events].sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
}

export function artifactPreviewCapability(artifact: { type?: string; path?: string }) {
  const type = String(artifact.type ?? "");
  if (["video", "audio", "image"].includes(type)) return { mode: "reference_only", label: "源文件引用" } as const;
  if (["markdown", "json", "report", "document", "publish_package"].includes(type)) return { mode: "text", label: "可读文本" } as const;
  return { mode: "metadata", label: "仅元数据" } as const;
}

export function gapLabel(gap: HistoricalGap) {
  return `${gap.code} · ${gap.message}`;
}

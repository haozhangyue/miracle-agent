import { describe, expect, it } from "vitest";
import { artifactPreviewCapability, confidenceLabel, eventSortDescending, gapLabel, isHistoricalRun, type HistoricalRunMeta } from "./historical";

const mixed: HistoricalRunMeta = {
  origin: "historical_import",
  mode: "historical_readonly",
  source_confidence: "mixed",
  source_meta_available: true
};

describe("historical web projection", () => {
  it("identifies read-only historical runs and labels evidence confidence", () => {
    expect(isHistoricalRun({ run_mode: "historical_readonly" }, mixed)).toBe(true);
    expect(confidenceLabel("high")).toBe("高证据");
    expect(confidenceLabel("mixed")).toBe("混合证据");
    expect(confidenceLabel("low")).toBe("低证据");
  });

  it("sorts event audit newest first without mutating the API array", () => {
    const events = [{ event_id: "old", created_at: "2026-07-11T10:00:00Z" }, { event_id: "new", created_at: "2026-07-11T11:00:00Z" }];
    expect(eventSortDescending(events).map((event) => event.event_id)).toEqual(["new", "old"]);
    expect(events[0]?.event_id).toBe("old");
  });

  it("describes media preview capability and source gaps", () => {
    expect(artifactPreviewCapability({ type: "video", path: "/source/video.mp4" })).toMatchObject({ mode: "reference_only", label: "源文件引用" });
    expect(artifactPreviewCapability({ type: "markdown", path: "/source/master.md" })).toMatchObject({ mode: "text", label: "可读文本" });
    expect(gapLabel({ code: "control_files_missing", message: "缺少控制文件" })).toContain("缺少控制文件");
  });
});

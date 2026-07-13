import { describe, expect, it } from "vitest";
import { canConfirmRunDraft, runDraftModeLabel, summarizeBranchImpact } from "./run-drafts";

describe("RunDraft web projection", () => {
  it("distinguishes editable drafts from converted drafts", () => {
    expect(runDraftModeLabel("draft")).toBe("Run Draft · Not started");
    expect(runDraftModeLabel("confirmed")).toBe("Run Draft · Confirmed");
    expect(runDraftModeLabel("converted")).toBe("Run Draft · Converted");
  });

  it("only enables confirmation for the latest confirmable plan", () => {
    expect(canConfirmRunDraft({ status: "ready_for_confirmation", latest_plan_hash: "sha256:one" }, { plan_hash: "sha256:one" })).toBe(true);
    expect(canConfirmRunDraft({ status: "ready_for_confirmation", latest_plan_hash: "sha256:one" }, { plan_hash: "sha256:two" })).toBe(false);
    expect(canConfirmRunDraft({ status: "draft", latest_plan_hash: "sha256:one" }, { plan_hash: "sha256:one" })).toBe(false);
  });

  it("shows optional blocked branches without marking the required path blocked", () => {
    expect(summarizeBranchImpact([
      { branch_id: "markdown_distribution", selection: "required", readiness: "ready" },
      { branch_id: "video_package", selection: "optional", readiness: "blocked" }
    ])).toEqual({ required_ready: 1, required_blocked: 0, optional_ready: 0, optional_blocked: 1 });
  });

  it("does not count an unselected optional branch as blocked", () => {
    expect(summarizeBranchImpact([
      { branch_id: "video_package", selection: "optional", readiness: "not_selected" }
    ])).toEqual({ required_ready: 0, required_blocked: 0, optional_ready: 0, optional_blocked: 0 });
  });
});

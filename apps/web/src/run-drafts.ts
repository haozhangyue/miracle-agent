type DraftProjection = {
  status: string;
  latest_plan_hash?: string;
};

type DraftPlanProjection = {
  plan_hash?: string;
};

type BranchImpactProjection = {
  branch_id: string;
  selection: "required" | "optional" | string;
  readiness: "ready" | "blocked" | "not_selected" | string;
};

export function runDraftModeLabel(status: string) {
  if (status === "converted") return "Run Draft · Converted";
  if (status === "confirmed" || status === "launch_pending") return "Run Draft · Confirmed";
  return "Run Draft · Not started";
}

export function canConfirmRunDraft(draft?: DraftProjection, plan?: DraftPlanProjection) {
  return Boolean(
    draft?.status === "ready_for_confirmation" &&
    draft.latest_plan_hash &&
    draft.latest_plan_hash === plan?.plan_hash
  );
}

export function summarizeBranchImpact(branches: BranchImpactProjection[]) {
  return branches.reduce(
    (summary, branch) => {
      const scope = branch.selection === "required" ? "required" : "optional";
      if (branch.readiness === "not_selected") return summary;
      const readiness = branch.readiness === "ready" ? "ready" : "blocked";
      summary[`${scope}_${readiness}`] += 1;
      return summary;
    },
    { required_ready: 0, required_blocked: 0, optional_ready: 0, optional_blocked: 0 } as Record<"required_ready" | "required_blocked" | "optional_ready" | "optional_blocked", number>
  );
}

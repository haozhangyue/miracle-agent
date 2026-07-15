import type { AdapterManifest } from "./types";

// P6-05 only registers the intended runtime; P6-06 owns health and process execution.
export const codexCliRealAdapterManifest: AdapterManifest = {
  id: "codex-cli-real",
  kind: "codex",
  display_name: "Codex CLI Local Adapter",
  version: "0.1.0",
  status: "experimental",
  description: "Codex CLI real adapter contract. It remains unavailable until P6-06 health and isolated attempt workspace controls are implemented.",
  execution_mode: "shell",
  capabilities: [
    "fact.verify",
    "content.longform_draft",
    "fact.safe_writing",
    "script.write",
    "storyboard.plan",
    "publish.package",
    "retro.collect"
  ],
  supported_providers: ["codex-local"],
  default_provider: "codex-local",
  required_credentials: [
    { key: "CODEX_CLI_AUTH", label: "Codex CLI login state", source: "keychain", required: true, providers: ["codex-local"] }
  ],
  runtime: { local_executor: "codex-cli", can_execute: false, entrypoint: "codex" }
};

import type { AdapterInvocation, AdapterResult } from "./types";

export interface AdapterPlugin {
  id: string;
  kind: AdapterInvocation["adapter_kind"];
  display_name: string;
  capabilities: string[];
  required_credentials: string[];
  execute(invocation: AdapterInvocation): Promise<AdapterResult> | AdapterResult;
}

export const adapterPluginShells = [
  {
    id: "mock-local-adapter",
    kind: "mock-local",
    display_name: "Mock Local Adapter",
    capabilities: ["source.collect", "content.longform_draft", "script.write", "publish.package"],
    required_credentials: []
  },
  {
    id: "codex-adapter-shell",
    kind: "codex",
    display_name: "Codex Adapter Shell",
    capabilities: ["code.generate", "content.longform_draft", "workflow.operate"],
    required_credentials: []
  },
  {
    id: "hermes-adapter-shell",
    kind: "hermes",
    display_name: "Hermes Adapter Shell",
    capabilities: ["agent.collaborate", "workflow.operate"],
    required_credentials: []
  },
  {
    id: "openclaw-adapter-shell",
    kind: "openclaw",
    display_name: "OpenClaw Adapter Shell",
    capabilities: ["agent.collaborate", "tool.use"],
    required_credentials: []
  },
  {
    id: "official-api-adapter-shell",
    kind: "official-api",
    display_name: "Official API Adapter Shell",
    capabilities: ["model.call", "image.generate", "text.generate", "video.generate"],
    required_credentials: ["PROVIDER_API_KEY"]
  }
] satisfies Array<Omit<AdapterPlugin, "execute">>;

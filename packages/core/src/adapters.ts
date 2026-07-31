import { adapterManifestSchema } from "./schemas";
import { codexCliRealAdapterManifest } from "./codex-cli";
import type { AdapterInvocation, AdapterManifest, AdapterRegistryEntry, AdapterResult } from "./types";

export interface AdapterPlugin {
  id: string;
  kind: AdapterInvocation["adapter_kind"];
  display_name: string;
  capabilities: string[];
  required_credentials: string[];
  execute(invocation: AdapterInvocation): Promise<AdapterResult> | AdapterResult;
}

export const defaultAdapterManifests: AdapterManifest[] = [
  {
    id: "mock-local-adapter",
    kind: "mock-local",
    display_name: "Mock Local Adapter",
    version: "0.1.0",
    status: "stable",
    description: "MVP 本地 Mock Runner，用于无外部依赖地验证 Orchestrator、Artifact、Gate 和 Trace 写入闭环。",
    execution_mode: "mock-compatible",
    capabilities: [
      "source.collect",
      "fact.verify",
      "content.longform_draft",
      "fact.safe_writing",
      "script.write",
      "storyboard.plan",
      "tts.generate",
      "subtitle.generate",
      "video.render",
      "publish.package",
      "retro.collect"
    ],
    supported_providers: ["mock-provider", "mock-tts", "mock-failure"],
    default_provider: "mock-provider",
    required_credentials: [],
    runtime: { local_executor: "mock-runner", can_execute: true }
  },
  {
    id: "codex-mock-compatible-adapter",
    kind: "codex",
    display_name: "Codex Mock-Compatible Adapter",
    version: "0.1.0",
    status: "experimental",
    description: "Codex 平台 adapter 的 MVP manifest。当前使用 Mock Runner 兼容执行，保留后续替换为 Codex CLI/官方能力的边界。",
    execution_mode: "mock-compatible",
    capabilities: [
      "code.generate",
      "source.collect",
      "fact.verify",
      "content.longform_draft",
      "fact.safe_writing",
      "workflow.operate",
      "script.write",
      "storyboard.plan",
      "publish.package",
      "retro.collect"
    ],
    supported_providers: ["codex-local", "mock-provider", "mock-failure"],
    default_provider: "codex-local",
    required_credentials: [],
    runtime: { local_executor: "mock-runner", can_execute: true, entrypoint: "mock://codex-compatible" }
  },
  codexCliRealAdapterManifest,
  {
    id: "hermes-adapter-shell",
    kind: "hermes",
    display_name: "Hermes Adapter Shell",
    version: "0.1.0",
    status: "draft",
    description: "Hermes Agent adapter 占位 manifest，仅进入目录和路由评估，不在 MVP 执行。",
    execution_mode: "shell",
    capabilities: ["agent.collaborate", "workflow.operate"],
    supported_providers: ["hermes-local"],
    default_provider: "hermes-local",
    required_credentials: [],
    runtime: { local_executor: "not-implemented", can_execute: false }
  },
  {
    id: "openclaw-adapter-shell",
    kind: "openclaw",
    display_name: "OpenClaw Adapter Shell",
    version: "0.1.0",
    status: "draft",
    description: "OpenClaw adapter 占位 manifest，仅进入目录和路由评估，不在 MVP 执行。",
    execution_mode: "shell",
    capabilities: ["agent.collaborate", "tool.use"],
    supported_providers: ["openclaw-local"],
    default_provider: "openclaw-local",
    required_credentials: [],
    runtime: { local_executor: "not-implemented", can_execute: false }
  },
  {
    id: "official-api-adapter-shell",
    kind: "official-api",
    display_name: "Official API Adapter Shell",
    version: "0.1.0",
    status: "draft",
    description: "官方 API adapter 占位 manifest，用于验证凭证检查、ProviderPolicy 和后续远程 Worker 边界。",
    execution_mode: "external",
    capabilities: ["model.call", "text.generate", "image.generate", "video.generate", "tts.generate", "subtitle.generate"],
    supported_providers: ["openai", "anthropic", "volc-tts", "mock-failure"],
    default_provider: "openai",
    required_credentials: [
      { key: "PROVIDER_API_KEY", label: "默认模型/API Provider Key", source: "env", required: true, providers: ["openai", "anthropic"] },
      { key: "VOLC_TTS_API_KEY", label: "火山 TTS API Key", source: "env", required: false, providers: ["volc-tts"] }
    ],
    runtime: { local_executor: "external-api", can_execute: false }
  }
];

export const adapterPluginShells = defaultAdapterManifests.map((manifest) => ({
  id: manifest.id,
  kind: manifest.kind,
  display_name: manifest.display_name,
  capabilities: manifest.capabilities,
  required_credentials: manifest.required_credentials.map((credential) => credential.key)
})) satisfies Array<Omit<AdapterPlugin, "execute">>;

export function parseAdapterManifest(input: unknown): AdapterManifest {
  return adapterManifestSchema.parse(input);
}

export function parseAdapterManifests(input: unknown[]): AdapterManifest[] {
  return input.map(parseAdapterManifest);
}

export function buildAdapterRegistry(input: { manifests: AdapterManifest[]; availableCredentials?: string[]; provider?: string }): AdapterRegistryEntry[] {
  const availableCredentials = new Set(input.availableCredentials ?? []);
  return input.manifests.map((manifest) => {
    const credentialStatus = manifest.required_credentials.map((credential) => ({
      ...credential,
      configured: credential.source === "env" ? availableCredentials.has(credential.key) : false
    }));
    const missingRequiredCredentials = credentialStatus.filter((credential) =>
      credential.required
      && !credential.configured
      && (
        input.provider === undefined
        || credential.providers === undefined
        || credential.providers.includes(input.provider)
      )
    );
    const unavailableReasons = [
      ...(manifest.status === "blocked" ? ["adapter_blocked"] : []),
      ...(!manifest.runtime.can_execute ? ["runtime_not_executable"] : []),
      ...missingRequiredCredentials.map((credential) => `missing_credential:${credential.key}`)
    ];
    return {
      ...manifest,
      credential_status: credentialStatus,
      executable: unavailableReasons.length === 0,
      unavailable_reasons: unavailableReasons
    };
  });
}

function capabilityScore(manifest: AdapterManifest, capabilities: string[]) {
  return capabilities.reduce((score, capability) => score + (manifest.capabilities.includes(capability) ? 1 : 0), 0);
}

export function selectAdapterManifest(input: {
  manifests: AdapterManifest[];
  capabilityRequirements: string[];
  provider?: string;
  preferredKinds?: AdapterInvocation["adapter_kind"][];
  availableCredentials?: string[];
}): AdapterRegistryEntry | undefined {
  const registry = buildAdapterRegistry({
    manifests: input.manifests,
    availableCredentials: input.availableCredentials,
    provider: input.provider
  });
  const preferredKinds = new Set(input.preferredKinds ?? []);
  return registry
    .filter((adapter) => adapter.executable)
    .filter((adapter) => input.provider === undefined || adapter.supported_providers.includes(input.provider) || adapter.default_provider === input.provider)
    .filter((adapter) => input.capabilityRequirements.every((capability) => adapter.capabilities.includes(capability)))
    .sort((a, b) => {
      const preferredDelta = Number(preferredKinds.has(b.kind)) - Number(preferredKinds.has(a.kind));
      if (preferredDelta !== 0) return preferredDelta;
      const scoreDelta = capabilityScore(b, input.capabilityRequirements) - capabilityScore(a, input.capabilityRequirements);
      if (scoreDelta !== 0) return scoreDelta;
      return a.id.localeCompare(b.id);
    })[0];
}

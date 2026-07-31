import type { ModelApiRequest, ProviderDriver } from "@miracle/core";
import { openAiCompatibleDriver } from "./openai-compatible";

function requireDeepSeekApiPath(input: ModelApiRequest) {
  try {
    if (!input.profile.api_path || new URL(input.profile.api_path, "https://miracle.invalid").pathname !== "/chat/completions") {
      throw new Error("deepseek_api_path_invalid");
    }
  } catch {
    throw new Error("deepseek_api_path_invalid");
  }
}

export const deepseekDriver: ProviderDriver = {
  ...openAiCompatibleDriver,
  id: "deepseek",

  buildRequest(input) {
    requireDeepSeekApiPath(input);
    const request = openAiCompatibleDriver.buildRequest(input);
    const body = JSON.parse(String(request.init.body)) as Record<string, unknown>;
    return {
      ...request,
      init: {
        ...request.init,
        body: JSON.stringify({ ...body, stream: false })
      }
    };
  }
};

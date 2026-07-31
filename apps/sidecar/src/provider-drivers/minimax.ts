import type { NormalizedModelResponse, ProviderDriver } from "@miracle/core";
import { openAiCompatibleDriver } from "./openai-compatible";

function isSuccessfulBaseResponse(body: unknown) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return false;
  const baseResponse = (body as Record<string, unknown>).base_resp;
  if (baseResponse === null || typeof baseResponse !== "object" || Array.isArray(baseResponse)) return false;
  return Number.isInteger((baseResponse as Record<string, unknown>).status_code)
    && (baseResponse as Record<string, unknown>).status_code === 0;
}

export const minimaxDriver: ProviderDriver = {
  ...openAiCompatibleDriver,
  id: "minimax",

  parseResponse(input): NormalizedModelResponse {
    if (!isSuccessfulBaseResponse(input.body)) throw new Error("minimax_base_response_invalid");
    return openAiCompatibleDriver.parseResponse(input);
  }
};

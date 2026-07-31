import type { ProviderDriver } from "@miracle/core";
import { openAiCompatibleDriver } from "./openai-compatible";

export const kimiDriver: ProviderDriver = {
  ...openAiCompatibleDriver,
  id: "kimi"
};

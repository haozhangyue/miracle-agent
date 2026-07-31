import type { AdapterError, ModelApiRequest, NormalizedModelResponse, ProviderDriver } from "@miracle/core";

function errorForStatus(status: number): AdapterError {
  if (status === 401) return { code: "authentication_failed", message: "Provider rejected the configured credential.", recoverable: false };
  if (status === 403) return { code: "permission_denied", message: "Provider denied access to the requested model or operation.", recoverable: false };
  if (status === 404) return { code: "provider_endpoint_not_found", message: "Provider endpoint was not found.", recoverable: false };
  if (status === 408) return { code: "provider_timeout", message: "Provider timed out while handling the request.", recoverable: true };
  if (status === 413) return { code: "provider_request_too_large", message: "Provider rejected the request because it is too large.", recoverable: false };
  if (status === 429) return { code: "provider_rate_limited", message: "Provider rate limit was reached.", recoverable: true };
  if (status >= 500) return { code: "provider_unavailable", message: "Provider is temporarily unavailable.", recoverable: true };
  return { code: "provider_http_error", message: "Provider returned an unexpected HTTP error.", recoverable: false };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function tokenCount(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export const openAiCompatibleDriver: ProviderDriver = {
  id: "openai-compatible",

  buildRequest(input: ModelApiRequest) {
    const url = new URL(input.profile.api_path ?? "/v1/chat/completions", input.profile.base_url);
    const prompt = input.prompt ?? `Execute Miracle operation ${input.invocation.operation_id} for node ${input.invocation.node_id}.`;
    return {
      url: url.toString(),
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${input.credential}`
        },
        body: JSON.stringify({
          model: input.profile.model,
          messages: [{ role: "user", content: prompt }]
        })
      }
    };
  },

  parseResponse(input): NormalizedModelResponse {
    const body = asRecord(input.body);
    const choice = Array.isArray(body?.choices) ? asRecord(body.choices[0]) : undefined;
    const message = asRecord(choice?.message);
    const content = message?.content;
    if (typeof content !== "string") throw new Error("compatible_response_missing_message_content");
    const usage = asRecord(body?.usage);
    return {
      output_text: content,
      ...(usage ? {
        usage: {
          input_tokens: tokenCount(usage.prompt_tokens),
          output_tokens: tokenCount(usage.completion_tokens),
          total_tokens: tokenCount(usage.total_tokens)
        }
      } : {}),
      ...(typeof body?.id === "string" ? { raw_receipt_id: body.id } : {})
    };
  },

  mapError(input) {
    if (input.response) return errorForStatus(input.response.status);
    return { code: "provider_network_error", message: "Provider request could not be completed.", recoverable: true };
  }
};

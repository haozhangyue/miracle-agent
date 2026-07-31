import type { AdapterError, AdapterInvocation, AdapterResult, ProviderDriver, ProviderProfile } from "@miracle/core";

export interface ModelApiAdapterOptions {
  driver: ProviderDriver;
  max_response_bytes?: number;
}

export interface ModelApiExecutionInput {
  invocation: AdapterInvocation;
  profile: ProviderProfile;
  credential: string;
  signal: AbortSignal;
  prompt?: string;
}

const defaultMaxResponseBytes = 1_048_576;

type AbortKind = "timeout" | "cancelled";

class ProviderResponseTooLargeError extends Error {}
class ProviderResponseInvalidError extends Error {}
class ProviderRequestInvalidError extends Error {}

function abortSignals(input: { signal: AbortSignal; timeout_ms: number }) {
  const controller = new AbortController();
  let kind: AbortKind | undefined;
  const abort = (nextKind: AbortKind) => {
    kind ??= nextKind;
    controller.abort();
  };
  const onAbort = () => abort("cancelled");
  if (input.signal.aborted) onAbort();
  else input.signal.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => abort("timeout"), input.timeout_ms);
  return {
    signal: controller.signal,
    abortKind: () => kind,
    cleanup: () => {
      clearTimeout(timeout);
      input.signal.removeEventListener("abort", onAbort);
    }
  };
}

async function readLimitedText(response: Response, limit: number) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new ProviderResponseTooLargeError();
    }
    chunks.push(value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(output);
  } catch {
    throw new ProviderResponseInvalidError();
  }
}

function containsCredential(value: string | undefined, credential: string) {
  return credential.length > 0 && value?.includes(credential) === true;
}

function sanitizeDriverError(error: AdapterError, credential: string): AdapterError {
  if (!containsCredential(error.code, credential) && !containsCredential(error.message, credential)) return error;
  return {
    code: "provider_response_redacted",
    message: "Provider response contained sensitive credential material.",
    recoverable: false
  };
}

function validateDriverRequestUrl(requestUrl: string, baseUrl: string) {
  try {
    const request = new URL(requestUrl);
    const profileBase = new URL(baseUrl);
    if (
      !["http:", "https:"].includes(profileBase.protocol)
      || profileBase.username.length > 0
      || profileBase.password.length > 0
      || !["http:", "https:"].includes(request.protocol)
      || request.username.length > 0
      || request.password.length > 0
      || request.origin !== profileBase.origin
    ) {
      throw new ProviderRequestInvalidError();
    }
  } catch (error) {
    if (error instanceof ProviderRequestInvalidError) throw error;
    throw new ProviderRequestInvalidError();
  }
}

export class ModelApiAdapter {
  private readonly driver: ProviderDriver;
  private readonly maxResponseBytes: number;

  constructor(options: ModelApiAdapterOptions) {
    this.driver = options.driver;
    this.maxResponseBytes = options.max_response_bytes ?? defaultMaxResponseBytes;
    if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1) throw new Error("max_response_bytes must be a positive integer");
  }

  async execute(input: ModelApiExecutionInput): Promise<AdapterResult> {
    const startedAt = Date.now();
    const control = abortSignals({ signal: input.signal, timeout_ms: input.invocation.runtime_control.timeout_ms });
    const receipt = (extra: Record<string, unknown> = {}) => ({
      provider: input.profile.provider,
      adapter_kind: input.invocation.adapter_kind,
      adapter_id: input.invocation.adapter_id,
      model: input.profile.model,
      operation_id: input.invocation.operation_id,
      latency_ms: Date.now() - startedAt,
      ...extra
    });
    const failure = (status: AdapterResult["status"], error: AdapterError): AdapterResult => ({
      operation_id: input.invocation.operation_id,
      attempt_id: input.invocation.attempt_id,
      node_run_id: input.invocation.node_run_id,
      status,
      provider_receipt: receipt(),
      artifact_descriptors: [],
      error,
      received_at: new Date().toISOString()
    });

    try {
      const request = this.driver.buildRequest(input);
      validateDriverRequestUrl(request.url, input.profile.base_url);
      const response = await fetch(request.url, { ...request.init, redirect: "manual", signal: control.signal });
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        return failure("failed", sanitizeDriverError(this.driver.mapError({ response }), input.credential));
      }
      const text = await readLimitedText(response, this.maxResponseBytes);
      let body: unknown;
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        return failure("failed", { code: "provider_response_invalid", message: "Provider returned invalid JSON.", recoverable: false });
      }
      let normalized;
      try {
        normalized = this.driver.parseResponse({ response, body, profile: input.profile });
      } catch {
        return failure("failed", { code: "provider_response_invalid", message: "Provider response did not satisfy the compatible contract.", recoverable: false });
      }
      return {
        operation_id: input.invocation.operation_id,
        attempt_id: input.invocation.attempt_id,
        node_run_id: input.invocation.node_run_id,
        status: "succeeded",
        provider_receipt: receipt({
          ...(normalized.usage ? { usage: normalized.usage } : {}),
          ...(normalized.external_session_id && !containsCredential(normalized.external_session_id, input.credential) ? { external_session_id: normalized.external_session_id } : {}),
          ...(normalized.raw_receipt_id && !containsCredential(normalized.raw_receipt_id, input.credential) ? { raw_receipt_id: normalized.raw_receipt_id } : {})
        }),
        artifact_descriptors: [],
        received_at: new Date().toISOString()
      };
    } catch (error) {
      if (control.abortKind() === "timeout") {
        return failure("timed_out", { code: "process_timeout", message: "Provider request exceeded the configured timeout.", recoverable: true });
      }
      if (control.abortKind() === "cancelled") {
        return failure("cancelled", { code: "operation_cancelled", message: "Provider request was cancelled.", recoverable: false });
      }
      if (error instanceof ProviderResponseTooLargeError) {
        return failure("failed", { code: "provider_response_too_large", message: "Provider response exceeded the configured size limit.", recoverable: false });
      }
      if (error instanceof ProviderResponseInvalidError) {
        return failure("failed", { code: "provider_response_invalid", message: "Provider returned invalid UTF-8.", recoverable: false });
      }
      if (error instanceof ProviderRequestInvalidError) {
        return failure("failed", { code: "provider_request_invalid", message: "Provider Driver returned an unsafe request URL.", recoverable: false });
      }
      return failure("failed", sanitizeDriverError(this.driver.mapError({ error }), input.credential));
    } finally {
      control.cleanup();
    }
  }
}

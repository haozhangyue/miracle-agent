export class ProviderRequestInvalidError extends Error {
  constructor() {
    super("Provider Driver api_path or base_url is invalid.");
    this.name = "ProviderRequestInvalidError";
  }
}

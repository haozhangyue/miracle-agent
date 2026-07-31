import { describe, expect, it, vi } from "vitest";
import type { ProviderCatalogEntry, ProviderDriver } from "@miracle/core";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertProviderSmokeEnabled, runProviderSmoke } from "../src/provider-smoke";
import { createProviderDriverRegistry, ProviderDriverRegistry } from "../src/provider-driver-registry";

const catalogEntry = {
  id: "fixture-compatible",
  display_name: "Fixture Compatible",
  driver_id: "fixture-driver",
  profile: {
    id: "fixture-compatible-default",
    provider: "fixture-compatible",
    model: "fixture-chat",
    base_url: "http://127.0.0.1:9999",
    credential_ref: "MODEL_API_FIXTURE_CREDENTIAL",
    verification_status: "configured_unverified"
  },
  credential: { key: "MODEL_API_FIXTURE_CREDENTIAL", source: "env" },
  documentation: { official_url: "https://example.invalid/docs", verified_at: "2026-07-31T00:00:00.000Z" },
  capabilities: ["model.call"],
  cancellation: "http_abort"
} satisfies ProviderCatalogEntry;

describe("provider smoke safety gate", () => {
  it("blocks the smoke before driver request construction when opt-in is disabled", () => {
    expect(() => assertProviderSmokeEnabled({ enabled: undefined, provider: "fixture-compatible", credential: "fixture-secret" }))
      .toThrow(/MIRACLE_ENABLE_MODEL_API/i);
  });

  it("blocks the smoke before network access when the credential is missing", () => {
    expect(() => assertProviderSmokeEnabled({ enabled: "1", provider: "fixture-compatible", credential: undefined }))
      .toThrow(/credential/i);
  });

  it("does not construct a Driver request when an opted-in smoke has no credential", async () => {
    let builtRequest = false;
    const driver: ProviderDriver = {
      id: "fixture-driver",
      buildRequest: () => {
        builtRequest = true;
        return { url: "http://127.0.0.1:1/should-not-run", init: {} };
      },
      parseResponse: () => ({ output_text: "unused" }),
      mapError: () => ({ code: "unused", message: "unused", recoverable: false })
    };
    const registry = new ProviderDriverRegistry().register({ driver, providers: ["fixture-compatible"] });

    await expect(runProviderSmoke({
      catalog: [catalogEntry],
      driverRegistry: registry,
      env: { MIRACLE_ENABLE_MODEL_API: "1", MIRACLE_SMOKE_PROVIDER: "fixture-compatible" }
    })).rejects.toThrow(/credential/i);

    expect(builtRequest).toBe(false);
  });

  it("rejects a symlinked workspace before constructing a Driver request", async () => {
    const canonicalWorkspace = await mkdtemp(path.join(tmpdir(), "miracle-provider-smoke-workspace-"));
    const linkedWorkspace = `${canonicalWorkspace}-link`;
    let builtRequest = false;
    const registry = new ProviderDriverRegistry().register({
      driver: {
        id: "fixture-driver",
        buildRequest: () => { builtRequest = true; return { url: "http://127.0.0.1:1/never", init: {} }; },
        parseResponse: () => ({ output_text: "unused" }),
        mapError: () => ({ code: "unused", message: "unused", recoverable: false })
      },
      providers: ["fixture-compatible"]
    });
    try {
      await symlink(canonicalWorkspace, linkedWorkspace, "dir");
      await expect(runProviderSmoke({
        workspaceDir: linkedWorkspace,
        catalog: [catalogEntry],
        driverRegistry: registry,
        env: { MIRACLE_ENABLE_MODEL_API: "1", MIRACLE_SMOKE_PROVIDER: "fixture-compatible", MODEL_API_FIXTURE_CREDENTIAL: "fixture-secret" }
      })).rejects.toThrow(/workspace.*canonical|symlink/i);
      expect(builtRequest).toBe(false);
    } finally {
      await rm(linkedWorkspace, { force: true });
      await rm(canonicalWorkspace, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked artifact root before constructing a Driver request", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "miracle-provider-smoke-root-"));
    const outside = await mkdtemp(path.join(tmpdir(), "miracle-provider-smoke-outside-"));
    let builtRequest = false;
    const registry = new ProviderDriverRegistry().register({
      driver: {
        id: "fixture-driver",
        buildRequest: () => { builtRequest = true; return { url: "http://127.0.0.1:1/never", init: {} }; },
        parseResponse: () => ({ output_text: "unused" }),
        mapError: () => ({ code: "unused", message: "unused", recoverable: false })
      },
      providers: ["fixture-compatible"]
    });
    try {
      await symlink(outside, path.join(workspace, "smoke-artifacts"), "dir");
      await expect(runProviderSmoke({
        workspaceDir: workspace,
        catalog: [catalogEntry],
        driverRegistry: registry,
        env: { MIRACLE_ENABLE_MODEL_API: "1", MIRACLE_SMOKE_PROVIDER: "fixture-compatible", MODEL_API_FIXTURE_CREDENTIAL: "fixture-secret" }
      })).rejects.toThrow(/artifact root.*unsafe|artifact root.*canonical/i);
      expect(builtRequest).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked target before constructing a Driver request", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "miracle-provider-smoke-target-"));
    const outside = path.join(workspace, "outside.md");
    let builtRequest = false;
    const now = vi.spyOn(Date, "now").mockReturnValue(2468);
    const registry = new ProviderDriverRegistry().register({
      driver: {
        id: "fixture-driver",
        buildRequest: () => { builtRequest = true; return { url: "http://127.0.0.1:1/never", init: {} }; },
        parseResponse: () => ({ output_text: "unused" }),
        mapError: () => ({ code: "unused", message: "unused", recoverable: false })
      },
      providers: ["fixture-compatible"]
    });
    try {
      await mkdir(path.join(workspace, "smoke-artifacts"));
      await writeFile(outside, "outside", "utf8");
      await symlink(outside, path.join(workspace, "smoke-artifacts", "fixture-compatible-2468.md"));
      await expect(runProviderSmoke({
        workspaceDir: workspace,
        catalog: [catalogEntry],
        driverRegistry: registry,
        env: { MIRACLE_ENABLE_MODEL_API: "1", MIRACLE_SMOKE_PROVIDER: "fixture-compatible", MODEL_API_FIXTURE_CREDENTIAL: "fixture-secret" }
      })).rejects.toThrow(/target.*unsafe|target.*already exists/i);
      expect(await readFile(outside, "utf8")).toBe("outside");
      expect(builtRequest).toBe(false);
    } finally {
      now.mockRestore();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("writes a redacted Markdown artifact after an explicitly enabled successful smoke", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        id: "smoke-receipt",
        choices: [{ message: { content: "safe response fixture-secret" } }],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const workspace = await mkdtemp(path.join(tmpdir(), "miracle-provider-smoke-"));
    try {
      const result = await runProviderSmoke({
        workspaceDir: workspace,
        catalog: [{
          ...catalogEntry,
          driver_id: "openai-compatible",
          profile: { ...catalogEntry.profile, base_url: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}` }
        }],
        driverRegistry: createProviderDriverRegistry(),
        env: {
          MIRACLE_ENABLE_MODEL_API: "1",
          MIRACLE_SMOKE_PROVIDER: "fixture-compatible",
          MODEL_API_FIXTURE_CREDENTIAL: "fixture-secret"
        }
      });

      const artifact = await readFile(result.artifact_path, "utf8");
      expect(result).toMatchObject({ provider: "fixture-compatible", usage: { total_tokens: 5 } });
      expect(artifact).toContain("[REDACTED]");
      expect(artifact).not.toContain("fixture-secret");
      expect(JSON.stringify(result)).not.toContain("fixture-secret");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("does not write outside the workspace when the artifact root is replaced after verification", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: "safe response" } }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const workspace = await mkdtemp(path.join(tmpdir(), "miracle-provider-smoke-race-"));
    const outside = await mkdtemp(path.join(tmpdir(), "miracle-provider-smoke-race-outside-"));
    const originalRoot = path.join(workspace, "smoke-artifacts-original");
    let hookInvoked = false;
    try {
      await expect(runProviderSmoke({
        workspaceDir: workspace,
        catalog: [{
          ...catalogEntry,
          driver_id: "openai-compatible",
          profile: { ...catalogEntry.profile, base_url: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}` }
        }],
        driverRegistry: createProviderDriverRegistry(),
        env: {
          MIRACLE_ENABLE_MODEL_API: "1",
          MIRACLE_SMOKE_PROVIDER: "fixture-compatible",
          MODEL_API_FIXTURE_CREDENTIAL: "fixture-secret"
        },
        beforeArtifactWrite: async () => {
          hookInvoked = true;
          await rename(path.join(workspace, "smoke-artifacts"), originalRoot);
          await symlink(outside, path.join(workspace, "smoke-artifacts"), "dir");
        }
      })).rejects.toThrow(/artifact root.*changed|artifact root.*unsafe/i);

      expect(hookInvoked).toBe(true);
      expect(await readdir(outside)).toEqual([]);
      expect(await readdir(originalRoot)).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

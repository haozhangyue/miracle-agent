import {
  retryScheduleRecordSchema,
  retryStateRecordSchema,
  type NodeAttempt,
  type RetryScheduleRecord,
  type RetryStateRecord
} from "@miracle/core";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

type LegacyRetryStateRecord = {
  operation_id: string;
  node_run_id: string;
  phase: "waiting_for_retry" | "exhausted" | "blocked";
  reason_code: string;
  decision: unknown;
  updated_at: string;
};

export interface RetryStateMigrationIssue {
  operation_id: string;
  node_run_id: string;
  reason_code: "retry_state_migration_failed";
  message: string;
  legacy_record: LegacyRetryStateRecord;
  updated_at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function legacyRetryStateRecord(value: unknown): LegacyRetryStateRecord | undefined {
  if (!isRecord(value)
    || value.attempt_id !== undefined
    || value.attempt_number !== undefined
    || value.error !== undefined
    || value.effects_committed !== undefined
    || typeof value.operation_id !== "string"
    || typeof value.node_run_id !== "string"
    || !["waiting_for_retry", "exhausted", "blocked"].includes(String(value.phase))
    || typeof value.reason_code !== "string"
    || !isRecord(value.decision)
    || typeof value.updated_at !== "string") {
    return undefined;
  }
  return value as LegacyRetryStateRecord;
}

function latestOperationAttempt(attempts: NodeAttempt[], legacy: LegacyRetryStateRecord) {
  return attempts
    .filter((attempt) =>
      attempt.operation_id === legacy.operation_id
      && attempt.node_run_id === legacy.node_run_id
    )
    .sort((left, right) => {
      const numberDifference = (right.attempt_number ?? 1) - (left.attempt_number ?? 1);
      if (numberDifference !== 0) return numberDifference;
      return Date.parse(right.created_at ?? right.dispatched_at ?? right.started_at ?? "")
        - Date.parse(left.created_at ?? left.dispatched_at ?? left.started_at ?? "");
    })[0];
}

export class RetryScheduleStore {
  private readonly workspaceDir: string;

  constructor(input: { workspace_dir: string }) {
    this.workspaceDir = path.resolve(input.workspace_dir);
  }

  private schedulePath(runId: string) {
    if (!runId || path.basename(runId) !== runId) throw new Error("runId must be a single path segment");
    return path.join(this.workspaceDir, "runs", runId, "retry_schedule.json");
  }

  async list(runId: string): Promise<RetryScheduleRecord[]> {
    try {
      const value = JSON.parse(await readFile(this.schedulePath(runId), "utf8")) as unknown;
      if (!Array.isArray(value)) throw new Error("retry_schedule.json must contain an array");
      const records = value.map((record) => retryScheduleRecordSchema.parse(record));
      if (new Set(records.map((record) => record.operation_id)).size !== records.length) {
        throw new Error("retry_schedule.json contains duplicate active operation schedules");
      }
      return records;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async upsert(runId: string, record: RetryScheduleRecord) {
    const parsed = retryScheduleRecordSchema.parse(record);
    const current = await this.list(runId);
    await this.writeAtomically(runId, [
      ...current.filter((item) => item.operation_id !== parsed.operation_id),
      parsed
    ]);
    return parsed;
  }

  async remove(runId: string, operationId: string) {
    const current = await this.list(runId);
    const next = current.filter((record) => record.operation_id !== operationId);
    if (next.length !== current.length) await this.writeAtomically(runId, next);
  }

  async due(runId: string, now: string) {
    const nowMs = Date.parse(now);
    if (!Number.isFinite(nowMs)) throw new Error("now must be a valid timestamp");
    return (await this.list(runId)).filter((record) => Date.parse(record.scheduled_for) <= nowMs);
  }

  private async writeAtomically(runId: string, records: RetryScheduleRecord[]) {
    const target = this.schedulePath(runId);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporary,
        `${JSON.stringify(records, null, 2)}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 }
      );
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

export class RetryStateStore {
  private readonly workspaceDir: string;

  constructor(input: { workspace_dir: string }) {
    this.workspaceDir = path.resolve(input.workspace_dir);
  }

  private statePath(runId: string) {
    if (!runId || path.basename(runId) !== runId) throw new Error("runId must be a single path segment");
    return path.join(this.workspaceDir, "runs", runId, "retry_state.json");
  }

  private migrationIssuesPath(runId: string) {
    if (!runId || path.basename(runId) !== runId) throw new Error("runId must be a single path segment");
    return path.join(this.workspaceDir, "runs", runId, "retry_state_migration_blocked.json");
  }

  async list(runId: string): Promise<RetryStateRecord[]> {
    try {
      const value = JSON.parse(await readFile(this.statePath(runId), "utf8")) as unknown;
      if (!Array.isArray(value)) throw new Error("retry_state.json must contain an array");
      const records = value.map((record) => retryStateRecordSchema.parse(record));
      if (new Set(records.map((record) => record.operation_id)).size !== records.length) {
        throw new Error("retry_state.json contains duplicate operations");
      }
      return records;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async requiresMigration(runId: string) {
    try {
      const value = JSON.parse(await readFile(this.statePath(runId), "utf8")) as unknown;
      if (!Array.isArray(value)) throw new Error("retry_state.json must contain an array");
      if (value.some((record) => !retryStateRecordSchema.safeParse(record).success)) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return (await this.migrationIssues(runId)).length > 0;
  }

  async migrateLegacy(runId: string, attempts: NodeAttempt[]) {
    let rawRecords: unknown[];
    try {
      const value = JSON.parse(await readFile(this.statePath(runId), "utf8")) as unknown;
      if (!Array.isArray(value)) throw new Error("retry_state.json must contain an array");
      rawRecords = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      rawRecords = [];
    }
    const existingIssues = await this.migrationIssues(runId);
    const currentRecords: RetryStateRecord[] = [];
    const legacyByOperation = new Map<string, LegacyRetryStateRecord>();
    let migrationRequired = existingIssues.length > 0;

    for (const rawRecord of rawRecords) {
      const current = retryStateRecordSchema.safeParse(rawRecord);
      if (current.success) {
        currentRecords.push(current.data);
        continue;
      }
      const legacy = legacyRetryStateRecord(rawRecord);
      if (!legacy) throw current.error;
      legacyByOperation.set(legacy.operation_id, legacy);
      migrationRequired = true;
    }
    for (const issue of existingIssues) {
      if (!currentRecords.some((record) => record.operation_id === issue.operation_id)) {
        legacyByOperation.set(issue.operation_id, issue.legacy_record);
      }
    }

    const issues: RetryStateMigrationIssue[] = [];
    for (const legacy of legacyByOperation.values()) {
      const attempt = latestOperationAttempt(attempts, legacy);
      if (!attempt?.attempt_id || !attempt.error) {
        issues.push({
          operation_id: legacy.operation_id,
          node_run_id: legacy.node_run_id,
          reason_code: "retry_state_migration_failed",
          message: `Cannot migrate legacy RetryState ${legacy.operation_id}: matching latest NodeAttempt error facts are unavailable.`,
          legacy_record: legacy,
          updated_at: new Date().toISOString()
        });
        continue;
      }
      currentRecords.push(retryStateRecordSchema.parse({
        ...legacy,
        attempt_id: attempt.attempt_id,
        attempt_number: attempt.attempt_number ?? 1,
        error: attempt.error,
        effects_committed: false
      }));
    }

    if (new Set(currentRecords.map((record) => record.operation_id)).size !== currentRecords.length) {
      throw new Error("retry_state.json contains duplicate operations");
    }
    if (migrationRequired) {
      await this.writeMigrationIssuesAtomically(runId, issues);
      await this.writeAtomically(runId, currentRecords);
    }
    return { records: currentRecords, issues };
  }

  async migrationIssues(runId: string): Promise<RetryStateMigrationIssue[]> {
    try {
      const value = JSON.parse(await readFile(this.migrationIssuesPath(runId), "utf8")) as unknown;
      if (!Array.isArray(value)) throw new Error("retry_state_migration_blocked.json must contain an array");
      return value.map((issue) => {
        if (!isRecord(issue)
          || typeof issue.operation_id !== "string"
          || typeof issue.node_run_id !== "string"
          || issue.reason_code !== "retry_state_migration_failed"
          || typeof issue.message !== "string"
          || typeof issue.updated_at !== "string") {
          throw new Error("retry_state_migration_blocked.json contains an invalid issue");
        }
        const legacy = legacyRetryStateRecord(issue.legacy_record);
        if (!legacy) throw new Error("retry_state_migration_blocked.json contains an invalid legacy record");
        return { ...issue, legacy_record: legacy } as RetryStateMigrationIssue;
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async upsert(runId: string, record: RetryStateRecord) {
    const parsed = retryStateRecordSchema.parse(record);
    const current = await this.list(runId);
    await this.writeAtomically(runId, [
      ...current.filter((item) => item.operation_id !== parsed.operation_id),
      parsed
    ]);
    return parsed;
  }

  async remove(runId: string, operationId: string) {
    const current = await this.list(runId);
    const next = current.filter((record) => record.operation_id !== operationId);
    if (next.length !== current.length) await this.writeAtomically(runId, next);
  }

  private async writeAtomically(runId: string, records: RetryStateRecord[]) {
    const target = this.statePath(runId);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporary,
        `${JSON.stringify(records, null, 2)}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 }
      );
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async writeMigrationIssuesAtomically(runId: string, issues: RetryStateMigrationIssue[]) {
    const target = this.migrationIssuesPath(runId);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporary,
        `${JSON.stringify(issues, null, 2)}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 }
      );
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

import { retryScheduleRecordSchema, type RetryScheduleRecord } from "@miracle/core";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

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

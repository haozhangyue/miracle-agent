#!/usr/bin/env node

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);

if (args.length === 1 && args[0] === "--version") {
  if (process.env.FAKE_CODEX_HEALTH_STDERR === "huge") process.stderr.write(`${"x".repeat(16 * 1024)}\n`);
  process.stdout.write("codex-cli 0.142.1\n");
  process.exit(0);
}

if (args[0] === "login" && args[1] === "status") {
  if (process.env.FAKE_CODEX_LOGIN === "missing") {
    process.stderr.write("Not logged in\n");
    process.exit(1);
  }
  process.stdout.write("Authenticated\n");
  process.exit(0);
}

if (args[0] === "exec") {
  if (process.env.FAKE_CODEX_EXEC_MARKER) await appendFile(process.env.FAKE_CODEX_EXEC_MARKER, "exec\n", "utf8");
  const mode = process.env.FAKE_CODEX_MODE ?? "success";
  if (mode === "nonzero") {
    process.stdout.write('{"type":"thread.started","thread_id":"thread_fake"}\n');
    process.stderr.write("fake non-zero exit\n");
    process.exit(9);
  }
  if (mode === "invalid-jsonl") {
    process.stdout.write("not-json\n");
    process.exit(0);
  }
  if (mode === "huge-output") {
    process.stdout.write(`${"x".repeat(2048)}\n`);
    process.exit(0);
  }
  if (mode === "huge-stderr") {
    process.stderr.write(`${"x".repeat(2048)}\n`);
    process.exit(0);
  }
  if (mode === "ignore-term") {
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1_000);
  } else {
    const outputFlag = args.indexOf("--output-last-message");
    if (outputFlag >= 0 && args[outputFlag + 1]) {
      const outputPath = path.resolve(args[outputFlag + 1]);
      const cdFlag = args.indexOf("--cd");
      const workDir = cdFlag >= 0 && args[cdFlag + 1] ? path.resolve(args[cdFlag + 1]) : process.cwd();
      const launchContext = await readFile(path.resolve(workDir, "../input/launch_context.json"), "utf8")
        .then((value) => JSON.parse(value))
        .catch(() => ({}));
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(
        outputPath,
        launchContext.inputs?.force_invalid_output
          ? JSON.stringify({ artifact_type: "text", content: "invalid" })
          : launchContext.inputs?.force_multi_output
            ? JSON.stringify({
              outputs: [
                { output_id: "voiceover", artifact_type: "script", content: "这是经校验的口播稿。" },
                { output_id: "summary", artifact_type: "report", content: "# Miracle P7-03\n\n这是经校验的报告。\n" }
              ]
            })
            : launchContext.inputs?.force_collision_output
              ? JSON.stringify({
                outputs: [
                  { output_id: "a/b", artifact_type: "report", content: "# slash output\n" },
                  { output_id: "a?b", artifact_type: "script", content: "collision-safe script" }
                ]
              })
            : JSON.stringify({ artifact_type: "markdown", content: "# Miracle P6-07\n\n这是 fake-codex 生成并经过校验的 Markdown 母稿。\n" }),
        "utf8"
      );
    }
    process.stdout.write('{"type":"thread.started","thread_id":"thread_fake"}\n');
    process.stdout.write('{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}\n');
    process.exit(0);
  }
}

process.stderr.write(`unsupported fake Codex command: ${args.join(" ")}\n`);
process.exit(2);

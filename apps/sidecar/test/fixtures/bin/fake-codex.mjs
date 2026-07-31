#!/usr/bin/env node

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);

if (args.length === 1 && args[0] === "--version") {
  if (process.env.FAKE_CODEX_PERMISSION === "denied") {
    process.stderr.write("Permission denied\n");
    process.exit(126);
  }
  if (process.env.FAKE_CODEX_HEALTH_STDERR === "huge") process.stderr.write(`${"x".repeat(16 * 1024)}\n`);
  process.stdout.write("codex-cli 0.142.1\n");
  process.exit(0);
}

if (args[0] === "login" && args[1] === "status") {
  if (process.env.FAKE_CODEX_LOGIN === "missing") {
    process.stderr.write("Not logged in\n");
    process.exit(1);
  }
  if (process.env.FAKE_CODEX_LOGIN === "error") {
    process.stderr.write("Login status check failed\n");
    process.exit(2);
  }
  process.stdout.write("Authenticated\n");
  process.exit(0);
}

if (args[0] === "exec") {
  if (process.env.FAKE_CODEX_EXEC_MARKER) await appendFile(process.env.FAKE_CODEX_EXEC_MARKER, "exec\n", "utf8");
  const schemaFlag = args.indexOf("--output-schema");
  if (schemaFlag < 0 || !args[schemaFlag + 1]) {
    process.stderr.write("missing --output-schema\n");
    process.exit(10);
  }
  const outputSchema = JSON.parse(await readFile(path.resolve(args[schemaFlag + 1]), "utf8"));
  const forbiddenSchemaKeywords = new Set([
    "allOf",
    "oneOf",
    "contains",
    "minContains",
    "maxContains",
    "pattern",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems"
  ]);
  const inspectSchema = (value) => {
    if (Array.isArray(value)) return value.find(inspectSchema);
    if (!value || typeof value !== "object") return undefined;
    for (const [key, child] of Object.entries(value)) {
      if (forbiddenSchemaKeywords.has(key)) return key;
      const nested = inspectSchema(child);
      if (nested) return nested;
    }
    return undefined;
  };
  const forbiddenKeyword = inspectSchema(outputSchema);
  if (forbiddenKeyword) {
    process.stderr.write(`unsupported output schema keyword: ${forbiddenKeyword}\n`);
    process.exit(11);
  }
  const inspectSchemaLimits = (schema) => {
    let propertyCount = 0;
    let stringCharacters = 0;
    let violation;
    const addCharacters = (value) => {
      if (violation) return;
      const encoded = typeof value === "string" ? value : JSON.stringify(value);
      stringCharacters += encoded?.length ?? 0;
      if (stringCharacters > 120_000) violation = "schema string characters exceed 120000";
    };
    const visit = (value, depth) => {
      if (violation || !value || typeof value !== "object" || Array.isArray(value)) return;
      if (depth > 10) {
        violation = "schema nesting depth exceeds 10";
        return;
      }
      if (value.properties && typeof value.properties === "object" && !Array.isArray(value.properties)) {
        for (const [name, child] of Object.entries(value.properties)) {
          propertyCount += 1;
          if (propertyCount > 5_000) {
            violation = "schema object properties exceed 5000";
            return;
          }
          addCharacters(name);
          visit(child, depth + 1);
        }
      }
      for (const definitionKeyword of ["$defs", "definitions"]) {
        const definitions = value[definitionKeyword];
        if (!definitions || typeof definitions !== "object" || Array.isArray(definitions)) continue;
        for (const [name, child] of Object.entries(definitions)) {
          addCharacters(name);
          visit(child, depth + 1);
        }
      }
      if (Array.isArray(value.items)) {
        for (const child of value.items) visit(child, depth + 1);
      } else if (value.items) {
        visit(value.items, depth + 1);
      }
      for (const unionKeyword of ["anyOf", "allOf", "oneOf"]) {
        if (Array.isArray(value[unionKeyword])) {
          for (const child of value[unionKeyword]) visit(child, depth + 1);
        }
      }
      if (Array.isArray(value.enum)) {
        for (const item of value.enum) addCharacters(item);
      }
      if (Object.hasOwn(value, "const")) addCharacters(value.const);
    };
    visit(schema, 1);
    return violation;
  };
  const schemaLimitViolation = inspectSchemaLimits(outputSchema);
  if (schemaLimitViolation) {
    process.stderr.write(`invalid output schema: ${schemaLimitViolation}\n`);
    process.exit(12);
  }
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
      const attemptId = path.basename(path.resolve(workDir, ".."));
      if (launchContext.inputs?.force_fail_first_attempt && !attemptId.endsWith("_2")) {
        process.stdout.write('{"type":"thread.started","thread_id":"thread_retry_once"}\n');
        process.stderr.write("stateful fake first attempt failure\n");
        process.exit(9);
      }
      if (launchContext.inputs?.force_slow_output) {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
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
            : launchContext.inputs?.force_near_limit_multi_output
              ? JSON.stringify({
                outputs: [
                  { output_id: "voiceover", artifact_type: "script", content: "v".repeat(1_000_000) },
                  { output_id: "summary", artifact_type: "report", content: "s".repeat(1_000_000) }
                ]
              })
            : launchContext.inputs?.force_collision_output
              ? JSON.stringify({
                outputs: [
                  { output_id: "a/b", artifact_type: "report", content: "# slash output\n" },
                  { output_id: "a?b", artifact_type: "script", content: "collision-safe script" }
                ]
              })
              : launchContext.inputs?.force_case_collision_output
                ? JSON.stringify({
                  outputs: [
                    { output_id: "Summary", artifact_type: "report", content: "# upper-case summary\n" },
                    { output_id: "summary", artifact_type: "script", content: "lower-case summary" }
                  ]
                })
                : launchContext.inputs?.force_suffix_collision_output
                  ? JSON.stringify({
                    outputs: [
                      { output_id: "a/b", artifact_type: "report", content: "# slash output\n" },
                      { output_id: "a?b", artifact_type: "script", content: "question output" },
                      { output_id: "a_b_c14cddc033f6", artifact_type: "outline", content: "# raw normalized suffix\n" }
                    ]
                  })
                  : launchContext.inputs?.force_long_output
                    ? JSON.stringify({ artifact_type: "report", content: "# bounded identity\n" })
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

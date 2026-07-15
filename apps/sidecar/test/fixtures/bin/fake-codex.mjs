#!/usr/bin/env node

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
    process.stdout.write('{"type":"thread.started","thread_id":"thread_fake"}\n');
    process.stdout.write('{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}\n');
    process.exit(0);
  }
}

process.stderr.write(`unsupported fake Codex command: ${args.join(" ")}\n`);
process.exit(2);

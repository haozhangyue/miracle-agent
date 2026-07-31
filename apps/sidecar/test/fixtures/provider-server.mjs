import { createServer } from "node:http";

const oversizedBody = JSON.stringify({
  id: "fixture-oversized",
  choices: [{ message: { content: "x".repeat(1_100_000) } }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
});

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
    json(res, 404, { error: { message: "not found" } });
    return;
  }

  for await (const _chunk of req) {
    // Consume the request so client-side transport behavior matches a real server.
  }

  const mode = url.searchParams.get("mode") ?? "success";
  if (mode === "401") return json(res, 401, { error: { message: "unauthorized" } });
  if (mode === "429") return json(res, 429, { error: { message: "rate limited" } });
  if (mode === "500") return json(res, 500, { error: { message: "provider failure" } });
  if (mode === "slow") return setTimeout(() => json(res, 200, successBody()), 300);
  if (mode === "invalid-json") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end("{not-json");
    return;
  }
  if (mode === "oversized") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(oversizedBody);
    return;
  }
  return json(res, 200, successBody(mode !== "missing-usage"));
});

function successBody(withUsage = true) {
  return {
    id: "fixture-chatcmpl-001",
    choices: [{ message: { content: "fixture completion" } }],
    ...(withUsage ? { usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 } } : {})
  };
}

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not bind a TCP port.");
  process.stdout.write(`provider-fixture:${address.port}\n`);
});

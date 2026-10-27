/**
 * Tiny OpenAI-compatible mock used to smoke-test the translation UI without a
 * paid API key. It is not part of the app bundle.
 *
 *   node scripts/mock-openai.mjs
 *   Settings -> OpenAI-compatible -> http://127.0.0.1:8787/v1
 */
import http from "node:http";

const port = Number(process.env.PORT || 8787);

const server = http.createServer((req, res) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
    res.writeHead(404, { ...cors, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Not found" } }));
    return;
  }

  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    let boxCount = 3;
    try {
      const parsed = JSON.parse(body);
      const text = JSON.stringify(parsed.messages ?? []);
      const match = text.match(/exactly\s+(\d+)\s+translations/i);
      if (match) boxCount = Number(match[1]);
    } catch {
      // Keep the default count; the response is only a smoke test.
    }

    const translations = Array.from(
      { length: boxCount },
      (_, index) => `ترجمة تجريبية ${index + 1}`,
    );
    const sourceTexts = Array.from(
      { length: boxCount },
      (_, index) => `Mock source ${index + 1}`,
    );
    const content = JSON.stringify({ translations, sourceTexts });

    res.writeHead(200, { ...cors, "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content } }],
      }),
    );
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Mock OpenAI-compatible server listening on http://127.0.0.1:${port}/v1`);
});

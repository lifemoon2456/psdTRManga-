/**
 * Tiny Gemini-compatible mock for local smoke tests. It is not part of the app
 * bundle and never calls a real API.
 *
 *   PORT=8788 node scripts/mock-gemini.mjs
 *
 * Then set:
 *   Gemini base URL: http://127.0.0.1:8788/v1beta
 *   Model:           mock-gemini
 *   Mode:            Text only
 *
 * Scenario models:
 *   mock-gemini         normal, returns ID-keyed translations in shuffled order
 *   mock-missing        omits the last bubble on every response (tests recovery)
 *   mock-malformed      returns invalid JSON once, then valid JSON
 *   mock-429-once       returns 429 once, then succeeds (tests Retry-After)
 *   mock-429-daily      always returns a daily-quota 429 (tests pause)
 *   mock-offline        closes the connection without a response
 */
import http from "node:http";

const port = Number(process.env.PORT || 8788);
const calls = new Map();
let totalCalls = 0;

function cors(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type, x-goog-api-key, authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    ...extra,
  };
}

function send(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, cors({ "Content-Type": "application/json; charset=utf-8", ...extraHeaders }));
  res.end(text);
}

function segmentsFromBody(body) {
  const parts = body?.contents?.[0]?.parts || [];
  const text = parts.map((part) => part.text || "").join("\n");
  const marker = text.lastIndexOf('{"segments"');
  if (marker < 0) return [];
  try {
    const parsed = JSON.parse(text.slice(marker));
    return Array.isArray(parsed.segments) ? parsed.segments : [];
  } catch {
    return [];
  }
}

function translationPayload(segments, { omitLast = false } = {}) {
  const ordered = segments.length > 2 ? [segments[1], segments[0], ...segments.slice(2)] : segments;
  const kept = omitLast ? ordered.slice(0, Math.max(0, ordered.length - 1)) : ordered;
  return {
    candidates: [
      {
        content: {
          parts: [
            {
              text: JSON.stringify({
                translations: kept.map((segment) => ({
                  id: segment.id,
                  translation: `ترجمة ${segment.id}`,
                })),
              }),
            },
          ],
        },
        finishReason: "STOP",
      },
    ],
    usageMetadata: {
      promptTokenCount: Math.max(1, Math.round(JSON.stringify(bodySafe(segments)).length / 4)),
      candidatesTokenCount: Math.max(1, kept.length * 8),
      totalTokenCount: Math.max(2, Math.round(JSON.stringify(bodySafe(segments)).length / 4) + kept.length * 8),
    },
  };
}

function bodySafe(value) {
  try {
    return value ?? [];
  } catch {
    return [];
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors());
    res.end();
    return;
  }

  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
  });
  req.on("end", () => {
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      send(res, 400, { error: { message: "Invalid JSON body." } });
      return;
    }

    const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
    const model = decodeURIComponent(url.pathname.split("/models/")[1] || "").replace(
      /:(generateContent|countTokens)$/,
      "",
    );
    totalCalls++;
    calls.set(model, (calls.get(model) || 0) + 1);
    const call = calls.get(model) || 0;
    console.log(`[mock-gemini] #${totalCalls} model=${model} path=${url.pathname}`);

    if (model === "mock-offline") {
      req.socket.destroy();
      return;
    }
    if (model === "mock-429-daily") {
      send(
        res,
        429,
        {
          error: {
            code: 429,
            message: "Resource exhausted: quota exceeded for per-day limit.",
            status: "RESOURCE_EXHAUSTED",
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.QuotaFailure",
                violations: [
                  { quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" },
                ],
              },
            ],
          },
        },
        { "Retry-After": "3600" },
      );
      return;
    }
    if (model === "mock-429-once" && call === 1) {
      send(
        res,
        429,
        { error: { code: 429, message: "Rate limit exceeded. Try again shortly.", status: "RESOURCE_EXHAUSTED" } },
        { "Retry-After": "0" },
      );
      return;
    }
    if (url.pathname.endsWith(":countTokens")) {
      send(res, 200, { totalTokens: 1234 });
      return;
    }
    if (!url.pathname.endsWith(":generateContent")) {
      send(res, 404, { error: { message: "Not found.", status: "NOT_FOUND" } });
      return;
    }
    if (model === "mock-malformed" && call === 1) {
      send(res, 200, {
        candidates: [{ content: { parts: [{ text: "This is not JSON." }] }, finishReason: "STOP" }],
      });
      return;
    }

    const segments = segmentsFromBody(body);
    if (segments.length === 0) {
      send(res, 400, { error: { message: "No segments found in prompt.", status: "INVALID_ARGUMENT" } });
      return;
    }
    send(res, 200, translationPayload(segments, { omitLast: model === "mock-missing" }));
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[mock-gemini] listening on http://127.0.0.1:${port}/v1beta`);
  console.log("[mock-gemini] models: mock-gemini, mock-missing, mock-malformed, mock-429-once, mock-429-daily, mock-offline");
});

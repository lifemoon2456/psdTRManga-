import type { TranslationSettings } from "../src/lib/translation";

export interface MockRequest {
  url: string;
  body: Record<string, unknown>;
  rawBody: string;
  headers: Record<string, string>;
}

export function makeSettings(
  overrides: Partial<TranslationSettings> = {},
): TranslationSettings {
  return {
    engine: "gemini",
    sourceLang: "English",
    targetLang: "Arabic",
    geminiApiKey: "test-key",
    geminiModel: "mock-model",
    geminiBaseUrl: "http://mock.local/v1beta",
    geminiMode: "text",
    openaiBaseUrl: "http://mock.local/v1",
    openaiApiKey: "",
    openaiModel: "mock-vl",
    openaiJsonMode: false,
    temperature: 0.25,
    smartBatch: true,
    batchPages: 4,
    batchTokenBudget: 12_000,
    maxConcurrentRequests: 1,
    rpmLimit: 0,
    tpmLimit: 0,
    maxRetries: 0,
    useCountTokens: false,
    cacheEnabled: false,
    useVisionOnOcrFailure: false,
    seriesSummary: "",
    glossary: "",
    ...overrides,
  };
}

export function textSegmentsFromBody(body: Record<string, unknown>): Array<{ id: string; text: string }> {
  const contents = body.contents as Array<{ parts?: Array<{ text?: string }> }> | undefined;
  const text = (contents?.[0]?.parts ?? []).map((part) => part.text ?? "").join("\n");
  const marker = text.lastIndexOf('{"segments"');
  if (marker < 0) return [];
  try {
    const parsed = JSON.parse(text.slice(marker)) as {
      segments?: Array<{ id?: string; text?: string }>;
    };
    return (parsed.segments ?? [])
      .filter((segment): segment is { id: string; text: string } =>
        typeof segment.id === "string" && typeof segment.text === "string",
      )
      .map((segment) => ({ id: segment.id, text: segment.text }));
  } catch {
    return [];
  }
}

export function geminiSuccess(
  segments: Array<{ id: string; text: string }>,
  options: { shuffle?: boolean; translate?: (segment: { id: string; text: string }) => string } = {},
): Response {
  const ordered = options.shuffle && segments.length > 2
    ? [segments[1], segments[0], ...segments.slice(2)]
    : segments;
  const payload = {
    candidates: [
      {
        content: {
          parts: [
            {
              text: JSON.stringify({
                translations: ordered.map((segment) => ({
                  id: segment.id,
                  translation: options.translate?.(segment) ?? `ترجمة ${segment.id}`,
                })),
              }),
            },
          ],
        },
        finishReason: "STOP",
      },
    ],
    usageMetadata: {
      promptTokenCount: 100,
      candidatesTokenCount: segments.length * 8,
      totalTokenCount: 100 + segments.length * 8,
    },
  };
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export function gemini429(retryAfterSeconds = "0", daily = false): Response {
  const error = daily
    ? {
        code: 429,
        message: "Quota exceeded for per-day limit.",
        status: "RESOURCE_EXHAUSTED",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.QuotaFailure",
            violations: [
              { quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" },
            ],
          },
        ],
      }
    : { code: 429, message: "Rate limit exceeded. Try again shortly.", status: "RESOURCE_EXHAUSTED" };
  return new Response(JSON.stringify({ error }), {
    status: 429,
    headers: {
      "content-type": "application/json",
      "retry-after": retryAfterSeconds,
    },
  });
}

export function installFetch(
  handler: (
    request: MockRequest,
    callIndex: number,
  ) => Promise<Response> | Response,
): { requests: MockRequest[]; restore: () => void } {
  const original = globalThis.fetch;
  const requests: MockRequest[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawBody = typeof init?.body === "string" ? init.body : "";
    const body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const request = {
      url: String(input),
      body,
      rawBody,
      headers,
    };
    requests.push(request);
    return handler(request, requests.length - 1);
  }) as typeof fetch;
  return {
    requests,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

export function installNeverFetch(): { restore: () => void; requests: string[] } {
  const original = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      requests.push(String(input));
      const signal = init?.signal;
      const abort = () => reject(new DOMException("Aborted", "AbortError"));
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    })) as typeof fetch;
  return {
    requests,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";
import {
  RequestManager,
  isAbortError,
} from "../src/lib/translation/request-manager";
import {
  translateBubbles,
} from "../src/lib/translation/smart-batch";
import {
  bubbleId,
  type TranslationBubbleInput,
} from "../src/lib/translation/batching";
import {
  clearTranslationCache,
  translationCacheKey,
} from "../src/lib/translation/cache";
import {
  gemini429,
  geminiSuccess,
  installFetch,
  installNeverFetch,
  makeSettings,
  textSegmentsFromBody,
} from "./helpers";

function makeInputs(pages: number, bubbles: number): TranslationBubbleInput[] {
  const inputs: TranslationBubbleInput[] = [];
  for (let pageIndex = 0; pageIndex < pages; pageIndex++) {
    for (let boxIndex = 0; boxIndex < bubbles; boxIndex++) {
      inputs.push({
        id: bubbleId(pageIndex, boxIndex),
        text: `page ${pageIndex + 1} dialogue ${boxIndex + 1}`,
        pageId: `page-${pageIndex + 1}`,
        pageIndex,
        boxIndex,
      });
    }
  }
  return inputs;
}

function manager(overrides: Partial<ConstructorParameters<typeof RequestManager>[0]> = {}): RequestManager {
  return new RequestManager({
    config: {
      maxConcurrent: 1,
      rpm: 0,
      tpm: 0,
      maxRetries: 0,
      baseDelayMs: 1,
      maxDelayMs: 10,
    },
    ...overrides,
  });
}

test("30 pages x 18 bubbles uses 8 text-only requests and keeps every ID", async () => {
  const inputs = makeInputs(30, 18);
  const { requests, restore } = installFetch((request) => {
    const segments = textSegmentsFromBody(request.body);
    assert.ok(segments.length > 0);
    assert.ok(!JSON.stringify(request.body).includes("inlineData"));
    assert.ok(!request.rawBody.includes("base64"));
    return geminiSuccess(segments, { shuffle: true });
  });

  try {
    const requestManager = manager();
    const result = await translateBubbles(inputs, {
      settings: makeSettings(),
      manager: requestManager,
    });

    assert.equal(result.translations.size, 540);
    assert.equal(result.batches, 8);
    assert.equal(result.requestedBubbles, 540);
    assert.equal(result.missing.length, 0);
    assert.equal(requests.length, 8);
    assert.equal(requestManager.snapshot().requests, 8);
    assert.equal(result.translations.get("p001_b001"), "ترجمة p001_b001");
    assert.equal(result.translations.get("p030_b018"), "ترجمة p030_b018");
  } finally {
    restore();
  }
});

test("malformed JSON retries once without responseSchema, then succeeds", async () => {
  const inputs = makeInputs(1, 2);
  let call = 0;
  const { requests, restore } = installFetch((request) => {
    call++;
    const segments = textSegmentsFromBody(request.body);
    if (call === 1) {
      return new Response(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ text: "not json at all" }] }, finishReason: "STOP" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const generationConfig = request.body.generationConfig as Record<string, unknown>;
    assert.equal(generationConfig.responseSchema, undefined);
    return geminiSuccess(segments);
  });

  try {
    const result = await translateBubbles(inputs, {
      settings: makeSettings(),
      manager: manager(),
    });
    assert.equal(requests.length, 2);
    assert.equal(result.translations.size, 2);
    assert.equal(result.missing.length, 0);
  } finally {
    restore();
  }
});

test("partial response keeps valid bubbles and retries only missing IDs", async () => {
  const inputs = makeInputs(1, 2);
  let firstId = "";
  const { requests, restore } = installFetch((request) => {
    const segments = textSegmentsFromBody(request.body);
    if (!firstId) firstId = segments[0]?.id ?? "";
    return geminiSuccess([{ id: firstId, text: "unused" }]);
  });

  try {
    const result = await translateBubbles(inputs, {
      settings: makeSettings(),
      manager: manager(),
    });
    assert.equal(result.translations.size, 1);
    assert.equal(result.translations.get("p001_b001"), "ترجمة p001_b001");
    assert.deepEqual(result.missing, ["p001_b002"]);
    assert.equal(requests.length, 3);
    assert.ok(
      requests.slice(1).every((request) => textSegmentsFromBody(request.body).length === 1),
      "missing-ID retries must send only the missing bubble",
    );
  } finally {
    restore();
  }
});

test("429 Retry-After is honored and the same request succeeds", async () => {
  const inputs = makeInputs(1, 1);
  let call = 0;
  const { requests, restore } = installFetch((request) => {
    call++;
    if (call === 1) return gemini429("0");
    return geminiSuccess(textSegmentsFromBody(request.body));
  });

  try {
    const requestManager = manager();
    const result = await translateBubbles(inputs, {
      settings: makeSettings({ maxRetries: 1 }),
      manager: requestManager,
    });
    assert.equal(requests.length, 2);
    assert.equal(result.translations.size, 1);
    assert.equal(requestManager.snapshot().retries, 1);
    assert.equal(requestManager.snapshot().requests, 2);
  } finally {
    restore();
  }
});

test("daily quota pauses without retrying and preserves completed state", async () => {
  const inputs = makeInputs(1, 1);
  const { requests, restore } = installFetch(() => gemini429("0", true));

  try {
    const requestManager = manager();
    await assert.rejects(
      translateBubbles(inputs, {
        settings: makeSettings({ maxRetries: 4 }),
        manager: requestManager,
      }),
      /حصة|Quota|quota/,
    );
    assert.equal(requests.length, 1);
    assert.ok((requestManager.snapshot().quotaPausedUntil ?? 0) > Date.now());
  } finally {
    restore();
  }
});

test("offline failure retries with backoff and then stops without losing completed batches", async () => {
  const inputs = makeInputs(1, 1);
  const { requests, restore } = installFetch(() => {
    throw new TypeError("fetch failed");
  });

  try {
    const requestManager = manager();
    await assert.rejects(
      translateBubbles(inputs, {
        settings: makeSettings({ maxRetries: 1 }),
        manager: requestManager,
      }),
      /اتصال|fetch failed/,
    );
    assert.equal(requests.length, 2);
    assert.equal(requestManager.snapshot().failedRequests, 1);
  } finally {
    restore();
  }
});

test("abort stops in-flight work", async () => {
  const inputs = makeInputs(1, 2);
  const { requests, restore } = installNeverFetch();
  const controller = new AbortController();
  const pending = translateBubbles(inputs, {
    settings: makeSettings(),
    manager: manager(),
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 20);

  try {
    await assert.rejects(pending, (error) => isAbortError(error));
    assert.equal(requests.length, 1);
  } finally {
    restore();
  }
});

test("cache reuses identical source text and ignores edits to other bubbles", async () => {
  await clearTranslationCache();
  const inputs = makeInputs(1, 2);
  let calls = 0;
  const { requests, restore } = installFetch((request) => {
    calls++;
    return geminiSuccess(textSegmentsFromBody(request.body));
  });

  try {
    const first = await translateBubbles(inputs, {
      settings: makeSettings({ cacheEnabled: true }),
      manager: manager(),
    });
    assert.equal(first.cacheHits, 0);
    assert.equal(requests.length, 1);

    const second = await translateBubbles(inputs, {
      settings: makeSettings({ cacheEnabled: true }),
      manager: manager(),
    });
    assert.equal(second.translations.size, 2);
    assert.equal(second.cacheHits, 2);
    assert.equal(requests.length, 1, "cache hit must not call the API");
    assert.equal(calls, 1);

    const keyA = await translationCacheKey({
      sourceText: "first line",
      sourceLang: "English",
      targetLang: "Arabic",
      model: "mock-model",
      temperature: 0.25,
      glossary: "",
      seriesSummary: "",
    });
    const keyB = await translationCacheKey({
      sourceText: "edited line",
      sourceLang: "English",
      targetLang: "Arabic",
      model: "mock-model",
      temperature: 0.25,
      glossary: "",
      seriesSummary: "",
    });
    assert.notEqual(keyA, keyB);
  } finally {
    restore();
  }
});

import {
  estimateBatchTokens,
  planTextBatches,
  type TextBatch,
  type TranslationBubbleInput,
} from "./batching";
import {
  getCachedTranslation,
  putCachedTranslation,
  translationCacheKey,
  type TranslationCacheRecord,
} from "./cache";
import { countGeminiTextTokens, requestGeminiTextBatch, type GeminiTextOptions } from "./gemini-text";
import {
  ApiError,
  BatchTooLargeError,
  QuotaExhaustedError,
  RequestAbortedError,
  isAbortError,
  type RequestManager,
  type RequestManagerStats,
} from "./request-manager";
import { parseLlmJson, validateIdTranslations } from "./validator";
import type { TranslationSettings } from "./index";

export interface SmartBatchCallbacks {
  onCacheHit?: (input: TranslationBubbleInput, translation: string) => void;
  onTranslated?: (
    input: TranslationBubbleInput,
    translation: string,
    meta: { fromCache: boolean; batchId: string },
  ) => void;
  onBatchStart?: (batch: TextBatch, index: number, total: number) => void;
  onBatchComplete?: (
    batch: TextBatch,
    index: number,
    total: number,
    translatedCount: number,
    error?: string,
  ) => void;
  onBatchProgress?: (
    batch: TextBatch,
    index: number,
    total: number,
    remainingBatches: number,
  ) => void;
  onError?: (error: unknown, batch?: TextBatch) => void;
  onManagerStats?: (stats: RequestManagerStats) => void;
}

export interface SmartBatchOptions {
  settings: TranslationSettings;
  manager: RequestManager;
  signal?: AbortSignal;
  forceRefresh?: boolean;
  callbacks?: SmartBatchCallbacks;
}

export interface SmartBatchResult {
  translations: Map<string, string>;
  cacheHits: number;
  requestedBubbles: number;
  batches: number;
  missing: string[];
  errors: string[];
}

interface BatchTranslationResult {
  translations: Map<string, string>;
  missing: string[];
  unexpected: string[];
  duplicates: string[];
  countedPromptTokens?: number;
}

function geminiOptions(
  settings: TranslationSettings,
  manager: RequestManager,
  signal: AbortSignal | undefined,
  structuredOutput?: boolean,
): GeminiTextOptions {
  return {
    apiKey: settings.geminiApiKey,
    model: settings.geminiModel,
    baseUrl: settings.geminiBaseUrl,
    sourceLang: settings.sourceLang,
    targetLang: settings.targetLang,
    temperature: settings.temperature,
    seriesSummary: settings.seriesSummary,
    glossary: settings.glossary,
    manager,
    signal,
    structuredOutput,
  };
}

function cacheKeyFor(
  input: TranslationBubbleInput,
  settings: TranslationSettings,
): Promise<string> {
  return translationCacheKey({
    sourceText: input.text,
    sourceLang: settings.sourceLang,
    targetLang: settings.targetLang,
    model: settings.geminiModel,
    temperature: settings.temperature,
    glossary: settings.glossary,
    seriesSummary: settings.seriesSummary,
  });
}

function cacheRecordFor(
  input: TranslationBubbleInput,
  translation: string,
  settings: TranslationSettings,
  key: string,
): TranslationCacheRecord {
  const now = Date.now();
  return {
    key,
    translation,
    sourceText: input.text,
    sourceLang: settings.sourceLang,
    targetLang: settings.targetLang,
    model: settings.geminiModel,
    createdAt: now,
    lastUsedAt: now,
  };
}

function isFatalError(error: unknown): boolean {
  if (error instanceof QuotaExhaustedError) return true;
  if (isAbortError(error)) return true;
  if (error instanceof ApiError) {
    if (error.batchTooLarge) return false;
    if (error.status === 0) return true;
    if (error.status === 401 || error.status === 403 || error.status === 404) return true;
    if (error.status === 429) return true;
    if (error.status >= 500) return true;
  }
  return false;
}

function splitSegments(segments: TranslationBubbleInput[]): [TranslationBubbleInput[], TranslationBubbleInput[]] {
  const middle = Math.ceil(segments.length / 2);
  return [segments.slice(0, middle), segments.slice(middle)];
}

/**
 * Translate one batch with ID-aware recovery:
 * - validate missing/duplicate/unexpected ids instead of trusting array order;
 * - keep every valid translation;
 * - retry only missing ids with minimal context;
 * - split oversized batches;
 * - retry malformed JSON once before splitting.
 */
async function translateBatchWithRecovery(
  segments: TranslationBubbleInput[],
  options: SmartBatchOptions,
  depth = 0,
  structuredOutput = true,
): Promise<BatchTranslationResult> {
  if (segments.length === 0) {
    return { translations: new Map(), missing: [], unexpected: [], duplicates: [] };
  }
  if (options.signal?.aborted) throw new RequestAbortedError();

  const gemini = geminiOptions(options.settings, options.manager, options.signal, structuredOutput);
  let countedPromptTokens: number | undefined;

  if (options.settings.useCountTokens && depth === 0) {
    try {
      countedPromptTokens = await countGeminiTextTokens(segments, gemini);
      if (
        segments.length > 1 &&
        countedPromptTokens > Math.max(1000, options.settings.batchTokenBudget)
      ) {
        const [left, right] = splitSegments(segments);
        const leftResult = await translateBatchWithRecovery(left, options, depth + 1, structuredOutput);
        const rightResult = await translateBatchWithRecovery(right, options, depth + 1, structuredOutput);
        return mergeBatchResults(leftResult, rightResult);
      }
    } catch (error) {
      if (isAbortError(error) || error instanceof QuotaExhaustedError) throw error;
      // countTokens is advisory; fall back to the local estimate.
      options.callbacks?.onError?.(error);
    }
  }

  let rawText: string;
  try {
    const response = await requestGeminiTextBatch(segments, gemini);
    rawText = response.text;
  } catch (error) {
    if (error instanceof BatchTooLargeError && segments.length > 1) {
      const [left, right] = splitSegments(segments);
      const leftResult = await translateBatchWithRecovery(left, options, depth + 1, structuredOutput);
      const rightResult = await translateBatchWithRecovery(right, options, depth + 1, structuredOutput);
      return mergeBatchResults(leftResult, rightResult);
    }
    throw error;
  }

  let validated: ReturnType<typeof validateIdTranslations>;
  try {
    const raw = parseLlmJson(rawText);
    validated = validateIdTranslations(
      raw,
      segments.map((segment) => segment.id),
    );
  } catch (error) {
    if (structuredOutput) {
      return translateBatchWithRecovery(segments, options, depth, false);
    }
    if (segments.length > 1) {
      const [left, right] = splitSegments(segments);
      const leftResult = await translateBatchWithRecovery(left, options, depth + 1, false);
      const rightResult = await translateBatchWithRecovery(right, options, depth + 1, false);
      return mergeBatchResults(leftResult, rightResult);
    }
    throw error;
  }

  const translations = new Map<string, string>();
  for (const [id, translation] of validated.translations) {
    if (translation.trim()) translations.set(id, translation);
  }

  if (validated.missing.length > 0 && depth < 2) {
    const missingSet = new Set(validated.missing);
    const missingSegments = segments.filter((segment) => missingSet.has(segment.id));
    if (missingSegments.length > 0) {
      const retry = await translateBatchWithRecovery(
        missingSegments,
        options,
        depth + 1,
        structuredOutput,
      );
      for (const [id, translation] of retry.translations) translations.set(id, translation);
      return {
        translations,
        missing: retry.missing,
        unexpected: [...new Set([...validated.unexpected, ...retry.unexpected])],
        duplicates: [...new Set([...validated.duplicates, ...retry.duplicates])],
        countedPromptTokens,
      };
    }
  }

  return {
    translations,
    missing: validated.missing,
    unexpected: validated.unexpected,
    duplicates: validated.duplicates,
    countedPromptTokens,
  };
}

function mergeBatchResults(
  left: BatchTranslationResult,
  right: BatchTranslationResult,
): BatchTranslationResult {
  return {
    translations: new Map([...left.translations, ...right.translations]),
    missing: [...new Set([...left.missing, ...right.missing])],
    unexpected: [...new Set([...left.unexpected, ...right.unexpected])],
    duplicates: [...new Set([...left.duplicates, ...right.duplicates])],
    countedPromptTokens: (left.countedPromptTokens ?? 0) + (right.countedPromptTokens ?? 0) || undefined,
  };
}

function combineSignals(signals: Array<AbortSignal | undefined>): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}

export async function translateBubbles(
  inputs: TranslationBubbleInput[],
  options: SmartBatchOptions,
): Promise<SmartBatchResult> {
  if (options.signal?.aborted) throw new RequestAbortedError();
  const settings = options.settings;
  const callbacks = options.callbacks ?? {};
  const internalAbort = new AbortController();
  const requestSignal = combineSignals([options.signal, internalAbort.signal]);
  const effectiveOptions: SmartBatchOptions = { ...options, signal: requestSignal };
  const result: SmartBatchResult = {
    translations: new Map(),
    cacheHits: 0,
    requestedBubbles: 0,
    batches: 0,
    missing: [],
    errors: [],
  };

  const usable = inputs.filter((input) => input.text.trim().length > 0);
  if (usable.length === 0) return result;

  const keys = new Map<string, string>();
  await Promise.all(
    usable.map(async (input) => {
      try {
        keys.set(input.id, await cacheKeyFor(input, settings));
      } catch {
        // A failed cache key must not prevent translation.
      }
    }),
  );

  const cacheWrites: Promise<void>[] = [];
  const applyTranslation = (
    input: TranslationBubbleInput,
    translation: string,
    fromCache: boolean,
    batchId: string,
    persist: boolean,
  ) => {
    if (!translation.trim() || result.translations.has(input.id)) return;
    result.translations.set(input.id, translation);
    if (fromCache) result.cacheHits++;
    callbacks.onTranslated?.(input, translation, { fromCache, batchId });
    if (fromCache) callbacks.onCacheHit?.(input, translation);
    if (persist && settings.cacheEnabled) {
      const key = keys.get(input.id);
      if (key) {
        cacheWrites.push(
          putCachedTranslation(
            cacheRecordFor(input, translation, settings, key),
          ).catch(() => {
            // Cache write failures are non-fatal.
          }),
        );
      }
    }
  };

  const misses: TranslationBubbleInput[] = [];
  for (const input of usable) {
    if (!settings.cacheEnabled || options.forceRefresh) {
      misses.push(input);
      continue;
    }
    const key = keys.get(input.id);
    if (!key) {
      misses.push(input);
      continue;
    }
    try {
      const cached = await getCachedTranslation(key);
      if (cached) {
        applyTranslation(input, cached, true, "cache", false);
      } else {
        misses.push(input);
      }
    } catch {
      misses.push(input);
    }
  }

  result.requestedBubbles = misses.length;
  const batches = planTextBatches(misses, {
    smartBatch: settings.smartBatch,
    batchPages: settings.batchPages,
    tokenBudget: settings.batchTokenBudget,
    maxSegmentsPerBatch: 120,
  });
  result.batches = batches.length;
  if (batches.length === 0) {
    result.missing = [];
    return result;
  }

  options.manager.updateConfig({
    maxConcurrent: settings.maxConcurrentRequests,
    rpm: settings.rpmLimit,
    tpm: settings.tpmLimit,
    maxRetries: settings.maxRetries,
  });

  let fatalError: unknown = null;
  let completedBatches = 0;
  let nextBatch = 0;
  const concurrency = Math.max(
    1,
    Math.min(settings.maxConcurrentRequests || 1, batches.length),
  );

  const runOne = async (batch: TextBatch, index: number): Promise<void> => {
    if (requestSignal.aborted) throw new RequestAbortedError();
    callbacks.onBatchStart?.(batch, index, batches.length);
    try {
      const batchResult = await translateBatchWithRecovery(batch.segments, effectiveOptions);
      for (const segment of batch.segments) {
        const translation = batchResult.translations.get(segment.id);
        if (translation) {
          applyTranslation(segment, translation, false, batch.id, true);
        }
      }
      for (const id of batchResult.missing) {
        if (!result.missing.includes(id)) result.missing.push(id);
      }
      if (batchResult.unexpected.length > 0) {
        result.errors.push(
          `دفعة ${batch.id}: تجاهل ${batchResult.unexpected.length} معرّفًا غير متوقع.`,
        );
      }
      if (batchResult.duplicates.length > 0) {
        result.errors.push(
          `دفعة ${batch.id}: كرر Gemini ${batchResult.duplicates.length} معرّفًا؛ حُفظت النسخة الصحيحة.`,
        );
      }
      if (cacheWrites.length > 0) {
        await Promise.allSettled(cacheWrites.splice(0));
      }
      completedBatches++;
      callbacks.onBatchComplete?.(
        batch,
        index,
        batches.length,
        batch.segments.filter((segment) => result.translations.has(segment.id)).length,
      );
      callbacks.onBatchProgress?.(
        batch,
        index,
        batches.length,
        Math.max(0, batches.length - completedBatches),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`دفعة ${batch.id}: ${message}`);
      callbacks.onError?.(error, batch);
      callbacks.onBatchComplete?.(batch, index, batches.length, 0, message);
      if (isFatalError(error)) {
        fatalError = error;
        internalAbort.abort();
        options.manager.abortPending(message);
        throw error;
      }
    }
  };

  const worker = async (): Promise<void> => {
    while (true) {
      if (fatalError || requestSignal.aborted) return;
      const index = nextBatch++;
      if (index >= batches.length) return;
      await runOne(batches[index], index);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  if (fatalError) throw fatalError;

  result.missing = result.missing.filter((id) => !result.translations.has(id));
  return result;
}

/** Exposed for diagnostics / tests. */
export function batchTokenEstimate(batch: TextBatch): number {
  return estimateBatchTokens(batch.segments);
}

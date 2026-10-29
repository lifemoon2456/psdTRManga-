import { estimateTextTokens } from "./batching";
import {
  extractGeminiText,
  geminiApiError,
  geminiEndpoint,
  geminiFinishReason,
  normalizeGeminiUsage,
  type GeminiErrorBody,
} from "./gemini-common";
import { buildTextBatchJsonSchema, buildTextBatchPrompts } from "./prompts";
import {
  ApiError,
  BatchTooLargeError,
  type RequestManager,
  type TokenUsage,
} from "./request-manager";

export interface GeminiTextSegment {
  id: string;
  text: string;
}

export interface GeminiTextOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  sourceLang: string;
  targetLang: string;
  temperature: number;
  seriesSummary: string;
  glossary: string;
  manager: RequestManager;
  signal?: AbortSignal;
  /** Explicitly disable for a provider/proxy that rejects responseSchema. */
  structuredOutput?: boolean;
}

export interface GeminiTextResponse {
  text: string;
  finishReason: string;
  usage?: TokenUsage;
}

function validateKey(apiKey: string): string {
  const key = apiKey.trim();
  if (!key || /[^\x21-\x7e]/.test(key)) {
    throw new ApiError("مفتاح Gemini فارغ أو يحتوي على أحرف غير صالحة. أعد لصقه.", {
      status: 401,
      retryable: false,
    });
  }
  return key;
}

function buildPrompts(segments: GeminiTextSegment[], options: GeminiTextOptions) {
  return buildTextBatchPrompts({
    sourceLang: options.sourceLang,
    targetLang: options.targetLang,
    glossary: options.glossary,
    seriesSummary: options.seriesSummary,
    segments,
  });
}

function estimatePromptTokens(
  systemPrompt: string,
  userPrompt: string,
  segments: GeminiTextSegment[],
): number {
  const outputEstimate = segments.reduce(
    (total, segment) => total + Math.ceil(estimateTextTokens(segment.text) * 1.25) + 28,
    0,
  );
  return (
    500 +
    estimateTextTokens(systemPrompt) +
    estimateTextTokens(userPrompt) +
    outputEstimate
  );
}

function maxOutputTokensFor(segments: GeminiTextSegment[]): number {
  const estimate = segments.reduce(
    (total, segment) => total + Math.ceil(estimateTextTokens(segment.text) * 1.35) + 36,
    0,
  );
  return Math.min(8192, Math.max(1024, estimate + 300));
}

function bodyFor(
  systemPrompt: string,
  userPrompt: string,
  segments: GeminiTextSegment[],
  options: GeminiTextOptions,
  includeSchema: boolean,
): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = {
    temperature: options.temperature,
    responseMimeType: "application/json",
    maxOutputTokens: maxOutputTokensFor(segments),
  };
  if (includeSchema) generationConfig.responseSchema = buildTextBatchJsonSchema();
  return {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    generationConfig,
  };
}

async function performTextRequest(
  systemPrompt: string,
  userPrompt: string,
  segments: GeminiTextSegment[],
  options: GeminiTextOptions,
  includeSchema: boolean,
): Promise<GeminiTextResponse> {
  const key = validateKey(options.apiKey);
  const url = geminiEndpoint(options.baseUrl, options.model, "generateContent");
  const estimatedTokens = estimatePromptTokens(systemPrompt, userPrompt, segments);

  return options.manager.execute(
    estimatedTokens,
    async (signal) => {
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": key,
          },
          body: JSON.stringify(
            bodyFor(systemPrompt, userPrompt, segments, options, includeSchema),
          ),
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new ApiError("تعذّر الاتصال بـ Gemini. تحقق من الشبكة ثم أعد المحاولة.", {
          retryable: true,
          cause: error,
        });
      }

      const rawText = await response.text();
      let body: GeminiErrorBody;
      try {
        body = JSON.parse(rawText) as GeminiErrorBody;
      } catch {
        if (!response.ok) {
          throw geminiApiError(
            response.status,
            response.statusText,
            {},
            response.headers.get("retry-after"),
            rawText,
          );
        }
        throw new ApiError("رد Gemini ليس JSON صالحًا.", {
          status: response.status,
          retryable: true,
        });
      }

      const usage = normalizeGeminiUsage(
        (body as GeminiErrorBody & {
          usageMetadata?: Parameters<typeof normalizeGeminiUsage>[0];
        }).usageMetadata,
      );

      if (!response.ok) {
        const error = geminiApiError(
          response.status,
          response.statusText,
          body,
          response.headers.get("retry-after"),
          rawText,
        );
        if (error instanceof ApiError) {
          (error as ApiError & { usage?: TokenUsage }).usage = usage;
        }
        throw error;
      }

      if (body.promptFeedback?.blockReason) {
        throw new ApiError(
          `Gemini رفض الطلب: ${body.promptFeedback.blockReason}. جرّب تعديل النص أو السياق.`,
          { status: 400, retryable: false, usage },
        );
      }

      const finishReason = geminiFinishReason(body);
      if (finishReason === "MAX_TOKENS") {
        throw new BatchTooLargeError(
          "تجاوز رد Gemini حد التوكنات. ستُقسَّم الدفعة إلى دفعات أصغر.",
          { usage },
        );
      }
      if (finishReason === "SAFETY" || finishReason === "RECITATION") {
        throw new ApiError(`توقف Gemini بسبب: ${finishReason}.`, {
          status: 400,
          retryable: false,
          usage,
        });
      }

      const text = extractGeminiText(body);
      if (!text) {
        throw new ApiError("Gemini أعاد ردًا فارغًا. ستُعاد المحاولة.", {
          status: response.status,
          retryable: true,
          usage,
        });
      }

      return { data: { text, finishReason, usage }, usage };
    },
    { signal: options.signal },
  );
}

function schemaRejected(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 400 &&
    /response.?schema|schema|responseMimeType|response_mime_type/i.test(error.message)
  );
}

/**
 * Text-only request. It never adds an inlineData part or any Base64 payload.
 */
export async function requestGeminiTextBatch(
  segments: GeminiTextSegment[],
  options: GeminiTextOptions,
): Promise<GeminiTextResponse> {
  const prompts = buildPrompts(segments, options);
  const structured = options.structuredOutput !== false;

  try {
    return await performTextRequest(
      prompts.systemPrompt,
      prompts.userPrompt,
      segments,
      options,
      structured,
    );
  } catch (error) {
    if (structured && schemaRejected(error)) {
      return performTextRequest(
        prompts.systemPrompt,
        `${prompts.userPrompt}\n\nReturn only the JSON object requested. Do not use markdown.`,
        segments,
        options,
        false,
      );
    }
    throw error;
  }
}

/** Optional countTokens call used when the user enables precise budgeting. */
export async function countGeminiTextTokens(
  segments: GeminiTextSegment[],
  options: GeminiTextOptions,
): Promise<number> {
  const prompts = buildPrompts(segments, options);
  const key = validateKey(options.apiKey);
  const url = geminiEndpoint(options.baseUrl, options.model, "countTokens");
  const estimated = estimatePromptTokens(prompts.systemPrompt, prompts.userPrompt, segments);
  return options.manager.execute(
    Math.max(20, Math.round(estimated * 0.1)),
    async (signal) => {
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": key,
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: prompts.systemPrompt }] },
            contents: [{ role: "user", parts: [{ text: prompts.userPrompt }] }],
          }),
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new ApiError("تعذّر حساب توكنات Gemini.", { retryable: true, cause: error });
      }
      const rawText = await response.text();
      let body: { totalTokens?: number; error?: { message?: string } };
      try {
        body = JSON.parse(rawText) as typeof body;
      } catch {
        throw new ApiError("رد countTokens غير صالح.", {
          status: response.status,
          retryable: true,
        });
      }
      if (!response.ok) {
        throw geminiApiError(
          response.status,
          response.statusText,
          body as GeminiErrorBody,
          response.headers.get("retry-after"),
          rawText,
        );
      }
      const total = Number(body.totalTokens);
      if (!Number.isFinite(total) || total <= 0) {
        throw new ApiError("Gemini لم يُرجع عدد التوكنات.", { retryable: false });
      }
      return { data: total };
    },
    { signal: options.signal },
  );
}

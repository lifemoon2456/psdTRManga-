import { drawNumberedBboxes } from "./numbered";
import {
  extractGeminiText,
  geminiApiError,
  geminiEndpoint,
  geminiFinishReason,
  normalizeGeminiUsage,
  type GeminiErrorBody,
} from "./gemini-common";
import { buildCorrectionPrompt, buildVisionPrompts } from "./prompts";
import {
  ApiError,
  type RequestManager,
  type TokenUsage,
} from "./request-manager";
import { parseLlmJson, validateTranslationResult } from "./validator";

export interface GeminiVisionOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  sourceLang: string;
  targetLang: string;
  temperature?: number;
  seriesContext?: SeriesContext;
  manager?: RequestManager;
  signal?: AbortSignal;
}

async function callGemini(
  systemPrompt: string,
  userPrompt: string,
  imageBase64: string,
  options: GeminiVisionOptions,
  estimatedTokens = 2600,
): Promise<unknown> {
  const key = options.apiKey.trim();
  if (!key || /[^\x21-\x7e]/.test(key)) {
    throw new ApiError("مفتاح Gemini فارغ أو يحتوي على أحرف غير صالحة. أعد لصقه.", {
      status: 401,
      retryable: false,
    });
  }

  const url = geminiEndpoint(
    options.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta",
    options.model,
    "generateContent",
  );

  const attempt = async (signal: AbortSignal) => {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": key,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [
            {
              role: "user",
              parts: [
                { text: userPrompt },
                { inlineData: { mimeType: "image/jpeg", data: imageBase64 } },
              ],
            },
          ],
          generationConfig: {
            temperature: options.temperature ?? 0.25,
            responseMimeType: "application/json",
            maxOutputTokens: 8192,
          },
        }),
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ApiError("تعذّر الاتصال بـ Gemini. تحقق من الشبكة.", {
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
      (error as ApiError & { usage?: TokenUsage }).usage = usage;
      throw error;
    }

    if (body.promptFeedback?.blockReason) {
      throw new ApiError(`Gemini رفض الطلب: ${body.promptFeedback.blockReason}.`, {
        status: 400,
        retryable: false,
        usage,
      });
    }
    const finishReason = geminiFinishReason(body);
    if (finishReason === "SAFETY" || finishReason === "RECITATION") {
      throw new ApiError(`توقف Gemini بسبب: ${finishReason}.`, {
        status: 400,
        retryable: false,
        usage,
      });
    }

    const text = extractGeminiText(body);
    if (!text) {
      throw new ApiError("Gemini أعاد ردًا فارغًا.", {
        status: response.status,
        retryable: true,
        usage,
      });
    }
    return { data: parseLlmJson(text), usage };
  };

  if (options.manager) {
    return options.manager.execute(estimatedTokens, attempt, { signal: options.signal });
  }
  return (await attempt(options.signal ?? new AbortController().signal)).data;
}

/**
 * Vision-first translation: the model sees the page and the numbered boxes, so
 * it can use artwork, reading order, and vertical Japanese layout as context.
 * This is an explicit opt-in mode and the OCR-failure fallback.
 */
export async function translateWithGeminiVision(
  imageSrc: string,
  bboxes: Bbox[],
  options: GeminiVisionOptions,
): Promise<TranslateResult> {
  if (bboxes.length === 0) return { translations: [], sourceTexts: [] };

  const numbered = await drawNumberedBboxes(imageSrc, bboxes);
  const imageBase64 = numbered.replace(/^data:image\/[a-z]+;base64,/i, "");
  const prompts = buildVisionPrompts({
    boxCount: bboxes.length,
    sourceLang: options.sourceLang,
    targetLang: options.targetLang,
    seriesContext: options.seriesContext,
  });

  const estimated = 2600 + bboxes.length * 35;
  const raw = await callGemini(
    prompts.systemPrompt,
    prompts.userPrompt,
    imageBase64,
    options,
    estimated,
  );

  const received = Array.isArray((raw as { translations?: unknown[] })?.translations)
    ? (raw as { translations: unknown[] }).translations.length
    : -1;

  if (received !== bboxes.length) {
    const corrected = await callGemini(
      prompts.systemPrompt,
      `${prompts.userPrompt}\n\n${buildCorrectionPrompt(bboxes.length, received)}`,
      imageBase64,
      options,
      estimated,
    );
    return validateTranslationResult(corrected, bboxes.length);
  }

  return validateTranslationResult(raw, bboxes.length);
}

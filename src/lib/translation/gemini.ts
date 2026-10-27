import { drawNumberedBboxes } from "./numbered";
import { buildCorrectionPrompt, buildVisionPrompts } from "./prompts";
import { parseLlmJson, validateTranslationResult } from "./validator";

export interface GeminiVisionOptions {
  apiKey: string;
  model: string;
  sourceLang: string;
  targetLang: string;
  temperature?: number;
  seriesContext?: SeriesContext;
}

interface GeminiResponse {
  candidates?: {
    content?: {
      parts?: { text?: string }[];
    };
  }[];
  error?: { message?: string };
}

async function callGemini(
  systemPrompt: string,
  userPrompt: string,
  imageBase64: string,
  options: GeminiVisionOptions,
): Promise<unknown> {
  const key = options.apiKey.trim();
  if (!key || /[^\x21-\x7e]/.test(key)) {
    throw new Error("مفتاح Gemini فارغ أو يحتوي على أحرف غير صالحة. أعد لصقه.");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    options.model,
  )}:generateContent`;

  const response = await fetch(url, {
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
  });

  const data = (await response.json()) as GeminiResponse;
  if (!response.ok) {
    throw new Error(
      `Gemini API: ${data.error?.message || response.statusText || response.status}`,
    );
  }

  const text = (data.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("");
  if (!text.trim()) throw new Error("Gemini أعاد ردًا فارغًا.");

  return parseLlmJson(text);
}

/**
 * Vision-first translation: the model sees the page and the numbered boxes, so
 * it can use artwork, reading order, and vertical Japanese layout as context.
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

  const raw = await callGemini(
    prompts.systemPrompt,
    prompts.userPrompt,
    imageBase64,
    options,
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
    );
    return validateTranslationResult(corrected, bboxes.length);
  }

  return validateTranslationResult(raw, bboxes.length);
}

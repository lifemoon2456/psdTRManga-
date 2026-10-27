import { drawNumberedBboxes } from "./numbered";
import { buildCorrectionPrompt, buildVisionPrompts } from "./prompts";
import { parseLlmJson, validateTranslationResult } from "./validator";

export interface OpenAIVisionOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  sourceLang: string;
  targetLang: string;
  temperature?: number;
  jsonMode?: boolean;
  seriesContext?: SeriesContext;
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string | { text?: string }[] } }[];
  error?: { message?: string };
}

function endpointFor(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (base.endsWith("/chat/completions")) return base;
  return `${base}/chat/completions`;
}

async function callOpenAI(
  systemPrompt: string,
  userPrompt: string,
  imageDataUrl: string,
  options: OpenAIVisionOptions,
): Promise<unknown> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.apiKey.trim()) headers.Authorization = `Bearer ${options.apiKey.trim()}`;

  const body: Record<string, unknown> = {
    model: options.model,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          { type: "text", text: userPrompt },
          {
            type: "image_url",
            image_url: { url: imageDataUrl, detail: "high" },
          },
        ],
      },
    ],
    temperature: options.temperature ?? 0.25,
    stream: false,
    max_tokens: 8192,
  };
  if (options.jsonMode) body.response_format = { type: "json_object" };

  const response = await fetch(endpointFor(options.baseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let data: ChatCompletionResponse;
  try {
    data = JSON.parse(text) as ChatCompletionResponse;
  } catch {
    throw new Error(`رد المزود ليس JSON (${response.status}): ${text.slice(0, 300)}`);
  }

  if (!response.ok) {
    throw new Error(
      `OpenAI-compatible API: ${data.error?.message || response.statusText || response.status}`,
    );
  }

  const content = data.choices?.[0]?.message?.content;
  const contentText = Array.isArray(content)
    ? content.map((part) => part.text ?? "").join("")
    : content;
  if (!contentText?.trim()) throw new Error("المزود أعاد ردًا فارغًا.");

  return parseLlmJson(contentText);
}

/**
 * Works with OpenAI vision models and local OpenAI-compatible servers that
 * accept `image_url` content parts (Ollama, LM Studio, vLLM, etc.).
 */
export async function translateWithOpenAIVision(
  imageSrc: string,
  bboxes: Bbox[],
  options: OpenAIVisionOptions,
): Promise<TranslateResult> {
  if (bboxes.length === 0) return { translations: [], sourceTexts: [] };

  const numbered = await drawNumberedBboxes(imageSrc, bboxes);
  const prompts = buildVisionPrompts({
    boxCount: bboxes.length,
    sourceLang: options.sourceLang,
    targetLang: options.targetLang,
    seriesContext: options.seriesContext,
  });

  const raw = await callOpenAI(
    prompts.systemPrompt,
    prompts.userPrompt,
    numbered,
    options,
  );

  const received = Array.isArray((raw as { translations?: unknown[] })?.translations)
    ? (raw as { translations: unknown[] }).translations.length
    : -1;

  if (received !== bboxes.length) {
    const corrected = await callOpenAI(
      prompts.systemPrompt,
      `${prompts.userPrompt}\n\n${buildCorrectionPrompt(bboxes.length, received)}`,
      numbered,
      options,
    );
    return validateTranslationResult(corrected, bboxes.length);
  }

  return validateTranslationResult(raw, bboxes.length);
}

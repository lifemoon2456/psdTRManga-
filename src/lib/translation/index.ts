import { translateWithGeminiVision } from "./gemini";
import { translateWithOpenAIVision } from "./openai";
import type { RequestManager } from "./request-manager";

export type TranslationEngine = "gemini" | "openai" | "manual";
export type GeminiMode = "text" | "vision";

export interface TranslationSettings {
  engine: TranslationEngine;
  sourceLang: string;
  targetLang: string;
  geminiApiKey: string;
  geminiModel: string;
  geminiBaseUrl: string;
  geminiMode: GeminiMode;
  openaiBaseUrl: string;
  openaiApiKey: string;
  openaiModel: string;
  openaiJsonMode: boolean;
  temperature: number;

  /** Local OCR + Smart Batch settings. */
  smartBatch: boolean;
  batchPages: number;
  batchTokenBudget: number;
  maxConcurrentRequests: number;
  rpmLimit: number;
  tpmLimit: number;
  maxRetries: number;
  useCountTokens: boolean;
  cacheEnabled: boolean;
  useVisionOnOcrFailure: boolean;
  seriesSummary: string;
  glossary: string;
  seriesContext?: SeriesContext;
}

export interface TranslatePageOptions {
  manager?: RequestManager;
  signal?: AbortSignal;
}

export function isTextOnlyTranslation(settings: TranslationSettings): boolean {
  return settings.engine === "gemini" && settings.geminiMode === "text";
}

export function isVisionTranslation(settings: TranslationSettings): boolean {
  return (
    settings.engine === "openai" ||
    (settings.engine === "gemini" && settings.geminiMode === "vision")
  );
}

export function shouldUseLocalOcr(settings: TranslationSettings): boolean {
  return settings.engine === "manual" || isTextOnlyTranslation(settings);
}

export async function translatePage(
  imageSrc: string,
  bboxes: Bbox[],
  settings: TranslationSettings,
  options: TranslatePageOptions = {},
): Promise<TranslateResult> {
  if (settings.engine === "manual") {
    return {
      translations: new Array(bboxes.length).fill(""),
      sourceTexts: new Array(bboxes.length).fill(""),
    };
  }

  if (settings.engine === "gemini") {
    return translateWithGeminiVision(imageSrc, bboxes, {
      apiKey: settings.geminiApiKey,
      model: settings.geminiModel,
      baseUrl: settings.geminiBaseUrl,
      sourceLang: settings.sourceLang,
      targetLang: settings.targetLang,
      temperature: settings.temperature,
      seriesContext: settings.seriesContext,
      manager: options.manager,
      signal: options.signal,
    });
  }

  return translateWithOpenAIVision(imageSrc, bboxes, {
    baseUrl: settings.openaiBaseUrl,
    apiKey: settings.openaiApiKey,
    model: settings.openaiModel,
    sourceLang: settings.sourceLang,
    targetLang: settings.targetLang,
    temperature: settings.temperature,
    jsonMode: settings.openaiJsonMode,
    seriesContext: settings.seriesContext,
    signal: options.signal,
  });
}

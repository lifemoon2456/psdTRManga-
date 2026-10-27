import { translateWithGeminiVision } from "./gemini";
import { translateWithOpenAIVision } from "./openai";

export type TranslationEngine = "gemini" | "openai" | "manual";

export interface TranslationSettings {
  engine: TranslationEngine;
  sourceLang: string;
  targetLang: string;
  geminiApiKey: string;
  geminiModel: string;
  openaiBaseUrl: string;
  openaiApiKey: string;
  openaiModel: string;
  openaiJsonMode: boolean;
  temperature: number;
  seriesContext?: SeriesContext;
}

export async function translatePage(
  imageSrc: string,
  bboxes: Bbox[],
  settings: TranslationSettings,
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
      sourceLang: settings.sourceLang,
      targetLang: settings.targetLang,
      temperature: settings.temperature,
      seriesContext: settings.seriesContext,
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
  });
}

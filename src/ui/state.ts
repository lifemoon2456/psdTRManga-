import { DefaultConfig, FONT_PRESETS, type FontPreset } from "../lib/configs";
import { allFontPresets } from "../lib/custom-fonts";
import type { PageAnalysis, PageRender, PipelineSettings } from "../lib/pipeline";
import type { TranslationEngine } from "../lib/translation";

export type PageStatus = "queued" | "analyzing" | "ready" | "rendering" | "done" | "error";

export interface PageJob {
  id: string;
  file: File;
  name: string;
  url: string;
  width: number;
  height: number;
  status: PageStatus;
  stage: string;
  error: string;
  analysis: PageAnalysis | null;
  render: PageRender | null;
  /** Translations changed after the last render. */
  dirty: boolean;
}

export interface AppSettings {
  sourceLang: "Japanese" | "English" | "Auto-Detect";
  engine: TranslationEngine;
  geminiApiKey: string;
  geminiModel: string;
  openaiBaseUrl: string;
  openaiApiKey: string;
  openaiModel: string;
  openaiJsonMode: boolean;
  temperature: number;
  detectionModel: string;
  detectionMinConfidence: number;
  inpaintMethod: "fast" | "quality";
  fontId: string;
  psdCompress: boolean;
  psdRtl: boolean;
  psdRasterPreview: boolean;
}

const STORAGE_KEY = "manga-psd-studio:settings:v1";

export const DEFAULT_SETTINGS: AppSettings = {
  sourceLang: "Japanese",
  engine: "gemini",
  geminiApiKey: "",
  geminiModel: "gemini-2.5-flash",
  openaiBaseUrl: "http://127.0.0.1:11434/v1",
  openaiApiKey: "",
  openaiModel: "qwen2.5vl:7b",
  openaiJsonMode: false,
  temperature: 0.25,
  detectionModel: "comic-text-detector",
  detectionMinConfidence: DefaultConfig.detectionMinConfidence,
  inpaintMethod: "quality",
  fontId: "noto-naskh",
  psdCompress: true,
  psdRtl: true,
  psdRasterPreview: true,
};

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage can be unavailable in private mode; settings remain in memory.
  }
}

export function selectedFont(settings: AppSettings): FontPreset {
  return allFontPresets().find((font) => font.id === settings.fontId) ?? FONT_PRESETS[0];
}

export function toPipelineSettings(settings: AppSettings): PipelineSettings {
  return {
    detectionModel: settings.detectionModel,
    detectionMinConfidence: settings.detectionMinConfidence,
    inpaintMethod: settings.inpaintMethod,
    font: selectedFont(settings),
    psdCompress: settings.psdCompress,
    psdRtl: settings.psdRtl,
    psdRasterPreview: settings.psdRasterPreview,
    translation: {
      engine: settings.engine,
      sourceLang: settings.sourceLang,
      targetLang: "Arabic",
      geminiApiKey: settings.geminiApiKey,
      geminiModel: settings.geminiModel,
      openaiBaseUrl: settings.openaiBaseUrl,
      openaiApiKey: settings.openaiApiKey,
      openaiModel: settings.openaiModel,
      openaiJsonMode: settings.openaiJsonMode,
      temperature: settings.temperature,
    },
  };
}

export function validateSettings(settings: AppSettings): string | null {
  if (settings.engine === "gemini" && !settings.geminiApiKey.trim()) {
    return "أدخل مفتاح Gemini API أولًا، أو اختر محرك ترجمة آخر من الإعدادات.";
  }
  if (settings.engine === "gemini" && !settings.geminiModel.trim()) {
    return "أدخل اسم موديل Gemini (مثل gemini-2.5-flash).";
  }
  if (settings.engine === "openai") {
    if (!settings.openaiBaseUrl.trim()) return "أدخل عنوان خادم OpenAI-compatible.";
    if (!settings.openaiModel.trim()) return "أدخل اسم الموديل في خادم OpenAI-compatible.";
  }
  if (
    !Number.isFinite(settings.detectionMinConfidence) ||
    settings.detectionMinConfidence <= 0 ||
    settings.detectionMinConfidence > 1
  ) {
    return "حد الثقة في الكشف يجب أن يكون بين 0 و1.";
  }
  if (
    !Number.isFinite(settings.temperature) ||
    settings.temperature < 0 ||
    settings.temperature > 2
  ) {
    return "درجة حرارة الترجمة يجب أن تكون بين 0 و2.";
  }
  return null;
}

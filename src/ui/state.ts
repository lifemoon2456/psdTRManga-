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
  geminiBaseUrl: string;
  geminiMode: "text" | "vision";
  openaiBaseUrl: string;
  openaiApiKey: string;
  openaiModel: string;
  openaiJsonMode: boolean;
  temperature: number;

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

  detectionModel: string;
  detectionMinConfidence: number;
  inpaintMethod: "fast" | "quality";
  fontId: string;
  psdCompress: boolean;
  psdRtl: boolean;
  psdRasterPreview: boolean;
}

const SETTINGS_STORAGE_KEY = "manga-psd-studio:settings:v1";
const SECRETS_STORAGE_KEY = "manga-psd-studio:secrets:v1";

type StoredSecrets = Pick<AppSettings, "geminiApiKey" | "openaiApiKey">;

export const DEFAULT_SETTINGS: AppSettings = {
  sourceLang: "Japanese",
  engine: "gemini",
  geminiApiKey: "",
  geminiModel: "gemini-2.5-flash-lite",
  geminiBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
  geminiMode: "text",
  openaiBaseUrl: "http://127.0.0.1:11434/v1",
  openaiApiKey: "",
  openaiModel: "qwen2.5vl:7b",
  openaiJsonMode: false,
  temperature: 0.25,
  smartBatch: true,
  batchPages: 4,
  batchTokenBudget: 12_000,
  maxConcurrentRequests: 1,
  rpmLimit: 0,
  tpmLimit: 0,
  maxRetries: 4,
  useCountTokens: false,
  cacheEnabled: true,
  useVisionOnOcrFailure: false,
  seriesSummary: "",
  glossary: "",
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
    const rawSettings = localStorage.getItem(SETTINGS_STORAGE_KEY);
    const parsedSettings = rawSettings
      ? (JSON.parse(rawSettings) as Partial<AppSettings>)
      : {};
    const rawSecrets = localStorage.getItem(SECRETS_STORAGE_KEY);
    const parsedSecrets = rawSecrets
      ? (JSON.parse(rawSecrets) as Partial<StoredSecrets>)
      : {};

    // API keys used to live in the general settings record. Prefer the
    // dedicated record when present, but retain a legacy key once so existing
    // users are migrated without having to paste their key again.
    const geminiApiKey = normalizeApiKey(
      typeof parsedSecrets.geminiApiKey === "string"
        ? parsedSecrets.geminiApiKey
        : parsedSettings.geminiApiKey,
    );
    const openaiApiKey = normalizeApiKey(
      typeof parsedSecrets.openaiApiKey === "string"
        ? parsedSecrets.openaiApiKey
        : parsedSettings.openaiApiKey,
    );
    return { ...DEFAULT_SETTINGS, ...parsedSettings, geminiApiKey, openaiApiKey };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function normalizeApiKey(value: unknown): string {
  // Keys copied from dashboards often include a trailing line break. It is not
  // part of the credential and makes the request fail even though validation
  // appears to accept the key.
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Store credentials separately from regular UI/project settings. API keys are
 * still local to this browser, but routine settings updates and project
 * imports/exports can no longer accidentally replace them.
 */
export function saveSettings(settings: AppSettings): boolean {
  const { geminiApiKey, openaiApiKey, ...publicSettings } = settings;
  try {
    localStorage.setItem(
      SECRETS_STORAGE_KEY,
      JSON.stringify({
        geminiApiKey: normalizeApiKey(geminiApiKey),
        openaiApiKey: normalizeApiKey(openaiApiKey),
      } satisfies StoredSecrets),
    );
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(publicSettings));
    return true;
  } catch {
    // Storage can be unavailable in private mode; settings remain in memory.
    return false;
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
      geminiBaseUrl: settings.geminiBaseUrl,
      geminiMode: settings.geminiMode,
      openaiBaseUrl: settings.openaiBaseUrl,
      openaiApiKey: settings.openaiApiKey,
      openaiModel: settings.openaiModel,
      openaiJsonMode: settings.openaiJsonMode,
      temperature: settings.temperature,
      smartBatch: settings.smartBatch,
      batchPages: settings.batchPages,
      batchTokenBudget: settings.batchTokenBudget,
      maxConcurrentRequests: settings.maxConcurrentRequests,
      rpmLimit: settings.rpmLimit,
      tpmLimit: settings.tpmLimit,
      maxRetries: settings.maxRetries,
      useCountTokens: settings.useCountTokens,
      cacheEnabled: settings.cacheEnabled,
      useVisionOnOcrFailure: settings.useVisionOnOcrFailure,
      seriesSummary: settings.seriesSummary,
      glossary: settings.glossary,
    },
  };
}

export function validateSettings(settings: AppSettings): string | null {
  if (settings.engine === "gemini" && !settings.geminiApiKey.trim()) {
    return "أدخل مفتاح Gemini API أولًا، أو اختر محرك ترجمة آخر من الإعدادات.";
  }
  if (settings.engine === "gemini" && !settings.geminiModel.trim()) {
    return "أدخل اسم موديل Gemini (مثل gemini-2.5-flash-lite).";
  }
  if (
    settings.engine === "gemini" &&
    !/^https?:\/\//i.test(settings.geminiBaseUrl.trim())
  ) {
    return "عنوان Gemini API يجب أن يبدأ بـ http:// أو https://.";
  }
  if (
    settings.engine === "gemini" &&
    settings.geminiMode !== "text" &&
    settings.geminiMode !== "vision"
  ) {
    return "طريقة Gemini غير صالحة. اختر نص فقط أو Vision.";
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
  if (
    !Number.isFinite(settings.batchPages) ||
    settings.batchPages < 1 ||
    settings.batchPages > 8
  ) {
    return "عدد الصفحات في الدفعة يجب أن يكون بين 1 و8.";
  }
  if (
    !Number.isFinite(settings.batchTokenBudget) ||
    settings.batchTokenBudget < 1000 ||
    settings.batchTokenBudget > 1_000_000
  ) {
    return "ميزانية التوكنات لكل دفعة يجب أن تكون بين 1000 و1,000,000.";
  }
  if (
    !Number.isFinite(settings.maxConcurrentRequests) ||
    settings.maxConcurrentRequests < 1 ||
    settings.maxConcurrentRequests > 4
  ) {
    return "عدد الطلبات المتزامنة يجب أن يكون بين 1 و4.";
  }
  if (!Number.isFinite(settings.rpmLimit) || settings.rpmLimit < 0) {
    return "حد RPM يجب أن يكون صفرًا أو رقمًا موجبًا.";
  }
  if (!Number.isFinite(settings.tpmLimit) || settings.tpmLimit < 0) {
    return "حد TPM يجب أن يكون صفرًا أو رقمًا موجبًا.";
  }
  if (
    !Number.isFinite(settings.maxRetries) ||
    settings.maxRetries < 0 ||
    settings.maxRetries > 10
  ) {
    return "عدد محاولات إعادة المحاولة يجب أن يكون بين 0 و10.";
  }
  return null;
}

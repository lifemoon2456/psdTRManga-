import JSZip from "jszip";
import type { PageAnalysis } from "./pipeline";
import type { AppSettings } from "../ui/state";

/**
 * Project persistence has two independent paths:
 *
 * - The current project is autosaved into IndexedDB (source images + analysis).
 * - A portable `.mpsproj` ZIP can be exported/imported. It contains the same
 *   data but never contains API keys or custom font files.
 *
 * Rendered PSDs/PNGs are intentionally not persisted. They can be recreated
 * from the source page and the editable boxes/translations, and storing several
 * large PSDs would quickly exhaust browser storage.
 */

export const PROJECT_FORMAT = "manga-psd-studio-project";
export const PROJECT_VERSION = 1;
export const PROJECT_FILE_EXTENSION = "mpsproj";

const PROJECT_DB_NAME = "manga-psd-studio:projects";
const PROJECT_DB_VERSION = 1;
const PROJECT_STORE_NAME = "projects";
const CURRENT_PROJECT_ID = "current";
const MANIFEST_NAME = "project.json";
export const MAX_PROJECT_PAGES = 500;
const MAX_PROJECT_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_PAGE_BYTES = 150 * 1024 * 1024;

export type ProjectPageStatus = "queued" | "ready" | "error";

/** Settings safe to persist in a project. API keys are deliberately omitted. */
export type ProjectSettings = Omit<AppSettings, "geminiApiKey" | "openaiApiKey">;

export interface ProjectPage {
  id: string;
  name: string;
  width: number;
  height: number;
  status: ProjectPageStatus;
  stage: string;
  error: string;
  dirty: boolean;
  analysis: PageAnalysis | null;
  image: Blob;
  imageType: string;
}

export interface ProjectSnapshot {
  version: number;
  savedAt: number;
  selectedId: string | null;
  settings: Partial<ProjectSettings>;
  pages: ProjectPage[];
}

interface ProjectManifestPage {
  id: string;
  name: string;
  width: number;
  height: number;
  status: ProjectPageStatus;
  stage: string;
  error: string;
  dirty: boolean;
  analysis: PageAnalysis | null;
  imagePath: string;
  imageType: string;
}

interface ProjectManifest {
  format: typeof PROJECT_FORMAT;
  version: number;
  savedAt: number;
  selectedId: string | null;
  settings: Partial<ProjectSettings>;
  pages: ProjectManifestPage[];
}

interface StoredProjectRecord extends ProjectSnapshot {
  id: typeof CURRENT_PROJECT_ID;
}

const PROJECT_SETTING_KEYS = [
  "sourceLang",
  "engine",
  "geminiModel",
  "geminiBaseUrl",
  "geminiMode",
  "openaiBaseUrl",
  "openaiModel",
  "openaiJsonMode",
  "temperature",
  "smartBatch",
  "batchPages",
  "batchTokenBudget",
  "maxConcurrentRequests",
  "rpmLimit",
  "tpmLimit",
  "maxRetries",
  "useCountTokens",
  "cacheEnabled",
  "useVisionOnOcrFailure",
  "seriesSummary",
  "glossary",
  "detectionModel",
  "detectionMinConfidence",
  "inpaintMethod",
  "fontId",
  "psdCompress",
  "psdRtl",
  "psdRasterPreview",
] as const satisfies readonly (keyof ProjectSettings)[];

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function cleanString(value: unknown, maxLength = 500): string {
  return typeof value === "string"
    ? value.replace(/\0/g, "").trim().slice(0, maxLength)
    : "";
}

function cleanName(value: unknown, fallback: string): string {
  const name = cleanString(value, 220);
  if (!name) return fallback;
  return name.split(/[\\/]/).pop() || fallback;
}

export const SUPPORTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
]);

function normalizeImageType(value: unknown, imagePath = ""): string {
  const type = cleanString(value, 100).toLowerCase();
  if (SUPPORTED_IMAGE_TYPES.has(type)) return type;
  const extension = imagePath.split(".").pop()?.toLowerCase();
  switch (extension) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "avif":
      return "image/avif";
    case "png":
      return "image/png";
    default:
      return "";
  }
}

function imageExtension(imageType: string, name: string): string {
  const type = imageType.toLowerCase();
  if (type === "image/jpeg") return "jpg";
  if (type === "image/webp") return "webp";
  if (type === "image/gif") return "gif";
  if (type === "image/avif") return "avif";
  if (type === "image/png") return "png";
  const extension = name.split(".").pop()?.toLowerCase();
  return extension && /^[a-z0-9]{1,8}$/.test(extension) ? extension : "png";
}

function sanitizeId(value: unknown): string {
  const id = cleanString(value, 100).replace(/[^A-Za-z0-9._-]+/g, "-");
  return id || "page";
}

function normalizeStyle(value: unknown): TextStyle | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const style: TextStyle = {};
  const fontSize = finiteNumber(record.fontSize);
  if (fontSize !== null && fontSize > 0) style.fontSize = fontSize;
  for (const key of ["color", "strokeColor"] as const) {
    if (typeof record[key] === "string") style[key] = cleanString(record[key], 80);
  }
  const strokeWidth = finiteNumber(record.strokeWidth);
  if (strokeWidth !== null && strokeWidth >= 0) style.strokeWidth = strokeWidth;
  const strokeWidthFactor = finiteNumber(record.strokeWidthFactor);
  if (strokeWidthFactor !== null && strokeWidthFactor >= 0) {
    style.strokeWidthFactor = strokeWidthFactor;
  }
  for (const key of ["bold", "italic", "underline"] as const) {
    if (typeof record[key] === "boolean") style[key] = record[key] as boolean;
  }
  return Object.keys(style).length > 0 ? style : undefined;
}

function normalizeRect(
  value: unknown,
  maxWidth: number,
  maxHeight: number,
): { x1: number; y1: number; x2: number; y2: number } | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const x1 = finiteNumber(record.x1);
  const y1 = finiteNumber(record.y1);
  const x2 = finiteNumber(record.x2);
  const y2 = finiteNumber(record.y2);
  if (x1 === null || y1 === null || x2 === null || y2 === null) return undefined;
  const width = maxWidth > 0 ? maxWidth : Math.max(1, x1, x2);
  const height = maxHeight > 0 ? maxHeight : Math.max(1, y1, y2);
  const left = clamp(Math.min(x1, x2), 0, width);
  const right = clamp(Math.max(x1, x2), 0, width);
  const top = clamp(Math.min(y1, y2), 0, height);
  const bottom = clamp(Math.max(y1, y2), 0, height);
  if (right - left < 1 || bottom - top < 1) return undefined;
  return { x1: left, y1: top, x2: right, y2: bottom };
}

function normalizeBox(value: unknown, width: number, height: number): Bbox | null {
  const rect = normalizeRect(value, width, height);
  const record = asRecord(value);
  if (!rect || !record) return null;
  const confidence = clamp(finiteNumber(record.confidence) ?? 0, 0, 1);
  const box: Bbox = { ...rect, confidence };
  if (record.manual === true) box.manual = true;
  if (record.gateSkip === "not-japanese" || record.gateSkip === "low-confidence") {
    box.gateSkip = record.gateSkip;
  }
  if (record.inpaintDeclined === true) box.inpaintDeclined = true;
  const style = normalizeStyle(record.style);
  if (style) box.style = style;
  const inpaintArea = normalizeRect(record.inpaintArea, width, height);
  if (inpaintArea) box.inpaintArea = inpaintArea;
  return box;
}

function normalizeAnalysis(value: unknown, width: number, height: number): PageAnalysis | null {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.boxes)) return null;
  const boxes: Bbox[] = [];
  for (const item of record.boxes) {
    const box = normalizeBox(item, width, height);
    if (box) boxes.push(box);
  }
  const rawTranslations = Array.isArray(record.translations) ? record.translations : [];
  const rawSourceTexts = Array.isArray(record.sourceTexts) ? record.sourceTexts : [];
  const analysis: PageAnalysis = {
    boxes,
    translations: boxes.map((_, index) =>
      typeof rawTranslations[index] === "string" ? (rawTranslations[index] as string) : "",
    ),
    sourceTexts: boxes.map((_, index) =>
      typeof rawSourceTexts[index] === "string" ? (rawSourceTexts[index] as string) : "",
    ),
  };
  if (Array.isArray(record.ocrFailedBoxes)) {
    const failed = record.ocrFailedBoxes
      .map((value) => finiteNumber(value))
      .filter((value): value is number => value !== null && value >= 0 && value < boxes.length)
      .map((value) => Math.floor(value));
    analysis.ocrFailedBoxes = [...new Set(failed)];
  }
  if (Array.isArray(record.ocrConfidences)) {
    const rawConfidences = record.ocrConfidences;
    analysis.ocrConfidences = boxes.map((_, index) => {
      const value = finiteNumber(rawConfidences[index]);
      return value === null ? 0 : clamp(value, 0, 1);
    });
  }
  if (typeof record.ocrEngine === "string") {
    analysis.ocrEngine = cleanString(record.ocrEngine, 160);
  }
  if (typeof record.ocrError === "string") {
    analysis.ocrError = cleanString(record.ocrError, 1000);
  }
  return analysis;
}

function normalizeSettings(value: unknown): Partial<ProjectSettings> {
  const record = asRecord(value);
  if (!record) return {};
  const settings: Partial<ProjectSettings> = {};
  if (record.sourceLang === "Japanese" || record.sourceLang === "English" || record.sourceLang === "Auto-Detect") {
    settings.sourceLang = record.sourceLang;
  }
  if (record.engine === "gemini" || record.engine === "openai" || record.engine === "manual") {
    settings.engine = record.engine;
  }
  if (typeof record.geminiModel === "string") {
    settings.geminiModel = cleanString(record.geminiModel, 160);
  }
  if (typeof record.geminiBaseUrl === "string") {
    settings.geminiBaseUrl = cleanString(record.geminiBaseUrl, 500);
  }
  if (record.geminiMode === "text" || record.geminiMode === "vision") {
    settings.geminiMode = record.geminiMode;
  }
  if (typeof record.openaiBaseUrl === "string") {
    settings.openaiBaseUrl = cleanString(record.openaiBaseUrl, 500);
  }
  if (typeof record.openaiModel === "string") {
    settings.openaiModel = cleanString(record.openaiModel, 160);
  }
  if (typeof record.openaiJsonMode === "boolean") settings.openaiJsonMode = record.openaiJsonMode;
  const temperature = finiteNumber(record.temperature);
  if (temperature !== null && temperature >= 0 && temperature <= 2) settings.temperature = temperature;

  for (const key of ["smartBatch", "useCountTokens", "cacheEnabled", "useVisionOnOcrFailure"] as const) {
    if (typeof record[key] === "boolean") settings[key] = record[key] as boolean;
  }
  const batchPages = finiteNumber(record.batchPages);
  if (batchPages !== null) settings.batchPages = Math.round(clamp(batchPages, 1, 8));
  const batchTokenBudget = finiteNumber(record.batchTokenBudget);
  if (batchTokenBudget !== null) {
    settings.batchTokenBudget = Math.round(clamp(batchTokenBudget, 1000, 1_000_000));
  }
  const maxConcurrentRequests = finiteNumber(record.maxConcurrentRequests);
  if (maxConcurrentRequests !== null) {
    settings.maxConcurrentRequests = Math.round(clamp(maxConcurrentRequests, 1, 4));
  }
  for (const key of ["rpmLimit", "tpmLimit"] as const) {
    const value = finiteNumber(record[key]);
    if (value !== null && value >= 0) settings[key] = Math.round(value);
  }
  const maxRetries = finiteNumber(record.maxRetries);
  if (maxRetries !== null) settings.maxRetries = Math.round(clamp(maxRetries, 0, 10));
  if (typeof record.seriesSummary === "string") {
    settings.seriesSummary = cleanString(record.seriesSummary, 4000);
  }
  if (typeof record.glossary === "string") {
    settings.glossary = cleanString(record.glossary, 8000);
  }
  if (typeof record.detectionModel === "string") {
    settings.detectionModel = cleanString(record.detectionModel, 100);
  }
  const detectionMinConfidence = finiteNumber(record.detectionMinConfidence);
  if (
    detectionMinConfidence !== null &&
    detectionMinConfidence > 0 &&
    detectionMinConfidence <= 1
  ) {
    settings.detectionMinConfidence = detectionMinConfidence;
  }
  if (record.inpaintMethod === "quality" || record.inpaintMethod === "fast") {
    settings.inpaintMethod = record.inpaintMethod;
  }
  if (typeof record.fontId === "string") settings.fontId = cleanString(record.fontId, 160);
  for (const key of ["psdCompress", "psdRtl", "psdRasterPreview"] as const) {
    if (typeof record[key] === "boolean") settings[key] = record[key] as boolean;
  }
  return settings;
}

export function projectSettingsFromApp(settings: AppSettings): ProjectSettings {
  const safe = {} as ProjectSettings;
  for (const key of PROJECT_SETTING_KEYS) {
    (safe as unknown as Record<string, unknown>)[key] = settings[key];
  }
  return safe;
}

/** Merge project settings while preserving the user's local API keys. */
export function applyProjectSettings(
  current: AppSettings,
  project: Partial<ProjectSettings>,
): AppSettings {
  const next = { ...current };
  for (const key of PROJECT_SETTING_KEYS) {
    const value = project[key];
    if (value !== undefined) {
      (next as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return next;
}

export function projectStatus(status: string): ProjectPageStatus {
  if (status === "error") return "error";
  if (status === "queued") return "queued";
  return "ready";
}

export async function exportProjectFile(snapshot: ProjectSnapshot): Promise<Blob> {
  if (snapshot.pages.length > MAX_PROJECT_PAGES) {
    throw new Error(`لا يمكن تصدير أكثر من ${MAX_PROJECT_PAGES} صفحة في مشروع واحد.`);
  }

  const zip = new JSZip();
  const manifestPages: ProjectManifestPage[] = [];

  for (let index = 0; index < snapshot.pages.length; index++) {
    const page = snapshot.pages[index];
    const extension = imageExtension(page.imageType, page.name);
    const imagePath = `pages/${String(index + 1).padStart(3, "0")}-${sanitizeId(page.id)}.${extension}`;
    zip.file(imagePath, page.image, { compression: "STORE" });
    manifestPages.push({
      id: page.id,
      name: page.name,
      width: page.width,
      height: page.height,
      status: page.status,
      stage: page.stage,
      error: page.error,
      dirty: page.dirty,
      analysis: page.analysis,
      imagePath,
      imageType: page.imageType,
    });
  }

  const manifest: ProjectManifest = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    savedAt: snapshot.savedAt,
    selectedId: snapshot.selectedId,
    settings: snapshot.settings,
    pages: manifestPages,
  };
  zip.file(MANIFEST_NAME, JSON.stringify(manifest, null, 2), { compression: "DEFLATE" });

  return zip.generateAsync({
    type: "blob",
    mimeType: "application/zip",
    compression: "STORE",
  });
}

export async function importProjectFile(file: File): Promise<ProjectSnapshot> {
  if (file.size > MAX_PROJECT_FILE_BYTES) {
    throw new Error("ملف المشروع أكبر من الحد المسموح (2 GB).");
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch (error) {
    throw new Error(`تعذّر قراءة ملف المشروع. تأكد أنه ملف .mpsproj سليم. (${errorMessage(error)})`);
  }

  const manifestEntry = zip.file(MANIFEST_NAME);
  if (!manifestEntry) {
    throw new Error("ملف المشروع لا يحتوي على project.json.");
  }

  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(await manifestEntry.async("text"));
  } catch (error) {
    throw new Error(`project.json غير صالح. (${errorMessage(error)})`);
  }
  const manifest = asRecord(manifestValue);
  if (!manifest || manifest.format !== PROJECT_FORMAT) {
    throw new Error("هذا الملف ليس مشروع Manga PSD Studio.");
  }
  const version = finiteNumber(manifest.version);
  if (version !== PROJECT_VERSION) {
    throw new Error(`إصدار المشروع غير مدعوم: ${String(manifest.version)}.`);
  }
  if (!Array.isArray(manifest.pages) || manifest.pages.length > MAX_PROJECT_PAGES) {
    throw new Error(`عدد الصفحات غير صالح أو يتجاوز ${MAX_PROJECT_PAGES}.`);
  }

  const pages: ProjectPage[] = [];
  let totalImageBytes = 0;
  for (let index = 0; index < manifest.pages.length; index++) {
    const rawPage = asRecord(manifest.pages[index]);
    if (!rawPage) throw new Error(`بيانات الصفحة ${index + 1} غير صالحة.`);

    const imagePath = cleanString(rawPage.imagePath, 500);
    if (!imagePath || imagePath.startsWith("/") || imagePath.includes("..") || imagePath.includes("\\")) {
      throw new Error(`مسار صورة غير صالح في الصفحة ${index + 1}.`);
    }
    const imageEntry = zip.file(imagePath);
    if (!imageEntry) {
      throw new Error(`صورة الصفحة ${index + 1} مفقودة من ملف المشروع.`);
    }
    const bytes = await imageEntry.async("uint8array");
    if (bytes.byteLength > MAX_PAGE_BYTES) {
      throw new Error(`صورة الصفحة ${index + 1} أكبر من الحد المسموح (150 MB).`);
    }
    if (bytes.byteLength === 0) {
      throw new Error(`صورة الصفحة ${index + 1} فارغة.`);
    }
    totalImageBytes += bytes.byteLength;
    if (totalImageBytes > MAX_PROJECT_FILE_BYTES) {
      throw new Error("إجمالي صور المشروع أكبر من الحد المسموح (2 GB).");
    }

    const name = cleanName(rawPage.name, `page-${index + 1}.png`);
    const width = Math.max(0, finiteNumber(rawPage.width) ?? 0);
    const height = Math.max(0, finiteNumber(rawPage.height) ?? 0);
    const imageType = normalizeImageType(rawPage.imageType, imagePath);
    if (!imageType) {
      throw new Error(`نوع صورة غير مدعوم في الصفحة ${index + 1}. استخدم PNG أو JPG أو WebP أو GIF أو AVIF.`);
    }
    const analysis = normalizeAnalysis(rawPage.analysis, width, height);
    const status: ProjectPageStatus =
      rawPage.status === "error" ? "error" : rawPage.status === "queued" ? "queued" : analysis ? "ready" : "queued";

    pages.push({
      id: cleanString(rawPage.id, 120) || `page-${index + 1}`,
      name,
      width,
      height,
      status,
      stage: cleanString(rawPage.stage, 300),
      error: cleanString(rawPage.error, 1000),
      dirty: rawPage.dirty === true,
      analysis,
      image: new Blob([bytes as unknown as BlobPart], { type: imageType }),
      imageType,
    });
  }

  const selectedId = cleanString(manifest.selectedId, 120) || null;
  const savedAt = finiteNumber(manifest.savedAt) ?? Date.now();
  return {
    version: PROJECT_VERSION,
    savedAt,
    selectedId,
    settings: normalizeSettings(manifest.settings),
    pages,
  };
}

let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("المتصفح لا يدعم IndexedDB، لذلك لا يمكن حفظ المشروع محليًا."));
      return;
    }

    const request = indexedDB.open(PROJECT_DB_NAME, PROJECT_DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(PROJECT_STORE_NAME)) {
        database.createObjectStore(PROJECT_STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => {
      reject(request.error ?? new Error("تعذّر فتح مخزن المشروع المحلي."));
    };
    request.onblocked = () => {
      reject(new Error("مخزن المشروع مشغول في نافذة أخرى. أغلق النوافذ الأخرى وأعد المحاولة."));
    };
  });

  return databasePromise;
}

export async function saveProjectSnapshot(snapshot: ProjectSnapshot): Promise<void> {
  const database = await openDatabase();
  const record: StoredProjectRecord = { id: CURRENT_PROJECT_ID, ...snapshot };
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(PROJECT_STORE_NAME, "readwrite");
    transaction.objectStore(PROJECT_STORE_NAME).put(record);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => {
      reject(transaction.error ?? new Error("تعذّر حفظ المشروع في المتصفح."));
    };
    transaction.onabort = () => {
      reject(transaction.error ?? new Error("تعذّر حفظ المشروع في المتصفح."));
    };
  });
}

export async function loadProjectSnapshot(): Promise<ProjectSnapshot | null> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(PROJECT_STORE_NAME, "readonly");
    const request = transaction.objectStore(PROJECT_STORE_NAME).get(CURRENT_PROJECT_ID);
    request.onsuccess = () => {
      const record = request.result as StoredProjectRecord | undefined;
      if (!record) {
        resolve(null);
        return;
      }
      resolve({
        version: record.version,
        savedAt: record.savedAt,
        selectedId: record.selectedId,
        settings: record.settings ?? {},
        pages: Array.isArray(record.pages) ? record.pages : [],
      });
    };
    request.onerror = () => {
      reject(request.error ?? new Error("تعذّر قراءة المشروع المحفوظ."));
    };
  });
}

export async function clearProjectSnapshot(): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(PROJECT_STORE_NAME, "readwrite");
    transaction.objectStore(PROJECT_STORE_NAME).delete(CURRENT_PROJECT_ID);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => {
      reject(transaction.error ?? new Error("تعذّر حذف المشروع المحفوظ."));
    };
    transaction.onabort = () => {
      reject(transaction.error ?? new Error("تعذّر حذف المشروع المحفوظ."));
    };
  });
}

import { FONT_PRESETS, type FontPreset } from "./configs";

/**
 * User-supplied fonts are kept in IndexedDB, never uploaded. The browser uses
 * a unique CSS family name for each one so it cannot collide with an installed
 * font; the PSD still receives the real PostScript name.
 */

const DB_NAME = "manga-psd-studio:fonts";
const DB_VERSION = 1;
const STORE_NAME = "fonts";
const MAX_FONT_BYTES = 30 * 1024 * 1024;
const CSS_FAMILY_PREFIX = "MangaPSDCustom";
const ACCEPTED_EXTENSIONS = new Set(["ttf", "otf", "woff", "woff2"]);

export interface CustomFontRecord {
  id: string;
  label: string;
  familyName: string;
  fullName: string;
  postscriptName: string;
  cssFamily: string;
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
  createdAt: number;
}

export interface CustomFontInfo {
  id: string;
  label: string;
  familyName: string;
  postscriptName: string;
  fileName: string;
  mimeType: string;
  size: number;
  createdAt: number;
  cssStack: string;
}

export interface CustomFontDownload {
  bytes: Uint8Array;
  fileName: string;
  mimeType: string;
}

interface CustomFontEntry {
  record: CustomFontRecord;
  preset: FontPreset;
  face: FontFace;
}

interface FontkitFont {
  postscriptName?: string;
  familyName?: string;
  fullName?: string;
  close?: () => void;
}

interface FontkitCollection {
  fonts?: FontkitFont[];
}

type FontkitCreate = (buffer: Uint8Array) => FontkitFont | FontkitCollection;

const entries = new Map<string, CustomFontEntry>();
let databasePromise: Promise<IDBDatabase> | null = null;
let loadingPromise: Promise<void> | null = null;
let persistenceError: string | null = null;
let fontkitPromise: Promise<FontkitCreate> | null = null;

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function cleanName(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/\0/g, "").replace(/\s+/g, " ").trim()
    : "";
}

function fallbackName(fileName: string): string {
  return (
    fileName
      .replace(/\.[^.]+$/, "")
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "خط مخصص"
  );
}

function sanitizePostScriptName(value: string): string {
  return value.replace(/[^A-Za-z0-9.-]/g, "").slice(0, 120);
}

function makeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `font-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function mimeTypeForFile(file: File): string {
  if (file.type) return file.type;
  const extension = file.name.split(".").pop()?.toLowerCase();
  switch (extension) {
    case "ttf":
      return "font/ttf";
    case "otf":
      return "font/otf";
    case "woff":
      return "font/woff";
    case "woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

function normalizeBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error("بيانات الخط غير صالحة.");
}

function cssStackFor(cssFamily: string): string {
  return `${JSON.stringify(cssFamily)}, "Noto Naskh Arabic", serif`;
}

async function getFontkitCreate(): Promise<FontkitCreate> {
  if (!fontkitPromise) {
    fontkitPromise = import("fontkit")
      .then((module) => {
        const create = (module as unknown as { create?: FontkitCreate }).create;
        if (typeof create !== "function") {
          throw new Error("محرك قراءة الخطوط غير متاح.");
        }
        return create;
      })
      .catch((error) => {
        // Let a later attempt retry if the on-demand chunk failed to load.
        fontkitPromise = null;
        throw error;
      });
  }
  return fontkitPromise;
}

async function readFontMetadata(
  bytes: Uint8Array,
  fileName: string,
): Promise<{ familyName: string; fullName: string; postscriptName: string; label: string }> {
  try {
    const create = await getFontkitCreate();
    const parsed = create(bytes);
    const font = "fonts" in parsed && Array.isArray(parsed.fonts)
      ? parsed.fonts[0]
      : (parsed as FontkitFont);
    if (!font) throw new Error("لم يُعثر على خط داخل الملف.");

    const familyName =
      cleanName(font.familyName) || cleanName(font.fullName) || fallbackName(fileName);
    const fullName = cleanName(font.fullName) || familyName;
    const postscriptName =
      cleanName(font.postscriptName) ||
      sanitizePostScriptName(familyName) ||
      sanitizePostScriptName(fallbackName(fileName));

    if (typeof font.close === "function") font.close();
    if (!postscriptName) {
      throw new Error("لم يُعثر على اسم PostScript للخط.");
    }

    return {
      familyName,
      fullName,
      postscriptName,
      label: `${familyName} — مخصص`.slice(0, 120),
    };
  } catch (error) {
    throw new Error(
      `تعذر قراءة ملف الخط. تأكد أنه TTF أو OTF أو WOFF أو WOFF2 سليم. (${errorMessage(error)})`,
    );
  }
}

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("المتصفح لا يدعم IndexedDB، لذلك لا يمكن حفظ الخطوط."));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => {
      reject(request.error ?? new Error("تعذر فتح مخزن الخطوط المحلي."));
    };
    request.onblocked = () => {
      reject(new Error("مخزن الخطوط مشغول في نافذة أخرى. أغلق النوافذ الأخرى وأعد المحاولة."));
    };
  });

  return databasePromise;
}

async function readRecords(): Promise<CustomFontRecord[]> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).getAll();
    request.onsuccess = () => {
      const records: CustomFontRecord[] = [];
      for (const record of request.result as CustomFontRecord[]) {
        try {
          records.push({
            ...record,
            bytes: normalizeBytes(record.bytes),
          });
        } catch (error) {
          console.warn("Manga PSD Studio: skipping an invalid stored font record", error);
        }
      }
      resolve(records.sort((a, b) => a.createdAt - b.createdAt));
    };
    request.onerror = () => {
      reject(request.error ?? new Error("تعذر قراءة الخطوط المحفوظة."));
    };
  });
}

async function putRecord(record: CustomFontRecord): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(record);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => {
      reject(transaction.error ?? new Error("تعذر حفظ الخط في المتصفح."));
    };
    transaction.onabort = () => {
      reject(transaction.error ?? new Error("تعذر حفظ الخط في المتصفح."));
    };
  });
}

async function deleteRecord(id: string): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => {
      reject(transaction.error ?? new Error("تعذر حذف الخط من المتصفح."));
    };
    transaction.onabort = () => {
      reject(transaction.error ?? new Error("تعذر حذف الخط من المتصفح."));
    };
  });
}

async function registerRecord(record: CustomFontRecord): Promise<CustomFontEntry> {
  if (
    typeof document === "undefined" ||
    !document.fonts ||
    typeof FontFace === "undefined"
  ) {
    throw new Error("المتصفح لا يدعم تحميل الخطوط المخصصة.");
  }

  const existing = entries.get(record.id);
  if (existing) {
    try {
      document.fonts.delete(existing.face);
    } catch {
      // Ignore a face that was already removed by the browser.
    }
    entries.delete(record.id);
  }

  const face = new FontFace(record.cssFamily, record.bytes as unknown as BufferSource, {
    style: "normal",
    weight: "400",
    display: "swap",
  });
  await face.load();
  document.fonts.add(face);

  const preset: FontPreset = {
    id: record.id,
    label: record.label,
    cssStack: cssStackFor(record.cssFamily),
    postscriptName: record.postscriptName,
    rtl: true,
    custom: true,
    fileName: record.fileName,
  };

  const entry: CustomFontEntry = { record, preset, face };
  entries.set(record.id, entry);
  return entry;
}

async function loadRecords(): Promise<void> {
  try {
    const records = await readRecords();
    for (const record of records) {
      try {
        await registerRecord(record);
      } catch (error) {
        console.warn(`Manga PSD Studio: could not load custom font ${record.fileName}`, error);
      }
    }
    persistenceError = null;
  } catch (error) {
    persistenceError = `تعذر تحميل الخطوط المحفوظة: ${errorMessage(error)}`;
    console.warn("Manga PSD Studio: custom font storage unavailable", error);
  }
}

export function loadCustomFonts(): Promise<void> {
  if (!loadingPromise) loadingPromise = loadRecords();
  return loadingPromise;
}

export function customFontsPersistenceError(): string | null {
  return persistenceError;
}

export function allFontPresets(): FontPreset[] {
  return [...FONT_PRESETS, ...Array.from(entries.values(), (entry) => entry.preset)];
}

export function listCustomFonts(): CustomFontInfo[] {
  return Array.from(entries.values())
    .map(({ record, preset }) => ({
      id: record.id,
      label: record.label,
      familyName: record.familyName,
      postscriptName: record.postscriptName,
      fileName: record.fileName,
      mimeType: record.mimeType,
      size: record.bytes.byteLength,
      createdAt: record.createdAt,
      cssStack: preset.cssStack,
    }))
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function getCustomFontDownload(id: string): CustomFontDownload | null {
  const entry = entries.get(id);
  if (!entry) return null;
  return {
    bytes: entry.record.bytes,
    fileName: entry.record.fileName,
    mimeType: entry.record.mimeType,
  };
}

export async function importCustomFont(file: File): Promise<CustomFontInfo> {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!ACCEPTED_EXTENSIONS.has(extension)) {
    throw new Error("اختر ملف خط بصيغة TTF أو OTF أو WOFF أو WOFF2.");
  }
  if (file.size === 0) {
    throw new Error("ملف الخط فارغ.");
  }
  if (file.size > MAX_FONT_BYTES) {
    throw new Error("حجم ملف الخط كبير جدًا. الحد الأقصى 30 MB.");
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const metadata = await readFontMetadata(bytes, file.name);
  const id = makeId();
  const record: CustomFontRecord = {
    id,
    label: metadata.label,
    familyName: metadata.familyName,
    fullName: metadata.fullName,
    postscriptName: metadata.postscriptName,
    cssFamily: `${CSS_FAMILY_PREFIX}-${id}`,
    fileName: file.name,
    mimeType: mimeTypeForFile(file),
    bytes,
    createdAt: Date.now(),
  };

  const entry = await registerRecord(record);
  try {
    await putRecord(record);
    persistenceError = null;
  } catch (error) {
    persistenceError = `تم استخدام الخط في هذه الجلسة، لكن تعذر حفظه بشكل دائم: ${errorMessage(error)}`;
    console.warn("Manga PSD Studio: could not persist custom font", error);
  }

  return {
    id: entry.record.id,
    label: entry.record.label,
    familyName: entry.record.familyName,
    postscriptName: entry.record.postscriptName,
    fileName: entry.record.fileName,
    mimeType: entry.record.mimeType,
    size: entry.record.bytes.byteLength,
    createdAt: entry.record.createdAt,
    cssStack: entry.preset.cssStack,
  };
}

export async function removeCustomFont(id: string): Promise<void> {
  const entry = entries.get(id);
  if (entry) {
    try {
      document.fonts.delete(entry.face);
    } catch {
      // The face may already be gone.
    }
    entries.delete(id);
  }

  try {
    await deleteRecord(id);
    persistenceError = null;
  } catch (error) {
    persistenceError = `تعذر حذف الخط من التخزين الدائم: ${errorMessage(error)}`;
    console.warn("Manga PSD Studio: could not delete custom font record", error);
  }
}

/**
 * Persistent translation cache.
 *
 * The key includes every input that can change the Arabic wording: source text,
 * languages, model, temperature, glossary and series context. Editing one
 * bubble therefore invalidates only that bubble, never the whole page.
 */

export const TRANSLATION_CACHE_DB = "manga-psd-studio:translation-cache";
export const TRANSLATION_CACHE_STORE = "translations";
export const TRANSLATION_CACHE_VERSION = 1;
const PROMPT_VERSION = "manga-text-v1";

export interface TranslationCacheKeyInput {
  sourceText: string;
  sourceLang: string;
  targetLang: string;
  model: string;
  temperature: number;
  glossary: string;
  seriesSummary: string;
}

export interface TranslationCacheRecord {
  key: string;
  translation: string;
  sourceText: string;
  sourceLang: string;
  targetLang: string;
  model: string;
  createdAt: number;
  lastUsedAt: number;
}

let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB غير متاح في هذا المتصفح."));
      return;
    }
    const request = indexedDB.open(TRANSLATION_CACHE_DB, TRANSLATION_CACHE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(TRANSLATION_CACHE_STORE)) {
        database.createObjectStore(TRANSLATION_CACHE_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => {
      databasePromise = null;
      reject(request.error ?? new Error("تعذّر فتح ذاكرة الترجمة."));
    };
    request.onblocked = () => {
      databasePromise = null;
      reject(new Error("ذاكرة الترجمة مشغولة في نافذة أخرى."));
    };
  });
  return databasePromise;
}

async function sha256Hex(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }
  // Very small non-cryptographic fallback for old/private contexts. It is only
  // used as a cache key, never for security.
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv-${(hash >>> 0).toString(16)}-${value.length}`;
}

export async function translationCacheKey(input: TranslationCacheKeyInput): Promise<string> {
  const payload = JSON.stringify({
    promptVersion: PROMPT_VERSION,
    sourceText: input.sourceText,
    sourceLang: input.sourceLang,
    targetLang: input.targetLang,
    model: input.model,
    temperature: Number(input.temperature.toFixed(3)),
    glossary: input.glossary.trim(),
    seriesSummary: input.seriesSummary.trim(),
  });
  return sha256Hex(payload);
}

export async function getCachedTranslation(key: string): Promise<string | null> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(TRANSLATION_CACHE_STORE, "readonly");
    const request = transaction.objectStore(TRANSLATION_CACHE_STORE).get(key);
    request.onsuccess = () => {
      const record = request.result as TranslationCacheRecord | undefined;
      resolve(record?.translation?.trim() || null);
    };
    request.onerror = () => reject(request.error ?? new Error("تعذّر قراءة ذاكرة الترجمة."));
  });
}

export async function putCachedTranslation(
  record: TranslationCacheRecord,
): Promise<void> {
  if (!record.translation.trim()) return;
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(TRANSLATION_CACHE_STORE, "readwrite");
    transaction.objectStore(TRANSLATION_CACHE_STORE).put(record);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("تعذّر حفظ الترجمة في الذاكرة."));
    transaction.onabort = () => reject(transaction.error ?? new Error("تعذّر حفظ الترجمة في الذاكرة."));
  });
}

export async function countTranslationCache(): Promise<number> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(TRANSLATION_CACHE_STORE, "readonly");
    const request = transaction.objectStore(TRANSLATION_CACHE_STORE).count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("تعذّر قراءة ذاكرة الترجمة."));
  });
}

export async function clearTranslationCache(): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(TRANSLATION_CACHE_STORE, "readwrite");
    transaction.objectStore(TRANSLATION_CACHE_STORE).clear();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("تعذّر مسح ذاكرة الترجمة."));
    transaction.onabort = () => reject(transaction.error ?? new Error("تعذّر مسح ذاكرة الترجمة."));
  });
}

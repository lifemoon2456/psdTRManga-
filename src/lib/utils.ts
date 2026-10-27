import * as ort from "onnxruntime-web/wasm";
import { ensureWasmPaths } from "./hardware";
import { getExpectedSha256, verifyBufferSha256 } from "./manifests/hashes";

ensureWasmPaths();

export function sniffMime(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return "image/png";
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return "image/webp";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70)
    return "image/avif";
  return "image/jpeg";
}

export async function fetchAsImageBitmap(url: string): Promise<ImageBitmap> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`تعذّر تحميل الصورة (${response.status})`);
  const arrayBuffer = await response.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  const mime = sniffMime(bytes);
  const blob = new Blob([arrayBuffer], { type: mime });
  return createImageBitmap(blob);
}

export function arrayBufferToBase64DataUrl(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const mime = sniffMime(bytes);
  const chunkSize = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

export async function fetchAsBase64(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`تعذّر تحميل الصورة (${res.status})`);
  const blob = await res.blob();
  const mimeType = blob.type || "image/jpeg";
  const arrayBuffer = await blob.arrayBuffer();
  const uint8 = new Uint8Array(arrayBuffer);
  const chunkSize = 8192;
  let binary = "";
  for (let i = 0; i < uint8.length; i += chunkSize) {
    binary += String.fromCharCode(...uint8.subarray(i, i + chunkSize));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

const inFlightRequests = new Map<string, Promise<ort.InferenceSession | Response>>();

function devProxyUrl(url: string): string {
  // In the local dev server, route model downloads through Vite's proxy so
  // browsers that block direct cross-origin fetches can still download models.
  // Production builds use the original URLs (or a host you configure).
  if (!import.meta.env.DEV) return url;
  if (url.startsWith("https://huggingface.co/")) {
    return `/hf/${url.slice("https://huggingface.co/".length)}`;
  }
  if (url.startsWith("https://github.com/")) {
    return `/gh/${url.slice("https://github.com/".length)}`;
  }
  return url;
}

function resolveArtifactUrl(repoID: string, path: string): { url: string; cacheName: string } {
  const isDirectUrl =
    path.startsWith("http://") ||
    path.startsWith("https://") ||
    repoID.startsWith("http://") ||
    repoID.startsWith("https://");

  const rawUrl = isDirectUrl
    ? path.startsWith("http://") || path.startsWith("https://")
      ? path
      : `${repoID}/${path}`
    : `https://huggingface.co/${repoID}/resolve/main/${path}`;

  return { url: devProxyUrl(rawUrl), cacheName: isDirectUrl ? "direct-model-cache" : repoID };
}

async function openCache(name: string): Promise<Cache | null> {
  try {
    if (typeof caches === "undefined") return null;
    return await caches.open(name);
  } catch {
    return null;
  }
}

export function downloadArtifactHF(
  repoID: string,
  path: `${string}.onnx`,
  noReturn?: boolean,
  options?: { gpu?: boolean },
): Promise<ort.InferenceSession>;
export function downloadArtifactHF(
  repoID: string,
  path: string,
  noReturn?: boolean,
  options?: { gpu?: boolean },
): Promise<Response>;
export async function downloadArtifactHF(
  repoID: string,
  path: string,
  noReturn?: boolean,
  _options?: { gpu?: boolean },
): Promise<ort.InferenceSession | Response | undefined> {
  const { url, cacheName } = resolveArtifactUrl(repoID, path);

  if (inFlightRequests.has(url)) {
    const result = await inFlightRequests.get(url)!;
    return result instanceof Response ? result.clone() : result;
  }

  const requestPromise = (async () => {
    const cache = await openCache(cacheName);
    let response = cache
      ? await cache.match(url).catch(() => undefined)
      : undefined;

    if (!response) {
      let fetched: Response;
      let buffer: ArrayBuffer;
      try {
        // A stalled cross-origin request would otherwise leave the page stuck
        // on "detecting" forever. Model downloads are large, so allow 15 min.
        fetched = await fetch(url, { signal: AbortSignal.timeout(15 * 60 * 1000) });
        if (!fetched.ok) {
          throw new Error(`HTTP ${fetched.status} ${fetched.statusText}`);
        }
        buffer = await fetched.arrayBuffer();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `تعذّر تنزيل الموديل من ${url}. تحقق من الاتصال أو أعد المحاولة. (${detail})`,
        );
      }

      const expected = getExpectedSha256(path, url);
      if (expected) {
        const valid = await verifyBufferSha256(buffer, expected);
        if (!valid) {
          if (cache) await cache.delete(url).catch(() => {});
          throw new Error(`فشل التحقق من سلامة الموديل (SHA-256): ${path}`);
        }
      }

      response = new Response(buffer, {
        headers: fetched.headers,
        status: fetched.status,
        statusText: fetched.statusText,
      });
      // A full/private cache must not block a model that is already in memory.
      if (cache) await cache.put(url, response.clone()).catch(() => {});
    }

    if (noReturn) return undefined;

    const isOnnx = path.endsWith(".onnx") || url.endsWith(".onnx") || url.includes(".onnx?");
    if (!isOnnx) return response.clone();

    const modelBytes = new Uint8Array(await response.arrayBuffer());
    return await ort.InferenceSession.create(modelBytes.slice().buffer, {
      executionProviders: ["wasm"],
    });
  })();

  inFlightRequests.set(url, requestPromise as Promise<ort.InferenceSession | Response>);
  try {
    const result = await requestPromise;
    return result instanceof Response ? result.clone() : result;
  } finally {
    inFlightRequests.delete(url);
  }
}

export async function downloadArtifactFromUrl(
  url: string,
  cacheKey = "direct-model-cache",
  options?: { gpu?: boolean },
): Promise<ort.InferenceSession> {
  return (await downloadArtifactHF(cacheKey, url, false, options)) as unknown as ort.InferenceSession;
}

export async function isArtifactCached(repoID: string, path: string): Promise<boolean> {
  try {
    const { url, cacheName } = resolveArtifactUrl(repoID, path);
    const cache = await openCache(cacheName);
    if (!cache) return false;
    const matched = await cache.match(url);
    if (!matched || !matched.ok) return false;
    const blob = await matched.blob();
    return blob.size > 1024;
  } catch {
    return false;
  }
}

export async function streamArtifactToCache(
  url: string,
  cacheName: string,
  opts?: { signal?: AbortSignal; onProgress?: (loaded: number, total: number) => void },
): Promise<void> {
  const cache = await openCache(cacheName);
  if (!cache) throw new Error("CacheStorage غير متاح في هذا المتصفح");

  const existing = await cache.match(url);
  if (existing?.ok) {
    const blob = await existing.blob();
    if (blob.size > 1024) {
      opts?.onProgress?.(blob.size, blob.size);
      return;
    }
    await cache.delete(url);
  }

  const res = await fetch(url, { signal: opts?.signal });
  if (!res.ok) throw new Error(`تعذّر التنزيل: HTTP ${res.status}`);

  const total = Number(res.headers.get("content-length") || 0);
  const reader = res.body?.getReader();
  if (!reader) {
    const blob = await res.blob();
    await cache.put(url, new Response(blob, { headers: res.headers }));
    opts?.onProgress?.(blob.size, blob.size);
    return;
  }

  const chunks: Uint8Array[] = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.length;
      opts?.onProgress?.(loaded, total);
    }
  }
  const merged = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  await cache.put(url, new Response(merged, { status: 200, headers: res.headers }));
}

export async function fetchAndCacheWithProgress(
  repoID: string,
  path: string,
  onProgress?: (loaded: number, total: number) => void,
  options?: { signal?: AbortSignal },
): Promise<void> {
  const { url, cacheName } = resolveArtifactUrl(repoID, path);
  return streamArtifactToCache(url, cacheName, { signal: options?.signal, onProgress });
}

export function clearPartialDownload(_repoID: string, _path: string): void {
  // Downloads are not resumable in this standalone build.
}

export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return (err as { name?: string }).name === "AbortError";
}

export async function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as unknown as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof scheduler?.yield === "function") return scheduler.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export interface RunLock {
  <T>(task: () => Promise<T>): Promise<T>;
  getDeadLetterCount(): number;
  reset(): void;
}

let sharedOrtTail: Promise<unknown> = Promise.resolve();

export function createRunLock(subsystem = "core"): RunLock {
  let deadLetters = 0;
  const lock = function runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = sharedOrtTail.then(task, task);
    sharedOrtTail = result.catch((err) => {
      deadLetters++;
      console.error(`[dead-letter:${subsystem}] (#${deadLetters})`, err);
    });
    return result;
  } as RunLock;
  lock.getDeadLetterCount = () => deadLetters;
  lock.reset = () => {
    sharedOrtTail = Promise.resolve();
    deadLetters = 0;
  };
  return lock;
}

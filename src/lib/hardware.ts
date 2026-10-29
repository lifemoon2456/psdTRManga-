import * as ort from "onnxruntime-web/wasm";

// Keep logs quiet; the UI reports failures.
ort.env.logLevel = "error";

/**
 * This app prioritizes correctness over GPU coverage. Several of the reused
 * models (RT-DETR, LaMa) contain operators that are not portable to WebGPU in
 * onnxruntime-web, so every session runs on WASM. This also makes the output
 * deterministic across machines.
 */
export function resolveExecutionProvidersForModel(
  _pathOrUrl: string,
  _gpu?: boolean,
): readonly string[] {
  return ["wasm"];
}

export function ensureWasmPaths(): void {
  const env = ort.env.wasm as unknown as Record<string, unknown>;
  if (!env.wasmPaths) env.wasmPaths = "/ort/";
  if (!env.numThreads) {
    // Threaded WASM is available only on a cross-origin-isolated page. The
    // app already configures these headers for Vite dev/preview; production
    // hosts that omit them automatically fall back to one thread instead of
    // failing to load a model.
    const isolated =
      typeof crossOriginIsolated !== "undefined" &&
      crossOriginIsolated &&
      typeof SharedArrayBuffer !== "undefined";
    const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 1 : 1;
    // Reserve some capacity for the UI and cap the pool to limit memory use on
    // large manga pages. This speeds up LaMa, RT-DETR and PaddleOCR together.
    env.numThreads = isolated ? Math.min(4, Math.max(1, Math.floor(cores / 2))) : 1;
  }
}

ensureWasmPaths();

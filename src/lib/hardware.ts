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
    // Multi-threaded WASM requires a worker loader that is fragile when the
    // app is served by different static hosts. One thread is slower but much
    // more portable; this app prioritizes reliable output over speed.
    env.numThreads = 1;
  }
}

ensureWasmPaths();

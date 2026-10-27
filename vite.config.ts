import { defineConfig, type Plugin } from "vite";
import { fileURLToPath, URL } from "node:url";
import fs from "node:fs";
import path from "node:path";

// ONNX Runtime Web uses SharedArrayBuffer for multi-threaded WASM. These
// headers enable cross-origin isolation in dev. For production, configure the
// same two headers on the static host (or set ORT threads to 1).
const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

/**
 * ONNX Runtime dynamically imports its loader with a `?import` query. Vite
 * treats files in `public/` as static, so its transform middleware returns 500
 * for `/ort/*.mjs?import`. Serve those loader files ourselves in dev; the
 * production build copies them unchanged to dist/ort.
 */
function ortLoaderPlugin(): Plugin {
  return {
    name: "ort-loader-static",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const rawUrl = req.url ?? "";
        const pathname = rawUrl.split("?")[0];
        if (!pathname.startsWith("/ort/") || !pathname.endsWith(".mjs")) {
          next();
          return;
        }
        const publicRoot = path.resolve(process.cwd(), "public");
        const filePath = path.resolve(publicRoot, `.${pathname}`);
        if (!filePath.startsWith(publicRoot + path.sep)) {
          res.statusCode = 403;
          res.end("Forbidden");
          return;
        }
        fs.readFile(filePath, (error, data) => {
          if (error) {
            next();
            return;
          }
          res.setHeader("Content-Type", "text/javascript; charset=utf-8");
          res.setHeader("Cache-Control", "no-cache");
          res.end(data);
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [ortLoaderPlugin()],
  resolve: {
    // Use ORT's external-WASM build. The WASM binaries are served from
    // /ort/, so there is no need to emit a second hashed copy into dist/.
    conditions: ["onnxruntime-web-use-extern-wasm"],
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    headers: isolationHeaders,
    proxy: {
      "/hf": {
        target: "https://huggingface.co",
        changeOrigin: true,
        followRedirects: true,
        rewrite: (path) => path.replace(/^\/hf/, ""),
      },
      "/gh": {
        target: "https://github.com",
        changeOrigin: true,
        followRedirects: true,
        rewrite: (path) => path.replace(/^\/gh/, ""),
      },
    },
  },
  preview: {
    headers: isolationHeaders,
  },
  build: {
    target: "es2022",
  },
  optimizeDeps: {
    // onnxruntime-web ships its own WASM loader; pre-bundling it can break
    // the relative wasmPaths resolution.
    exclude: ["onnxruntime-web"],
  },
});

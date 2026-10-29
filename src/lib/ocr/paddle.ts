import * as ort from "onnxruntime-web/wasm";
import { downloadArtifactHF, createRunLock } from "../utils";
import type { OcrLineCrop } from "./layout";

/**
 * PP-OCR recognisers, running locally through onnxruntime-web WASM.
 *
 * - Japanese manga: fumetodev/PP-OCRv6_small_rec_manga_ONNX (Apache-2.0),
 *   a 21 MB fine-tune that reads vertical manga lettering well.
 * - English: monkt/paddleocr-onnx English PP-OCRv5 mobile recogniser
 *   (Apache-2.0). Both use the same CTC output contract.
 */

export type OcrLanguage = "Japanese" | "English";

interface ModelSpec {
  repo: string;
  path: string;
  dictUrl: string;
  label: string;
}

const MODELS: Record<OcrLanguage, ModelSpec> = {
  Japanese: {
    repo: "fumetodev/PP-OCRv6_small_rec_manga_ONNX",
    path: "ppocr-rec-v6-small-manga.onnx",
    dictUrl: "/dicts/ppocrv6_dict.txt",
    label: "PP-OCRv6 manga (اليابانية)",
  },
  English: {
    repo: "monkt/paddleocr-onnx",
    path: "languages/english/rec.onnx",
    dictUrl: "/dicts/ppocrv5_en_dict.txt",
    label: "PP-OCRv5 English",
  },
};

const sessions = new Map<OcrLanguage, Promise<ort.InferenceSession>>();
const dictionaries = new Map<string, Promise<string[]>>();
const runExclusive = createRunLock("ocr");

function createCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function context2d(
  canvas: HTMLCanvasElement | OffscreenCanvas,
): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  const context = canvas.getContext("2d", { willReadFrequently: true }) as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!context) throw new Error("تعذّر إنشاء سياق Canvas للـ OCR.");
  return context;
}

async function loadDictionary(url: string): Promise<string[]> {
  const existing = dictionaries.get(url);
  if (existing) return existing;
  const promise = (async () => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`تعذّر تحميل قاموس OCR (${response.status}).`);
    }
    const text = await response.text();
    return text
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)
      .filter((line, index, lines) => line.length > 0 || index < lines.length - 1);
  })();
  dictionaries.set(url, promise);
  try {
    return await promise;
  } catch (error) {
    dictionaries.delete(url);
    throw error;
  }
}

async function loadSession(language: OcrLanguage): Promise<ort.InferenceSession> {
  const existing = sessions.get(language);
  if (existing) return existing;
  const spec = MODELS[language];
  const promise = (async () => {
    const session = (await downloadArtifactHF(spec.repo, spec.path)) as unknown as ort.InferenceSession;
    return session;
  })();
  sessions.set(language, promise);
  try {
    return await promise;
  } catch (error) {
    sessions.delete(language);
    throw error;
  }
}

function softmaxConfidence(top1: number, top2: number, rowSum: number): number {
  if (rowSum > 0.5 && rowSum < 1.5 && top1 <= 1.01) {
    return Math.max(0, Math.min(1, top1));
  }
  const gap = top1 - top2;
  return Math.max(0, Math.min(1, 1 / (1 + Math.exp(-gap))));
}

function decodeCtc(
  logits: Float32Array,
  timesteps: number,
  classes: number,
  dictionary: string[],
): { text: string; confidence: number } {
  const characters: string[] = [];
  let confidenceTotal = 0;
  let confidenceCount = 0;
  let previous = -1;

  for (let step = 0; step < timesteps; step++) {
    const offset = step * classes;
    let top1 = -Infinity;
    let top2 = -Infinity;
    let index = 0;
    let sum = 0;
    for (let classIndex = 0; classIndex < classes; classIndex++) {
      const value = logits[offset + classIndex];
      sum += value;
      if (value > top1) {
        top2 = top1;
        top1 = value;
        index = classIndex;
      } else if (value > top2) {
        top2 = value;
      }
    }

    if (index === 0) {
      previous = index;
      continue;
    }
    if (index === previous) continue;
    previous = index;

    if (index === dictionary.length + 1) {
      characters.push(" ");
    } else if (index > 0 && index <= dictionary.length) {
      characters.push(dictionary[index - 1]);
    } else {
      continue;
    }
    confidenceTotal += softmaxConfidence(top1, top2, sum);
    confidenceCount++;
  }

  const text = characters
    .join("")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
  return {
    text,
    confidence: confidenceCount > 0 ? confidenceTotal / confidenceCount : 0,
  };
}

function lineTensor(
  source: CanvasImageSource & { width: number; height: number },
  line: OcrLineCrop,
): { data: Float32Array; width: number } {
  const sourceCanvas = createCanvas(line.width, line.height);
  const sourceContext = context2d(sourceCanvas);
  sourceContext.drawImage(
    source,
    line.x,
    line.y,
    line.width,
    line.height,
    0,
    0,
    line.width,
    line.height,
  );

  let rotated: HTMLCanvasElement | OffscreenCanvas = sourceCanvas;
  if (line.vertical) {
    const rotatedCanvas = createCanvas(line.height, line.width);
    const rotatedContext = context2d(rotatedCanvas);
    rotatedContext.translate(0, line.width);
    rotatedContext.rotate(-Math.PI / 2);
    rotatedContext.drawImage(sourceCanvas, 0, 0);
    rotated = rotatedCanvas;
  }

  const targetWidth = Math.max(1, Math.min(1600, Math.round((rotated.width * 48) / Math.max(1, rotated.height))));
  const targetCanvas = createCanvas(targetWidth, 48);
  const targetContext = context2d(targetCanvas);
  targetContext.fillStyle = `rgb(${line.background.r}, ${line.background.g}, ${line.background.b})`;
  targetContext.fillRect(0, 0, targetWidth, 48);
  targetContext.imageSmoothingEnabled = true;
  targetContext.imageSmoothingQuality = "high";
  targetContext.drawImage(rotated, 0, 0, targetWidth, 48);

  const pixels = targetContext.getImageData(0, 0, targetWidth, 48).data;
  const data = new Float32Array(3 * targetWidth * 48);
  const plane = targetWidth * 48;
  for (let index = 0; index < plane; index++) {
    const pixel = index * 4;
    data[index] = (pixels[pixel] / 255 - 0.5) / 0.5;
    data[plane + index] = (pixels[pixel + 1] / 255 - 0.5) / 0.5;
    data[plane * 2 + index] = (pixels[pixel + 2] / 255 - 0.5) / 0.5;
  }
  return { data, width: targetWidth };
}

export async function recognizeLine(
  source: CanvasImageSource & { width: number; height: number },
  line: OcrLineCrop,
  language: OcrLanguage,
): Promise<{ text: string; confidence: number }> {
  if (line.width < 2 || line.height < 2) return { text: "", confidence: 0 };
  const [session, dictionary] = await Promise.all([
    loadSession(language),
    loadDictionary(MODELS[language].dictUrl),
  ]);
  const tensorData = lineTensor(source, line);
  const inputName = session.inputNames[0] ?? "x";
  const outputName = session.outputNames[0];
  if (!outputName) throw new Error("موديل OCR لا يحتوي مخرجًا صالحًا.");

  const input = new ort.Tensor("float32", tensorData.data, [1, 3, 48, tensorData.width]);
  let output: ort.Tensor;
  try {
    output = (await runExclusive(async () => {
      const outputs = await session.run({ [inputName]: input });
      return outputs[outputName];
    })) as ort.Tensor;
  } finally {
    input.dispose?.();
  }

  try {
    const dims = output.dims;
    if (dims.length !== 3) throw new Error("شكل مخرج OCR غير متوقع.");
    const timesteps = dims[1];
    const classes = dims[2];
    return decodeCtc(output.data as Float32Array, timesteps, classes, dictionary);
  } finally {
    output.dispose?.();
  }
}

export function ocrModelLabel(language: OcrLanguage): string {
  return MODELS[language].label;
}

export async function warmOcrModel(language: OcrLanguage): Promise<void> {
  await loadSession(language);
}

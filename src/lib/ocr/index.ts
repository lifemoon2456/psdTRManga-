import { fetchAsImageBitmap } from "../utils";
import { layoutTextBox, type OcrLineCrop } from "./layout";
import {
  ocrModelLabel,
  recognizeLine,
  warmOcrModel,
  type OcrLanguage,
} from "./paddle";

export interface OcrBoxResult {
  text: string;
  confidence: number;
  engine: string;
}

export interface OcrPageResult {
  texts: string[];
  confidences: number[];
  failedBoxes: number[];
  engine: string;
  error?: string;
}

export interface OcrOptions {
  sourceLang: string;
  onProgress?: (message: string) => void;
}

interface LanguageRun {
  boxes: OcrBoxResult[];
  failedBoxes: number[];
  engine: string;
}

function hasJapanese(text: string): boolean {
  return /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/u.test(text);
}

function latinLetters(text: string): number {
  return (text.match(/[A-Za-z]/g) ?? []).length;
}

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

function joinLines(lines: Array<{ text: string; confidence: number }>): {
  text: string;
  confidence: number;
} {
  const nonEmpty = lines.filter((line) => line.text.trim());
  if (nonEmpty.length === 0) return { text: "", confidence: 0 };
  let weighted = 0;
  let weight = 0;
  for (const line of nonEmpty) {
    const lineWeight = Math.max(1, line.text.length);
    weighted += line.confidence * lineWeight;
    weight += lineWeight;
  }
  return {
    text: nonEmpty.map((line) => line.text.trim()).join("\n"),
    confidence: weight > 0 ? weighted / weight : 0,
  };
}

async function runLanguage(
  source: CanvasImageSource & { width: number; height: number },
  image: ImageData,
  boxes: Bbox[],
  language: OcrLanguage,
  onProgress?: (message: string) => void,
): Promise<LanguageRun> {
  onProgress?.(`تهيئة ${ocrModelLabel(language)}…`);
  await warmOcrModel(language);
  const engine = ocrModelLabel(language);
  const results: OcrBoxResult[] = [];
  const failedBoxes: number[] = [];

  for (let index = 0; index < boxes.length; index++) {
    onProgress?.(`قراءة النص محليًا: ${index + 1} من ${boxes.length}…`);
    try {
      const layout = layoutTextBox(image, boxes[index], language);
      const lineResults: Array<{ text: string; confidence: number }> = [];
      for (const line of layout) {
        lineResults.push(await recognizeLine(source, line, language));
      }
      const joined = joinLines(lineResults);
      results.push({
        text: joined.text,
        confidence: joined.confidence,
        engine,
      });
      if (!joined.text) failedBoxes.push(index);
    } catch {
      results.push({ text: "", confidence: 0, engine });
      failedBoxes.push(index);
    }
  }

  return { boxes: results, failedBoxes, engine };
}

/**
 * Extract source text from detection boxes without sending any image to an API.
 * A failure returns empty texts and a list of failed boxes so the page remains
 * renderable/exportable (boxes without translations are simply left alone).
 */
export async function extractTextFromBoxes(
  imageSrc: string,
  boxes: Bbox[],
  options: OcrOptions,
): Promise<OcrPageResult> {
  if (boxes.length === 0) {
    return { texts: [], confidences: [], failedBoxes: [], engine: "" };
  }

  let bitmap: ImageBitmap | null = null;
  try {
    options.onProgress?.("تحميل الصفحة لاستخراج النص محليًا…");
    bitmap = await fetchAsImageBitmap(imageSrc);
    const canvas = createCanvas(bitmap.width, bitmap.height);
    const context = context2d(canvas);
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, bitmap.width, bitmap.height);

    const requested: OcrLanguage =
      options.sourceLang === "English" ? "English" : "Japanese";

    let run: LanguageRun;
    try {
      run = await runLanguage(canvas, image, boxes, requested, options.onProgress);
    } catch (error) {
      if (options.sourceLang !== "Auto-Detect" || requested === "English") throw error;
      options.onProgress?.("تعذّر تشغيل موديل اليابانية؛ تجربة موديل الإنجليزية…");
      run = await runLanguage(canvas, image, boxes, "English", options.onProgress);
    }

    if (options.sourceLang === "Auto-Detect" && requested === "Japanese") {
      const combined = run.boxes.map((box) => box.text).join(" ");
      const japanese = hasJapanese(combined);
      const latin = latinLetters(combined);
      if (!japanese && (latin >= 2 || combined.trim().length === 0)) {
        options.onProgress?.("النص يبدو إنجليزيًا؛ إعادة القراءة بموديل الإنجليزية…");
        run = await runLanguage(canvas, image, boxes, "English", options.onProgress);
      }
    }

    return {
      texts: run.boxes.map((box) => box.text),
      confidences: run.boxes.map((box) => box.confidence),
      failedBoxes: run.failedBoxes,
      engine: run.engine,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      texts: boxes.map(() => ""),
      confidences: boxes.map(() => 0),
      failedBoxes: boxes.map((_, index) => index),
      engine: "",
      error: message,
    };
  } finally {
    bitmap?.close();
  }
}

export type { OcrLineCrop };

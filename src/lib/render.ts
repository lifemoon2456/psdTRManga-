import type { FontPreset } from "./configs";
import {
  drawFittedText,
  isDarkRegion,
  textStyleForBackground,
} from "./canvas/text-fit";
import { fetchAsImageBitmap } from "./utils";

export async function imageDataFromUrl(url: string): Promise<ImageData> {
  const bitmap = await fetchAsImageBitmap(url);
  try {
    const canvas =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(bitmap.width, bitmap.height)
        : Object.assign(document.createElement("canvas"), {
            width: bitmap.width,
            height: bitmap.height,
          });
    const ctx = canvas.getContext("2d", { willReadFrequently: true }) as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (!ctx) throw new Error("تعذّر إنشاء سياق Canvas");
    ctx.drawImage(bitmap, 0, 0);
    return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

function maxFontForBox(bbox: Bbox): number {
  const height = Math.max(1, bbox.y2 - bbox.y1);
  return Math.max(32, Math.min(96, Math.round(height * 0.55)));
}

async function drawAllTranslations(
  ctx: CanvasRenderingContext2D,
  background: ImageData,
  bboxes: Bbox[],
  translations: string[],
  font: FontPreset,
): Promise<void> {
  ctx.direction = font.rtl ? "rtl" : "ltr";
  for (let i = 0; i < bboxes.length; i++) {
    const text = translations[i]?.trim();
    if (!text) continue;
    const style = textStyleForBackground(isDarkRegion(background, bboxes[i]));
    const styledBox: Bbox = { ...bboxes[i], style: { ...bboxes[i].style, ...style } };
    await drawFittedText(ctx, text, styledBox, font.cssStack, maxFontForBox(bboxes[i]));
  }
}

export async function renderTranslations(
  inpaintedSrc: string,
  bboxes: Bbox[],
  translations: string[],
  font: FontPreset,
): Promise<{ dataUrl: string; imageData: ImageData; textLayer: ImageData }> {
  if (typeof document !== "undefined" && document.fonts) {
    try {
      await document.fonts.load(`700 24px ${font.cssStack}`);
    } catch {
      // fall through to the CSS fallback
    }
  }

  const bitmap = await fetchAsImageBitmap(inpaintedSrc);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("تعذّر إنشاء سياق الرسم");
    ctx.drawImage(bitmap, 0, 0);
    const background = ctx.getImageData(0, 0, canvas.width, canvas.height);
    await drawAllTranslations(ctx, background, bboxes, translations, font);

    const textCanvas = document.createElement("canvas");
    textCanvas.width = bitmap.width;
    textCanvas.height = bitmap.height;
    const textCtx = textCanvas.getContext("2d", { willReadFrequently: true });
    if (!textCtx) throw new Error("تعذّر إنشاء سياق طبقة النص");
    await drawAllTranslations(textCtx, background, bboxes, translations, font);

    return {
      dataUrl: canvas.toDataURL("image/png"),
      imageData: ctx.getImageData(0, 0, canvas.width, canvas.height),
      textLayer: textCtx.getImageData(0, 0, textCanvas.width, textCanvas.height),
    };
  } finally {
    bitmap.close();
  }
}

export function downloadDataUrl(dataUrl: string, filename: string): void {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  a.click();
}

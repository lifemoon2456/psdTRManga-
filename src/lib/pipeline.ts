import { DefaultConfig, type FontPreset } from "./configs";
import { detectTextBubble } from "./detections/main";
import { getCachedSegmentation } from "./detections/segmentation";
import { extractTextFromBoxes } from "./ocr";
import { inpaintImageAuto, inpaintImageQuality } from "./inpaint/ladder";
import { buildPsd } from "./psd";
import { imageDataFromUrl, renderTranslations } from "./render";
import { shouldUseLocalOcr, type TranslationSettings } from "./translation";

export type PipelineStage =
  | "detect"
  | "ocr"
  | "translate"
  | "inpaint"
  | "compose"
  | "psd"
  | "done";

export interface PipelineSettings {
  detectionModel: string;
  detectionMinConfidence: number;
  inpaintMethod: "fast" | "quality";
  font: FontPreset;
  psdCompress: boolean;
  psdRtl: boolean;
  psdRasterPreview: boolean;
  translation: TranslationSettings;
}

export interface PageAnalysis {
  boxes: Bbox[];
  translations: string[];
  sourceTexts: string[];
  /** Box indexes where local OCR returned no text. */
  ocrFailedBoxes?: number[];
  ocrConfidences?: number[];
  ocrEngine?: string;
  ocrError?: string;
}

export interface PageRender {
  cleanedUrl: string;
  finalUrl: string;
  psd: Uint8Array;
}

export type ProgressFn = (stage: PipelineStage, message?: string) => void;

export async function analyzePage(
  imageSrc: string,
  settings: PipelineSettings,
  onProgress?: ProgressFn,
): Promise<PageAnalysis> {
  onProgress?.("detect", "كشف مناطق النص…");
  const boxes = await detectTextBubble(
    imageSrc,
    settings.detectionMinConfidence,
    settings.detectionModel,
  );

  if (boxes.length === 0) {
    return { boxes: [], translations: [], sourceTexts: [] };
  }

  if (!shouldUseLocalOcr(settings.translation)) {
    return {
      boxes,
      translations: new Array(boxes.length).fill(""),
      sourceTexts: new Array(boxes.length).fill(""),
    };
  }

  onProgress?.("ocr", `استخراج النص محليًا من ${boxes.length} منطقة…`);
  const ocr = await extractTextFromBoxes(imageSrc, boxes, {
    sourceLang: settings.translation.sourceLang,
    onProgress: (message) => onProgress?.("ocr", message),
  });

  return {
    boxes,
    translations: new Array(boxes.length).fill(""),
    sourceTexts: ocr.texts,
    ocrFailedBoxes: ocr.failedBoxes,
    ocrConfidences: ocr.confidences,
    ocrEngine: ocr.engine,
    ocrError: ocr.error,
  };
}

export async function renderPage(
  imageSrc: string,
  analysis: PageAnalysis,
  settings: PipelineSettings,
  onProgress?: ProgressFn,
): Promise<PageRender> {
  const { boxes, translations } = analysis;
  const paintable = boxes.filter((_, index) => translations[index]?.trim());

  let cleanedUrl = imageSrc;
  if (paintable.length > 0) {
    onProgress?.(
      "inpaint",
      settings.inpaintMethod === "quality"
        ? "تنظيف الصفحة باستخدام LaMa…"
        : "تنظيف الصفحة…",
    );
    if (settings.inpaintMethod === "quality") {
      const result = await inpaintImageQuality(imageSrc, paintable);
      cleanedUrl = result.url;
    } else {
      const result = await inpaintImageAuto(imageSrc, paintable, {
        segmentation: getCachedSegmentation(imageSrc),
      });
      cleanedUrl = result.url;
    }
  }

  onProgress?.("compose", "تركيب النص العربي…");
  const final = await renderTranslations(cleanedUrl, boxes, translations, settings.font);

  onProgress?.("psd", "إنشاء ملف PSD بطبقات نص قابلة للتعديل…");
  const cleaned = await imageDataFromUrl(cleanedUrl);
  const psd = await buildPsd({
    cleaned,
    preview: final.imageData,
    rasterText: final.textLayer,
    rasterVisible: settings.psdRasterPreview,
    bubbles: boxes.map((bbox, index) => ({
      bbox,
      text: translations[index] ?? "",
    })),
    font: settings.font,
    dpi: DefaultConfig.psdDpi,
    compress: settings.psdCompress,
    rtl: settings.psdRtl,
  });

  onProgress?.("done", "تمت المعالجة");
  return { cleanedUrl, finalUrl: final.dataUrl, psd };
}

export async function processPage(
  imageSrc: string,
  settings: PipelineSettings,
  onProgress?: ProgressFn,
): Promise<{ analysis: PageAnalysis; render: PageRender }> {
  const analysis = await analyzePage(imageSrc, settings, onProgress);
  const render = await renderPage(imageSrc, analysis, settings, onProgress);
  return { analysis, render };
}

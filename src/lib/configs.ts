/**
 * App-level defaults. The detection/inpaint modules imported from Libre Manga
 * Translator expect this module to expose `DefaultConfig` with the same field
 * names, so keep that contract stable.
 */

export const DefaultConfig = {
  /** Lower = more boxes (better recall for faint text). */
  detectionMinConfidence: 0.45,

  detectionModels: [
    {
      id: "comic-text-detector",
      label: "Comic Text Detector — جودة أعلى",
      size: "~95 MB",
      desc: "صناديق نص دقيقة + قناع تجزئة. الافتراضي للجودة.",
    },
    {
      id: "comic-bubble",
      label: "RT-DETR — أخف وأسرع",
      size: "~11 MB",
      desc: "كشف الفقاعات والنص الحر. أسرع لكن أقل دقة في الحواف.",
    },
  ],

  rtdetrModelRepo: "ogkalu/comic-text-and-bubble-detector",
  comicTextDetectorUrl:
    "https://github.com/zyddnys/manga-image-translator/releases/download/beta-0.3/comictextdetector.pt.onnx",

  /** "quality" uses LaMa first and falls back to the fast ladder. */
  inpaintMethod: "quality" as "fast" | "quality",
  lamaRepo: "ogkalu/lama-manga-onnx-dynamic",
  lamaModelPath: "lama-manga-dynamic.onnx" as `${string}.onnx`,

  /** PSD text metrics. 72 DPI keeps 1 px == 1 pt in Photoshop. */
  psdDpi: 72,
  psdCompress: true,

  /** Arabic defaults. */
  sourceLang: "Japanese" as "Japanese" | "English" | "Auto-Detect",
  targetLang: "Arabic",
} as const;

export function normalizeDetectionModel(id: string | null | undefined): string {
  return id || DefaultConfig.detectionModels[0].id;
}

export interface FontPreset {
  id: string;
  label: string;
  cssStack: string;
  postscriptName: string;
  /** Bundled file path, when present. */
  file?: string;
  rtl?: boolean;
}

/**
 * Fonts must be installed on the machine that opens the PSD. The app bundles
 * the files (where available) and exposes a download link; PSD itself only
 * stores the PostScript name.
 */
export const FONT_PRESETS: FontPreset[] = [
  {
    id: "noto-naskh",
    label: "Noto Naskh Arabic — نسخ عربي",
    cssStack: "'Noto Naskh Arabic', 'Noto Sans Arabic', serif",
    postscriptName: "NotoNaskhArabic-Regular",
    file: "/fonts/NotoNaskhArabic-Regular.ttf",
    rtl: true,
  },
  {
    id: "noto-sans-arabic",
    label: "Noto Sans Arabic — حديث",
    cssStack: "'Noto Sans Arabic', 'Noto Naskh Arabic', sans-serif",
    postscriptName: "NotoSansArabic-Regular",
    file: "/fonts/NotoSansArabic-Regular.ttf",
    rtl: true,
  },
  {
    id: "amiri",
    label: "Amiri — خط مطبعي",
    cssStack: "'Amiri', 'Noto Naskh Arabic', serif",
    postscriptName: "Amiri-Regular",
    file: "/fonts/Amiri-Regular.ttf",
    rtl: true,
  },
  {
    id: "system-arabic",
    label: "خط النظام العربي",
    cssStack: "'Segoe UI', 'Tahoma', 'Arial', sans-serif",
    postscriptName: "SegoeUI",
    rtl: true,
  },
];

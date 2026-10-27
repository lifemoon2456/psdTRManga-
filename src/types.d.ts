interface TextStyle {
  fontSize?: number;
  color?: string;
  strokeColor?: string;
  strokeWidth?: number;
  /** Multiplier of font size when strokeWidth is not set. */
  strokeWidthFactor?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

interface Bbox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  confidence: number;
  gateSkip?: "not-japanese" | "low-confidence";
  inpaintDeclined?: boolean;
  style?: TextStyle;
  inpaintArea?: { x1: number; y1: number; x2: number; y2: number };
}

type Translations = string[];

interface SeriesContext {
  seriesName: string;
  summary: string;
  dictionary: string;
  lastChapterId: string | null;
  lastPageIndex: number | null;
  recentHistory: { chapterId: string; pageIndex: number; text: string }[];
  translatedCount: number;
}

interface TranslateResult {
  translations: Translations;
  sourceTexts?: string[];
  context?: { summary: string; dictionary: string };
}

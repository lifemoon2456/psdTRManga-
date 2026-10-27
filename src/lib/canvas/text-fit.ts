export const BUNDLED_FONT_STACKS: Record<string, string> = {
  system: "'Segoe UI', sans-serif",
  noto: "'Noto Sans', sans-serif",
  bangers: "'Bangers', cursive",
  comic: "'Comic Neue', cursive",
};

let activeFontStack = "'Noto Naskh Arabic', 'Noto Sans Arabic', serif";

/** Set by the app before rendering / PSD export. */
export function setActiveFontStack(stack: string): void {
  activeFontStack = stack;
}

export function getActiveFontStack(): string {
  return activeFontStack;
}

/**
 * Kept for compatibility with the imported canvas module. The standalone app
 * owns font selection in `configs.ts` / the settings UI, so this simply
 * returns the active stack.
 */
export async function resolveFontStack(): Promise<string> {
  return activeFontStack;
}

let measureCtx: CanvasRenderingContext2D | null = null;
function getMeasureCtx(): CanvasRenderingContext2D | null {
  if (!measureCtx && typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    measureCtx = canvas.getContext("2d");
  }
  return measureCtx;
}

export interface FittedTextLayout {
  fontSize: number;
  lines: string[];
  lineH: number;
  blockH: number;
  pad: number;
  maxW: number;
  maxH: number;
}

export function calculateFittedTextLayout(
  text: string,
  width: number,
  height: number,
  fontStack = "'Segoe UI', sans-serif",
  customFontSize?: number,
  bold = true,
  italic = false,
  maxFontSize = 40,
): FittedTextLayout {
  const pad = 8;
  const maxW = width - pad * 2;
  const maxH = height - pad * 2;
  if (maxW <= 0 || maxH <= 0 || !text) {
    const baseSize = customFontSize || 14;
    return {
      fontSize: baseSize,
      lines: text ? [text] : [],
      lineH: baseSize * 1.25,
      blockH: baseSize * 1.25,
      pad,
      maxW,
      maxH,
    };
  }

  const ctx = getMeasureCtx();
  const fontWeight = bold ? "700" : "600";
  const fontStyle = italic ? "italic" : "normal";
  const buildFont = (size: number) =>
    `${fontStyle === "italic" ? "italic " : ""}${fontWeight} ${size}px ${fontStack}`;

  let fontSize = customFontSize
    ? Math.min(customFontSize, maxH)
    : Math.min(maxFontSize, maxH);
  let lines: string[] = [];

  if (ctx) {
    if (customFontSize) {
      ctx.font = buildFont(fontSize);
      lines = wrapText(ctx, text, maxW);
    } else {
      while (fontSize >= 4) {
        ctx.font = buildFont(fontSize);
        lines = wrapText(ctx, text, maxW);
        const lineH = fontSize <= 6 ? fontSize * 1.1 : fontSize * 1.25;
        if (lines.length * lineH <= maxH) break;
        fontSize--;
      }
    }
  } else {
    lines = text.split("\n");
  }

  const lineH = fontSize <= 6 ? fontSize * 1.1 : fontSize * 1.25;
  const blockH = lines.length * lineH;

  return {
    fontSize,
    lines,
    lineH,
    blockH,
    pad,
    maxW,
    maxH,
  };
}

export function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxW: number,
): string[] {
  const lines: string[] = [];

  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(" ");
    let line = "";

    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;

      if (ctx.measureText(candidate).width <= maxW) {
        line = candidate;
      } else {
        // Word doesn't fit - try hyphenating it
        if (ctx.measureText(word).width > maxW) {
          if (line) {
            lines.push(line);
            line = "";
          }

          let chunk = "";
          for (const char of word) {
            const prevChar = chunk.slice(-1);
            const needsHyphen =
              /[A-Za-z0-9]/.test(prevChar) && /[A-Za-z0-9]/.test(char);
            const suffix = needsHyphen ? "-" : "";
            const trial = chunk + char + suffix;
            if (ctx.measureText(trial).width > maxW && chunk) {
              lines.push(chunk + suffix);
              chunk = char;
            } else {
              chunk += char;
            }
          }
          line = chunk;
        } else {
          if (line) lines.push(line);
          line = word;
        }
      }
    }

    if (line) lines.push(line);
  }

  return lines;
}

/**
 * Estimates whether a text region sits on a dark background. Manga lettering
 * normally uses black-on-white, but white-on-black bubbles are common; using
 * the wrong fill makes the translation look like an outline instead of text.
 */
export function isDarkRegion(image: ImageData, bbox: Bbox): boolean {
  const x1 = Math.max(0, Math.floor(bbox.x1));
  const y1 = Math.max(0, Math.floor(bbox.y1));
  const x2 = Math.min(image.width, Math.ceil(bbox.x2));
  const y2 = Math.min(image.height, Math.ceil(bbox.y2));
  const width = x2 - x1;
  const height = y2 - y1;
  if (width <= 0 || height <= 0) return false;

  const margin = Math.max(
    4,
    Math.min(24, Math.round(Math.min(width, height) * 0.15)),
  );
  const rx1 = Math.max(0, x1 - margin);
  const ry1 = Math.max(0, y1 - margin);
  const rx2 = Math.min(image.width, x2 + margin);
  const ry2 = Math.min(image.height, y2 + margin);
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 500)));
  const values: number[] = [];
  const sample = (x: number, y: number) => {
    const index = (y * image.width + x) * 4;
    const alpha = image.data[index + 3] / 255;
    const pixel =
      (0.2126 * image.data[index] +
        0.7152 * image.data[index + 1] +
        0.0722 * image.data[index + 2]) /
      255;
    // Transparent pixels read as white page, which is the safer default.
    values.push(pixel * alpha + (1 - alpha));
  };

  // Prefer a ring just outside the text box. Fast inpainting can leave bright
  // remnants *inside* the box, while the bubble color around it stays intact.
  for (let y = ry1; y < ry2; y += step) {
    for (let x = rx1; x < rx2; x += step) {
      if (x >= x1 && x < x2 && y >= y1 && y < y2) continue;
      sample(x, y);
    }
  }
  if (values.length === 0) {
    for (let y = y1; y < y2; y += step) {
      for (let x = x1; x < x2; x += step) sample(x, y);
    }
  }
  if (values.length === 0) return false;
  // Median is more robust than mean when a bubble edge or an old glyph leaks
  // into the sampled ring.
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)] < 0.45;
}

export function textStyleForBackground(dark: boolean): TextStyle {
  return dark
    ? // A thin dark stroke is invisible on a clean black bubble, but keeps the
      // white letters readable when fast inpainting leaves light remnants.
      { color: "#ffffff", strokeColor: "#000000", strokeWidthFactor: 0.06 }
    : { color: "#111111", strokeColor: "rgba(255,255,255,0.9)", strokeWidthFactor: 0.12 };
}

export async function drawFittedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  bbox: Bbox,
  fontStack = "'Segoe UI', sans-serif",
  maxFontSize = 40,
): Promise<void> {
  const pad = 8;
  const maxW = bbox.x2 - bbox.x1 - pad * 2;
  const maxH = bbox.y2 - bbox.y1 - pad * 2;
  if (maxW <= 0 || maxH <= 0 || !text) return;

  const style = bbox.style;
  const bold = style?.bold ?? true;
  const italic = style?.italic ?? false;
  const fontWeight = bold ? "700" : "600";
  const fontStyle = italic ? "italic" : "normal";

  try {
    await document.fonts.load(`${fontStyle} ${fontWeight} 16px ${fontStack}`);
  } catch (error) {
    console.warn("LMT: Failed to load custom font, falling back.", error);
  }

  const layout = calculateFittedTextLayout(
    text,
    bbox.x2 - bbox.x1,
    bbox.y2 - bbox.y1,
    fontStack,
    style?.fontSize,
    bold,
    italic,
    maxFontSize,
  );

  const { fontSize, lines, lineH, blockH } = layout;
  const startY = bbox.y1 + pad + Math.max(0, (maxH - blockH) / 2);
  const centerX = (bbox.x1 + bbox.x2) / 2;

  ctx.font = `${fontStyle === "italic" ? "italic " : ""}${fontWeight} ${fontSize}px ${fontStack}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.lineJoin = "round";

  const strokeColor = style?.strokeColor ?? "rgba(255,255,255,0.85)";
  const hasStroke = strokeColor !== "none" && strokeColor !== "transparent";
  const strokeWidth =
    style?.strokeWidth ?? fontSize * (style?.strokeWidthFactor ?? 0.25);
  const fillColor = style?.color ?? "#1a1a1a";

  lines.forEach((line, i) => {
    const y = startY + i * lineH;

    if (hasStroke) {
      ctx.lineWidth = strokeWidth;
      ctx.strokeStyle = strokeColor;
      ctx.strokeText(line, centerX, y);
    }

    ctx.fillStyle = fillColor;
    ctx.fillText(line, centerX, y);

    if (style?.underline) {
      const metrics = ctx.measureText(line);
      const textW = metrics.width;
      const underlineY = y + fontSize * 1.05;
      ctx.beginPath();
      ctx.strokeStyle = fillColor;
      ctx.lineWidth = Math.max(1, Math.round(fontSize * 0.08));
      ctx.moveTo(centerX - textW / 2, underlineY);
      ctx.lineTo(centerX + textW / 2, underlineY);
      ctx.stroke();
    }
  });
}

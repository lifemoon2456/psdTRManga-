import { writePsdUint8Array } from "ag-psd";
import type { FontPreset } from "./configs";
import {
  calculateFittedTextLayout,
  drawFittedText,
  isDarkRegion,
  textStyleForBackground,
} from "./canvas/text-fit";

export interface PsdBubble {
  bbox: Bbox;
  text: string;
}

export interface BuildPsdOptions {
  cleaned: ImageData;
  /** Flattened preview (cleaned page + text) used as the PSD composite. */
  preview?: ImageData;
  /** Transparent text-only layer for exact browser-shaped Arabic. */
  rasterText?: ImageData;
  /** Show the browser-shaped raster text layer above the editable layers. */
  rasterVisible?: boolean;
  bubbles: PsdBubble[];
  font: FontPreset;
  /** 72 keeps 1 px == 1 pt in Photoshop. */
  dpi?: number;
  compress?: boolean;
  fillColor?: { r: number; g: number; b: number };
  strokeColor?: { r: number; g: number; b: number };
  /** PSD text engine direction: 2 is right-to-left in Photoshop's text engine. */
  rtl?: boolean;
}

async function ensureFont(font: FontPreset): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  try {
    await document.fonts.load(`700 24px ${font.cssStack}`);
  } catch {
    // The canvas fallback still renders; PSD will reference the PostScript
    // name and Photoshop may substitute if the font is not installed.
  }
}

/**
 * `ag-psd` does not paint a text layer's pixels from its text data. Photoshop
 * normally asks to redraw such layers on open, but until then a layer can look
 * empty. Draw this bubble's browser-shaped text into a small layer bitmap so
 * it is visible immediately and still remains a real editable text layer.
 */
async function renderTextLayerBitmap(
  bubble: PsdBubble,
  font: FontPreset,
  dark: boolean,
  maxFontSize: number,
  rtl: boolean,
  left: number,
  top: number,
  width: number,
  height: number,
): Promise<ImageData | undefined> {
  if (typeof document === "undefined") return undefined;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return undefined;
  ctx.direction = rtl ? "rtl" : "ltr";
  ctx.translate(-left, -top);
  const style = textStyleForBackground(dark);
  const styledBox: Bbox = {
    ...bubble.bbox,
    style: { ...bubble.bbox.style, ...style },
  };
  await drawFittedText(ctx, bubble.text, styledBox, font.cssStack, maxFontSize);
  return ctx.getImageData(0, 0, width, height);
}

/**
 * Builds a PSD with:
 * - one editable text layer per translated bubble;
 * - the cleaned/inpainted page as the background layer;
 * - an optional flattened composite for a correct initial preview.
 *
 * The PSD stores font *names*, not font files. Install the selected font on
 * the machine that opens the PSD (the app exposes the bundled font files).
 */
export async function buildPsd(options: BuildPsdOptions): Promise<Uint8Array> {
  const {
    cleaned,
    preview,
    rasterText,
    rasterVisible = false,
    bubbles,
    font,
    dpi = 72,
    compress = true,
    fillColor = { r: 0, g: 0, b: 0 },
    strokeColor = { r: 255, g: 255, b: 255 },
    rtl = font.rtl ?? true,
  } = options;

  await ensureFont(font);

  const textLayers: any[] = [];
  for (let index = 0; index < bubbles.length; index++) {
    const bubble = bubbles[index];
    if (bubble.text.trim().length === 0) continue;
    const width = Math.max(1, bubble.bbox.x2 - bubble.bbox.x1);
    const height = Math.max(1, bubble.bbox.y2 - bubble.bbox.y1);
    const maxFontSize = Math.max(
      32,
      Math.min(96, Math.round(height * 0.55)),
    );
    const layout = calculateFittedTextLayout(
      bubble.text,
      width,
      height,
      font.cssStack,
      undefined,
      true,
      false,
      maxFontSize,
    );

    const fontSize = Math.max(6, layout.fontSize);
    const dark = isDarkRegion(cleaned, bubble.bbox);
    const bubbleFill = dark ? { r: 255, g: 255, b: 255 } : fillColor;
    const bubbleStroke = dark ? { r: 0, g: 0, b: 0 } : strokeColor;
    const outlineWidth = Math.max(
      1,
      Math.round(fontSize * (dark ? 0.06 : 0.12)),
    );
    // Box text is top-aligned in Photoshop. Use a box just tall enough for
    // the pre-wrapped block and move it down so it matches the centered
    // browser preview.
    const boxHeight = Math.min(
      height,
      Math.max(1, layout.blockH + layout.pad * 2),
    );
    const boxY = bubble.bbox.y1 + Math.max(0, (height - boxHeight) / 2);

    // Keep a small margin so strokes and Arabic ascenders are not clipped by
    // the layer bitmap. The layer is still positioned in page coordinates.
    const layerPad = Math.max(24, Math.ceil(fontSize * 0.75));
    const layerLeft = Math.max(0, Math.floor(bubble.bbox.x1 - layerPad));
    const layerTop = Math.max(0, Math.floor(bubble.bbox.y1 - layerPad));
    const layerRight = Math.min(
      cleaned.width,
      Math.ceil(bubble.bbox.x2 + layerPad),
    );
    const layerBottom = Math.min(
      cleaned.height,
      Math.ceil(bubble.bbox.y2 + layerPad),
    );
    const layerWidth = Math.max(1, layerRight - layerLeft);
    const layerHeight = Math.max(1, layerBottom - layerTop);
    const layerImage = await renderTextLayerBitmap(
      bubble,
      font,
      dark,
      maxFontSize,
      rtl,
      layerLeft,
      layerTop,
      layerWidth,
      layerHeight,
    );

    textLayers.push({
      name: `Bubble ${String(index + 1).padStart(3, "0")} — editable`,
      // Keep editable layers visible under the optional raster preview. Users
      // can hide the preview layer to edit the live text immediately.
      hidden: false,
      ...(layerImage
        ? {
            left: layerLeft,
            top: layerTop,
            right: layerRight,
            bottom: layerBottom,
            imageData: layerImage,
          }
        : {}),
      text: {
        text: layout.lines.join("\n"),
        transform: [1, 0, 0, 1, bubble.bbox.x1, boxY],
        shapeType: "box" as const,
        // Box bounds are relative to the text layer transform. If a PSD
        // editor treats them as absolute, adjust to [x1,y1,x2,y2].
        boxBounds: [0, 0, width, boxHeight],
        orientation: "horizontal" as const,
        antiAlias: "smooth" as const,
        style: {
          font: { name: font.postscriptName },
          fontSize,
          fauxBold: true,
          leading: layout.lineH,
          autoLeading: false,
          fillColor: bubbleFill,
          fillFlag: true,
          strokeColor: bubbleStroke,
          strokeFlag: true,
          outlineWidth,
          characterDirection: rtl ? 2 : 0,
        },
        paragraphStyle: {
          justification: "center" as const,
        },
      },
    });
  }

  const psd = {
    width: cleaned.width,
    height: cleaned.height,
    imageData: (preview ?? cleaned) as unknown as ImageData,
    imageResources: {
      resolutionInfo: {
        horizontalResolution: dpi,
        horizontalResolutionUnit: "PPI" as const,
        widthUnit: "Inches" as const,
        verticalResolution: dpi,
        verticalResolutionUnit: "PPI" as const,
        heightUnit: "Inches" as const,
      },
    },
    // ag-psd expects children top-to-bottom. Text sits above the background.
    children: [
      ...(rasterText
        ? [
            {
              name: "Preview — raster Arabic text (hide to edit)",
              imageData: rasterText as unknown as ImageData,
              hidden: !rasterVisible,
            },
          ]
        : []),
      ...textLayers,
      {
        name: "Background — cleaned page",
        imageData: cleaned as unknown as ImageData,
      },
    ],
  };

  return writePsdUint8Array(psd as any, {
    compress,
    invalidateTextLayers: true,
    noBackground: true,
  });
}

export function downloadBytes(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([bytes as unknown as BlobPart], {
    type: "image/vnd.adobe.photoshop",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

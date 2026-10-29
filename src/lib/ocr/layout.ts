/**
 * Local OCR layout analysis.
 *
 * Detection gives us text regions, not text lines. This module estimates the
 * background, builds an ink mask, detects horizontal lines or vertical Japanese
 * columns, and returns crops in manga reading order (top-to-bottom, and
 * right-to-left for vertical columns).
 */

export interface OcrLineCrop {
  x: number;
  y: number;
  width: number;
  height: number;
  vertical: boolean;
  background: { r: number; g: number; b: number };
}

interface Band {
  start: number;
  end: number;
}

interface CropData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  x: number;
  y: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function cropImageData(image: ImageData, x: number, y: number, width: number, height: number): CropData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row++) {
    const sourceStart = ((y + row) * image.width + x) * 4;
    const targetStart = row * width * 4;
    data.set(image.data.subarray(sourceStart, sourceStart + width * 4), targetStart);
  }
  return { data, width, height, x, y };
}

function estimateBackground(crop: CropData): { r: number; g: number; b: number } {
  const histogram = new Uint32Array(32 * 32 * 32);
  const step = crop.width * crop.height > 250_000 ? 2 : 1;
  for (let y = 0; y < crop.height; y += step) {
    for (let x = 0; x < crop.width; x += step) {
      const index = (y * crop.width + x) * 4;
      const r = crop.data[index] >> 3;
      const g = crop.data[index + 1] >> 3;
      const b = crop.data[index + 2] >> 3;
      histogram[(r << 10) | (g << 5) | b]++;
    }
  }
  let best = 0;
  let bestCount = -1;
  for (let index = 0; index < histogram.length; index++) {
    if (histogram[index] > bestCount) {
      bestCount = histogram[index];
      best = index;
    }
  }
  return {
    r: (((best >> 10) & 31) << 3) + 4,
    g: (((best >> 5) & 31) << 3) + 4,
    b: ((best & 31) << 3) + 4,
  };
}

function buildInkMask(
  crop: CropData,
  background: { r: number; g: number; b: number },
): { mask: Uint8Array; inkRatio: number } {
  const mask = new Uint8Array(crop.width * crop.height);
  let count = 0;
  const bgLum = 0.299 * background.r + 0.587 * background.g + 0.114 * background.b;
  const threshold = 52;
  for (let y = 0; y < crop.height; y++) {
    for (let x = 0; x < crop.width; x++) {
      const index = (y * crop.width + x) * 4;
      const r = crop.data[index];
      const g = crop.data[index + 1];
      const b = crop.data[index + 2];
      const distance = Math.sqrt(
        (r - background.r) ** 2 + (g - background.g) ** 2 + (b - background.b) ** 2,
      );
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const isInk = distance > threshold || Math.abs(lum - bgLum) > threshold;
      if (isInk) {
        mask[y * crop.width + x] = 1;
        count++;
      }
    }
  }
  return { mask, inkRatio: count / Math.max(1, crop.width * crop.height) };
}

export function findBands(
  counts: Uint32Array,
  thresholdRatio = 0.07,
  mergeGap = 2,
  minSize = 2,
): Band[] {
  let maximum = 0;
  for (const count of counts) maximum = Math.max(maximum, count);
  if (maximum <= 0) return [];
  const threshold = Math.max(1, Math.round(maximum * thresholdRatio));
  const raw: Band[] = [];
  let start = -1;
  for (let index = 0; index < counts.length; index++) {
    if (counts[index] >= threshold) {
      if (start < 0) start = index;
    } else if (start >= 0) {
      raw.push({ start, end: index });
      start = -1;
    }
  }
  if (start >= 0) raw.push({ start, end: counts.length });

  const merged: Band[] = [];
  for (const band of raw) {
    const previous = merged[merged.length - 1];
    if (previous && band.start - previous.end <= mergeGap) {
      previous.end = band.end;
    } else {
      merged.push({ ...band });
    }
  }
  return merged.filter((band) => band.end - band.start >= minSize);
}

function removeTinyBands(bands: Band[]): Band[] {
  if (bands.length < 3) return bands;
  const thickness = median(bands.map((band) => band.end - band.start));
  const minimum = Math.max(2, Math.round(thickness * 0.32));
  const filtered = bands.filter((band) => band.end - band.start >= minimum);
  return filtered.length > 0 ? filtered : bands;
}

function isEdgeBand(band: Band, length: number): boolean {
  const thickness = band.end - band.start;
  return thickness <= 4 && (band.start <= 1 || band.end >= length - 1);
}

function projection(mask: Uint8Array, width: number, height: number) {
  const rows = new Uint32Array(height);
  const columns = new Uint32Array(width);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x]) {
        rows[y]++;
        columns[x]++;
      }
    }
  }
  return { rows, columns };
}

function chooseVertical(
  rowBands: Band[],
  columnBands: Band[],
  width: number,
  height: number,
  sourceLang: string,
): boolean {
  const rows = rowBands.length;
  const columns = columnBands.length;
  // A single vertical column has one column band and one band per glyph row;
  // a single horizontal line is the opposite. Do not confuse the two.
  if (columns === 1 && rows > 1) return true;
  if (rows === 1 && columns > 1) return false;
  if (columns > rows + 1) return true;
  if (rows > columns + 1) return false;

  const tall = height > width * 1.08;
  const wide = width > height * 1.08;
  if (sourceLang === "Japanese") {
    if (tall) return true;
    if (wide && rows >= columns) return false;
    // Multiple vertical columns have several glyph rows and fewer column
    // bands. Horizontal multi-line text has the opposite shape.
    if (columns > 1 && rows >= columns) return true;
    return columns >= rows;
  }
  if (sourceLang === "English") {
    if (wide) return false;
    if (tall && columns > rows) return true;
    return columns > rows;
  }
  return tall || columns > rows;
}

export function layoutTextBox(
  image: ImageData,
  box: Bbox,
  sourceLang: string,
): OcrLineCrop[] {
  const pageWidth = image.width;
  const pageHeight = image.height;
  const left = clamp(Math.round(Math.min(box.x1, box.x2)), 0, pageWidth - 1);
  const top = clamp(Math.round(Math.min(box.y1, box.y2)), 0, pageHeight - 1);
  const right = clamp(Math.round(Math.max(box.x1, box.x2)), left + 1, pageWidth);
  const bottom = clamp(Math.round(Math.max(box.y1, box.y2)), top + 1, pageHeight);
  const boxWidth = Math.max(1, right - left);
  const boxHeight = Math.max(1, bottom - top);
  const pad = clamp(Math.round(Math.min(boxWidth, boxHeight) * 0.05), 2, 12);
  const cropX = clamp(left - pad, 0, pageWidth - 1);
  const cropY = clamp(top - pad, 0, pageHeight - 1);
  const cropRight = clamp(right + pad, cropX + 1, pageWidth);
  const cropBottom = clamp(bottom + pad, cropY + 1, pageHeight);
  const crop = cropImageData(
    image,
    cropX,
    cropY,
    cropRight - cropX,
    cropBottom - cropY,
  );

  const background = estimateBackground(crop);
  let { mask, inkRatio } = buildInkMask(crop, background);
  if (inkRatio > 0.58) {
    // A very tight crop can make text dominate the histogram. Invert the mask
    // only if that produces a more plausible (sparse) ink ratio.
    const inverted = new Uint8Array(mask.length);
    let invertedCount = 0;
    for (let index = 0; index < mask.length; index++) {
      inverted[index] = mask[index] ? 0 : 1;
      invertedCount += inverted[index];
    }
    const invertedRatio = invertedCount / Math.max(1, mask.length);
    if (invertedRatio < 0.5) {
      mask = inverted;
      inkRatio = invertedRatio;
    }
  }
  if (inkRatio < 0.003) {
    return [
      {
        x: cropX,
        y: cropY,
        width: cropRight - cropX,
        height: cropBottom - cropY,
        vertical: boxHeight > boxWidth * 1.12,
        background,
      },
    ];
  }

  const { rows, columns } = projection(mask, crop.width, crop.height);
  let rowBands = removeTinyBands(findBands(rows)).filter(
    (band) => !isEdgeBand(band, crop.height),
  );
  let columnBands = removeTinyBands(findBands(columns)).filter(
    (band) => !isEdgeBand(band, crop.width),
  );
  if (rowBands.length === 0) rowBands = findBands(rows);
  if (columnBands.length === 0) columnBands = findBands(columns);

  const vertical = chooseVertical(
    rowBands,
    columnBands,
    boxWidth,
    boxHeight,
    sourceLang,
  );

  const lines: OcrLineCrop[] = [];
  if (vertical) {
    const ordered = columnBands
      .slice()
      .sort((a, b) => b.start - a.start)
      .slice(0, 24);
    for (const band of ordered) {
      let minY = crop.height;
      let maxY = -1;
      for (let y = 0; y < crop.height; y++) {
        for (let x = band.start; x < band.end; x++) {
          if (mask[y * crop.width + x]) {
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
            break;
          }
        }
      }
      if (maxY < 0) continue;
      const linePad = clamp(
        Math.round(Math.max(4, (band.end - band.start) * 0.25)),
        4,
        16,
      );
      const x = clamp(crop.x + band.start - linePad, 0, pageWidth - 1);
      const y = clamp(crop.y + minY - linePad, 0, pageHeight - 1);
      const width = clamp(band.end - band.start + linePad * 2, 2, pageWidth - x);
      const height = clamp(maxY - minY + 1 + linePad * 2, 2, pageHeight - y);
      lines.push({ x, y, width, height, vertical: true, background });
    }
  } else {
    const ordered = rowBands.slice(0, 24);
    for (const band of ordered) {
      let minX = crop.width;
      let maxX = -1;
      for (let x = 0; x < crop.width; x++) {
        for (let y = band.start; y < band.end; y++) {
          if (mask[y * crop.width + x]) {
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            break;
          }
        }
      }
      if (maxX < 0) continue;
      const linePad = clamp(
        Math.round(Math.max(4, (band.end - band.start) * 0.25)),
        4,
        16,
      );
      const x = clamp(crop.x + minX - linePad, 0, pageWidth - 1);
      const y = clamp(crop.y + band.start - linePad, 0, pageHeight - 1);
      const width = clamp(maxX - minX + 1 + linePad * 2, 2, pageWidth - x);
      const height = clamp(band.end - band.start + linePad * 2, 2, pageHeight - y);
      lines.push({ x, y, width, height, vertical: false, background });
    }
  }

  if (lines.length === 0) {
    return [
      {
        x: cropX,
        y: cropY,
        width: cropRight - cropX,
        height: cropBottom - cropY,
        vertical: boxHeight > boxWidth * 1.12,
        background,
      },
    ];
  }
  return lines;
}

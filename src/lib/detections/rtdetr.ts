import * as ort from "onnxruntime-web/wasm";
import { fetchAsImageBitmap, yieldToMain } from "../utils";
import { scalingImage, restoreBoundingBox, containmentNMS } from "./utils";
import { refineDetections } from "./boxes";
import {
  planDetectionTiles,
  shouldTile,
  mergeTiledBoxes,
} from "./tiling";

/**
 * RT-DETR-v2 detector wrapper for `ogkalu/comic-text-and-bubble-detector`
 * Model: `detector-v4-s_int8.onnx` (Apache-2.0, ~11.1 MB).
 * Classes: 0: bubble, 1: text_bubble, 2: text_free.
 *
 * Aspect-preserving policy: center-letterbox every page into 640×640 instead
 * of squeezing its x/y axes independently. Ask RT-DETR to return boxes in that
 * square coordinate frame, then remove the padding exactly once via
 * `restoreBoundingBox`.
 *
 * This is a deliberate product choice rather than the upstream processor's
 * default: its `preprocessor_config.json` declares `do_pad: false`. Keep the
 * wiring pinned by tests/unit/detections-contract.test.ts and measure recall on
 * real wide/tall pages before claiming an accuracy improvement.
 *
 * Very tall strips (webtoons/manhwa) trigger sliding-window tiling
 * so long pages are not downscaled into sub-pixel smears before inference.
 */
const INPUT_SIZE = 640;

interface DetectedGroups {
  textBoxes: Bbox[];
  bubbleBoxes: Bbox[];
}

async function runRtDetrSingle(
  session: ort.InferenceSession,
  input: string | CanvasImageSource,
  minConfidence = 0.35,
): Promise<DetectedGroups> {
  const { imageData, origWidth, origHeight } = await scalingImage(
    input,
    INPUT_SIZE,
  );
  const plane = INPUT_SIZE * INPUT_SIZE;
  const buffer = new Float32Array(3 * plane);
  const inv255 = 1.0 / 255.0;

  await yieldToMain();
  for (let i = 0; i < plane; i++) {
    const idx = i * 4;
    buffer[i] = imageData.data[idx] * inv255;
    buffer[plane + i] = imageData.data[idx + 1] * inv255;
    buffer[plane * 2 + i] = imageData.data[idx + 2] * inv255;
  }

  await yieldToMain();
  let imageTensor: ort.Tensor | null = new ort.Tensor("float32", buffer, [
    1,
    3,
    INPUT_SIZE,
    INPUT_SIZE,
  ]);
  // The pixels and output coordinates both use the letterboxed square. Passing
  // the true page size here would independently stretch the already-padded
  // frame; restoreBoundingBox performs the sole page-coordinate transform.
  const sizeArray = new BigInt64Array([
    BigInt(INPUT_SIZE),
    BigInt(INPUT_SIZE),
  ]);
  let sizeTensor: ort.Tensor | null = new ort.Tensor("int64", sizeArray, [1, 2]);

  const inNames = session.inputNames;
  const feeds: Record<string, ort.Tensor> = {};
  feeds[inNames[0] ?? "images"] = imageTensor;
  feeds[inNames[1] ?? "orig_target_sizes"] = sizeTensor;

  let labelsTensor: ort.Tensor | null = null;
  let boxesTensor: ort.Tensor | null = null;
  let scoresTensor: ort.Tensor | null = null;
  try {
    const results = await session.run(feeds);
    await yieldToMain();
    labelsTensor = results["labels"];
    boxesTensor = results["boxes"];
    scoresTensor = results["scores"];
    const labelsData = (await labelsTensor.getData()) as
      | BigInt64Array
      | Int32Array;
    const boxesData = (await boxesTensor.getData()) as Float32Array;
    const scoresData = (await scoresTensor.getData()) as Float32Array;

    const textBoxes: Bbox[] = [];
    const bubbleBoxes: Bbox[] = [];
    const count = Math.min(labelsData.length, scoresData.length);

    for (let i = 0; i < count; i++) {
      const score = scoresData[i];
      if (score < minConfidence) continue;
      const label = Number(labelsData[i]);

      const letterboxed = restoreBoundingBox(
        {
          x1: boxesData[i * 4],
          y1: boxesData[i * 4 + 1],
          x2: boxesData[i * 4 + 2],
          y2: boxesData[i * 4 + 3],
          confidence: score,
        },
        origWidth,
        origHeight,
        INPUT_SIZE,
      );

      const x1 = Math.max(0, Math.min(origWidth, letterboxed.x1));
      const y1 = Math.max(0, Math.min(origHeight, letterboxed.y1));
      const x2 = Math.max(0, Math.min(origWidth, letterboxed.x2));
      const y2 = Math.max(0, Math.min(origHeight, letterboxed.y2));
      if (x2 - x1 < 4 || y2 - y1 < 4) continue;

      const box: Bbox = { x1, y1, x2, y2, confidence: score };
      if (label === 1 || label === 2) {
        textBoxes.push(box);
      } else if (label === 0) {
        bubbleBoxes.push(box);
      }
    }

    return { textBoxes, bubbleBoxes };
  } finally {
    imageTensor?.dispose?.();
    sizeTensor?.dispose?.();
    labelsTensor?.dispose?.();
    boxesTensor?.dispose?.();
    scoresTensor?.dispose?.();
  }
}

export async function runRtDetrDetection(
  session: ort.InferenceSession,
  imageSrc: string,
  minConfidence = 0.35,
): Promise<Bbox[]> {
  const bitmap = await fetchAsImageBitmap(imageSrc);
  const origWidth = bitmap.width;
  const origHeight = bitmap.height;

  try {
    if (!shouldTile(origWidth, origHeight)) {
      const { textBoxes, bubbleBoxes } = await runRtDetrSingle(
        session,
        bitmap,
        minConfidence,
      );
      const targetBoxes = textBoxes.length > 0 ? textBoxes : bubbleBoxes;
      const nms = containmentNMS(targetBoxes);
      return refineDetections(nms, origWidth, origHeight).boxes;
    }

    // Tiled sliding-window path for webtoon/tall/large images
    const tiles = planDetectionTiles(origWidth, origHeight);
    const allTextBoxes: Bbox[] = [];
    const allBubbleBoxes: Bbox[] = [];

    for (const tile of tiles) {
      const tileCanvas = new OffscreenCanvas(tile.w, tile.h);
      const tileCtx = tileCanvas.getContext("2d", { willReadFrequently: true })!;
      tileCtx.drawImage(
        bitmap,
        tile.x,
        tile.y,
        tile.w,
        tile.h,
        0,
        0,
        tile.w,
        tile.h,
      );

      const tileResult = await runRtDetrSingle(
        session,
        tileCanvas,
        minConfidence,
      );

      for (const b of tileResult.textBoxes) {
        allTextBoxes.push({
          x1: Math.max(0, Math.min(origWidth, b.x1 + tile.x)),
          y1: Math.max(0, Math.min(origHeight, b.y1 + tile.y)),
          x2: Math.max(0, Math.min(origWidth, b.x2 + tile.x)),
          y2: Math.max(0, Math.min(origHeight, b.y2 + tile.y)),
          confidence: b.confidence,
        });
      }

      for (const b of tileResult.bubbleBoxes) {
        allBubbleBoxes.push({
          x1: Math.max(0, Math.min(origWidth, b.x1 + tile.x)),
          y1: Math.max(0, Math.min(origHeight, b.y1 + tile.y)),
          x2: Math.max(0, Math.min(origWidth, b.x2 + tile.x)),
          y2: Math.max(0, Math.min(origHeight, b.y2 + tile.y)),
          confidence: b.confidence,
        });
      }

      await yieldToMain();
    }

    const targetBoxes =
      allTextBoxes.length > 0 ? allTextBoxes : allBubbleBoxes;
    const merged = mergeTiledBoxes(targetBoxes);
    const nms = containmentNMS(merged);
    return refineDetections(nms, origWidth, origHeight).boxes;
  } finally {
    bitmap.close();
  }
}

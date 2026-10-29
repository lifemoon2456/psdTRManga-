import assert from "node:assert/strict";
import test from "node:test";
import { containmentNMS, restoreBoundingBox } from "../src/lib/detections/utils";
import {
  computeTileOrigins,
  mergeTiledBoxes,
  planDetectionTiles,
  shouldTile,
} from "../src/lib/detections/tiling";

test("RT-DETR letterbox coordinates restore to the original page exactly", () => {
  // A 1600 x 800 page becomes 640 x 320, with 160px top/bottom padding.
  const restored = restoreBoundingBox(
    { x1: 80, y1: 200, x2: 560, y2: 440, confidence: 0.9 },
    1600,
    800,
    640,
  );

  assert.deepEqual(restored, {
    x1: 200,
    y1: 100,
    x2: 1400,
    y2: 700,
    confidence: 0.9,
  });
});

test("ordinary pages stay single-pass while strips and oversized pages tile", () => {
  assert.equal(shouldTile(1200, 1800), false);
  assert.equal(shouldTile(900, 4000), true);
  assert.equal(shouldTile(2600, 1600), true);
});

test("tile planning covers the whole page with the requested overlap", () => {
  const spans = computeTileOrigins(2600, 1000, 200);
  assert.deepEqual(spans, [
    { start: 0, size: 1000 },
    { start: 800, size: 1000 },
    { start: 1600, size: 1000 },
  ]);

  const tiles = planDetectionTiles(800, 2600, 1000, 200);
  assert.deepEqual(tiles, [
    { x: 0, y: 0, w: 800, h: 1000 },
    { x: 0, y: 800, w: 800, h: 1000 },
    { x: 0, y: 1600, w: 800, h: 1000 },
  ]);
});

test("seam duplicates merge but distinct dialogue boxes remain separate", () => {
  const merged = mergeTiledBoxes([
    { x1: 100, y1: 780, x2: 400, y2: 980, confidence: 0.7 },
    { x1: 100, y1: 785, x2: 405, y2: 985, confidence: 0.9 },
    { x1: 100, y1: 1200, x2: 400, y2: 1400, confidence: 0.8 },
  ]);

  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0], {
    x1: 100,
    y1: 780,
    x2: 405,
    y2: 985,
    confidence: 0.9,
  });
});

test("containment NMS retains the higher-confidence box", () => {
  const kept = containmentNMS([
    { x1: 0, y1: 0, x2: 100, y2: 100, confidence: 0.6 },
    { x1: 2, y1: 2, x2: 98, y2: 98, confidence: 0.9 },
  ]);
  assert.deepEqual(kept, [
    { x1: 2, y1: 2, x2: 98, y2: 98, confidence: 0.9 },
  ]);
});

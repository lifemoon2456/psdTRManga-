import assert from "node:assert/strict";
import test from "node:test";
import { layoutTextBox } from "../src/lib/ocr/layout";

function image(width: number, height: number): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = 255;
    data[index + 1] = 255;
    data[index + 2] = 255;
    data[index + 3] = 255;
  }
  return { data, width, height, colorSpace: "srgb" } as ImageData;
}

function rect(
  target: ImageData,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  for (let row = y; row < y + height; row++) {
    for (let column = x; column < x + width; column++) {
      const index = (row * target.width + column) * 4;
      target.data[index] = 0;
      target.data[index + 1] = 0;
      target.data[index + 2] = 0;
    }
  }
}

test("a single vertical Japanese column is one vertical crop, not glyph rows", () => {
  const source = image(120, 220);
  rect(source, 45, 20, 22, 32);
  rect(source, 45, 80, 22, 32);
  rect(source, 45, 140, 22, 32);

  const lines = layoutTextBox(
    source,
    { x1: 38, y1: 10, x2: 74, y2: 190 },
    "Japanese",
  );

  assert.equal(lines.length, 1);
  assert.equal(lines[0].vertical, true);
  assert.ok(lines[0].height > lines[0].width);
});

test("a single horizontal line is one horizontal crop, not character columns", () => {
  const source = image(240, 90);
  rect(source, 20, 30, 32, 24);
  rect(source, 90, 30, 32, 24);
  rect(source, 160, 30, 32, 24);

  const lines = layoutTextBox(
    source,
    { x1: 10, y1: 20, x2: 210, y2: 65 },
    "Japanese",
  );

  assert.equal(lines.length, 1);
  assert.equal(lines[0].vertical, false);
  assert.ok(lines[0].width > lines[0].height);
});

test("two vertical Japanese columns are ordered right-to-left", () => {
  const source = image(240, 220);
  // Right column is read first in vertical Japanese.
  rect(source, 150, 20, 22, 32);
  rect(source, 150, 80, 22, 32);
  rect(source, 150, 140, 22, 32);
  rect(source, 80, 20, 22, 32);
  rect(source, 80, 80, 22, 32);
  rect(source, 80, 140, 22, 32);

  const lines = layoutTextBox(
    source,
    { x1: 60, y1: 10, x2: 190, y2: 190 },
    "Japanese",
  );

  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => line.vertical));
  assert.ok(lines[0].x > lines[1].x, "right column must come first");
});

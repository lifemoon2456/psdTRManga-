import assert from "node:assert/strict";
import test from "node:test";
import {
  bubbleId,
  estimateBatchTokens,
  planTextBatches,
  type TranslationBubbleInput,
} from "../src/lib/translation/batching";

function makeInputs(pages: number, bubbles: number, longEvery = 0): TranslationBubbleInput[] {
  const inputs: TranslationBubbleInput[] = [];
  for (let pageIndex = 0; pageIndex < pages; pageIndex++) {
    for (let boxIndex = 0; boxIndex < bubbles; boxIndex++) {
      inputs.push({
        id: bubbleId(pageIndex, boxIndex),
        text:
          longEvery > 0 && (pageIndex * bubbles + boxIndex) % longEvery === 0
            ? "This is a deliberately long manga dialogue line that should force a smaller batch. ".repeat(8)
            : `page ${pageIndex + 1} bubble ${boxIndex + 1}`,
        pageId: `page-${pageIndex + 1}`,
        pageIndex,
        boxIndex,
      });
    }
  }
  return inputs;
}

test("30 pages x 18 bubbles becomes 8 four-page batches with stable IDs", () => {
  const inputs = makeInputs(30, 18);
  const batches = planTextBatches(inputs, {
    smartBatch: true,
    batchPages: 4,
    tokenBudget: 12_000,
    maxSegmentsPerBatch: 120,
  });

  assert.equal(batches.length, 8);
  assert.deepEqual(
    batches.map((batch) => batch.segments.length),
    [72, 72, 72, 72, 72, 72, 72, 36],
  );
  assert.deepEqual(
    batches.map((batch) => batch.pageIndexes.length),
    [4, 4, 4, 4, 4, 4, 4, 2],
  );

  const ids = batches.flatMap((batch) => batch.segments.map((segment) => segment.id));
  assert.equal(ids.length, 540);
  assert.equal(new Set(ids).size, 540);
  assert.equal(ids[0], "p001_b001");
  assert.equal(ids[539], "p030_b018");
  assert.deepEqual(
    ids,
    inputs.map((input) => input.id),
  );
});

test("long text splits by token budget instead of exceeding it", () => {
  const inputs = makeInputs(2, 18, 3);
  const batches = planTextBatches(inputs, {
    smartBatch: true,
    batchPages: 4,
    tokenBudget: 1_800,
    maxSegmentsPerBatch: 120,
  });

  assert.ok(batches.length > 2, "expected more than one batch per page");
  for (const batch of batches) {
    assert.ok(
      batch.estimatedTokens <= 1_800 || batch.segments.length === 1,
      `batch ${batch.id} exceeded the budget: ${batch.estimatedTokens}`,
    );
    assert.ok(batch.estimatedTokens > 0);
  }
  assert.equal(
    batches.flatMap((batch) => batch.segments).length,
    inputs.length,
  );
});

test("Smart Batch off keeps one page per request and still splits oversized pages", () => {
  const inputs = makeInputs(3, 10);
  const batches = planTextBatches(inputs, {
    smartBatch: false,
    batchPages: 4,
    tokenBudget: 12_000,
  });
  assert.equal(batches.length, 3);
  assert.deepEqual(batches.map((batch) => batch.pageIndexes.length), [1, 1, 1]);
});

test("empty input never creates a request", () => {
  assert.deepEqual(
    planTextBatches([], {
      smartBatch: true,
      batchPages: 4,
      tokenBudget: 12_000,
    }),
    [],
  );
  assert.equal(estimateBatchTokens([]), 760);
});

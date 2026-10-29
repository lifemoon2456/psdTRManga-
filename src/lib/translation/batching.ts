/**
 * Deterministic Smart Batch planner.
 *
 * Batches are built from stable bubble ids, never from array positions. The
 * planner keeps page and bubble order, groups up to N pages, and splits a page
 * only when its own text would exceed the token budget.
 */

export interface TranslationBubbleInput {
  /** Stable id such as p001_b003. */
  id: string;
  text: string;
  pageId: string;
  /** Zero-based page index in the current project order. */
  pageIndex: number;
  /** Zero-based box index inside the page. */
  boxIndex: number;
}

export interface TextBatch {
  id: string;
  segments: TranslationBubbleInput[];
  pageIndexes: number[];
  estimatedTokens: number;
}

export interface BatchPlanOptions {
  smartBatch: boolean;
  batchPages: number;
  tokenBudget: number;
  maxSegmentsPerBatch?: number;
}

const PROMPT_OVERHEAD_TOKENS = 760;
const PER_SEGMENT_INPUT_OVERHEAD = 14;
const PER_SEGMENT_OUTPUT_OVERHEAD = 28;

export function bubbleId(pageIndex: number, boxIndex: number): string {
  return `p${String(pageIndex + 1).padStart(3, "0")}_b${String(boxIndex + 1).padStart(3, "0")}`;
}

/** Conservative local estimate; actual usage from Gemini is always preferred. */
export function estimateTextTokens(text: string): number {
  const value = text ?? "";
  let cjk = 0;
  let other = 0;
  for (const character of value) {
    if (/[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]/u.test(character)) cjk++;
    else other++;
  }
  return Math.max(1, Math.ceil(cjk * 1.15 + other / 3.5));
}

export function estimateSegmentTokens(segment: TranslationBubbleInput): number {
  const sourceTokens = estimateTextTokens(segment.text);
  return (
    PER_SEGMENT_INPUT_OVERHEAD +
    sourceTokens +
    Math.ceil(sourceTokens * 1.25) +
    PER_SEGMENT_OUTPUT_OVERHEAD
  );
}

export function estimateBatchTokens(segments: TranslationBubbleInput[]): number {
  return (
    PROMPT_OVERHEAD_TOKENS +
    segments.reduce((total, segment) => total + estimateSegmentTokens(segment), 0)
  );
}

function splitPageSegments(
  segments: TranslationBubbleInput[],
  tokenBudget: number,
  maxSegments: number,
): TranslationBubbleInput[][] {
  const chunks: TranslationBubbleInput[][] = [];
  let current: TranslationBubbleInput[] = [];
  let currentTokens = PROMPT_OVERHEAD_TOKENS;

  const flush = () => {
    if (current.length > 0) {
      chunks.push(current);
      current = [];
      currentTokens = PROMPT_OVERHEAD_TOKENS;
    }
  };

  for (const segment of segments) {
    const segmentTokens = estimateSegmentTokens(segment);
    if (
      current.length > 0 &&
      (current.length >= maxSegments || currentTokens + segmentTokens > tokenBudget)
    ) {
      flush();
    }
    current.push(segment);
    currentTokens += segmentTokens;
  }
  flush();
  return chunks;
}

export function planTextBatches(
  inputs: TranslationBubbleInput[],
  options: BatchPlanOptions,
): TextBatch[] {
  const tokenBudget = Math.max(1000, Math.round(options.tokenBudget || 12_000));
  const batchPages = Math.max(1, Math.min(20, Math.round(options.batchPages || 4)));
  const maxSegments = Math.max(1, Math.min(240, Math.round(options.maxSegmentsPerBatch ?? 120)));
  const ordered = inputs
    .filter((input) => input.text.trim().length > 0)
    .slice()
    .sort((a, b) => a.pageIndex - b.pageIndex || a.boxIndex - b.boxIndex);

  if (ordered.length === 0) return [];

  const pageGroups = new Map<string, TranslationBubbleInput[]>();
  for (const input of ordered) {
    const group = pageGroups.get(input.pageId);
    if (group) group.push(input);
    else pageGroups.set(input.pageId, [input]);
  }

  const batches: TranslationBubbleInput[][] = [];

  if (!options.smartBatch) {
    for (const group of pageGroups.values()) {
      for (const chunk of splitPageSegments(group, tokenBudget, maxSegments)) {
        batches.push(chunk);
      }
    }
  } else {
    let current: TranslationBubbleInput[] = [];
    let currentPages = new Set<string>();
    let currentTokens = PROMPT_OVERHEAD_TOKENS;

    const flush = () => {
      if (current.length > 0) {
        batches.push(current);
        current = [];
        currentPages = new Set<string>();
        currentTokens = PROMPT_OVERHEAD_TOKENS;
      }
    };

    for (const group of pageGroups.values()) {
      const groupTokens = estimateBatchTokens(group);
      const groupPages = new Set(group.map((item) => item.pageId));

      // A single page larger than the budget is split by bubble, preserving
      // reading order, instead of being sent as one oversized request.
      if (groupTokens > tokenBudget || group.length > maxSegments) {
        flush();
        for (const chunk of splitPageSegments(group, tokenBudget, maxSegments)) {
          batches.push(chunk);
        }
        continue;
      }

      const pagesAfterAdd = new Set([...currentPages, ...groupPages]).size;
      if (
        current.length > 0 &&
        (pagesAfterAdd > batchPages ||
          currentTokens + (groupTokens - PROMPT_OVERHEAD_TOKENS) > tokenBudget ||
          current.length + group.length > maxSegments)
      ) {
        flush();
      }

      current.push(...group);
      for (const pageId of groupPages) currentPages.add(pageId);
      currentTokens += groupTokens - PROMPT_OVERHEAD_TOKENS;

      if (currentPages.size >= batchPages) flush();
    }
    flush();
  }

  return batches.map((segments, index) => ({
    id: `batch-${index + 1}`,
    segments,
    pageIndexes: [...new Set(segments.map((segment) => segment.pageIndex))],
    estimatedTokens: estimateBatchTokens(segments),
  }));
}

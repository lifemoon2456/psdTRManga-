export interface VisionPromptOptions {
  boxCount: number;
  sourceLang: string;
  targetLang: string;
  seriesContext?: SeriesContext;
}

export function buildVisionPrompts(options: VisionPromptOptions): {
  systemPrompt: string;
  userPrompt: string;
} {
  const { boxCount, sourceLang, targetLang, seriesContext } = options;
  const sourceDescription =
    sourceLang === "Auto-Detect"
      ? "the source language (detect it from the page)"
      : sourceLang;

  const systemPrompt = `You are a professional manga translator and letterer working from ${sourceDescription} into ${targetLang}.
You will receive a manga page with numbered red boxes. Each number identifies one text region.

Your job:
1. Read the original text inside every numbered box.
2. Translate it naturally into ${targetLang}, preserving tone, emotion, character voice, jokes, honorifics where they matter, and the flow of the scene.
3. For Japanese, remember that text may be vertical, right-to-left, or split across several lines. Read it in the correct order before translating.
4. Sound effects (SFX) should be translated as natural Arabic sound effects when they carry meaning. If a box contains only a visual sound effect with no dialogue, you may use a short Arabic equivalent.
5. Do not translate the box numbers themselves.

${seriesContext?.summary ? `Series context: ${seriesContext.summary}\n` : ""}${seriesContext?.dictionary ? `Term dictionary (use these consistently): ${seriesContext.dictionary}\n` : ""}

CRITICAL OUTPUT RULES:
- Return EXACTLY ${boxCount} translations, one per numbered box, in ascending box order.
- NEVER merge, drop, split, reorder, or add boxes.
- If a box is empty or illegible, return an empty string at that index.
- "sourceTexts" must contain the original text exactly as you read it, not the translation. If a box is empty or illegible, use "".
- The translations must be in ${targetLang}. Do not leave dialogue in ${sourceDescription}.
- Return valid JSON only. No markdown fences, no commentary.

JSON shape:
{
  "translations": ["...", "..."],
  "sourceTexts": ["...", "..."]
}`;

  const userPrompt = `The image contains ${boxCount} numbered boxes. Translate every box into ${targetLang} and return exactly ${boxCount} items in each array. Preserve the original order.`;

  return { systemPrompt, userPrompt };
}

export function buildCorrectionPrompt(boxCount: number, received: number): string {
  return `Your previous response contained ${received} translations, but exactly ${boxCount} are required. Return the complete corrected JSON with exactly ${boxCount} translations and ${boxCount} sourceTexts, one per numbered box, in order. Do not explain.`;
}

export interface TextBatchPromptOptions {
  sourceLang: string;
  targetLang: string;
  glossary?: string;
  seriesSummary?: string;
  segments: Array<{ id: string; text: string }>;
}

export interface TextBatchPrompts {
  systemPrompt: string;
  userPrompt: string;
}

function sourceDescription(sourceLang: string): string {
  return sourceLang === "Auto-Detect"
    ? "the source language (Japanese or English; infer it from the text)"
    : sourceLang;
}

/**
 * Compact, reusable prompt for ID-keyed text-only translation. The JSON itself
 * is in the user message so identical instructions can be cached by providers.
 */
export function buildTextBatchPrompts(options: TextBatchPromptOptions): TextBatchPrompts {
  const { sourceLang, targetLang, glossary, seriesSummary, segments } = options;
  const source = sourceDescription(sourceLang);
  const glossaryText = glossary?.trim();
  const summaryText = seriesSummary?.trim();

  const systemPrompt = `You are a professional manga translator working from ${source} into ${targetLang}.
Translate every input segment naturally, as dialogue lettered for a manga: preserve meaning, emotion, character voice, jokes, honorifics, and the flow between neighbouring segments.
Keep character names and terminology consistent. If a sentence is split across segments, translate each part so the connected sentence still reads naturally.
Never invent, delete, merge, split, reorder, or add segments. Empty input must stay empty.
Return JSON only. Do not include commentary, markdown, source text, or explanations.

The output must be exactly:
{"translations":[{"id":"the exact input id","translation":"Arabic translation"}]}
Every input id must appear exactly once. Do not translate the ids themselves.`;

  const userPrompt = [
    summaryText ? `Series/chapter context (reuse consistently):\n${summaryText}` : "",
    glossaryText ? `Glossary (source = target; follow it exactly):\n${glossaryText}` : "",
    `Target language: ${targetLang}.`,
    "Segments (ordered in manga reading order):",
    JSON.stringify({ segments }),
  ]
    .filter(Boolean)
    .join("\n\n");

  return { systemPrompt, userPrompt };
}

export function buildMissingIdsPrompt(missingIds: string[], receivedIds: string[]): string {
  return `Your previous response was incomplete or contained duplicate ids.
Missing ids: ${JSON.stringify(missingIds)}
Received ids: ${JSON.stringify(receivedIds)}
Return only the missing ids now, each exactly once, in this JSON shape:
{"translations":[{"id":"...","translation":"..."}]}
Do not repeat ids that were already translated. Do not add explanations.`;
}

/** Gemini-compatible OpenAPI subset schema for the ID-keyed response. */
export function buildTextBatchJsonSchema(): Record<string, unknown> {
  return {
    type: "OBJECT",
    properties: {
      translations: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            id: { type: "STRING" },
            translation: { type: "STRING" },
          },
          required: ["id", "translation"],
          propertyOrdering: ["id", "translation"],
        },
      },
    },
    required: ["translations"],
    propertyOrdering: ["translations"],
  };
}

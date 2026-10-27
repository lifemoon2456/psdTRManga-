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

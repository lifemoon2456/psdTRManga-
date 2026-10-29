import {
  ApiError,
  BatchTooLargeError,
  QuotaExhaustedError,
  type TokenUsage,
} from "./request-manager";

export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
}

export interface GeminiErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: unknown[];
  };
  promptFeedback?: {
    blockReason?: string;
  };
  candidates?: {
    finishReason?: string;
    content?: { parts?: { text?: string }[] };
  }[];
}

export function geminiEndpoint(baseUrl: string, model: string, action: string): string {
  const base = (baseUrl.trim() || "https://generativelanguage.googleapis.com/v1beta").replace(
    /\/+$/,
    "",
  );
  if (base.endsWith(":generateContent") || base.endsWith(":countTokens")) {
    return base.replace(/:(generateContent|countTokens)$/, `:${action}`);
  }
  return `${base}/models/${encodeURIComponent(model)}:${action}`;
}

export function normalizeGeminiUsage(metadata: GeminiUsageMetadata | undefined): TokenUsage | undefined {
  if (!metadata) return undefined;
  const prompt = Math.max(0, Math.round(metadata.promptTokenCount ?? 0));
  const candidates = Math.max(0, Math.round(metadata.candidatesTokenCount ?? 0));
  const total = Math.max(
    0,
    Math.round(metadata.totalTokenCount ?? prompt + candidates),
  );
  if (prompt === 0 && candidates === 0 && total === 0) return undefined;
  return {
    promptTokens: prompt,
    candidatesTokens: candidates,
    totalTokens: total || prompt + candidates,
  };
}

export function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function parseRetryDelayFromDetails(details: unknown): number | undefined {
  if (!Array.isArray(details)) return undefined;
  for (const detail of details) {
    if (!detail || typeof detail !== "object") continue;
    const record = detail as Record<string, unknown>;
    const retryDelay = record.retryDelay;
    if (typeof retryDelay === "string") {
      const match = retryDelay.match(/^([\d.]+)s$/);
      if (match) return Math.round(Number(match[1]) * 1000);
    }
    const violations = record.violations;
    if (Array.isArray(violations)) {
      for (const violation of violations) {
        if (!violation || typeof violation !== "object") continue;
        const quotaId = (violation as Record<string, unknown>).quotaId;
        if (typeof quotaId === "string" && /per.?day|daily|rpd/i.test(quotaId)) {
          return 24 * 60 * 60 * 1000;
        }
      }
    }
  }
  return undefined;
}

function isDailyQuotaMessage(message: string): boolean {
  return /quota.*(?:per\s*day|daily|rpd|day)|(?:per\s*day|daily|rpd).*quota|free.?tier.*day/i.test(
    message,
  );
}

export function isDailyQuotaError(body: GeminiErrorBody, status: number): boolean {
  if (status !== 429 && body.error?.status !== "RESOURCE_EXHAUSTED") return false;
  const serialized = JSON.stringify(body.error ?? {});
  return isDailyQuotaMessage(`${body.error?.message ?? ""} ${serialized}`);
}

export function geminiApiError(
  status: number,
  statusText: string,
  body: GeminiErrorBody,
  retryAfterHeader: string | null,
  rawText = "",
): ApiError {
  const message =
    body.error?.message ||
    statusText ||
    rawText.slice(0, 400) ||
    `Gemini API (${status})`;
  const retryAfterMs =
    parseRetryAfterMs(retryAfterHeader) ??
    parseRetryDelayFromDetails(body.error?.details);
  const dailyQuota = isDailyQuotaError(body, status);
  const tooLarge =
    status === 413 ||
    (status === 400 &&
      /token|too large|too many|context length|maximum.*(?:input|output)|request payload|exceeds/i.test(
        message,
      ));

  if (dailyQuota) {
    return new QuotaExhaustedError(
      `${message} — توقفت العملية مؤقتًا لحماية الحصة. الصفحات المكتملة محفوظة.`,
      { status, code: body.error?.status, retryAfterMs },
    );
  }
  if (tooLarge) {
    return new BatchTooLargeError(message, { status, code: body.error?.status });
  }

  const retryable =
    status === 408 ||
    status === 429 ||
    status >= 500 ||
    body.error?.status === "UNAVAILABLE" ||
    body.error?.status === "RESOURCE_EXHAUSTED";

  return new ApiError(message, {
    status,
    code: body.error?.status,
    retryable,
    retryAfterMs,
  });
}

export function extractGeminiText(body: GeminiErrorBody): string {
  return (body.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("")
    .trim();
}

export function geminiFinishReason(body: GeminiErrorBody): string {
  return body.candidates?.[0]?.finishReason ?? "";
}

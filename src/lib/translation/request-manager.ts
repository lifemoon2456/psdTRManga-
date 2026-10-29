/**
 * Client-side request scheduler for translation providers.
 *
 * There are deliberately no built-in free-tier numbers here. The user chooses
 * concurrency / RPM / TPM in settings, and 0 means "no local limit". The
 * scheduler only protects the user from accidental bursts and never rotates
 * API keys.
 */

export interface TokenUsage {
  promptTokens: number;
  candidatesTokens: number;
  totalTokens: number;
}

export interface RequestManagerConfig {
  maxConcurrent: number;
  /** Requests per minute. 0 disables the local limit. */
  rpm: number;
  /** Tokens per minute. 0 disables the local limit. */
  tpm: number;
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_REQUEST_CONFIG: RequestManagerConfig = {
  maxConcurrent: 1,
  rpm: 0,
  tpm: 0,
  maxRetries: 4,
  baseDelayMs: 900,
  maxDelayMs: 30_000,
};

export interface RequestManagerStats {
  requests: number;
  successfulRequests: number;
  failedRequests: number;
  retries: number;
  promptTokens: number;
  candidatesTokens: number;
  totalTokens: number;
  estimatedTokens: number;
  lastError: string;
  activeRequests: number;
  queuedRequests: number;
  quotaPausedUntil: number | null;
  quotaReason: string;
}

export interface AttemptResult<T> {
  data: T;
  usage?: TokenUsage;
}

export interface ApiErrorOptions {
  status?: number;
  code?: string;
  retryable?: boolean;
  dailyQuota?: boolean;
  retryAfterMs?: number;
  batchTooLarge?: boolean;
  usage?: TokenUsage;
  cause?: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly dailyQuota: boolean;
  readonly retryAfterMs: number | undefined;
  readonly batchTooLarge: boolean;
  readonly usage: TokenUsage | undefined;

  constructor(message: string, options: ApiErrorOptions = {}) {
    super(message);
    this.name = "ApiError";
    this.status = options.status ?? 0;
    this.code = options.code ?? "";
    this.retryable = options.retryable ?? false;
    this.dailyQuota = options.dailyQuota ?? false;
    this.retryAfterMs = options.retryAfterMs;
    this.batchTooLarge = options.batchTooLarge ?? false;
    this.usage = options.usage;
    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export class QuotaExhaustedError extends ApiError {
  constructor(message: string, options: ApiErrorOptions = {}) {
    super(message, { ...options, dailyQuota: true, retryable: false });
    this.name = "QuotaExhaustedError";
  }
}

export class BatchTooLargeError extends ApiError {
  constructor(message: string, options: ApiErrorOptions = {}) {
    super(message, { ...options, batchTooLarge: true, retryable: false });
    this.name = "BatchTooLargeError";
  }
}

export class RequestAbortedError extends Error {
  constructor(message = "تم إيقاف الطلب.") {
    super(message);
    this.name = "AbortError";
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    error instanceof RequestAbortedError
  );
}

export interface RequestManagerOptions {
  config?: Partial<RequestManagerConfig>;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

interface QueueItem {
  estimatedTokens: number;
  signal?: AbortSignal;
  attempt: (signal: AbortSignal) => Promise<AttemptResult<unknown>>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

interface TokenReservation {
  at: number;
  tokens: number;
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RequestAbortedError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, milliseconds));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RequestAbortedError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export class RequestManager {
  private config: RequestManagerConfig;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;

  private queue: QueueItem[] = [];
  private active = 0;
  private pumping = false;
  private activeWaiters: Array<() => void> = [];
  private rateChain: Promise<unknown> = Promise.resolve();
  private requestTimes: number[] = [];
  private tokenWindow: TokenReservation[] = [];
  private pausedUntil = 0;
  private quotaReason = "";
  private quotaExhausted = false;
  private aborted = false;
  private abortReason = "";

  private stats: RequestManagerStats = {
    requests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    retries: 0,
    promptTokens: 0,
    candidatesTokens: 0,
    totalTokens: 0,
    estimatedTokens: 0,
    lastError: "",
    activeRequests: 0,
    queuedRequests: 0,
    quotaPausedUntil: null,
    quotaReason: "",
  };

  private listeners = new Set<(stats: RequestManagerStats) => void>();

  constructor(options: RequestManagerOptions = {}) {
    this.config = { ...DEFAULT_REQUEST_CONFIG, ...options.config };
    this.config.maxConcurrent = clampInteger(this.config.maxConcurrent, 1, 8);
    this.config.rpm = Math.max(0, this.config.rpm || 0);
    this.config.tpm = Math.max(0, this.config.tpm || 0);
    this.config.maxRetries = clampInteger(this.config.maxRetries, 0, 10);
    this.config.baseDelayMs = Math.max(1, this.config.baseDelayMs || 900);
    this.config.maxDelayMs = Math.max(this.config.baseDelayMs, this.config.maxDelayMs || 30_000);
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
  }

  updateConfig(config: Partial<RequestManagerConfig>): void {
    this.config = { ...this.config, ...config };
    this.config.maxConcurrent = clampInteger(this.config.maxConcurrent, 1, 8);
    this.config.rpm = Math.max(0, this.config.rpm || 0);
    this.config.tpm = Math.max(0, this.config.tpm || 0);
    this.config.maxRetries = clampInteger(this.config.maxRetries, 0, 10);
    this.config.baseDelayMs = Math.max(1, this.config.baseDelayMs || 900);
    this.config.maxDelayMs = Math.max(this.config.baseDelayMs, this.config.maxDelayMs || 30_000);
    this.notify();
  }

  getConfig(): RequestManagerConfig {
    return { ...this.config };
  }

  snapshot(): RequestManagerStats {
    return {
      ...this.stats,
      activeRequests: this.active,
      queuedRequests: this.queue.length,
      quotaPausedUntil: this.quotaExhausted ? this.pausedUntil : null,
      quotaReason: this.quotaReason,
    };
  }

  subscribe(listener: (stats: RequestManagerStats) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  resetStats(): void {
    this.stats = {
      requests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      retries: 0,
      promptTokens: 0,
      candidatesTokens: 0,
      totalTokens: 0,
      estimatedTokens: 0,
      lastError: "",
      activeRequests: this.active,
      queuedRequests: this.queue.length,
      quotaPausedUntil: null,
      quotaReason: "",
    };
    this.notify();
  }

  resume(): void {
    this.quotaExhausted = false;
    this.pausedUntil = 0;
    this.quotaReason = "";
    this.aborted = false;
    this.abortReason = "";
    this.notify();
    this.pump();
  }

  abortPending(reason = "تم إيقاف العملية."): void {
    this.aborted = true;
    this.abortReason = reason;
    const error = new RequestAbortedError(reason);
    this.rejectQueue(error);
    this.notify();
  }

  execute<T>(
    estimatedTokens: number,
    attempt: (signal: AbortSignal) => Promise<AttemptResult<T>>,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    const signal = options.signal;
    if (signal?.aborted) {
      return Promise.reject(new RequestAbortedError());
    }
    if (this.aborted) {
      return Promise.reject(new RequestAbortedError(this.abortReason));
    }
    if (this.quotaExhausted) {
      return Promise.reject(
        new QuotaExhaustedError(this.quotaReason || "تم استنفاد حصة الطلبات اليومية."),
      );
    }

    return new Promise<T>((resolve, reject) => {
      const item: QueueItem = {
        estimatedTokens: Math.max(1, Math.round(estimatedTokens)),
        signal,
        attempt: attempt as (signal: AbortSignal) => Promise<AttemptResult<unknown>>,
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      this.queue.push(item);
      this.notify();
      this.pump();
    });
  }

  private notify(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // A UI listener must never break the scheduler.
      }
    }
  }

  private rejectQueue(error: unknown): void {
    const queued = this.queue;
    this.queue = [];
    for (const item of queued) item.reject(error);
  }

  private waitForActiveChange(): Promise<void> {
    return new Promise((resolve) => {
      this.activeWaiters.push(resolve);
    });
  }

  private releaseActiveWaiter(): void {
    const waiters = this.activeWaiters;
    this.activeWaiters = [];
    for (const waiter of waiters) waiter();
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    void (async () => {
      try {
        while (this.queue.length > 0) {
          if (this.aborted) {
            this.rejectQueue(new RequestAbortedError(this.abortReason));
            break;
          }
          if (this.quotaExhausted) {
            this.rejectQueue(
              new QuotaExhaustedError(this.quotaReason || "تم استنفاد حصة الطلبات اليومية."),
            );
            break;
          }
          if (this.active >= this.config.maxConcurrent) {
            await this.waitForActiveChange();
            continue;
          }

          const item = this.queue.shift();
          if (!item) break;
          if (item.signal?.aborted) {
            item.reject(new RequestAbortedError());
            continue;
          }

          this.active++;
          this.notify();
          void this.runItem(item)
            .catch(() => {
              // runItem already rejects the caller's promise.
            })
            .finally(() => {
              this.active = Math.max(0, this.active - 1);
              this.notify();
              this.releaseActiveWaiter();
              this.pump();
            });
        }
      } finally {
        this.pumping = false;
      }
    })();
  }

  private async runItem(item: QueueItem): Promise<void> {
    let attempts = 0;
    while (true) {
      if (this.aborted) throw new RequestAbortedError(this.abortReason);
      if (item.signal?.aborted) throw new RequestAbortedError();
      await this.waitWhilePaused(item.signal);

      const reservation = await this.acquireRateSlot(item.estimatedTokens, item.signal);
      attempts++;
      this.stats.requests++;
      this.notify();

      try {
        const signal = item.signal ?? new AbortController().signal;
        const result = await item.attempt(signal);
        this.finishReservation(reservation, result.usage);
        this.recordUsage(result.usage, item.estimatedTokens);
        this.stats.successfulRequests++;
        this.stats.lastError = "";
        this.notify();
        item.resolve(result.data);
        return;
      } catch (error) {
        const apiError = this.normalizeError(error);
        this.finishReservation(reservation, apiError.usage);

        if (isAbortError(error) || item.signal?.aborted) {
          item.reject(new RequestAbortedError());
          return;
        }

        if (apiError.dailyQuota || apiError instanceof QuotaExhaustedError) {
          this.pauseForQuota(apiError);
          item.reject(apiError);
          return;
        }

        if (apiError.retryable && attempts <= this.config.maxRetries) {
          this.stats.retries++;
          const delay =
            apiError.retryAfterMs ??
            this.backoffDelay(attempts);
          this.stats.lastError = apiError.message;
          this.notify();
          await this.sleep(delay, item.signal);
          continue;
        }

        this.stats.failedRequests++;
        this.stats.lastError = apiError.message;
        this.notify();
        item.reject(apiError);
        return;
      }
    }
  }

  private normalizeError(error: unknown): ApiError {
    if (error instanceof ApiError) return error;
    if (isAbortError(error)) {
      return new ApiError("تم إيقاف الطلب.", { retryable: false, cause: error });
    }
    const message = error instanceof Error ? error.message : String(error);
    return new ApiError(message || "تعذّر الاتصال بمزود الترجمة.", {
      retryable: true,
      cause: error,
    });
  }

  private backoffDelay(attempt: number): number {
    const exponential = this.config.baseDelayMs * 2 ** Math.max(0, attempt - 1);
    const jitter = 0.5 + this.random() * 0.5;
    return Math.min(this.config.maxDelayMs, Math.round(exponential * jitter));
  }

  private async waitWhilePaused(signal?: AbortSignal): Promise<void> {
    if (!this.quotaExhausted) return;
    const remaining = this.pausedUntil - this.now();
    if (remaining > 0) {
      throw new QuotaExhaustedError(
        this.quotaReason || "تم استنفاد حصة الطلبات اليومية. أكمل لاحقًا.",
        { retryAfterMs: remaining },
      );
    }
    this.quotaExhausted = false;
    this.quotaReason = "";
    this.notify();
  }

  private acquireRateSlot(
    estimatedTokens: number,
    signal?: AbortSignal,
  ): Promise<TokenReservation> {
    const run = async (): Promise<TokenReservation> => {
      await this.waitForRpm(signal);
      await this.waitForTpm(estimatedTokens, signal);
      const reservation: TokenReservation = {
        at: this.now(),
        tokens: Math.max(1, Math.round(estimatedTokens)),
      };
      this.tokenWindow.push(reservation);
      this.stats.estimatedTokens += reservation.tokens;
      this.notify();
      return reservation;
    };

    const chained = this.rateChain.then(run, run);
    this.rateChain = chained.then(
      () => undefined,
      () => undefined,
    );
    return chained;
  }

  private async waitForRpm(signal?: AbortSignal): Promise<void> {
    if (this.config.rpm <= 0) return;
    while (true) {
      if (signal?.aborted) throw new RequestAbortedError();
      const now = this.now();
      this.requestTimes = this.requestTimes.filter((time) => now - time < 60_000);
      if (this.requestTimes.length < this.config.rpm) {
        this.requestTimes.push(now);
        return;
      }
      const wait = 60_000 - (now - this.requestTimes[0]) + 10;
      await this.sleep(wait, signal);
    }
  }

  private async waitForTpm(estimatedTokens: number, signal?: AbortSignal): Promise<void> {
    if (this.config.tpm <= 0) return;
    const reserve = Math.min(Math.max(1, estimatedTokens), this.config.tpm);
    while (true) {
      if (signal?.aborted) throw new RequestAbortedError();
      const now = this.now();
      this.tokenWindow = this.tokenWindow.filter((entry) => now - entry.at < 60_000);
      const used = this.tokenWindow.reduce((sum, entry) => sum + entry.tokens, 0);
      if (used + reserve <= this.config.tpm || this.tokenWindow.length === 0) return;
      const oldest = this.tokenWindow[0];
      const wait = Math.max(50, 60_000 - (now - oldest.at) + 10);
      await this.sleep(wait, signal);
    }
  }

  private finishReservation(reservation: TokenReservation, usage?: TokenUsage): void {
    if (!usage) return;
    const actual = usage.totalTokens > 0 ? usage.totalTokens : reservation.tokens;
    reservation.tokens = actual;
  }

  private recordUsage(usage: TokenUsage | undefined, estimatedTokens: number): void {
    if (!usage) {
      this.stats.totalTokens += estimatedTokens;
      return;
    }
    this.stats.promptTokens += usage.promptTokens;
    this.stats.candidatesTokens += usage.candidatesTokens;
    this.stats.totalTokens += usage.totalTokens;
  }

  private pauseForQuota(error: ApiError): void {
    const retryAfter = error.retryAfterMs && error.retryAfterMs > 0 ? error.retryAfterMs : 3_600_000;
    this.pausedUntil = this.now() + retryAfter;
    this.quotaReason = error.message || "تم استنفاد حصة الطلبات اليومية.";
    this.quotaExhausted = true;
    this.stats.quotaPausedUntil = this.pausedUntil;
    this.stats.quotaReason = this.quotaReason;
    this.rejectQueue(new QuotaExhaustedError(this.quotaReason, { retryAfterMs: retryAfter }));
    this.notify();
  }
}

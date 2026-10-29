import assert from "node:assert/strict";
import test from "node:test";
import {
  ApiError,
  QuotaExhaustedError,
  RequestAbortedError,
  RequestManager,
  isAbortError,
} from "../src/lib/translation/request-manager";

test("default concurrency is one and configurable concurrency is respected", async () => {
  let active = 0;
  let maximum = 0;
  const manager = new RequestManager({
    config: { maxConcurrent: 2, maxRetries: 0 },
  });
  const task = () =>
    manager.execute(10, async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return { data: true };
    });

  await Promise.all([task(), task(), task(), task()]);
  assert.equal(maximum, 2);
  assert.equal(manager.snapshot().requests, 4);
  assert.equal(manager.snapshot().successfulRequests, 4);
});

test("a daily quota response pauses the manager and rejects queued work", async () => {
  const manager = new RequestManager({
    config: { maxConcurrent: 1, maxRetries: 4 },
  });
  await assert.rejects(
    manager.execute(10, async () => {
      throw new QuotaExhaustedError("quota exhausted", {
        status: 429,
        retryAfterMs: 60_000,
      });
    }),
    QuotaExhaustedError,
  );
  assert.ok((manager.snapshot().quotaPausedUntil ?? 0) > Date.now());
  await assert.rejects(
    manager.execute(10, async () => ({ data: true })),
    QuotaExhaustedError,
  );
});

test("aborting a queued or in-flight request returns AbortError", async () => {
  const manager = new RequestManager({
    config: { maxConcurrent: 1, maxRetries: 0 },
  });
  const controller = new AbortController();
  const pending = manager.execute(
    10,
    async (signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new RequestAbortedError()), {
          once: true,
        });
      }),
    { signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, (error) => isAbortError(error));
});

test("non-retryable 401 is not retried", async () => {
  const manager = new RequestManager({
    config: { maxConcurrent: 1, maxRetries: 5, baseDelayMs: 1 },
  });
  let calls = 0;
  await assert.rejects(
    manager.execute(10, async () => {
      calls++;
      throw new ApiError("invalid key", { status: 401, retryable: false });
    }),
  );
  assert.equal(calls, 1);
  assert.equal(manager.snapshot().failedRequests, 1);
});

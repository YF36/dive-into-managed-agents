/**
 * 简单指数退避重试,只重试 529 / 503 / 504 / network。
 *
 * 不重试 400 / 401 / 403 / 404 / 422 / 429——这些是确定性错误,重试只会浪费 quota。
 * 429 即便有 retry-after,本测试套件也不让它自动重试,以免掩盖 rate-limit 信号。
 */

const RETRYABLE_STATUSES = new Set([502, 503, 504, 529]);

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelay = options.baseDelayMs ?? 500;
  const maxDelay = options.maxDelayMs ?? 5_000;

  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || i === attempts - 1) throw err;
      const delay = Math.min(maxDelay, baseDelay * 2 ** i);
      await sleep(delay);
    }
  }
  throw lastError;
}

function isRetryable(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const status = (err as { status?: number; statusCode?: number }).status
    ?? (err as { statusCode?: number }).statusCode;
  if (typeof status === "number") return RETRYABLE_STATUSES.has(status);
  const code = (err as { code?: string }).code;
  if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ECONNREFUSED") return true;
  return false;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

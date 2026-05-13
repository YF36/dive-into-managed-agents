/**
 * Latency 计量 helper。Phase 4 起 perf test 主要使用。
 *
 * 用法:
 *   const stats = await measureLatency(() => client.beta.agents.list(), 100);
 *   console.log(stats.p50, stats.p95, stats.p99);
 */

export interface LatencyStats {
  n: number;
  mean: number;
  std: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
}

export async function measureLatency<T>(
  fn: () => Promise<T>,
  n = 100,
  warmup = 5,
): Promise<LatencyStats> {
  for (let i = 0; i < warmup; i++) await fn();
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  return summarize(samples);
}

export function summarize(samples: number[]): LatencyStats {
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) {
    return { n: 0, mean: NaN, std: NaN, p50: NaN, p95: NaN, p99: NaN, min: NaN, max: NaN };
  }
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const variance = sorted.reduce((acc, x) => acc + (x - mean) ** 2, 0) / n;
  return {
    n,
    mean,
    std: Math.sqrt(variance),
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    min: sorted[0] ?? NaN,
    max: sorted[n - 1] ?? NaN,
  };
}

/**
 * Nearest-rank percentile(L2 修复:之前用 floor 偏移一位 —— p95 在 n=100 时
 * 取 sorted[95],即第 96 个值,实际应该是第 95 个值 sorted[94])。
 *
 * 公式:idx = ceil(p * n) - 1,clamp 到 [0, n-1]。
 * 例:n=100, p=0.95 → ceil(95)-1 = 94 → sorted[94](0-indexed 第 95 个值)
 *     n=100, p=0.50 → ceil(50)-1 = 49 → sorted[49]
 *     n=100, p=0.99 → ceil(99)-1 = 98 → sorted[98]
 */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return NaN;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1));
  return sortedAsc[idx] ?? NaN;
}

export function startTimer(): () => number {
  const t0 = performance.now();
  return () => performance.now() - t0;
}

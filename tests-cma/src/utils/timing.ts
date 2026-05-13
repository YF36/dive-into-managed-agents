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

function percentile(sortedAsc: number[], p: number): number {
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.floor(p * sortedAsc.length)));
  return sortedAsc[idx] ?? NaN;
}

export function startTimer(): () => number {
  const t0 = performance.now();
  return () => performance.now() - t0;
}

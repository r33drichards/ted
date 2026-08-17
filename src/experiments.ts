/**
 * Pure autoresearch logic: METRIC parsing and keep/discard verdicts.
 * No I/O — shared by the autoresearch workflow (bundled) and activities.
 */

export type Direction = 'min' | 'max';
export type Verdict = 'baseline' | 'keep' | 'discard' | 'crash';

/** Extract values from `METRIC <name>=<value>` lines in program output. */
export function parseMetricValues(output: string, metricName: string): number[] {
  const values: number[] = [];
  const re = new RegExp(
    `^\\s*METRIC\\s+${metricName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\s*$`,
    'gm',
  );
  for (const m of output.matchAll(re)) {
    const v = Number(m[1]);
    if (Number.isFinite(v)) values.push(v);
  }
  return values;
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Median absolute deviation — robust noise estimate. */
export function mad(xs: number[]): number {
  if (xs.length === 0) return 0;
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
}

/**
 * Decide a run's verdict against the current best.
 * A keep requires improvement in the right direction beyond the noise
 * threshold: max(MAD of the samples, 1% of |best|).
 */
export function decideVerdict(
  samples: number[],
  best: number | null,
  direction: Direction,
): { verdict: Verdict; value: number | null } {
  if (samples.length === 0) return { verdict: 'crash', value: null };
  const value = median(samples);
  if (best === null) return { verdict: 'baseline', value };
  const threshold = Math.max(mad(samples), Math.abs(best) * 0.01);
  const improvement = direction === 'min' ? best - value : value - best;
  return { verdict: improvement > threshold ? 'keep' : 'discard', value };
}

/** One-line IRC status for an iteration. */
export function formatRunLine(
  iteration: number,
  verdict: Verdict,
  value: number | null,
  best: number | null,
  unit: string,
  description: string,
): string {
  const fmt = (v: number | null) => (v === null ? '—' : `${Number(v.toFixed(4))}${unit}`);
  const desc = description.length > 120 ? description.slice(0, 120) + '…' : description;
  return `#${iteration} ${verdict} ${fmt(value)} (best ${fmt(best)}) — ${desc}`;
}

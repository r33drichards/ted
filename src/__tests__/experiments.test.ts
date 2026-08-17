import { describe, it, expect } from 'vitest';
import { parseMetricValues, median, mad, decideVerdict, formatRunLine } from '../experiments.js';

describe('parseMetricValues', () => {
  it('extracts values for the named metric only', () => {
    const out = 'setup done\nMETRIC time_ms=123.5\nMETRIC other=9\nMETRIC time_ms=130\n';
    expect(parseMetricValues(out, 'time_ms')).toEqual([123.5, 130]);
  });

  it('handles scientific notation and negatives', () => {
    expect(parseMetricValues('METRIC x=-1.5e3', 'x')).toEqual([-1500]);
  });

  it('returns empty on no matches', () => {
    expect(parseMetricValues('no metrics here', 'x')).toEqual([]);
  });

  it('escapes regex metacharacters in the metric name', () => {
    expect(parseMetricValues('METRIC a.b=2', 'a.b')).toEqual([2]);
    expect(parseMetricValues('METRIC aXb=2', 'a.b')).toEqual([]);
  });
});

describe('median/mad', () => {
  it('median of odd and even lengths', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('mad is robust to one outlier', () => {
    expect(mad([10, 10, 10, 100])).toBe(0);
  });
});

describe('decideVerdict', () => {
  it('crash when no samples', () => {
    expect(decideVerdict([], 100, 'min')).toEqual({ verdict: 'crash', value: null });
  });

  it('baseline when no best yet', () => {
    expect(decideVerdict([100, 102, 98], null, 'min')).toEqual({ verdict: 'baseline', value: 100 });
  });

  it('keeps a clear improvement (min)', () => {
    expect(decideVerdict([80, 81, 79], 100, 'min').verdict).toBe('keep');
  });

  it('discards a regression (min)', () => {
    expect(decideVerdict([120, 121, 119], 100, 'min').verdict).toBe('discard');
  });

  it('discards noise-level improvement', () => {
    // Improvement of 0.5 on best=100 is below the 1% threshold.
    expect(decideVerdict([99.5, 99.5, 99.5], 100, 'min').verdict).toBe('discard');
  });

  it('keeps a clear improvement (max)', () => {
    expect(decideVerdict([120, 119, 121], 100, 'max').verdict).toBe('keep');
  });
});

describe('formatRunLine', () => {
  it('formats a keep line', () => {
    const line = formatRunLine(12, 'keep', 143, 143, 'ms', 'memoize inner loop');
    expect(line).toBe('#12 keep 143ms (best 143ms) — memoize inner loop');
  });
});

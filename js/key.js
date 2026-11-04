/* Key detection: Krumhansl-Schmuckler profile correlation over a pitch-class
 * histogram. Pure logic, no DOM. */

const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function correlation(a, b) {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da === 0 || db === 0 ? 0 : num / Math.sqrt(da * db);
}

/** Accumulates how long the voice spent on each pitch class. */
export class PitchClassHistogram {
  constructor() { this.bins = new Float64Array(12); this.total = 0; }
  add(midiFloat, weight = 1) {
    const pc = (((Math.round(midiFloat) % 12) + 12) % 12);
    this.bins[pc] += weight;
    this.total += weight;
  }
  reset() { this.bins.fill(0); this.total = 0; }
}

/**
 * Best major or natural-minor key for a 12-bin histogram.
 * Returns {key: 0..11, scale: 'Major' | 'Natural Minor', score} or null when
 * the histogram is empty or uses fewer than three distinct pitch classes.
 */
export function detectKey(bins) {
  const used = Array.from(bins).filter(v => v > 0).length;
  if (used < 3) return null;
  let best = null;
  for (let root = 0; root < 12; root++) {
    for (const [scale, profile] of [['Major', MAJOR], ['Natural Minor', MINOR]]) {
      const rotated = profile.map((_, i) => profile[(i - root + 12) % 12]);
      const score = correlation(Array.from(bins), rotated);
      if (!best || score > best.score) best = { key: root, scale, score };
    }
  }
  return best;
}

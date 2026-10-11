/* Adversarial YIN evaluation: voice-like signals -> accuracy, octave errors, jitter, latency.
 * Run: node tests/eval-pitch.js */
import { yinDetect, freqToMidiFloat } from '../js/pitch.js';

const SR = 48000, N = 2048;
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

// Voice-like: harmonic stack + vibrato + tremolo + breath noise.
function voice(f0, n, { vibratoCents = 0, vibRate = 5.5, noiseAmt = 0.0, phase0 = 0 } = {}) {
  const f = new Float32Array(n);
  const harms = [1, 0.55, 0.3, 0.16, 0.08, 0.04];
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const vib = vibratoCents ? (vibratoCents / 100) * Math.sin(2 * Math.PI * vibRate * t + phase0) : 0;
    const fm = Math.pow(2, vib / 12);
    let s = 0;
    for (let h = 1; h <= harms.length; h++) {
      s += harms[h - 1] * Math.sin(2 * Math.PI * f0 * fm * h * t + phase0 * h);
    }
    const trem = 1 - 0.06 * Math.sin(2 * Math.PI * 4.7 * t);
    s = s * 0.35 * trem;
    if (noiseAmt) s += (rnd() * 2 - 1) * noiseAmt;
    f[i] = s;
  }
  return f;
}
const centsErr = (det, f0) => det ? (freqToMidiFloat(det.freq) - freqToMidiFloat(f0)) * 100 : null;

console.log('--- accuracy: voice-like tones, 8 pitches x 12 phases ---');
{
  let errs = [], octaves = 0, total = 0, nulls = 0;
  for (const f0 of [82.4, 110, 146.8, 196, 261.6, 349.2, 440, 587.3]) {
    for (let p = 0; p < 12; p++) {
      const det = yinDetect(voice(f0, N, { vibratoCents: 18, noiseAmt: 0.012, phase0: p * 0.7 }), SR);
      total++;
      const e = centsErr(det, f0);
      if (e === null) { nulls++; continue; }
      errs.push(Math.abs(e));
      if (Math.abs(e) > 600) octaves++;
    }
  }
  errs.sort((a, b) => a - b);
  const med = errs[Math.floor(errs.length / 2)];
  const p95 = errs[Math.floor(errs.length * 0.95)];
  console.log(`  frames=${total} nulls=${nulls} octaveErrors=${octaves}`);
  console.log(`  medianAbsErr=${med.toFixed(1)}c p95=${p95.toFixed(1)}c`);
}

console.log('--- jitter: steady 220 Hz voice, frame-to-frame cents stddev ---');
{
  const cents = [];
  for (let p = 0; p < 40; p++) {
    const det = yinDetect(voice(220, N, { phase0: p * 1.3, noiseAmt: 0.008 }), SR);
    if (det) cents.push(freqToMidiFloat(det.freq) * 100);
  }
  const mean = cents.reduce((a, b) => a + b, 0) / cents.length;
  const sd = Math.sqrt(cents.reduce((a, b) => a + (b - mean) ** 2, 0) / cents.length);
  const deltas = [];
  for (let i = 1; i < cents.length; i++) deltas.push(Math.abs(cents[i] - cents[i-1]));
  deltas.sort((a,b)=>a-b);
  console.log(`  frames=${cents.length} jitterSD=${sd.toFixed(1)}c medianFrameDelta=${deltas[Math.floor(deltas.length/2)].toFixed(1)}c maxDelta=${deltas[deltas.length-1].toFixed(1)}c`);
}

console.log('--- octave stress: low notes with strong 2nd harmonic ---');
{
  let oct = 0, tot = 0;
  for (const f0 of [65.4, 73.4, 82.4, 98]) {
    for (let p = 0; p < 10; p++) {
      // emphasize 2nd harmonic to bait octave-up errors
      const f = voice(f0, N, { phase0: p });
      for (let i = 0; i < N; i++) f[i] += 0.5 * 0.35 * Math.sin(2 * Math.PI * 2 * f0 * i / SR);
      const det = yinDetect(f, SR);
      const e = centsErr(det, f0);
      tot++;
      if (e !== null && Math.abs(e) > 600) oct++;
    }
  }
  console.log(`  octaveUpErrors=${oct}/${tot}`);
}

console.log('--- detection latency: frames from onset to first confident hit ---');
{
  const lats = [];
  for (let trial = 0; trial < 10; trial++) {
    const sig = voice(330, N * 8, { phase0: trial });
    let found = -1;
    for (let k = 0; k < 7; k++) {
      const frame = sig.slice(k * 1024, k * 1024 + N);
      const det = yinDetect(frame, SR);
      if (det && det.clarity >= 0.72) { found = k; break; }
    }
    lats.push(found);
  }
  console.log(`  framesToDetect(min/median/max 1024-hop): ${Math.min(...lats)}/${lats.sort()[5]}/${Math.max(...lats)}`);
}

console.log('--- breathy/whispery voice (weak fundamental) ---');
{
  let ok = 0, tot = 0;
  for (let p = 0; p < 12; p++) {
    // weak fundamental, strong breath noise -> hard case
    const f = voice(196, N, { noiseAmt: 0.05, phase0: p * 0.9 });
    for (let i = 0; i < N; i++) f[i] *= 0.5;
    const det = yinDetect(f, SR);
    const e = centsErr(det, 196);
    tot++;
    if (e !== null && Math.abs(e) < 50) ok++;
  }
  console.log(`  within50c=${ok}/${tot}`);
}

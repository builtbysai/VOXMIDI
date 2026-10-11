/* VOXMIDI DSP unit tests — run with: node tests/test-dsp.js
 * Synthesized waveforms -> expected MIDI notes, drum classes, SMF bytes.
 * The sandbox has no microphone, so this is how the pitch math gets proven. */
import {
  yinDetect, freqToMidiFloat, midiToName, frameRMS, NoteTracker,
} from '../js/pitch.js';
import { velocityGain, breathCurve } from '../js/engine.js';
import { fftMagnitudes, spectralCentroid, classifyHit, OnsetDetector } from '../js/drums.js';
import { eventsToSMF, inspectSMF } from '../js/midifile.js';

const SR = 48000;
let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
}
function sine(freq, n, amp = 0.5, phase = 0) {
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = amp * Math.sin(2 * Math.PI * freq * i / SR + phase);
  return f;
}
function noise(n, amp = 0.5) {
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = (Math.random() * 2 - 1) * amp;
  return f;
}
function lowpass(x, cutoff) {
  const a = 1 - Math.exp((-2 * Math.PI * cutoff) / SR);
  const y = new Float32Array(x.length);
  let s = 0;
  for (let i = 0; i < x.length; i++) { s += a * (x[i] - s); y[i] = s; }
  return y;
}
function highpass(x, cutoff) {
  const a = Math.exp((-2 * Math.PI * cutoff) / SR);
  const y = new Float32Array(x.length);
  let s = 0, px = 0;
  for (let i = 0; i < x.length; i++) { s = a * (s + x[i] - px); px = x[i]; y[i] = s; }
  return y;
}

console.log('YIN pitch detection');
{
  const cases = [
    [440.0, 69, 'A4'], [261.63, 60, 'C4'], [880.0, 81, 'A5'],
    [1174.66, 86, 'D6'], [110.0, 45, 'A2'], [196.0, 55, 'G3'],
    [329.63, 64, 'E4'], [523.25, 72, 'C5'],
  ];
  for (const [freq, midi, name] of cases) {
    const det = yinDetect(sine(freq, 2048), SR);
    const got = det ? Math.round(freqToMidiFloat(det.freq)) : null;
    check(`${freq} Hz -> MIDI ${midi} (${name})`, got === midi,
      `got ${got} (freq ${det?.freq?.toFixed(1)}, clarity ${det?.clarity?.toFixed(2)})`);
  }
  // Whistle-like: fundamental + harmonics, vibrato-ish.
  const w = new Float32Array(2048);
  for (let i = 0; i < 2048; i++) {
    w[i] = 0.5 * Math.sin(2 * Math.PI * 1200 * i / SR)
         + 0.15 * Math.sin(2 * Math.PI * 2400 * i / SR)
         + 0.05 * Math.sin(2 * Math.PI * 3600 * i / SR);
  }
  const dw = yinDetect(w, SR);
  check('whistle 1200 Hz + harmonics -> MIDI 86 (D6)',
    dw && Math.round(freqToMidiFloat(dw.freq)) === 86,
    `got ${dw && Math.round(freqToMidiFloat(dw.freq))}`);
  // Slightly detuned: 445 Hz should still read as A4 with positive cents.
  const dd = yinDetect(sine(445, 2048), SR);
  const cents = dd ? (freqToMidiFloat(dd.freq) - 69) * 100 : null;
  check('445 Hz -> A4, +20 cents', dd && Math.round(freqToMidiFloat(dd.freq)) === 69
    && cents > 10 && cents < 35, `cents=${cents?.toFixed(1)}`);
  // Noise and silence: no confident pitch.
  check('white noise -> null', yinDetect(noise(2048, 0.4), SR) === null);
  check('silence -> null', yinDetect(new Float32Array(2048), SR) === null);
  check('frameRMS(silence) == 0', frameRMS(new Float32Array(2048)) === 0);
  check('midiToName(69) == A4', midiToName(69) === 'A4');
  check('midiToName(60) == C4', midiToName(60) === 'C4');
}

console.log('NoteTracker state machine');
{
  const evts = [];
  const tr = new NoteTracker({
    onNoteOn: (m, v) => evts.push(['on', m, v]),
    onNoteOff: (m) => evts.push(['off', m]),
    onPitch: () => {},
  }, { gate: 0.01, onsetFrames: 3, changeFrames: 2, releaseFrames: 5 });
  const det = (f) => yinDetect(sine(f, 2048, 0.3), SR);
  const tick = (d, rms) => tr.process(d, rms);
  for (let i = 0; i < 6; i++) tick(null, 0.0);          // silence
  for (let i = 0; i < 6; i++) tick(det(440), 0.2);      // A4
  for (let i = 0; i < 5; i++) tick(det(523.25), 0.2);   // C5
  for (let i = 0; i < 8; i++) tick(null, 0.0);          // silence
  const seq = evts.map(e => e[0] + e[1]).join(' ');
  check('A4 on, change to C5, then off', seq === 'on69 off69 on72 off72', `got: ${seq}`);
  check('velocity in 1..127', evts.every(e => e[0] !== 'on' || (e[2] >= 1 && e[2] <= 127)));
  // Flutter resistance: alternating 440/466 for single frames must not retrigger.
  evts.length = 0; tr.reset();
  for (let i = 0; i < 6; i++) tick(det(440), 0.2);
  for (let i = 0; i < 10; i++) tick(det(i % 2 ? 466.16 : 440), 0.2);
  const ons = evts.filter(e => e[0] === 'on');
  check('single-frame wobble does not retrigger', ons.length === 1, `ons=${ons.length}`);
}

console.log('Drum classifier');
{
  // Partial-based synthesis: deterministic spectral content per class.
  const partials = (comps, decay) => {
    const f = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const t = i / SR;
      let s = 0;
      for (const [fr, a] of comps) s += a * Math.sin(2 * Math.PI * fr * t + fr);
      f[i] = s * Math.exp(-t * decay);
    }
    return f;
  };
  let rnd = 42;
  const rand = () => (rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const spread = (lo, hi, n, a) => {
    const c = [];
    for (let i = 0; i < n; i++) c.push([lo + rand() * (hi - lo), a * (0.5 + rand() * 0.5)]);
    return c;
  };
  const kickS = partials([[60, 0.9], [90, 0.7], [120, 0.5], [180, 0.3], [300, 0.12]], 30);
  const snareS = partials([[180, 0.25], ...spread(1200, 3400, 24, 0.35)], 34);
  const hatS = partials(spread(7000, 14000, 24, 0.3), 95);

  const hk = classifyHit(kickS, SR);
  check('kick burst -> kick', hk?.kind === 'kick', `got ${hk?.kind} @${hk?.centroid}Hz`);
  const hs = classifyHit(snareS, SR);
  check('snare burst -> snare', hs?.kind === 'snare', `got ${hs?.kind} @${hs?.centroid}Hz`);
  const hh = classifyHit(hatS, SR);
  check('hat burst -> hat', hh?.kind === 'hat', `got ${hh?.kind} @${hh?.centroid}Hz`);
  check('silence -> null', classifyHit(new Float32Array(1024), SR) === null);
  // Ambiguous mid sound should not fire confidently as something else.
  const amb = partials(spread(400, 900, 12, 0.3), 40);
  const ha = classifyHit(amb, SR);
  check('ambiguous sound stays null or kick', !ha || ha.kind === 'kick', `got ${ha?.kind}`);
}

console.log('OnsetDetector streaming');
{
  const hits = [];
  const od = new OnsetDetector((h) => hits.push(h), { sampleRate: SR, cooldownMs: 100 });
  let t = 0;
  const quiet = new Float32Array(1024).fill(0.004);
  // Snare-like burst built from partials (same recipe as the classifier test).
  let rnd2 = 7;
  const rand2 = () => (rnd2 = (rnd2 * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const comps2 = [[180, 0.25]];
  for (let p = 0; p < 24; p++) comps2.push([1200 + rand2() * 2200, 0.3]);
  const burst = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) {
    const t = i / SR;
    let s = 0;
    for (const [fr, a] of comps2) s += a * Math.sin(2 * Math.PI * fr * t + fr);
    // 3 ms raised-cosine attack: no step discontinuity at t=0.
    const attack = Math.min(1, t / 0.003);
    const ramp = attack * attack * (3 - 2 * attack);
    burst[i] = s * Math.exp(-t * 34) * ramp;
  }
  for (let i = 0; i < 30; i++, t += 16) od.process(quiet, 0.004, t);  // settle
  od.process(burst, 0.25, t); t += 16;                                 // hit
  for (let i = 0; i < 10; i++, t += 16) od.process(quiet, 0.004, t);
  check('onset fires exactly once', hits.length === 1, `hits=${hits.length}`);
  check('onset classified snare-ish', hits[0] && hits[0].kind === 'snare', `kind=${hits[0]?.kind}`);
}

console.log('Voice curves (wind synth)');
{
  check('velocityGain(0) small but audible', velocityGain(0) > 0 && velocityGain(0) < 0.2,
    `got ${velocityGain(0)}`);
  check('velocityGain(127) == 1', Math.abs(velocityGain(127) - 1) < 1e-9);
  check('velocityGain monotonic', velocityGain(30) < velocityGain(90) && velocityGain(90) < velocityGain(127));
  check('breathCurve(0) == 0', breathCurve(0) === 0);
  check('breathCurve(1) == 1', breathCurve(1) === 1);
  check('breathCurve soft knee below linear early', breathCurve(0.25) < 0.25 && breathCurve(0.25) > 0.1,
    `got ${breathCurve(0.25)}`);
  check('breathCurve clamps', breathCurve(-2) === 0 && breathCurve(5) === 1);
}

console.log('MIDI file writer');
{
  const smf = eventsToSMF([
    { t: 0.0, type: 'on', note: 69, vel: 100 },
    { t: 0.5, type: 'off', note: 69 },
    { t: 0.5, type: 'on', note: 72, vel: 90 },
    { t: 1.0, type: 'off', note: 72 },
  ]);
  const info = inspectSMF(smf);
  check('SMF header valid', info.ok && info.format === 0 && info.tracks === 1 && info.tpq === 480,
    JSON.stringify(info));
  const hex = [...smf.slice(0, 60)].map(b => b.toString(16).padStart(2, '0')).join(' ');
  check('MThd magic present', hex.startsWith('4d 54 68 64'));
  // Find a note-on 0x90 0x45 in the byte stream.
  let found = false;
  for (let i = 0; i < smf.length - 2; i++) {
    if (smf[i] === 0x90 && smf[i + 1] === 69 && smf[i + 2] === 100) { found = true; break; }
  }
  check('note-on 69 vel 100 encoded', found);
  // Per-event channel: drum hit on channel 9 -> status 0x99.
  const smf2 = eventsToSMF([{ t: 0, type: 'on', note: 36, vel: 110, ch: 9 }]);
  let foundCh = false;
  for (let i = 0; i < smf2.length - 2; i++) {
    if (smf2[i] === 0x99 && smf2[i + 1] === 36) { foundCh = true; break; }
  }
  check('drum on channel 9 (0x99) encoded', foundCh);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

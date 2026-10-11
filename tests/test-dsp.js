/* VOXMIDI DSP unit tests — run with: node tests/test-dsp.js
 * Synthesized waveforms -> expected MIDI notes, drum classes, SMF bytes.
 * The sandbox has no microphone, so this is how the pitch math gets proven. */
import {
  yinDetect, freqToMidiFloat, midiToName, frameRMS, NoteTracker,
} from '../js/pitch.js';
import { velocityGain, breathCurve, InternalSynth } from '../js/engine.js';
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

console.log('NoteTracker bend continuity (no boundary warble)');
{
  const SR = 48000, N = 2048, HOP = 1024;
  const centsSeq = []; const evts = []; let firstOnAt = -1;
  const tr = new NoteTracker({
    onNoteOn: (m) => { if (firstOnAt < 0) firstOnAt = centsSeq.length; evts.push(['on', m]); },
    onNoteOff: (m) => evts.push(['off', m]),
    onPitch: (fl, c) => centsSeq.push(c),
  }, { gate: 0.01 });
  // Continuous 3-second signal: voice hovers at MIDI 57.48 (just under the
  // A3/A#3 boundary) with +/-30c vibrato at 5.5 Hz. Adversarial for warble.
  // NOTE: vibrato is synthesized by integrating instantaneous frequency;
  // the closed form sin(2*pi*f(t)*t) is wrong for time-varying f.
  // Vibrato depth ramps in over 300ms like a real voice (it is not present
  // at full depth during the attack).
  const dur = 3.0, total = Math.floor(SR * dur);
  const sig = new Float32Array(total);
  const f0base = 440 * Math.pow(2, (57.48 - 69) / 12);
  const hs = [1, 0.55, 0.3, 0.16];
  const phases = [0, 0, 0, 0];
  for (let i = 0; i < total; i++) {
    const t = i / SR, vibCents = 30 * Math.min(1, t / 0.3) * Math.sin(2 * Math.PI * 5.5 * t);
    let s = 0;
    for (let h = 1; h <= 4; h++) {
      phases[h - 1] += 2 * Math.PI * f0base * h * Math.pow(2, vibCents / 1200) / SR;
      s += hs[h - 1] * Math.sin(phases[h - 1]);
    }
    sig[i] = s * 0.3;
  }
  for (let k = 0; k + N <= total; k += HOP) {
    const fr = sig.slice(k, k + N);
    tr.process(yinDetect(fr, SR), frameRMS(fr));
  }
  const ons = evts.filter(e => e[0] === 'on').length;
  // Continuity matters once a note is sounding: pre-onset bend jumps are
  // inaudible (InternalSynth.pitchBend no-ops without a voice) and only
  // feed the tuner needle.
  const sounded = firstOnAt >= 0 ? centsSeq.slice(firstOnAt) : centsSeq;
  let maxJump = 0;
  for (let i = 1; i < sounded.length; i++) maxJump = Math.max(maxJump, Math.abs(sounded[i] - sounded[i - 1]));
  check('vibrato at boundary: single noteOn, no flap', ons === 1, `ons=${ons}`);
  check('bend signal continuous (max jump < 30c)', maxJump < 30, `maxJump=${maxJump.toFixed(1)}c`);
  check('bend follows vibrato musically', Math.min(...centsSeq) < 0 && Math.max(...centsSeq) > 15,
    `range ${Math.min(...centsSeq).toFixed(0)}..${Math.max(...centsSeq).toFixed(0)}c`);
}

console.log('InternalSynth pitchBend smoothing (mock AudioContext)');
{
  // Minimal Web Audio mock: records param automation.
  const mkParam = () => {
    const p = { value: 0, calls: [], cancels: 0 };
    p.setTargetAtTime = (v, t, tau) => { p.calls.push([v, t, tau]); p.value = v; };
    p.setValueAtTime = (v) => { p.value = v; };
    p.cancelScheduledValues = () => { p.cancels++; };
    return p;
  };
  const mkNode = () => ({ connect() {}, start() {}, stop() {} });
  let now = 100;
  const mockCtx = {
    get currentTime() { return now; },
    get sampleRate() { return 48000; },
    createOscillator: () => Object.assign(mkNode(), { type: '', frequency: mkParam(), detune: mkParam() }),
    createGain: () => Object.assign(mkNode(), { gain: mkParam() }),
    createBiquadFilter: () => Object.assign(mkNode(), { type: '', frequency: mkParam(), Q: mkParam() }),
    createBufferSource: () => Object.assign(mkNode(), { buffer: null, loop: false }),
    createBuffer: (ch, len) => ({ getChannelData: () => new Float32Array(len) }),
  };
  const master = mockCtx.createGain();
  const synth = new InternalSynth(mockCtx, master);
  synth.noteOn(69, 90, 0);
  const det = () => synth.voice.oscA.detune.value;
  // Deadband: 2c of wobble must not move the detune.
  now += 1 / 80; synth.pitchBend(2);
  check('deadband swallows +/-4c wobble', det() === 0, `detune=${det()}`);
  // Slew limit: a 100c step in one 12.5ms frame may move at most ~19c.
  now += 1 / 80; synth.pitchBend(100);
  const d1 = det();
  check('slew limiter caps per-frame travel', d1 > 0 && d1 <= 20, `detune=${d1.toFixed(1)}`);
  // Given time, it converges to the target.
  for (let i = 0; i < 40; i++) { now += 1 / 80; synth.pitchBend(100); }
  check('bend converges to target', Math.abs(det() - 100) < 1, `detune=${det().toFixed(1)}`);
  // Legato: second noteOn while sounding must not cancel/re-attack the envelope.
  const cancelsBefore = synth.voice.envGain.gain.cancels;
  synth.noteOn(72, 90, 0);
  check('legato note change keeps envelope (no re-attack)',
    synth.voice.envGain.gain.cancels === cancelsBefore, 'envelope was cancelled');
  // Fresh note after noteOff re-attacks.
  synth.noteOff();
  synth.noteOn(72, 90, 0);
  check('fresh onset after silence re-attacks',
    synth.voice.envGain.gain.cancels > cancelsBefore, 'envelope was not reset');
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

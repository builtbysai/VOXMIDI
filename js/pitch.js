/* VOXMIDI pitch core: YIN pitch detection + monophonic note tracker.
 * Pure DSP, no DOM. Importable from node for unit tests and from the
 * browser app (ES module). */

export const A4 = 440;

/** Frequency (Hz) -> fractional MIDI note number. */
export function freqToMidiFloat(freq) {
  return 69 + 12 * Math.log2(freq / A4);
}

/** Fractional MIDI note -> frequency (Hz). */
export function midiFloatToFreq(m) {
  return A4 * Math.pow(2, (m - 69) / 12);
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Integer MIDI note -> "C4" style name. */
export function midiToName(midi) {
  const n = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  return NOTE_NAMES[n] + octave;
}

/**
 * YIN pitch detection (de Cheveigne & Kawahara).
 * frame: Float32Array of mono samples. Returns {freq, clarity} or null.
 * clarity in [0,1]; 1 = perfectly periodic. Null = no confident pitch.
 */
export function yinDetect(frame, sampleRate, opts = {}) {
  const minFreq = opts.minFreq ?? 55;
  const maxFreq = opts.maxFreq ?? 2500;
  const threshold = opts.threshold ?? 0.12;

  const n = frame.length;
  const minTau = Math.max(2, Math.floor(sampleRate / maxFreq));
  const maxTau = Math.min(n - 1, Math.ceil(sampleRate / minFreq));
  if (maxTau <= minTau) return null;

  // Step 1+2: difference function + cumulative mean normalized difference.
  // The full cmnd array is computed FIRST; the threshold scan runs after,
  // because the local-minimum walk reads ahead of the crossing point.
  const cmnd = new Float64Array(maxTau + 1);
  cmnd[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau <= maxTau; tau++) {
    let d = 0;
    for (let j = 0; j + tau < n; j++) {
      const diff = frame[j] - frame[j + tau];
      d += diff * diff;
    }
    runningSum += d;
    cmnd[tau] = runningSum === 0 ? 1 : (d * tau) / runningSum;
  }

  // Step 3: absolute threshold — first dip below it, scanning from minTau.
  let tauEstimate = -1;
  for (let tau = minTau; tau <= maxTau; tau++) {
    if (cmnd[tau] < threshold) {
      // Step 4: pick the local minimum at/after this tau.
      let t = tau;
      while (t + 1 <= maxTau && cmnd[t + 1] < cmnd[t]) t++;
      tauEstimate = t;
      break;
    }
  }

  // No dip under threshold: fall back to the global minimum (weak pitch).
  if (tauEstimate === -1) {
    let best = minTau;
    for (let tau = minTau + 1; tau <= maxTau; tau++) {
      if (cmnd[tau] < cmnd[best]) best = tau;
    }
    // If even the best minimum is poor, there is no pitch here.
    if (cmnd[best] > 0.45) return null;
    tauEstimate = best;
  }

  // Step 5: parabolic interpolation around tauEstimate for sub-sample tau.
  let betterTau = tauEstimate;
  if (tauEstimate > 1 && tauEstimate < maxTau) {
    const x0 = tauEstimate - 1, x2 = tauEstimate + 1;
    const s0 = cmnd[x0], s1 = cmnd[tauEstimate], s2 = cmnd[x2];
    const denom = s0 + s2 - 2 * s1;
    if (denom !== 0) betterTau = tauEstimate + (0.5 * (s0 - s2)) / denom;
  }

  const freq = sampleRate / betterTau;
  if (freq < minFreq * 0.9 || freq > maxFreq * 1.1) return null;
  const clarity = 1 - cmnd[tauEstimate];
  return { freq, clarity };
}

/** RMS level of a frame, 0..1ish. */
export function frameRMS(frame) {
  let s = 0;
  for (let i = 0; i < frame.length; i++) s += frame[i] * frame[i];
  return Math.sqrt(s / frame.length);
}

/**
 * Monophonic note tracker: turns a stream of {freq, clarity, rms} frames
 * into noteOn / noteOff / pitch events with debouncing so a voice doesn't
 * flutter between neighboring semitones.
 *
 * Callbacks: onNoteOn(midiInt, velocity, centsOffset),
 *             onNoteOff(midiInt),
 *             onPitch(midiFloat, cents) — called every voiced frame.
 */
export class NoteTracker {
  constructor(callbacks = {}, opts = {}) {
    this.cb = callbacks;
    this.gate = opts.gate ?? 0.015;          // RMS below this = silence
    this.minClarity = opts.minClarity ?? 0.72;
    this.onsetFrames = opts.onsetFrames ?? 3;   // stable frames to start a note
    this.changeFrames = opts.changeFrames ?? 2; // stable frames to change note
    this.releaseFrames = opts.releaseFrames ?? 5;// quiet frames to end a note
    this.reset();
  }

  reset() {
    this.current = null;       // {midi, velocity}
    this.candidate = null;     // {midi, count}
    this.quietCount = 0;
    this.smoothFloat = null;
  }

  setGate(g) { this.gate = g; }

  /**
   * Feed one analysis frame. now is a timestamp (ms) for velocity shaping.
   * quantize: optional fn(midiFloat) -> midiInt used before note decisions.
   */
  process(det, rms, quantize = null) {
    const voiced = det && det.clarity >= this.minClarity && rms >= this.gate;

    if (!voiced) {
      this.quietCount++;
      this.candidate = null;
      if (this.current && this.quietCount >= this.releaseFrames) {
        const m = this.current.midi;
        this.current = null;
        this.smoothFloat = null;
        this.cb.onNoteOff && this.cb.onNoteOff(m);
      }
      return;
    }
    this.quietCount = 0;

    let midiFloat = freqToMidiFloat(det.freq);
    // Light smoothing of the continuous pitch for bend/needle display.
    this.smoothFloat = this.smoothFloat === null
      ? midiFloat
      : this.smoothFloat + 0.35 * (midiFloat - this.smoothFloat);

    let midiInt = Math.round(midiFloat);
    if (quantize) midiInt = quantize(midiFloat);

    const velocity = Math.max(1, Math.min(127,
      Math.round(40 + 87 * Math.min(1, rms / 0.25))));

    this.cb.onPitch && this.cb.onPitch(this.smoothFloat, (this.smoothFloat - midiInt) * 100);

    if (!this.current) {
      if (!this.candidate || this.candidate.midi !== midiInt) {
        this.candidate = { midi: midiInt, count: 1 };
      } else {
        this.candidate.count++;
      }
      if (this.candidate.count >= this.onsetFrames) {
        this.current = { midi: midiInt, velocity };
        this.candidate = null;
        this.cb.onNoteOn && this.cb.onNoteOn(midiInt, velocity, (midiFloat - midiInt) * 100);
      }
      return;
    }

    if (midiInt !== this.current.midi) {
      if (!this.candidate || this.candidate.midi !== midiInt) {
        this.candidate = { midi: midiInt, count: 1 };
      } else {
        this.candidate.count++;
      }
      if (this.candidate.count >= this.changeFrames) {
        const old = this.current.midi;
        this.current = { midi: midiInt, velocity };
        this.candidate = null;
        this.cb.onNoteOff && this.cb.onNoteOff(old);
        this.cb.onNoteOn && this.cb.onNoteOn(midiInt, velocity, (midiFloat - midiInt) * 100);
      }
    } else {
      this.candidate = null;
    }
  }
}

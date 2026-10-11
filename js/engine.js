/* VOXMIDI audio engine: mic -> pitch/drums -> MIDI out + internal synth.
 * Browser-only. DSP math lives in pitch.js / drums.js (shared with node tests). */
import { yinDetect, freqToMidiFloat, frameRMS, NoteTracker } from './pitch.js';
import { OnsetDetector, extractFeatures, DEFAULT_TEMPLATES } from './drums.js';
import { eventsToSMF } from './midifile.js';

export const SCALES = {
  'Chromatic':        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  'Major':            [0, 2, 4, 5, 7, 9, 11],
  'Natural Minor':    [0, 2, 3, 5, 7, 8, 10],
  'Harmonic Minor':   [0, 2, 3, 5, 7, 8, 11],
  'Melodic Minor':    [0, 2, 3, 5, 7, 9, 11],
  'Dorian':           [0, 2, 3, 5, 7, 9, 10],
  'Phrygian':         [0, 1, 3, 5, 7, 8, 10],
  'Lydian':           [0, 2, 4, 6, 7, 9, 11],
  'Mixolydian':       [0, 2, 4, 5, 7, 9, 10],
  'Locrian':          [0, 1, 3, 5, 6, 8, 10],
  'Major Pentatonic': [0, 2, 4, 7, 9],
  'Minor Pentatonic': [0, 3, 5, 7, 10],
  'Blues':            [0, 3, 5, 6, 7, 10],
  'Whole Tone':       [0, 2, 4, 6, 8, 10],
};
export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Snap a fractional MIDI note to the nearest degree of key+scale. */
export function quantizeNote(midiFloat, keyRoot, scaleName) {
  const intervals = SCALES[scaleName] || SCALES.Chromatic;
  const base = Math.round(midiFloat);
  let best = base, bestDist = Infinity;
  for (let m = base - 12; m <= base + 12; m++) {
    const pc = (((m - keyRoot) % 12) + 12) % 12;
    if (intervals.includes(pc)) {
      const d = Math.abs(m - midiFloat);
      if (d < bestDist) { bestDist = d; best = m; }
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Internal synth: mono lead + tiny drum kit, all Web Audio.           */
/* ------------------------------------------------------------------ */
export class InternalSynth {
  constructor(ctx, master) {
    this.ctx = ctx;
    this.master = master;
    this.voice = null; // {oscA, oscB, filter, gain}
    this.localOn = true;
  }

  _ensureVoice() {
    if (this.voice) return this.voice;
    const ctx = this.ctx;
    const oscA = ctx.createOscillator(); oscA.type = 'sawtooth';
    const oscB = ctx.createOscillator(); oscB.type = 'sawtooth'; oscB.detune.value = 8;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass'; filter.frequency.value = 2400; filter.Q.value = 2;
    const gain = ctx.createGain(); gain.gain.value = 0;
    oscA.connect(filter); oscB.connect(filter);
    filter.connect(gain); gain.connect(this.master);
    oscA.start(); oscB.start();
    this.voice = { oscA, oscB, filter, gain };
    return this.voice;
  }

  noteOn(midi, velocity = 90, bendCents = 0) {
    if (!this.localOn) return;
    const v = this._ensureVoice();
    const t = this.ctx.currentTime;
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    const detune = bendCents; // cents
    v.oscA.frequency.cancelScheduledValues(t);
    v.oscB.frequency.cancelScheduledValues(t);
    // Glide to the new pitch over 25 ms: legato feel, no clicks.
    v.oscA.frequency.setTargetAtTime(freq, t, 0.008);
    v.oscB.frequency.setTargetAtTime(freq, t, 0.008);
    v.oscA.detune.setTargetAtTime(detune, t, 0.008);
    v.oscB.detune.setTargetAtTime(8 + detune, t, 0.008);
    const level = 0.22 * (velocity / 127);
    v.gain.gain.cancelScheduledValues(t);
    v.gain.gain.setTargetAtTime(level, t, 0.012);
    v.filter.frequency.setTargetAtTime(1200 + velocity * 22, t, 0.02);
  }

  pitchBend(cents) {
    if (!this.localOn || !this.voice) return;
    const t = this.ctx.currentTime;
    this.voice.oscA.detune.setTargetAtTime(cents, t, 0.01);
    this.voice.oscB.detune.setTargetAtTime(8 + cents, t, 0.01);
  }

  noteOff() {
    if (!this.voice) return;
    const t = this.ctx.currentTime;
    this.voice.gain.gain.setTargetAtTime(0, t, 0.03);
  }

  _noiseBuffer(dur) {
    const ctx = this.ctx;
    const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  drum(kind, velocity = 100) {
    if (!this.localOn) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const vol = 0.5 * (velocity / 127);
    if (kind === 'kick') {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.setValueAtTime(150, t);
      o.frequency.exponentialRampToValueAtTime(48, t + 0.11);
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
      o.connect(g); g.connect(this.master);
      o.start(t); o.stop(t + 0.26);
    } else if (kind === 'snare') {
      const src = ctx.createBufferSource(); src.buffer = this._noiseBuffer(0.2);
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1900; bp.Q.value = 0.8;
      const g = ctx.createGain();
      g.gain.setValueAtTime(vol * 0.9, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
      src.connect(bp); bp.connect(g); g.connect(this.master);
      src.start(t); src.stop(t + 0.2);
      const o = ctx.createOscillator(); o.frequency.value = 190;
      const g2 = ctx.createGain();
      g2.gain.setValueAtTime(vol * 0.5, t);
      g2.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
      o.connect(g2); g2.connect(this.master);
      o.start(t); o.stop(t + 0.12);
    } else { // hat
      const src = ctx.createBufferSource(); src.buffer = this._noiseBuffer(0.08);
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 7500;
      const g = ctx.createGain();
      g.gain.setValueAtTime(vol * 0.55, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
      src.connect(hp); hp.connect(g); g.connect(this.master);
      src.start(t); src.stop(t + 0.08);
    }
  }

  panic() { this.noteOff(); }
}

/* ------------------------------------------------------------------ */
/* MIDI output via Web MIDI API.                                       */
/* ------------------------------------------------------------------ */
export class MidiOut {
  constructor() {
    this.access = null;
    this.output = null;
    this.supported = 'requestMIDIAccess' in navigator;
    this.onDevices = null; // callback(devices:[{id,name}])
  }

  async enable() {
    if (!this.supported) return false;
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
      this.access.onstatechange = () => this._emit();
      this._emit();
      return true;
    } catch (e) {
      return false;
    }
  }

  _emit() {
    if (!this.access) return;
    const list = [...this.access.outputs.values()].map(o => ({ id: o.id, name: o.name || 'MIDI device' }));
    // Keep selection if the device is still there.
    if (this.output && ![...this.access.outputs.values()].some(o => o.id === this.output.id)) {
      this.output = null;
    }
    this.onDevices && this.onDevices(list);
  }

  select(id) {
    if (!this.access) return null;
    this.output = [...this.access.outputs.values()].find(o => o.id === id) || null;
    return this.output ? { id: this.output.id, name: this.output.name } : null;
  }

  get active() { return !!this.output; }

  _send(bytes) { if (this.output) { try { this.output.send(bytes); } catch (e) {} } }

  noteOn(midi, vel = 90, ch = 0) { this._send([0x90 | (ch & 15), midi & 127, Math.max(1, vel & 127)]); }
  noteOff(midi, ch = 0) { this._send([0x80 | (ch & 15), midi & 127, 64]); }
  /** cents in [-200, 200] mapped to the standard +/-2 semitone bend range. */
  pitchBend(cents, ch = 0) {
    const v = Math.max(0, Math.min(16383, Math.round(8192 + (cents / 200) * 8192)));
    this._send([0xE0 | (ch & 15), v & 127, (v >> 7) & 127]);
  }
  panic(ch = 0) {
    for (let m = 0; m < 128; m++) this._send([0x80 | (ch & 15), m, 64]);
    this._send([0xE0 | (ch & 15), 0, 64]); // bend reset
  }
}

/* ------------------------------------------------------------------ */
/* Session recorder -> Standard MIDI File download.                    */
/* ------------------------------------------------------------------ */
export class SessionRecorder {
  constructor() { this.reset(); }
  reset() { this.events = []; this.startAt = null; this.recording = false; }
  start() { this.reset(); this.recording = true; this.startAt = performance.now() / 1000; }
  stop() { this.recording = false; }
  get count() { return this.events.filter(e => e.type === 'on').length; }
  _t() { return performance.now() / 1000 - this.startAt; }
  noteOn(note, vel, ch = 0) { if (this.recording) this.events.push({ t: this._t(), type: 'on', note, vel, ch }); }
  noteOff(note, ch = 0) { if (this.recording) this.events.push({ t: this._t(), type: 'off', note, ch }); }
  toBlob() {
    const bytes = eventsToSMF(this.events);
    return new Blob([bytes], { type: 'audio/midi' });
  }
}

/* ------------------------------------------------------------------ */
/* The engine: owns the mic graph, the analysis loop, routing.         */
/* ------------------------------------------------------------------ */
export class AudioEngine {
  constructor(ui) {
    this.ui = ui; // callbacks: onLevel, onPitch, onNote, onDrum, onState
    this.ctx = null;
    this.analyser = null;
    this.frame = null;
    this.running = false;
    this.raf = 0;
    this.settings = {
      gate: 0.02, key: 0, scale: 'Major', quantize: true,
      bend: 'follow', octave: 0, drums: true, velocityOn: true,
      localSound: true,
    };
    this.tracker = null;
    this.onset = null;
    this.synth = null;
    this.midi = new MidiOut();
    this.recorder = new SessionRecorder();
    this.templates = JSON.parse(JSON.stringify(DEFAULT_TEMPLATES));
    this.pitchHistory = []; // recent midiFloat values for the ribbon
    this.lastFrameAt = 0;
  }

  get sampleRate() { return this.ctx ? this.ctx.sampleRate : 48000; }

  async init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') await this.ctx.resume(); return; }
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.9;
    const comp = this.ctx.createDynamicsCompressor();
    this.master.connect(comp); comp.connect(this.ctx.destination);
    this.synth = new InternalSynth(this.ctx, this.master);
    this.synth.localOn = this.settings.localSound;
    this.tracker = new NoteTracker({
      onNoteOn: (m, v, cents) => this._noteOn(m, v, cents),
      onNoteOff: (m) => this._noteOff(m),
      onPitch: (f, cents) => this._pitch(f, cents),
    }, { gate: this.settings.gate });
    this.onset = new OnsetDetector((hit) => this._drum(hit), {
      sampleRate: this.sampleRate, templates: this.templates,
    });
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  async listMics() {
    const devs = await navigator.mediaDevices.enumerateDevices();
    return devs.filter(d => d.kind === 'audioinput')
      .map(d => ({ id: d.deviceId, label: d.label || 'Microphone' }));
  }

  async startMic(deviceId = null) {
    await this.init();
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    const constraints = { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true } };
    if (deviceId) constraints.audio.deviceId = { exact: deviceId };
    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    if (this.micSrc) this.micSrc.disconnect();
    this.micSrc = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0;
    this.micSrc.connect(this.analyser); // never to destination: no feedback
    this.frame = new Float32Array(this.analyser.fftSize);
    this.running = true;
    this._loop();
    this.ui.onState && this.ui.onState('live');
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.synth && this.synth.panic();
    this.midi.panic();
    this.ui.onState && this.ui.onState('idle');
  }

  _loop() {
    if (!this.running) return;
    this.raf = requestAnimationFrame(() => this._loop());
    const now = performance.now();
    if (now - this.lastFrameAt < 12) return; // ~80 fps analysis cadence
    this.lastFrameAt = now;
    this.analyser.getFloatTimeDomainData(this.frame);
    const rms = frameRMS(this.frame);
    this.ui.onLevel && this.ui.onLevel(rms);

    // Pitch path.
    const det = rms >= this.tracker.gate * 0.6 ? yinDetect(this.frame, this.sampleRate) : null;
    const q = this.settings.quantize
      ? (f) => quantizeNote(f + this.settings.octave * 12, this.settings.key, this.settings.scale)
      : null;
    this.tracker.process(det, rms, q);

    // Drum path: only when enabled and the frame is loud but unpitched.
    if (this.settings.drums && rms > 0.02 && (!det || det.clarity < 0.55)) {
      this.onset.process(this.frame, rms, now);
    }
  }

  _noteOn(midi, velocity, cents) {
    const m = Math.max(0, Math.min(127, midi));
    const vel = this.settings.velocityOn ? velocity : 96;
    this.synth.noteOn(m, vel, this.settings.bend === 'follow' ? cents : 0);
    this.midi.noteOn(m, vel);
    if (this.settings.bend === 'follow') this.midi.pitchBend(cents);
    this.recorder.noteOn(m, vel);
    this.ui.onNote && this.ui.onNote(m, vel, true);
  }

  _noteOff(midi) {
    this.synth.noteOff();
    this.midi.noteOff(midi);
    this.midi.pitchBend(0);
    this.recorder.noteOff(midi);
    this.ui.onNote && this.ui.onNote(midi, 0, false);
  }

  _pitch(midiFloat, cents) {
    const shifted = midiFloat + this.settings.octave * 12;
    this.pitchHistory.push(shifted);
    if (this.pitchHistory.length > 320) this.pitchHistory.shift();
    this.ui.onPitch && this.ui.onPitch(shifted, cents);
    if (this.settings.bend === 'follow') {
      const c = Math.max(-200, Math.min(200, cents));
      this.synth.pitchBend(c);
      this.midi.pitchBend(c);
    }
  }

  _drum(hit) {
    const map = { kick: 36, snare: 38, hat: 42 };
    const note = map[hit.kind];
    this.synth.drum(hit.kind, hit.velocity);
    this.midi.noteOn(note, hit.velocity, 9);
    setTimeout(() => this.midi.noteOff(note, 9), 60);
    this.recorder.noteOn(note, hit.velocity, 9);
    setTimeout(() => this.recorder.noteOff(note, 9), 60);
    this.ui.onDrum && this.ui.onDrum(hit.kind, hit.velocity);
  }

  setGate(g) { this.settings.gate = g; if (this.tracker) this.tracker.setGate(g); }
  setTemplates(t) {
    this.templates = t;
    if (this.onset) this.onset.setTemplates(t);
  }
  panic() { this.synth && this.synth.panic(); this.midi.panic(); }

  /* Direct audition: playable keyboard / drum pads. Sound + MIDI, no record. */
  auditionNote(midi, vel = 96) {
    if (!this.ctx) return;
    this.synth.noteOn(midi, vel, 0);
    this.midi.noteOn(midi, vel);
  }
  auditionNoteOff(midi) {
    if (!this.ctx) return;
    this.synth.noteOff();
    this.midi.noteOff(midi);
  }
  auditionDrum(kind) {
    if (!this.ctx) return;
    const map = { kick: 36, snare: 38, hat: 42 };
    this.synth.drum(kind, 100);
    this.midi.noteOn(map[kind], 100, 9);
    setTimeout(() => this.midi.noteOff(map[kind], 9), 60);
  }
}

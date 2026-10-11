/* VOXMIDI UI: onboarding wizard + studio. Browser-only. */
import { AudioEngine, SCALES, NOTE_NAMES } from './engine.js';
import { midiToName } from './pitch.js';
import { extractFeatures, DEFAULT_TEMPLATES } from './drums.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const store = {
  get(k, d) { try { const v = localStorage.getItem('voxmidi.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('voxmidi.' + k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem('voxmidi.' + k); } catch (e) {} },
};

const app = {
  engine: null,
  step: 0,
  lockedNote: null,   // first stable note in the hum test
  lastNote: null,
  cents: 0,
  roll: [],           // {midi, start, end} session notes for the piano roll
  rollStart: null,
  training: null,     // {kind, takes:[], need}
};

function fmtNote(midi) {
  const n = midiToName(Math.round(midi));
  return { letter: n.slice(0, -1), octave: n.slice(-1) };
}

/* ---------------- onboarding ---------------- */

const STEPS = ['welcome', 'mic', 'level', 'hum'];

function showStep(i) {
  app.step = i;
  $$('.ob-step').forEach(el => el.hidden = true);
  $('#ob-' + STEPS[i]).hidden = false;
  $$('.ob-dot').forEach((d, j) => d.classList.toggle('on', j <= i));
  $('#ob-back').style.visibility = i === 0 ? 'hidden' : 'visible';
}

function enterStudio() {
  store.set('onboarded', true);
  $('#onboarding').hidden = true;
  $('#studio').hidden = false;
  document.body.classList.add('in-studio');
  sizeCanvases();
  refreshStudioMicUI();
  app.engine.ui.onState(app.engine.running ? 'live' : 'idle');
}

async function refreshStudioMicUI() {
  const btn = $('#btn-mic-studio');
  const status = $('#mic-studio-status');
  const sel = $('#mic-select-studio');
  if (app.engine.running) {
    btn.textContent = 'Stop microphone';
    status.textContent = 'Microphone is live.';
    try {
      const mics = await app.engine.listMics();
      if (mics.length > 1) {
        sel.hidden = false;
        sel.innerHTML = '';
        mics.forEach(m => {
          const o = document.createElement('option');
          o.value = m.id; o.textContent = m.label;
          sel.appendChild(o);
        });
      }
    } catch (e) {}
  } else {
    btn.textContent = 'Enable microphone';
    status.textContent = 'Microphone is off.';
    sel.hidden = true;
  }
}

async function enableMic() {
  const btn = $('#btn-mic');
  btn.disabled = true;
  btn.textContent = 'Waiting for the browser…';
  try {
    await app.engine.startMic($('#mic-select').value || null);
    const mics = await app.engine.listMics();
    const sel = $('#mic-select');
    sel.innerHTML = '';
    mics.forEach(m => {
      const o = document.createElement('option');
      o.value = m.id; o.textContent = m.label;
      sel.appendChild(o);
    });
    sel.hidden = mics.length < 2 ? true : false;
    $('#mic-select-label').hidden = mics.length < 2;
    $('#mic-hint').textContent = mics.length + (mics.length === 1 ? ' microphone found.' : ' microphones found.');
    btn.textContent = 'Microphone on';
    $('#btn-to-level').disabled = false;
    showStep(2);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Enable microphone';
    $('#mic-error').hidden = false;
    $('#mic-error').textContent = 'The browser blocked microphone access. Click the camera icon in the address bar, allow the microphone, then try again.';
  }
}

/* ---------------- studio rendering ---------------- */

function sizeCanvases() {
  for (const id of ['ribbon', 'roll']) {
    const c = $('#' + id);
    const r = c.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.max(50, r.width * dpr);
    c.height = Math.max(50, r.height * dpr);
  }
}

function drawRibbon() {
  const c = $('#ribbon');
  if (!c || !c.width) return;
  const g = c.getContext('2d');
  const W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  // Grid: one line per semitone in view.
  const hist = app.engine.pitchHistory;
  const lo = 36, hi = 96; // C2..C7 view
  const yOf = (m) => H - ((m - lo) / (hi - lo)) * H;
  g.strokeStyle = 'rgba(255,255,255,0.05)';
  g.lineWidth = 1;
  for (let m = lo; m <= hi; m++) {
    g.beginPath(); g.moveTo(0, yOf(m)); g.lineTo(W, yOf(m)); g.stroke();
  }
  if (hist.length < 2) return;
  // Trace.
  const n = hist.length;
  g.beginPath();
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * W;
    const y = yOf(Math.max(lo, Math.min(hi, hist[i])));
    i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
  }
  g.strokeStyle = '#35e0c5';
  g.lineWidth = Math.max(2, W / 400);
  g.shadowColor = '#35e0c5';
  g.shadowBlur = 12;
  g.stroke();
  g.shadowBlur = 0;
  // Head dot.
  const last = hist[n - 1];
  g.beginPath();
  g.arc(W - 6, yOf(Math.max(lo, Math.min(hi, last))), 7, 0, 7);
  g.fillStyle = '#35e0c5';
  g.fill();
}

function drawRoll() {
  const c = $('#roll');
  if (!c || !c.width) return;
  const g = c.getContext('2d');
  const W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  const now = performance.now() / 1000;
  const window = 30; // seconds visible
  const lo = 24, hi = 96;
  const xOf = (t) => W - ((now - t) / window) * W;
  const yOf = (m) => H - ((m - lo) / (hi - lo)) * H;
  const h = Math.max(3, (H / (hi - lo)) * 0.8);
  for (const n of app.roll) {
    const x0 = xOf(n.start), x1 = xOf(n.end ?? now);
    if (x1 < 0 || x0 > W) continue;
    g.fillStyle = n.live ? '#f5b02e' : 'rgba(139,123,255,0.75)';
    const y = yOf(n.midi) - h / 2;
    const w = Math.max(2, x1 - x0);
    g.beginPath();
    if (g.roundRect) g.roundRect(Math.max(0, x0), y, Math.min(w, W - Math.max(0, x0)), h, 3);
    else g.rect(Math.max(0, x0), y, Math.min(w, W - Math.max(0, x0)), h);
    g.fill();
  }
  // Playhead.
  g.fillStyle = 'rgba(255,255,255,0.25)';
  g.fillRect(W - 2, 0, 2, H);
}

function buildKeyboard() {
  const kb = $('#keyboard');
  kb.innerHTML = '';
  // Two octaves: C3 (48) to B4 (71).
  for (let m = 48; m <= 71; m++) {
    const pc = m % 12;
    const black = [1, 3, 6, 8, 10].includes(pc);
    const k = document.createElement('div');
    k.className = 'key ' + (black ? 'black' : 'white');
    k.dataset.midi = m;
    const lbl = document.createElement('span');
    lbl.textContent = NOTE_NAMES[pc] + (Math.floor(m / 12) - 1);
    k.appendChild(lbl);
    kb.appendChild(k);
  }
}

function lightKey(midi, on) {
  $$('#keyboard .key').forEach(k => {
    const m = +k.dataset.midi;
    k.classList.toggle('active', on && m === midi);
  });
}

function updateReadout(midiFloat, cents) {
  const r = fmtNote(midiFloat);
  $('#note-letter').textContent = r.letter;
  $('#note-octave').textContent = r.octave;
  const c = Math.max(-50, Math.min(50, Math.round(cents)));
  $('#cents-needle').style.left = (50 + c) + '%';
  $('#cents-val').textContent = (c >= 0 ? '+' : '') + c + ' ct';
  $('#note-name-full').textContent = r.letter + r.octave;
}

/* ---------------- panels ---------------- */

function buildScaleControls() {
  const keySel = $('#key-select');
  NOTE_NAMES.forEach((n, i) => {
    const o = document.createElement('option');
    o.value = i; o.textContent = n;
    keySel.appendChild(o);
  });
  const scSel = $('#scale-select');
  Object.keys(SCALES).forEach(s => {
    const o = document.createElement('option');
    o.value = s; o.textContent = s;
    scSel.appendChild(o);
  });
}

function applySettingsToUI() {
  const s = app.engine.settings;
  $('#key-select').value = s.key;
  $('#scale-select').value = s.scale;
  $('#tgl-quantize').checked = s.quantize;
  $('#bend-select').value = s.bend;
  $('#octave-select').value = s.octave;
  $('#gain-range').value = Math.round(s.gate * 1000);
  $('#gain-val').textContent = (s.gate * 100).toFixed(1) + '%';
  $('#tgl-drums').checked = s.drums;
  $('#tgl-velocity').checked = s.velocityOn;
  $('#tgl-local').checked = s.localSound;
  $('#drum-strip').classList.toggle('off', !s.drums);
}

function saveSettings() {
  const s = app.engine.settings;
  store.set('settings', {
    gate: s.gate, key: s.key, scale: s.scale, quantize: s.quantize,
    bend: s.bend, octave: s.octave, drums: s.drums,
    velocityOn: s.velocityOn, localSound: s.localSound,
    midiOut: app.engine.midi.output ? app.engine.midi.output.id : null,
  });
}

function loadSettings() {
  const s = store.get('settings', null);
  if (!s) return;
  Object.assign(app.engine.settings, s);
  app.engine.setGate(app.engine.settings.gate);
  const tpl = store.get('templates', null);
  if (tpl) app.engine.setTemplates(tpl);
}

/* ---------------- drums ---------------- */

const DRUM_LABEL = { kick: 'Kick', snare: 'Snare', hat: 'Hat' };

function flashPad(kind) {
  const pad = $('#pad-' + kind);
  if (!pad) return;
  pad.classList.remove('hit');
  void pad.offsetWidth;
  pad.classList.add('hit');
}

function openTraining() {
  $('#train-modal').hidden = false;
  renderTrainRows();
  app.training = null;
}

function renderTrainRows() {
  const tpl = app.engine.templates;
  const custom = store.get('templates', null);
  $('#train-rows').innerHTML = '';
  for (const kind of ['kick', 'snare', 'hat']) {
    const row = document.createElement('div');
    row.className = 'train-row';
    const isCustom = custom && custom[kind];
    row.innerHTML =
      '<div class="train-name">' + DRUM_LABEL[kind] +
      (isCustom ? ' <span class="badge">trained</span>' : '') + '</div>' +
      '<div class="train-status" id="train-status-' + kind + '">Default sound model</div>' +
      '<button class="btn small" data-train="' + kind + '">Train</button>';
    $('#train-rows').appendChild(row);
  }
  $$('#train-rows [data-train]').forEach(b =>
    b.addEventListener('click', () => startTraining(b.dataset.train)));
}

function startTraining(kind) {
  app.training = { kind, takes: [], need: 3 };
  $('#train-status-' + kind).textContent = 'Make your ' + kind + ' sound 3 times… (0/3)';
  $('#train-hint').textContent = 'Listening for sharp hits. Beatbox into the mic.';
}

function feedTraining(rms) {
  const t = app.training;
  if (!t) return;
  // Reuse the engine analyser frame for feature extraction.
  const frame = app.engine.frame;
  if (!frame || rms < 0.06) return;
  const now = performance.now();
  if (t.last && now - t.last < 250) return;
  // Simple peak gate: take the frame, extract features, average 3 takes.
  const feat = extractFeatures(frame, app.engine.sampleRate);
  if (!feat) return;
  t.last = now;
  t.takes.push(feat);
  const n = t.takes.length;
  $('#train-status-' + t.kind).textContent =
    'Make your ' + t.kind + ' sound 3 times… (' + n + '/3)';
  flashPad(t.kind);
  if (n >= t.need) {
    const avg = { centroid: 0, lowR: 0, midR: 0, highR: 0 };
    t.takes.forEach(f => { avg.centroid += f.centroid; avg.lowR += f.lowR; avg.midR += f.midR; avg.highR += f.highR; });
    avg.centroid = Math.round(avg.centroid / n);
    avg.lowR /= n; avg.midR /= n; avg.highR /= n;
    const tpl = Object.assign({}, app.engine.templates);
    tpl[t.kind] = avg;
    app.engine.setTemplates(tpl);
    store.set('templates', tpl);
    $('#train-status-' + t.kind).textContent = 'Trained. Centroid ' + avg.centroid + ' Hz.';
    app.training = null;
    renderTrainRows();
  }
}

/* ---------------- MIDI devices ---------------- */

async function refreshMidiUI() {
  const midi = app.engine.midi;
  const ok = await midi.enable();
  const wrap = $('#midi-select-wrap');
  if (!ok || !midi.supported) {
    $('#midi-status').textContent = 'MIDI output needs Chrome, Edge, or Firefox. Your built-in synth is ready either way.';
    wrap.hidden = true;
    return;
  }
  const paint = (list) => {
    const sel = $('#midi-select');
    const cur = sel.value;
    sel.innerHTML = '<option value="">Built-in synth only</option>';
    list.forEach(d => {
      const o = document.createElement('option');
      o.value = d.id;
      o.textContent = d.name;
      sel.appendChild(o);
    });
    if (list.some(d => d.id === cur)) sel.value = cur;
    $('#midi-status').textContent = list.length
      ? list.length + (list.length === 1 ? ' MIDI output found.' : ' MIDI outputs found.')
      : 'No MIDI outputs found. Plug in a device or a virtual MIDI port.';
  };
  midi.onDevices = paint;
  // Trigger an initial paint.
  midi._emit();
}

/* ---------------- record ---------------- */

function setRecording(on) {
  const btn = $('#btn-record');
  btn.classList.toggle('rec', on);
  btn.querySelector('.rec-label').textContent = on ? 'Stop' : 'Record';
  $('#btn-midi-dl').disabled = !(!on && app.engine.recorder.count > 0);
  $('#rec-count').textContent = on ? 'Recording…' : app.engine.recorder.count + ' notes';
}

/* ---------------- boot ---------------- */

function renderLoop() {
  drawRibbon();
  drawRoll();
  requestAnimationFrame(renderLoop);
}

export function boot() {
  const params = new URLSearchParams(location.search);
  if (params.get('fresh') === '1') {
    ['onboarded', 'settings', 'templates'].forEach(k => store.del(k));
  }

  app.engine = new AudioEngine({
    onLevel: (rms) => {
      const pct = Math.min(100, Math.round((rms / 0.3) * 100));
      const setBar = (id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.style.width = pct + '%';
        el.classList.toggle('hot', pct > 85);
      };
      setBar('meter-fill');
      setBar('ob-meter-fill');
      const ls = $('#level-state');
      if (ls) {
        const ok = rms > app.engine.settings.gate;
        ls.textContent = ok ? 'Good level. I hear you.' : 'Make some noise…';
        ls.classList.toggle('good', ok);
      }
      feedTraining(rms);
    },
    onPitch: (midiFloat, cents) => {
      app.cents = cents;
      updateReadout(midiFloat, cents);
      if (!$('#studio').hidden) return;
      // Hum test readout (onboarding step 4).
      const r = fmtNote(midiFloat);
      $('#hum-note').textContent = r.letter + r.octave;
      if (app.lockedNote === null && Math.abs(cents) < 40) {
        app.stable = (app.stable || 0) + 1;
        if (app.stable > 20) {
          app.lockedNote = Math.round(midiFloat);
          $('#hum-status').textContent = 'Locked on. Nice.';
          $('#hum-status').classList.add('good');
          const b = $('#btn-start');
          b.disabled = false;
          b.textContent = 'Start playing';
        }
      } else if (Math.abs(cents) >= 40) {
        app.stable = 0;
      }
    },
    onNote: (midi, vel, on) => {
      const now = performance.now() / 1000;
      if (on) {
        app.roll.push({ midi, start: now, end: null, live: true });
        app.lastNote = midi;
        lightKey(midi, true);
        const r = fmtNote(midi);
        $('#now-playing').textContent = 'Now: ' + r.letter + r.octave;
      } else {
        const n = [...app.roll].reverse().find(n => n.midi === midi && n.end === null);
        if (n) { n.end = now; n.live = false; }
        if (app.lastNote === midi) { app.lastNote = null; lightKey(midi, false); }
        $('#now-playing').textContent = 'Now: —';
      }
      if (app.roll.length > 400) app.roll.splice(0, app.roll.length - 400);
      if (app.engine.recorder.recording) {
        $('#rec-count').textContent = 'Recording… ' + app.engine.recorder.count + ' notes';
      }
    },
    onDrum: (kind, vel) => flashPad(kind),
    onState: (s) => { $('#status-dot').className = 'dot ' + s; },
  });

  loadSettings();
  buildKeyboard();
  buildScaleControls();
  applySettingsToUI();

  /* onboarding wiring */
  $('#btn-begin').addEventListener('click', () => showStep(1));
  $('#ob-back').addEventListener('click', () => showStep(Math.max(0, app.step - 1)));
  $$('[data-skip]').forEach(b => b.addEventListener('click', enterStudio));
  $('#btn-mic').addEventListener('click', enableMic);
  $('#btn-to-level').addEventListener('click', () => showStep(2));
  $('#mic-select').addEventListener('change', (e) => {
    app.engine.stop();
    app.engine.startMic(e.target.value).catch(() => {});
  });
  $('#btn-to-hum').addEventListener('click', () => showStep(3));
  $('#btn-start').addEventListener('click', enterStudio);

  $('#btn-mic-studio').addEventListener('click', async () => {
    const btn = $('#btn-mic-studio');
    if (app.engine.running) {
      app.engine.stop();
    } else {
      btn.disabled = true;
      btn.textContent = 'Waiting for the browser…';
      try {
        await app.engine.startMic($('#mic-select-studio').value || null);
      } catch (e) {
        $('#mic-studio-status').textContent = 'The browser blocked microphone access. Allow it in the address bar and try again.';
      }
      btn.disabled = false;
    }
    refreshStudioMicUI();
  });
  $('#mic-select-studio').addEventListener('change', (e) => {
    app.engine.stop();
    app.engine.startMic(e.target.value).then(refreshStudioMicUI).catch(() => {});
  });

  /* studio wiring */
  $('#gain-range').addEventListener('input', (e) => {
    const g = (+e.target.value) / 1000;
    app.engine.setGate(g);
    $('#gain-val').textContent = (g * 100).toFixed(1) + '%';
    saveSettings();
  });
  $('#key-select').addEventListener('change', (e) => { app.engine.settings.key = +e.target.value; saveSettings(); });
  $('#scale-select').addEventListener('change', (e) => { app.engine.settings.scale = e.target.value; saveSettings(); });
  $('#tgl-quantize').addEventListener('change', (e) => { app.engine.settings.quantize = e.target.checked; saveSettings(); });
  $('#bend-select').addEventListener('change', (e) => { app.engine.settings.bend = e.target.value; saveSettings(); });
  $('#octave-select').addEventListener('change', (e) => { app.engine.settings.octave = +e.target.value; saveSettings(); });
  $('#tgl-drums').addEventListener('change', (e) => {
    app.engine.settings.drums = e.target.checked;
    $('#drum-strip').classList.toggle('off', !e.target.checked);
    saveSettings();
  });
  $('#tgl-velocity').addEventListener('change', (e) => { app.engine.settings.velocityOn = e.target.checked; saveSettings(); });
  $('#tgl-local').addEventListener('change', (e) => {
    app.engine.settings.localSound = e.target.checked;
    if (app.engine.synth) app.engine.synth.localOn = e.target.checked;
    saveSettings();
  });
  $('#midi-select').addEventListener('change', (e) => {
    const dev = app.engine.midi.select(e.target.value);
    if (dev) {
      // A real MIDI device takes over: mute the local synth to avoid doubling.
      app.engine.settings.localSound = false;
      app.engine.synth.localOn = false;
      $('#tgl-local').checked = false;
    }
    saveSettings();
  });
  $('#btn-panic').addEventListener('click', () => {
    app.engine.panic();
    app.roll.forEach(n => { if (n.end === null) n.end = performance.now() / 1000; n.live = false; });
    lightKey(-1, false);
    $('#now-playing').textContent = 'Now: —';
  });

  /* record + download */
  $('#btn-record').addEventListener('click', () => {
    const rec = app.engine.recorder;
    if (rec.recording) { rec.stop(); setRecording(false); }
    else { app.roll = []; rec.start(); setRecording(true); }
  });
  $('#btn-midi-dl').addEventListener('click', () => {
    const blob = app.engine.recorder.toBlob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'voxmidi-session.mid';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  });
  $('#btn-clear-roll').addEventListener('click', () => { app.roll = []; });

  /* drums */
  $('#btn-train').addEventListener('click', openTraining);
  $('#train-close').addEventListener('click', () => { $('#train-modal').hidden = true; app.training = null; });
  $('#train-reset').addEventListener('click', () => {
    store.del('templates');
    app.engine.setTemplates(JSON.parse(JSON.stringify(DEFAULT_TEMPLATES)));
    renderTrainRows();
  });
  // Drum pads are playable: tap to audition the sound.
  $$('#drum-strip .pad').forEach(p => {
    const kind = p.id.replace('pad-', '');
    p.addEventListener('pointerdown', async () => {
      await app.engine.init();
      app.engine.auditionDrum(kind);
      flashPad(kind);
    });
  });
  // Keyboard is playable too.
  $$('#keyboard .key').forEach(k => {
    const midi = +k.dataset.midi;
    k.addEventListener('pointerdown', async (e) => {
      e.preventDefault();
      await app.engine.init();
      app.engine.auditionNote(midi);
      lightKey(midi, true);
    });
    const off = () => { app.engine.auditionNoteOff(midi); if (app.lastNote !== midi) lightKey(midi, false); };
    k.addEventListener('pointerup', off);
    k.addEventListener('pointerleave', off);
  });

  /* help */
  $('#btn-help').addEventListener('click', () => { $('#help-modal').hidden = false; });
  $('#help-close').addEventListener('click', () => { $('#help-modal').hidden = true; });
  $$('.modal').forEach(m => m.addEventListener('click', (e) => {
    if (e.target === m) m.hidden = true;
  }));

  window.addEventListener('resize', sizeCanvases);

  // Skip onboarding if done before, or via ?screen=studio (screenshots/demo).
  if (params.get('screen') === 'studio' || store.get('onboarded', false)) {
    enterStudio();
  } else {
    showStep(0);
  }

  refreshMidiUI();
  renderLoop();
  window.voxmidi = app; // for scripted testing
}

document.addEventListener('DOMContentLoaded', boot);

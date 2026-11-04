/* VOXMIDI UI: setup wizard and the three-tab studio (Play, Train, Setup).
 * The DSP lives in engine.js, pitch.js and drums.js; this file only wires
 * the engine to the screen. */
import { AudioEngine, SCALES, NOTE_NAMES } from './engine.js';
import { midiToName } from './pitch.js';
import { PitchWheel } from './wheel.js';
import { Keyboard } from './keyboard.js';
import { Trainer } from './train.js';
import { PitchClassHistogram, detectKey } from './key.js';
import { KINDS, sanitizeBank, buildTemplates } from './pads.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const hot = {}; // elements touched every analysis frame
const cached = (s) => (hot[s] ??= $(s));

const store = {
  get(k, d) { try { const v = localStorage.getItem('voxmidi.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('voxmidi.' + k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem('voxmidi.' + k); } catch (e) {} },
};

const VOICE_HOLD_MS = 160;     // how long the needle lingers after the last voiced frame
const KEY_MIN_FRAMES = 80;     // about one second of voiced audio before Find key answers
const KEY_MIN_SCORE = 0.5;

const app = {
  engine: null,
  wheel: null,
  keyboard: null,
  trainer: null,
  bank: null,
  tab: 'play',
  midiReady: false,
  pendingMidi: null,       // saved MIDI output id, selected once devices appear
  // live voice state for the wheel
  voice: null,             // continuous pitch (midi float) of the last voiced frame
  voiceAt: 0,
  cents: 0,
  level: 0,
  activeNote: null,        // sounding note after Stay in key and octave
  humNote: null, humCount: 0, humLocked: false,
  hist: new PitchClassHistogram(),
  histFrames: 0,
  recStart: 0,
  ariaNote: '',
};

function noteLabel(midi) {
  const n = midiToName(Math.round(midi));
  return { name: n, pc: ((Math.round(midi) % 12) + 12) % 12 };
}

/* ---------------- settings ---------------- */

function saveSettings() {
  const s = app.engine.settings;
  store.set('settings', {
    gate: s.gate, key: s.key, scale: s.scale, quantize: s.quantize,
    bend: s.bend, octave: s.octave, velocityOn: s.velocityOn, localSound: s.localSound,
    drums: app.trainer && app.trainer.recording ? app.trainer.savedDrums : s.drums,
    midiOut: app.engine.midi.output ? app.engine.midi.output.id : null,
  });
}

function loadSettings() {
  const saved = store.get('settings', null);
  if (saved) {
    const { midiOut, ...rest } = saved;
    for (const k of Object.keys(app.engine.settings)) if (k in rest) app.engine.settings[k] = rest[k];
    if (!SCALES[app.engine.settings.scale]) app.engine.settings.scale = 'Major';
    app.pendingMidi = midiOut || null;
  }
  app.bank = sanitizeBank(store.get('pads', null));
  app.engine.setGate(app.engine.settings.gate);
  app.engine.setTemplates(buildTemplates(app.bank));
}

function applySettingsToUI() {
  const s = app.engine.settings;
  $('#key-select').value = s.key;
  $('#scale-select').value = s.scale;
  $('#octave-select').value = s.octave;
  $('#gain-range').value = Math.round(s.gate * 1000);
  $('#gain-val').textContent = (s.gate * 100).toFixed(1) + '%';
  $('#tgl-quantize').checked = s.quantize;
  $('#bend-select').value = s.bend;
  $('#tgl-velocity').checked = s.velocityOn;
  $('#tgl-drums').checked = s.drums;
  $('#tgl-local').checked = s.localSound;
  paintDrumsState();
}

function inScalePcs() {
  const s = app.engine.settings;
  return new Set((SCALES[s.scale] || SCALES.Chromatic).map(i => (s.key + i) % 12));
}

function paintScale() {
  app.keyboard.setScale(inScalePcs(), app.engine.settings.key);
}

function paintDrumsState() {
  const on = app.engine.settings.drums || (app.trainer && app.trainer.recording);
  $('#pads').classList.toggle('off', !on);
  $('#drums-off-note').hidden = !!on;
}

function applyBank() {
  store.set('pads', app.bank);
  app.engine.setTemplates(buildTemplates(app.bank));
  paintPadMeta();
}

function paintPadMeta() {
  for (const kind of KINDS) {
    const n = app.bank[kind].length;
    $(`[data-meta="${kind}"]`).textContent = n ? `${n} ${n === 1 ? 'take' : 'takes'}` : 'Default';
  }
}

/* ---------------- status ---------------- */

function refreshStatus() {
  const e = app.engine;
  const mic = $('#st-mic');
  mic.textContent = e.running ? 'Mic live' : 'Mic off';
  mic.className = e.running ? 'on' : 'off';
  const s = e.settings;
  $('#st-out').textContent = e.midi.output ? 'MIDI: ' + (e.midi.output.name || 'device')
    : s.localSound ? 'Built-in synth' : 'No output';
  $('#btn-mic-play').hidden = e.running;
}

function fillSelect(sel, items, current) {
  sel.innerHTML = '';
  for (const it of items) {
    const o = document.createElement('option');
    o.value = it.id; o.textContent = it.label;
    sel.appendChild(o);
  }
  if (current && items.some(i => i.id === current)) sel.value = current;
}

async function refreshMicUI() {
  const e = app.engine;
  $('#btn-mic-studio').textContent = e.running ? 'Stop microphone' : 'Enable microphone';
  $('#mic-studio-status').textContent = e.running ? 'Microphone is live.' : 'Microphone is off.';
  $('#train-mic-note').hidden = e.running;
  if (!e.running) $('#mic-studio-field').hidden = true;
  refreshStatus();
  if (app.trainer) app.trainer.render();
  if (e.running) {
    try {
      const mics = await e.listMics();
      const track = e.stream && e.stream.getAudioTracks()[0];
      const cur = track && track.getSettings().deviceId;
      fillSelect($('#mic-select-studio'), mics, cur);
      $('#mic-studio-field').hidden = mics.length < 2;
    } catch (err) { /* device list is optional */ }
  }
}

async function startMicFrom(select) {
  await app.engine.startMic(select.value || null);
}

async function toggleStudioMic() {
  const btn = $('#btn-mic-studio');
  if (app.engine.running) {
    if (app.trainer) app.trainer.disarm(true);
    app.engine.stop();
  } else {
    btn.disabled = true;
    try {
      await startMicFrom($('#mic-select-studio'));
    } catch (err) {
      $('#mic-studio-status').textContent = 'The browser blocked the microphone. Allow it in the address bar and try again.';
    }
    btn.disabled = false;
  }
  refreshMicUI();
}

/* ---------------- setup wizard ---------------- */

const STEPS = ['mic', 'level', 'hum'];

function showStep(i) {
  $$('.ob-step').forEach(el => { el.hidden = true; });
  $('#ob-' + STEPS[i]).hidden = false;
  $$('.ob-steps li').forEach((li, j) => li.classList.toggle('on', j <= i));
}

async function enableMicWizard() {
  const btn = $('#btn-mic');
  btn.disabled = true;
  btn.textContent = 'Waiting for the browser';
  try {
    await startMicFrom($('#mic-select'));
    const mics = await app.engine.listMics();
    const track = app.engine.stream.getAudioTracks()[0];
    fillSelect($('#mic-select'), mics, track && track.getSettings().deviceId);
    $('#mic-select').hidden = $('#mic-select-label').hidden = mics.length < 2;
    showStep(1);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Enable microphone';
    const msg = $('#mic-error');
    msg.hidden = false;
    msg.textContent = 'The browser blocked the microphone. Click the icon in the address bar, allow it, then try again.';
  }
}

/** Hum test: lock when the same note holds for about a third of a second. */
function humFrame(midiFloat) {
  if (app.humLocked) return;
  const { name } = noteLabel(midiFloat);
  const n = Math.round(midiFloat);
  app.humCount = n === app.humNote ? app.humCount + 1 : 1;
  app.humNote = n;
  $('#hum-note').textContent = name;
  if (app.humCount >= 24) {
    app.humLocked = true;
    $('#hum-status').textContent = 'Locked on ' + name + '.';
    $('#hum-status').classList.add('good');
    $('#btn-start').disabled = false;
  }
}

function enterStudio() {
  store.set('onboarded', true);
  $('#onboarding').hidden = true;
  $('#studio').hidden = false;
  app.wheel.resize();
  app.trainer.resizeMap();
  refreshMicUI();
  app.engine.ui.onState(app.engine.running ? 'live' : 'idle');
}

/* ---------------- tabs ---------------- */

const TABS = ['play', 'train', 'setup'];

function selectTab(name, focus = false) {
  if (app.tab === 'train' && name !== 'train') app.trainer.disarm(true);
  app.tab = name;
  for (const t of TABS) {
    const btn = $('#tabbtn-' + t), on = t === name;
    btn.setAttribute('aria-selected', String(on));
    btn.tabIndex = on ? 0 : -1;
    $('#tab-' + t).hidden = !on;
    if (on && focus) btn.focus();
  }
  if (name === 'play') app.wheel.resize();
  if (name === 'train') app.trainer.resizeMap();
  if (name === 'setup') enableMidi();
  paintDrumsState();
}

/* ---------------- MIDI ---------------- */

/** Web MIDI is requested the first time Setup opens (or at once if a device was saved),
 *  so browsers that prompt for MIDI do not do it before the user asks. */
async function enableMidi() {
  if (app.midiReady) return;
  app.midiReady = true;
  const midi = app.engine.midi;
  const ok = await midi.enable();
  if (!ok) {
    $('#midi-select-wrap').hidden = true;
    $('#midi-status').textContent = midi.supported
      ? 'MIDI access was denied. The built-in synth still plays.'
      : 'This browser has no MIDI output. The built-in synth and MIDI download still work.';
    refreshStatus();
    return;
  }
  midi.onDevices = (list) => {
    const sel = $('#midi-select');
    const cur = sel.value || app.pendingMidi || '';
    fillSelect(sel, [{ id: '', label: 'None (built-in synth)' }, ...list.map(d => ({ id: d.id, label: d.name }))], cur);
    if (app.pendingMidi && list.some(d => d.id === app.pendingMidi)) {
      midi.select(app.pendingMidi);
      app.pendingMidi = null;
    } else if (!list.some(d => d.id === midi.output?.id)) {
      sel.value = '';
    }
    $('#midi-status').textContent = list.length
      ? `${list.length} MIDI ${list.length === 1 ? 'output' : 'outputs'} found.`
      : 'No MIDI outputs found. Connect a device or a virtual MIDI port.';
    refreshStatus();
  };
  midi._emit();
}

/* ---------------- pads ---------------- */

function flashPad(kind, vel) {
  const pad = $(`.pad[data-kind="${kind}"]`);
  pad.style.setProperty('--v', (Math.max(20, vel) / 127).toFixed(2));
  pad.classList.remove('hit');
  void pad.offsetWidth; // restart the animation
  pad.classList.add('hit');
}

function wirePads() {
  $$('.pad').forEach(pad => {
    const kind = pad.dataset.kind;
    pad.addEventListener('pointerdown', async (e) => {
      e.preventDefault();
      const r = pad.getBoundingClientRect();
      const vel = Math.round(50 + 77 * Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)));
      await app.engine.init();
      app.engine.auditionDrum(kind, vel);
      flashPad(kind, vel);
    });
    pad.addEventListener('keydown', async (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
        e.preventDefault();
        await app.engine.init();
        app.engine.auditionDrum(kind, 100);
        flashPad(kind, 100);
      }
    });
  });
}

/* ---------------- key finder ---------------- */

function findKey() {
  const msg = $('#findkey-msg');
  if (app.histFrames < KEY_MIN_FRAMES) {
    msg.textContent = app.engine.running ? 'Not enough yet. Sing a longer phrase.' : 'Turn the microphone on first.';
    return;
  }
  const r = detectKey(app.hist.bins);
  if (!r) { msg.textContent = 'Heard fewer than three different notes. Sing a phrase with some movement.'; return; }
  if (r.score < KEY_MIN_SCORE) { msg.textContent = 'No clear key in that phrase. Try again.'; return; }
  const s = app.engine.settings;
  s.key = r.key; s.scale = r.scale;
  applySettingsToUI();
  paintScale();
  saveSettings();
  msg.textContent = `${NOTE_NAMES[r.key]} ${r.scale === 'Major' ? 'major' : 'minor'}. Key and scale set.`;
  app.hist.reset();
  app.histFrames = 0;
}

/* ---------------- recording ---------------- */

function fmtTime(sec) {
  return Math.floor(sec / 60) + ':' + String(Math.floor(sec % 60)).padStart(2, '0');
}

function paintSession() {
  const rec = app.engine.recorder;
  const n = rec.count;
  const on = rec.recording;
  $('#btn-record').classList.toggle('on', on);
  $('#btn-record').setAttribute('aria-pressed', String(on));
  $('.sessionbar').classList.toggle('recording', on);
  $('#rec-count').textContent = on ? `Recording, ${n} ${n === 1 ? 'note' : 'notes'}`
    : n ? `${n} ${n === 1 ? 'note' : 'notes'} recorded` : 'No recording';
  $('#btn-midi-dl').disabled = on || n === 0;
  $('#btn-clear').disabled = on || n === 0;
  if (!on) $('#rec-label').textContent = 'Rec';
}

function toggleRecord() {
  const rec = app.engine.recorder;
  if (rec.recording) {
    // Close a held voice note so the file has no hanging note-on.
    if (app.engine.soundingNote !== null) rec.noteOff(app.engine.soundingNote);
    rec.stop();
  } else {
    rec.start();
    app.recStart = performance.now();
  }
  paintSession();
}

function downloadMidi() {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(app.engine.recorder.toBlob());
  a.download = 'voxmidi-session.mid';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/* ---------------- engine callbacks ---------------- */

function makeEngine() {
  return new AudioEngine({
    onLevel: (rms) => {
      app.level = rms;
      const pct = Math.min(100, Math.round((rms / 0.3) * 100));
      const clip = pct > 85;
      if (!cached('#onboarding').hidden) {
        const wiz = cached('#ob-meter-fill');
        wiz.style.width = pct + '%';
        wiz.classList.toggle('hot', clip);
        const ok = rms > app.engine.settings.gate;
        cached('#level-state').textContent = ok ? 'Good level.' : 'No signal yet.';
        cached('#level-state').classList.toggle('good', ok);
      } else {
        const fill = cached('#in-fill');
        fill.style.width = pct + '%';
        fill.classList.toggle('hot', clip);
      }
      app.trainer && app.trainer.feed(rms);
    },
    onPitch: (midiFloat, cents) => {
      const now = performance.now();
      app.voice = midiFloat; app.voiceAt = now; app.cents = cents;
      app.wheel.pushPitch(midiFloat, now);
      app.hist.add(midiFloat); app.histFrames++;
      if (!$('#onboarding').hidden && !$('#ob-hum').hidden) humFrame(midiFloat);
    },
    onNote: (midi, vel, on) => {
      app.activeNote = on ? midi : null;
      app.keyboard.setVoiceNote(on ? midi : null);
      if (app.engine.recorder.recording) paintSession();
    },
    onDrum: (kind, vel) => {
      flashPad(kind, vel);
      app.trainer.flash(kind);
      if (app.engine.recorder.recording) paintSession();
    },
    onState: (s) => {
      if (s === 'idle') {
        app.voice = null; app.activeNote = null; app.level = 0;
        app.keyboard && app.keyboard.setVoiceNote(null);
        const fill = $('#in-fill'); if (fill) fill.style.width = '0';
      }
      refreshStatus();
    },
  });
}

/* ---------------- render loop ---------------- */

function wheelState(now) {
  const e = app.engine;
  const voiced = app.voice !== null && now - app.voiceAt < VOICE_HOLD_MS;
  const active = app.activeNote;
  let label, sub = '';
  if (active !== null) { label = noteLabel(active).name; sub = (app.cents >= 0 ? '+' : '') + Math.round(app.cents) + ' ct'; }
  else if (voiced) { label = noteLabel(app.voice).name; sub = (app.cents >= 0 ? '+' : '') + Math.round(app.cents) + ' ct'; }
  else if (!e.running) { label = 'Mic off'; }
  else { label = 'Listening'; }
  if (label !== app.ariaNote) {
    app.ariaNote = label;
    $('#wheel').setAttribute('aria-label', 'Pitch wheel: ' + label);
  }
  return {
    inScale: inScalePcs(), root: e.settings.key,
    activePc: active !== null ? active % 12 : null,
    voice: voiced ? app.voice : null,
    cents: app.cents, label, sub,
    level: Math.min(1, app.level / 0.25), now,
  };
}

function frame() {
  const now = performance.now();
  if (!$('#studio').hidden) {
    if (app.tab === 'play') app.wheel.draw(wheelState(now));
    const rec = app.engine.recorder;
    if (rec.recording) $('#rec-label').textContent = fmtTime((now - app.recStart) / 1000);
  }
  requestAnimationFrame(frame);
}

/* ---------------- boot ---------------- */

function populate() {
  fillSelect($('#key-select'), NOTE_NAMES.map((n, i) => ({ id: String(i), label: n })));
  fillSelect($('#scale-select'), Object.keys(SCALES).map(s => ({ id: s, label: s })));
}

function wire() {
  /* wizard */
  $('#btn-mic').addEventListener('click', enableMicWizard);
  $('#mic-select').addEventListener('change', () => {
    app.engine.stop();
    startMicFrom($('#mic-select')).catch(() => {});
  });
  $('#btn-to-hum').addEventListener('click', () => showStep(2));
  $('#btn-start').addEventListener('click', enterStudio);
  $$('[data-skip]').forEach(b => b.addEventListener('click', enterStudio));

  /* tabs */
  TABS.forEach(t => $('#tabbtn-' + t).addEventListener('click', () => selectTab(t)));
  $('.tabstrip').addEventListener('keydown', (e) => {
    const i = TABS.indexOf(app.tab);
    const next = { ArrowRight: TABS[(i + 1) % TABS.length], ArrowLeft: TABS[(i + TABS.length - 1) % TABS.length],
      Home: TABS[0], End: TABS[TABS.length - 1] }[e.key];
    if (next) { e.preventDefault(); selectTab(next, true); }
  });

  /* transport */
  $('#btn-record').addEventListener('click', toggleRecord);
  $('#btn-midi-dl').addEventListener('click', downloadMidi);
  $('#btn-clear').addEventListener('click', () => { app.engine.recorder.reset(); paintSession(); });
  $('#btn-panic').addEventListener('click', () => {
    app.engine.panic();
    app.keyboard.releaseAll();
    app.activeNote = null;
  });

  /* play controls */
  const keyScale = () => { paintScale(); saveSettings(); };
  $('#key-select').addEventListener('change', (e) => { app.engine.settings.key = +e.target.value; keyScale(); });
  $('#scale-select').addEventListener('change', (e) => { app.engine.settings.scale = e.target.value; keyScale(); });
  $('#octave-select').addEventListener('change', (e) => { app.engine.settings.octave = +e.target.value; saveSettings(); });
  $('#gain-range').addEventListener('input', (e) => {
    const g = +e.target.value / 1000;
    app.engine.setGate(g);
    $('#gain-val').textContent = (g * 100).toFixed(1) + '%';
    saveSettings();
  });
  $('#btn-findkey').addEventListener('click', findKey);
  $('#btn-mic-play').addEventListener('click', toggleStudioMic);
  $('#btn-drums-on').addEventListener('click', () => {
    app.engine.settings.drums = true;
    $('#tgl-drums').checked = true;
    paintDrumsState(); saveSettings();
  });

  /* setup */
  $('#btn-mic-studio').addEventListener('click', toggleStudioMic);
  $('#btn-train-mic').addEventListener('click', toggleStudioMic);
  $('#mic-select-studio').addEventListener('change', () => {
    app.engine.stop();
    startMicFrom($('#mic-select-studio')).then(refreshMicUI).catch(refreshMicUI);
  });
  $('#tgl-quantize').addEventListener('change', (e) => { app.engine.settings.quantize = e.target.checked; saveSettings(); });
  $('#bend-select').addEventListener('change', (e) => { app.engine.settings.bend = e.target.value; saveSettings(); });
  $('#tgl-velocity').addEventListener('change', (e) => { app.engine.settings.velocityOn = e.target.checked; saveSettings(); });
  $('#tgl-drums').addEventListener('change', (e) => { app.engine.settings.drums = e.target.checked; paintDrumsState(); saveSettings(); });
  $('#tgl-local').addEventListener('change', (e) => setLocalSound(e.target.checked));
  $('#midi-select').addEventListener('change', (e) => {
    const dev = app.engine.midi.select(e.target.value);
    // A hardware or DAW target replaces the built-in synth; choosing none brings it back.
    setLocalSound(!dev);
    app.engine.midi.panic();
  });
  $('#btn-reset-all').addEventListener('click', () => {
    if (!confirm('Reset all settings and trained pads on this device?')) return;
    ['onboarded', 'settings', 'pads'].forEach(k => store.del(k));
    location.reload();
  });

  /* train */
  $('#train-reset').addEventListener('click', () => app.trainer.clearAll());

  /* canvases follow their boxes */
  const ro = new ResizeObserver(() => { app.wheel.resize(); app.trainer.resizeMap(); });
  ro.observe($('.wheel-wrap'));
  ro.observe($('#map'));
}

function setLocalSound(on) {
  app.engine.settings.localSound = on;
  if (app.engine.synth) app.engine.synth.localOn = on;
  $('#tgl-local').checked = on;
  refreshStatus();
  saveSettings();
}

export function boot() {
  app.engine = makeEngine();
  loadSettings();
  populate();

  app.wheel = new PitchWheel($('#wheel'));
  app.keyboard = new Keyboard($('#keyboard'), {
    down: async (midi, vel) => { await app.engine.init(); app.engine.auditionNote(midi, vel); },
    up: (midi) => app.engine.auditionNoteOff(midi),
  });
  app.trainer = new Trainer({
    engine: app.engine, bank: app.bank,
    rowsEl: $('#train-rows'), mapEl: $('#map'), hintEl: $('#train-hint'),
    onChange: applyBank,
    onArm: () => paintDrumsState(),
  });

  applySettingsToUI();
  paintScale();
  paintPadMeta();
  paintSession();
  wirePads();
  wire();

  if (store.get('onboarded', false)) {
    enterStudio();
    if (app.pendingMidi) enableMidi();
  } else {
    showStep(0);
  }
  frame();
}

document.addEventListener('DOMContentLoaded', boot);

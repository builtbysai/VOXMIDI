/* Train tab: record up to 12 takes per pad. Capture uses the engine's own
 * onset gate (OnsetDetector.isOnset) and feature extraction, so a take is the
 * exact frame the live classifier would see for that hit. */
import { OnsetDetector, extractFeatures, DEFAULT_TEMPLATES } from './drums.js';
import { KINDS, MAX_TAKES, addTake, removeTake } from './pads.js';

const LABEL = { kick: 'Kick', snare: 'Snare', hat: 'Hat' };
const F_LO = 60, F_HI = 16000;

export class Trainer {
  /**
   * engine: AudioEngine. bank: pads bank. onChange(): bank edited (persist + apply).
   * onArm(bool): recording started or stopped.
   */
  constructor({ engine, bank, rowsEl, mapEl, hintEl, onChange, onArm }) {
    this.engine = engine;
    this.bank = bank;
    this.rowsEl = rowsEl;
    this.mapEl = mapEl;
    this.hintEl = hintEl;
    this.onChange = onChange;
    this.onArm = onArm;
    this.armed = null;       // pad kind being recorded, or null
    this.savedDrums = true;  // drums setting to restore after recording
    this.detector = null;
    this.lastTake = null;    // {kind, index} for map emphasis
    this.render();
  }

  get recording() { return this.armed !== null; }

  arm(kind) {
    if (!this.engine.running || this.bank[kind].length >= MAX_TAKES) return;
    if (this.armed) this.disarm(true);
    this.savedDrums = this.engine.settings.drums;
    this.engine.settings.drums = false; // keep the live classifier quiet while training
    this.detector = new OnsetDetector(() => {}, { sampleRate: this.engine.sampleRate });
    this.armed = kind;
    this.onArm(true);
    this.hint(`Recording ${LABEL[kind].toLowerCase()} takes. Make the sound.`);
    this.render();
  }

  disarm(silent = false) {
    if (!this.armed) return;
    this.armed = null;
    this.engine.settings.drums = this.savedDrums;
    this.onArm(false);
    if (!silent) this.hint('');
    this.render();
  }

  hint(text) { this.hintEl.textContent = text; }

  /** Called every analysis frame with the frame's RMS. */
  feed(rms) {
    if (!this.armed) return;
    const now = performance.now();
    if (!this.detector.isOnset(rms, now)) return;
    const feat = extractFeatures(this.engine.frame, this.engine.sampleRate);
    if (!feat) return;
    this.detector.markHit(now);
    const kind = this.armed;
    if (addTake(this.bank, kind, feat)) {
      this.lastTake = { kind, index: this.bank[kind].length - 1 };
      this.onChange();
      const n = this.bank[kind].length;
      if (n >= MAX_TAKES) { this.disarm(true); this.hint(`${LABEL[kind]} is full at ${MAX_TAKES} takes.`); }
      else this.hint(`${LABEL[kind]}: take ${n} of ${MAX_TAKES}.`);
      this.render();
    }
  }

  /** A live hit from the engine: light the matching row so you can test. */
  flash(kind) {
    const row = this.rowsEl.querySelector(`[data-row="${kind}"]`);
    if (!row) return;
    row.classList.add('hit');
    clearTimeout(this._flashT);
    this._flashT = setTimeout(() => row.classList.remove('hit'), 220);
  }

  clear(kind) {
    if (this.armed === kind) this.disarm(true);
    this.bank[kind].length = 0;
    this.lastTake = null;
    this.onChange();
    this.hint('');
    this.render();
  }

  clearAll() {
    this.disarm(true);
    for (const k of KINDS) this.bank[k].length = 0;
    this.lastTake = null;
    this.onChange();
    this.hint('');
    this.render();
  }

  render() {
    this.rowsEl.innerHTML = '';
    const live = this.engine.running;
    for (const kind of KINDS) {
      const takes = this.bank[kind];
      const row = document.createElement('div');
      row.className = 'train-row';
      row.dataset.row = kind;

      const name = document.createElement('div');
      name.className = 'train-name';
      name.textContent = LABEL[kind];
      const sub = document.createElement('small');
      sub.textContent = takes.length ? `${takes.length} of ${MAX_TAKES}` : 'Default';
      name.appendChild(sub);

      const slots = document.createElement('div');
      slots.className = 'slots';
      for (let i = 0; i < MAX_TAKES; i++) {
        const s = document.createElement('button');
        s.type = 'button';
        s.className = 'slot' + (i < takes.length ? ' full' : '');
        if (i < takes.length) {
          s.setAttribute('aria-label', `Remove ${LABEL[kind].toLowerCase()} take ${i + 1}`);
          s.addEventListener('click', () => {
            removeTake(this.bank, kind, i);
            this.lastTake = null;
            this.onChange();
            this.render();
          });
        } else {
          s.disabled = true;
          s.setAttribute('aria-hidden', 'true');
          s.tabIndex = -1;
        }
        slots.appendChild(s);
      }

      const rec = document.createElement('button');
      rec.type = 'button';
      rec.className = 'tbtn' + (this.armed === kind ? ' armed' : '');
      rec.textContent = this.armed === kind ? 'Stop' : 'Record';
      rec.disabled = !live || (this.armed !== kind && takes.length >= MAX_TAKES);
      rec.addEventListener('click', () => (this.armed === kind ? this.disarm() : this.arm(kind)));

      const clr = document.createElement('button');
      clr.type = 'button';
      clr.className = 'tbtn';
      clr.textContent = 'Clear';
      clr.disabled = !takes.length;
      clr.addEventListener('click', () => this.clear(kind));

      const actions = document.createElement('div');
      actions.className = 'btn-row';
      actions.style.margin = '0';
      actions.append(rec, clr);

      row.append(name, slots, actions);
      this.rowsEl.appendChild(row);
    }
    this.drawMap();
  }

  resizeMap() {
    const r = this.mapEl.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.mapEl.width = Math.round(r.width * dpr);
    this.mapEl.height = Math.round(r.height * dpr);
    this.drawMap();
  }

  /** Spectral centroid (log axis) for every take, one lane per pad. */
  drawMap() {
    const c = this.mapEl;
    if (!c.width) return;
    const g = c.getContext('2d');
    const W = c.width, H = c.height;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const css = getComputedStyle(document.documentElement);
    const col = (n) => css.getPropertyValue(n).trim();
    g.clearRect(0, 0, W, H);
    const left = 54 * dpr, right = W - 10 * dpr, top = 8 * dpr, axisH = 22 * dpr;
    const laneH = (H - top - axisH) / KINDS.length;
    const xOf = (hz) => left + (Math.log(Math.max(F_LO, Math.min(F_HI, hz)) / F_LO) / Math.log(F_HI / F_LO)) * (right - left);
    g.font = `${11 * dpr}px ui-monospace, Menlo, Consolas, monospace`;
    g.textBaseline = 'middle';

    // Frequency grid.
    g.textAlign = 'center';
    for (const hz of [100, 300, 1000, 3000, 10000]) {
      const x = xOf(hz);
      g.strokeStyle = col('--line'); g.lineWidth = 1;
      g.beginPath(); g.moveTo(x, top); g.lineTo(x, H - axisH); g.stroke();
      g.fillStyle = col('--faint');
      g.fillText(hz >= 1000 ? hz / 1000 + 'k' : String(hz), x, H - axisH / 2);
    }
    KINDS.forEach((kind, i) => {
      const y = top + laneH * i + laneH / 2;
      g.textAlign = 'left';
      g.fillStyle = col('--dim');
      g.fillText(LABEL[kind], 0, y);
      g.strokeStyle = col('--line');
      g.beginPath(); g.moveTo(left, y); g.lineTo(right, y); g.stroke();
      const takes = this.bank[kind];
      if (!takes.length) { // untrained: hollow marker at the built-in sound
        g.strokeStyle = col('--faint'); g.lineWidth = 1.5 * dpr;
        g.beginPath(); g.arc(xOf(DEFAULT_TEMPLATES[kind].centroid), y, 5 * dpr, 0, Math.PI * 2); g.stroke();
        g.lineWidth = 1;
      }
      takes.forEach((t, j) => {
        const x = xOf(t.centroid);
        const latest = this.lastTake && this.lastTake.kind === kind && this.lastTake.index === j;
        g.fillStyle = col('--teal');
        g.beginPath(); g.arc(x, y, (latest ? 7 : 5) * dpr, 0, Math.PI * 2); g.fill();
        if (latest) {
          g.strokeStyle = col('--ink'); g.lineWidth = 2 * dpr;
          g.beginPath(); g.arc(x, y, 10 * dpr, 0, Math.PI * 2); g.stroke();
          g.lineWidth = 1;
        }
      });
    });
  }
}

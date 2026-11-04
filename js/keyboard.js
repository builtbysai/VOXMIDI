/* Playable two-octave keyboard (C3 to B4). Press, or drag across keys to glide.
 * Where you press sets velocity: the lower on the key, the harder. */
import { midiToName } from './pitch.js';

const FIRST = 48, LAST = 71;
const BLACK = new Set([1, 3, 6, 8, 10]);

export class Keyboard {
  /** handlers: {down(midi, velocity), up(midi)} */
  constructor(el, handlers) {
    this.el = el;
    this.h = handlers;
    this.keys = new Map();     // midi -> element
    this.held = new Set();     // notes held by pointer or key press
    this.voiceNote = null;     // note sounding from the voice
    this.pointers = new Map(); // pointerId -> midi
    this._build();
    this._wire();
  }

  _build() {
    const whites = [];
    for (let m = FIRST; m <= LAST; m++) if (!BLACK.has(m % 12)) whites.push(m);
    const wW = 100 / whites.length;
    for (let m = FIRST; m <= LAST; m++) {
      const black = BLACK.has(m % 12);
      const name = midiToName(m);
      const k = document.createElement('button');
      k.type = 'button';
      k.className = 'key ' + (black ? 'black' : 'white');
      k.dataset.midi = m;
      k.setAttribute('aria-label', name);
      if (black) {
        const before = whites.filter(w => w < m).length;
        k.style.width = (wW * 0.62) + '%';
        k.style.left = (before * wW - wW * 0.31) + '%';
      } else {
        const lbl = document.createElement('span');
        lbl.className = 'klabel'; lbl.setAttribute('aria-hidden', 'true');
        lbl.textContent = name;
        k.appendChild(lbl);
      }
      this.keys.set(m, k);
    }
    // White keys first so black keys paint over them regardless of DOM order.
    for (const [m, k] of this.keys) if (!BLACK.has(m % 12)) this.el.appendChild(k);
    for (const [m, k] of this.keys) if (BLACK.has(m % 12)) this.el.appendChild(k);
  }

  _velocityAt(key, clientY) {
    const r = key.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (clientY - r.top) / r.height));
    return Math.round(45 + 82 * f);
  }

  _press(midi, vel) {
    if (this.held.has(midi)) return;
    this.held.add(midi);
    this.h.down(midi, vel);
    this._paint();
  }

  _release(midi) {
    if (!this.held.delete(midi)) return;
    this.h.up(midi);
    this._paint();
  }

  _wire() {
    const keyAt = (x, y) => {
      const e = document.elementFromPoint(x, y);
      return e && e.closest ? e.closest('.key') : null;
    };
    this.el.addEventListener('pointerdown', (e) => {
      const k = e.target.closest('.key');
      if (!k) return;
      e.preventDefault();
      this.el.setPointerCapture(e.pointerId);
      const m = +k.dataset.midi;
      this.pointers.set(e.pointerId, m);
      this._press(m, this._velocityAt(k, e.clientY));
    });
    this.el.addEventListener('pointermove', (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      const k = keyAt(e.clientX, e.clientY);
      if (!k) return;
      const m = +k.dataset.midi, prev = this.pointers.get(e.pointerId);
      if (m === prev) return;
      this.pointers.set(e.pointerId, m);
      this._press(m, this._velocityAt(k, e.clientY));
      this._release(prev);
    });
    const end = (e) => {
      const m = this.pointers.get(e.pointerId);
      if (m === undefined) return;
      this.pointers.delete(e.pointerId);
      this._release(m);
    };
    this.el.addEventListener('pointerup', end);
    this.el.addEventListener('pointercancel', end);
    this.el.addEventListener('lostpointercapture', end);

    // Keyboard users: Enter or Space holds the focused key.
    this.el.addEventListener('keydown', (e) => {
      const k = e.target.closest('.key');
      if (k && (e.key === 'Enter' || e.key === ' ') && !e.repeat) {
        e.preventDefault();
        this._press(+k.dataset.midi, 100);
      }
    });
    this.el.addEventListener('keyup', (e) => {
      const k = e.target.closest('.key');
      if (k && (e.key === 'Enter' || e.key === ' ')) this._release(+k.dataset.midi);
    });
    this.el.addEventListener('focusout', (e) => {
      const k = e.target.closest && e.target.closest('.key');
      if (k && !this.pointers.size) this._release(+k.dataset.midi);
    });
  }

  /** Light the key for the note the voice is playing, or null. */
  setVoiceNote(midi) { this.voiceNote = midi; this._paint(); }

  /** Mark scale degrees (set of pitch classes) and the root. */
  setScale(inScale, root) {
    for (const [m, k] of this.keys) {
      const pc = m % 12;
      k.classList.toggle('inscale', inScale.has(pc));
      k.classList.toggle('root', pc === root);
    }
  }

  releaseAll() {
    this.pointers.clear();
    for (const m of [...this.held]) this._release(m);
    this.voiceNote = null;
    this._paint();
  }

  _paint() {
    for (const [m, k] of this.keys) {
      k.classList.toggle('active', this.held.has(m) || m === this.voiceNote);
    }
  }
}

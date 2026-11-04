/* Pitch wheel: twelve pitch classes on a ring, C at the top, clockwise by semitone.
 *  - Lit sector: the note that is sounding (after Stay in key).
 *  - Needle and trail: where the voice actually is, so bends and slides read.
 *  - Amber labels: notes in the chosen key and scale. The root carries a tick.
 *  - Inner arc: input loudness, which is what drives velocity. */
import { NOTE_NAMES } from './engine.js';

const TAU = Math.PI * 2;
const SEG = TAU / 12;
const TRAIL_MS = 700;

export class PitchWheel {
  constructor(canvas) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    const css = getComputedStyle(document.documentElement);
    const v = (n) => css.getPropertyValue(n).trim();
    this.c = {
      surface: v('--surface-2'), line: v('--line'), amber: v('--amber'), amberLow: v('--amber-low'),
      amberInk: v('--amber-ink'), ink: v('--ink'), dim: v('--dim'), faint: v('--faint'), bg: v('--bg'),
    };
    this.font = getComputedStyle(document.body).fontFamily;
    this.trail = []; // {pos: 0..12 pitch-class position, t}
    this.level = 0;  // smoothed 0..1
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
  }

  /** Record the voice position for the needle trail. */
  pushPitch(midiFloat, now) {
    const pos = ((midiFloat % 12) + 12) % 12;
    this.trail.push({ pos, t: now });
    while (this.trail.length && now - this.trail[0].t > TRAIL_MS) this.trail.shift();
  }

  /**
   * s: {inScale:Set<pc>, root:pc, activePc:int|null, voice:float|null,
   *     cents:number, label:string, sub:string, level:0..1, now:ms}
   */
  draw(s) {
    const { g, c } = this;
    const W = this.canvas.width, H = this.canvas.height;
    if (!W || !H) return;
    g.clearRect(0, 0, W, H);
    const S = Math.min(W, H);
    const cx = W / 2, cy = H / 2;
    const R = S / 2 - S * 0.03;
    const thick = R * 0.27;
    const r0 = R - thick;
    const ang = (pos) => -Math.PI / 2 + pos * SEG;
    const gap = SEG * 0.045;

    // Sectors.
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `700 ${Math.max(11, S * 0.034)}px ${this.font}`;
    for (let pc = 0; pc < 12; pc++) {
      const a0 = ang(pc) - SEG / 2 + gap, a1 = ang(pc) + SEG / 2 - gap;
      const on = pc === s.activePc;
      const scaled = s.inScale.has(pc);
      g.beginPath();
      g.arc(cx, cy, R, a0, a1);
      g.arc(cx, cy, r0, a1, a0, true);
      g.closePath();
      g.fillStyle = on ? c.amber : scaled ? c.amberLow : c.surface;
      g.fill();
      const lr = (R + r0) / 2;
      g.fillStyle = on ? c.amberInk : scaled ? c.amber : c.faint;
      g.fillText(NOTE_NAMES[pc], cx + Math.cos(ang(pc)) * lr, cy + Math.sin(ang(pc)) * lr);
    }
    // Root tick, just outside the ring.
    g.strokeStyle = c.amber; g.lineWidth = Math.max(2, S * 0.006);
    g.beginPath();
    g.moveTo(cx + Math.cos(ang(s.root)) * (R + S * 0.006), cy + Math.sin(ang(s.root)) * (R + S * 0.006));
    g.lineTo(cx + Math.cos(ang(s.root)) * (R + S * 0.026), cy + Math.sin(ang(s.root)) * (R + S * 0.026));
    g.stroke();

    // Loudness arc, inside the ring.
    this.level += 0.35 * (s.level - this.level);
    const lr = r0 - S * 0.035;
    g.lineWidth = Math.max(2, S * 0.008); g.lineCap = 'butt';
    g.strokeStyle = c.line;
    g.beginPath(); g.arc(cx, cy, lr, 0, TAU); g.stroke();
    if (this.level > 0.01) {
      g.strokeStyle = s.voice !== null ? c.amber : c.faint;
      g.beginPath(); g.arc(cx, cy, lr, -Math.PI / 2, -Math.PI / 2 + TAU * Math.min(1, this.level)); g.stroke();
    }

    // Trail and needle on the ring's inner edge.
    const tr = r0 - S * 0.012;
    for (const p of this.trail) {
      const age = (s.now - p.t) / TRAIL_MS;
      if (age >= 1) continue;
      g.globalAlpha = (1 - age) * 0.55;
      g.fillStyle = c.ink;
      g.beginPath();
      g.arc(cx + Math.cos(ang(p.pos)) * tr, cy + Math.sin(ang(p.pos)) * tr, S * 0.006, 0, TAU);
      g.fill();
    }
    g.globalAlpha = 1;
    if (s.voice !== null) {
      const a = ang(((s.voice % 12) + 12) % 12);
      g.strokeStyle = c.ink; g.lineWidth = Math.max(2, S * 0.007);
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * (r0 - S * 0.07), cy + Math.sin(a) * (r0 - S * 0.07));
      g.lineTo(cx + Math.cos(a) * (R - S * 0.005), cy + Math.sin(a) * (R - S * 0.005));
      g.stroke();
      g.fillStyle = c.ink;
      g.beginPath(); g.arc(cx + Math.cos(a) * tr, cy + Math.sin(a) * tr, S * 0.014, 0, TAU); g.fill();
    }

    // Centre readout.
    const has = s.voice !== null || s.activePc !== null;
    g.fillStyle = has ? c.ink : c.faint;
    g.font = `800 ${has ? S * 0.15 : S * 0.065}px ${this.font}`;
    g.fillText(s.label, cx, cy - S * 0.03);
    g.fillStyle = c.dim;
    g.font = `500 ${S * 0.034}px ui-monospace, Menlo, Consolas, monospace`;
    g.fillText(s.sub, cx, cy + S * (has ? 0.075 : 0.045));

    // Cents gauge: centre mark, fixed range of +/-50.
    if (has) {
      const gw = S * 0.2, gy = cy + S * 0.125;
      g.strokeStyle = c.line; g.lineWidth = Math.max(1, S * 0.004);
      g.beginPath(); g.moveTo(cx - gw / 2, gy); g.lineTo(cx + gw / 2, gy); g.stroke();
      g.beginPath(); g.moveTo(cx, gy - S * 0.012); g.lineTo(cx, gy + S * 0.012); g.stroke();
      const k = Math.max(-50, Math.min(50, s.cents)) / 50;
      g.fillStyle = Math.abs(s.cents) < 12 ? c.amber : c.ink;
      g.fillRect(cx + k * gw / 2 - S * 0.005, gy - S * 0.016, S * 0.01, S * 0.032);
    }
  }
}

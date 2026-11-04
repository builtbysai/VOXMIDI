/* Trained pad bank: up to 12 recorded takes per pad, turned into the
 * template set the drum classifier reads. Pure logic, no DOM. */
import { DEFAULT_TEMPLATES } from './drums.js';

export const KINDS = ['kick', 'snare', 'hat'];
export const MAX_TAKES = 12;

const FIELDS = ['centroid', 'lowR', 'midR', 'highR'];
const isFeature = (f) => f && FIELDS.every(k => Number.isFinite(f[k]));

export function emptyBank() {
  return { kick: [], snare: [], hat: [] };
}

/** Validate untrusted JSON (localStorage) into a well-formed bank. */
export function sanitizeBank(raw) {
  const bank = emptyBank();
  if (!raw || typeof raw !== 'object') return bank;
  for (const kind of KINDS) {
    const list = Array.isArray(raw[kind]) ? raw[kind] : [];
    bank[kind] = list.filter(isFeature)
      .slice(0, MAX_TAKES)
      .map(f => ({ centroid: f.centroid, lowR: f.lowR, midR: f.midR, highR: f.highR }));
  }
  return bank;
}

/** Add a take. Returns false when the pad is already full. */
export function addTake(bank, kind, feat) {
  if (!isFeature(feat) || bank[kind].length >= MAX_TAKES) return false;
  bank[kind].push({ centroid: feat.centroid, lowR: feat.lowR, midR: feat.midR, highR: feat.highR });
  return true;
}

export function removeTake(bank, kind, index) {
  bank[kind].splice(index, 1);
}

/** Classifier templates: a pad with takes uses them, otherwise its default. */
export function buildTemplates(bank) {
  const out = {};
  for (const kind of KINDS) {
    out[kind] = bank[kind].length
      ? bank[kind].map(f => ({ ...f }))
      : { ...DEFAULT_TEMPLATES[kind] };
  }
  return out;
}

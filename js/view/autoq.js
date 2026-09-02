// ---------------------------------------------------------------------------
// autoq.js - the first-run graphics tuner.
//
// Nobody knows what a given phone can draw until it has drawn it. So the
// first time the inside view is on screen, the tuner watches the real frame
// times for a couple of seconds and, if they are over budget, takes one
// option off, then measures again, until the frames come in under budget or
// there is nothing left to take off. What it decided is stored, so the next
// visit starts there instead of stuttering through the test again. Anything
// set by hand in the settings panel is stored as the visitor's own choice and
// the tuner never touches it after that.
//
// The measurement is the wall-clock gap between animation frames, not the
// clamped dt the simulation uses, because the clamp is exactly what would hide
// a slow device.
// ---------------------------------------------------------------------------

const STORE = 'ncs.gfx';

// Cheapest loss first. Each rung is applied only if it changes something, so
// a phone that starts with bloom and refraction off goes straight to the
// rungs that matter to it: the size of the frame it is filling.
export const LADDER = [
  ['bloom', false],
  ['refraction', false],
  ['hidpi', false],
  ['shadows', false],
  ['scale', 0.8],
  ['steam', false],
  ['scale', 0.65],
  ['particles', false],
  ['scale', 0.5]
];

const WARMUP = 2.5;     // seconds ignored after boot and after every change: shader compiles
const WINDOW = 2.0;     // seconds of frames per decision
const MIN_FRAMES = 4;   // fewer than this in a window and the median means nothing yet
const HITCH = 400;      // a frame longer than this is a compile or a tab switch, not the rate

export class AutoQ {
  // target: the frame rate that counts as good enough. Passing is measured
  // with a tenth of slack, so a phone pinned at exactly 30 by its own vsync
  // passes a 30 fps target.
  constructor(stage, { target = 30, onChange = null } = {}) {
    this.stage = stage;
    this.budget = (1000 / target) * 1.1;
    this.onChange = onChange;
    this.saved = this.load();
    this.steps = [];
    this.result = null;    // the measured frame time when the tuner stopped
    this.done = false;
    this.enabled = true;
    this.reset();
  }

  load() {
    try {
      const raw = localStorage.getItem(STORE);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  save(by) {
    const s = this.stage;
    const rec = { by, q: Object.assign({}, s.q), scale: s.scale,
      steps: this.steps.slice(), ms: this.result, when: new Date().toISOString().slice(0, 10) };
    this.saved = rec;
    try { localStorage.setItem(STORE, JSON.stringify(rec)); } catch (e) { /* private mode */ }
  }

  // What a previous visit settled on, put back before the first frame.
  applySaved() {
    const rec = this.saved;
    if (!rec || !rec.q) return false;
    for (const k of Object.keys(rec.q)) {
      if (k in this.stage.q && this.stage.q[k] !== rec.q[k]) this.stage.setQuality(k, rec.q[k]);
    }
    if (rec.scale && rec.scale !== this.stage.scale) this.stage.setScale(rec.scale);
    this.steps = rec.steps || [];
    this.result = rec.ms || null;
    this.done = true;
    return true;
  }

  // The visitor changed something by hand: keep it, and stop tuning.
  userSet() {
    this.done = true;
    this.steps = [];
    this.result = null;
    this.save('user');
    if (this.onChange) this.onChange();
  }

  // Measure again from the current settings, whatever a previous visit found.
  // Asked for by hand, so it measures even where the tuner was stood down.
  restart() {
    this.enabled = true;
    this.done = false;
    this.steps = [];
    this.result = null;
    this.reset();
    if (this.onChange) this.onChange();
  }

  reset() {
    this.warm = WARMUP;
    this.dts = [];
    this.span = 0;
    this.last = null;
  }

  // One call per animation frame while the inside view is being drawn.
  tick() {
    if (this.done || !this.enabled) return;
    const now = performance.now();
    if (document.hidden || this.stage.lost) { this.last = null; return; }
    if (this.last == null) { this.last = now; return; }
    const ms = now - this.last;
    this.last = now;
    if (ms > HITCH) return;
    if (this.warm > 0) { this.warm -= ms / 1000; return; }
    this.dts.push(ms);
    this.span += ms / 1000;
    // A window is two seconds, or however long it takes to see a few frames
    // on a device so slow that two seconds holds fewer than that. It used to
    // throw a short window away as a stall, and on a device at five frames a
    // second that meant it never decided anything at all.
    if (this.span < WINDOW || this.dts.length < MIN_FRAMES) return;
    const sorted = this.dts.slice().sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    this.result = Math.round(median * 10) / 10;
    if (median <= this.budget || !this.stepDown()) {
      this.done = true;
      this.save('auto');
      if (this.onChange) this.onChange();
      return;
    }
    // Something was taken off: warm up and measure again.
    this.reset();
    if (this.onChange) this.onChange();
  }

  // Apply the next rung that actually changes something. False when the
  // ladder is used up.
  stepDown() {
    const s = this.stage;
    for (const [key, val] of LADDER) {
      if (key === 'scale') {
        if (s.scale <= val + 1e-6) continue;
        s.setScale(val);
      } else {
        if (!s.q[key]) continue;
        s.setQuality(key, false);
      }
      this.steps.push([key, val, this.result]);
      return true;
    }
    return false;
  }

  // One sentence for the settings panel.
  note() {
    const fps = (ms) => `${Math.round(1000 / ms)} fps`;
    if (!this.done) return this.enabled ? 'Measuring this device.' : 'Not measured.';
    const rec = this.saved;
    if (rec && rec.by === 'user') return 'Set by hand. Measure again to let the app choose.';
    if (!this.steps.length) {
      return this.result ? `Measured ${fps(this.result)} first time. Nothing turned off.` : '';
    }
    const names = { bloom: 'bloom', refraction: 'refraction', hidpi: 'full pixel density',
      shadows: 'shadows', steam: 'steam', particles: 'bubbles' };
    const parts = [];
    let scale = null;
    for (const [k, v] of this.steps) {
      if (k === 'scale') scale = v; else parts.push(names[k] || k);
    }
    const off = parts.length ? `${parts.join(', ')} off` : '';
    const res = scale ? `resolution ${Math.round(scale * 100)}%` : '';
    const first = this.steps[0][2];
    return `Adjusted for this device: ${[off, res].filter(Boolean).join(', ')}.`
      + ` Was ${fps(first)}, now ${this.result ? fps(this.result) : 'measuring'}.`;
  }
}

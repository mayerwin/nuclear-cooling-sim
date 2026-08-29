// ---------------------------------------------------------------------------
// audio.js - every sound in here is synthesised on the fly. No files, no
// network, nothing to load: oscillators, filtered noise and envelopes.
//
// Two kinds of sound. Continuous layers (pump hum, water rushing, boiling, the
// klaxon) are voices that live for the session and whose gain follows the
// model, so what you hear is what the simulation is doing. One-shots (scram,
// quake, wave, explosion) are fired by events.
//
// Browsers will not start audio without a gesture, so init() is called from the
// Start button. Before that the whole module is inert.
// ---------------------------------------------------------------------------

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// A short burst of noise, reused by everything that needs texture.
function noiseBuffer(ctx, seconds) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < n; i++) {
    // brown-ish noise: less hiss, more rush of water
    last = (last + (Math.random() * 2 - 1) * 0.08) * 0.985;
    d[i] = clamp(last * 3.2, -1, 1);
  }
  return buf;
}

export class Sound {
  constructor() {
    this.ready = false;
    this.muted = false;
    this.ctx = null;
    this.layers = {};
    this.alarmOn = false;
  }

  init() {
    if (this.ready) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();
    this.noise = noiseBuffer(ctx, 3);

    const master = this.master = ctx.createGain();
    master.gain.value = this.muted ? 0 : 0.9;
    // a limiter, so a hydrogen explosion during an alarm cannot clip
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 8; comp.attack.value = 0.004;
    master.connect(comp).connect(ctx.destination);

    // ---- continuous layers ------------------------------------------------
    // A working power station should sound calm, not ominous. A 58 Hz sawtooth
    // is a horror-film drone: it sits in the chest and it buzzes. An octave up,
    // as a triangle, with the filter open enough to let the tone through, is a
    // machine room humming to itself.
    this.layers.pump = this.hum(116, 'triangle', 520);
    this.layers.flow = this.rush(560, 0.9);
    this.layers.boil = this.rush(1500, 2.4);
    this.layers.grid = this.hum(120, 'sine', 260);
    // The room tone: two quiet sines a fifth apart, well above the chest. A
    // working station is not a threat, and the ambience should not imply one.
    this.layers.airA = this.hum(196, 'sine', 900);
    this.layers.airB = this.hum(294, 'sine', 900);
    this.ready = true;
    if (ctx.state === 'suspended') ctx.resume();
    // and it fades up rather than arriving all at once
    master.gain.setValueAtTime(0, ctx.currentTime);
    master.gain.setTargetAtTime(this.muted ? 0 : 0.9, ctx.currentTime, 1.1);
  }

  // a droning voice: oscillator through a lowpass, gain we can ride
  hum(freq, type, cut) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator(); osc.type = type; osc.frequency.value = freq;
    const det = ctx.createOscillator(); det.type = type; det.frequency.value = freq * 1.008;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = cut;
    const g = ctx.createGain(); g.gain.value = 0;
    osc.connect(lp); det.connect(lp); lp.connect(g).connect(this.master);
    osc.start(); det.start();
    return { gain: g.gain, freq: osc.frequency, freq2: det.frequency };
  }

  // looping noise through a bandpass: water, steam, boiling
  rush(centre, q) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise; src.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
    bp.frequency.value = centre; bp.Q.value = q;
    const g = ctx.createGain(); g.gain.value = 0;
    src.connect(bp).connect(g).connect(this.master);
    src.start();
    return { gain: g.gain, freq: bp.frequency };
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.05);
  }

  // ---- one-shots ----------------------------------------------------------
  ping(freq, dur, type = 'sine', vol = 0.3, slideTo) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + dur + 0.05);
  }

  burst(centre, q, dur, vol, sweepTo) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = this.noise;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
    bp.frequency.setValueAtTime(centre, t); bp.Q.value = q;
    if (sweepTo) bp.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + Math.min(0.06, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0006, t + dur);
    src.connect(bp).connect(g).connect(this.master);
    src.start(t); src.stop(t + dur + 0.05);
  }

  // The vocabulary. Each phase of a scenario gets a sound that means something:
  // machinery stopping is a descending note, a threat arriving is a rising one,
  // something breaking is broadband.
  cue(name) {
    if (!this.ready) return;
    switch (name) {
      case 'scram': this.ping(420, 0.5, 'square', 0.22, 120); this.burst(900, 1, 0.35, 0.10); break;
      case 'trip': this.ping(300, 0.35, 'square', 0.16, 140); break;
      case 'start': this.ping(320, 0.4, 'triangle', 0.18, 640); break;
      case 'quake': this.burst(70, 0.6, 3.2, 0.42, 40); break;
      case 'wave': this.burst(260, 0.5, 4.5, 0.40, 90); break;
      case 'flood': this.burst(400, 0.7, 1.8, 0.26, 120); break;
      case 'fire': this.burst(700, 0.5, 2.4, 0.16); break;
      case 'valve': this.ping(180, 0.16, 'square', 0.2); break;
      case 'breach': this.burst(120, 0.4, 2.6, 0.5, 45); this.ping(90, 1.6, 'sawtooth', 0.3, 40); break;
      case 'explosion':
        this.burst(160, 0.3, 2.8, 0.62, 40);
        this.ping(70, 2.2, 'sawtooth', 0.34, 32);
        break;
      case 'steamex':
        this.burst(320, 0.4, 3.4, 0.66, 50);
        this.ping(110, 2.6, 'sawtooth', 0.36, 34);
        break;
      case 'safe': this.ping(520, 0.5, 'sine', 0.16, 780); break;
      default: break;
    }
  }

  // ---- the klaxon ---------------------------------------------------------
  // Two alternating tones, started and stopped rather than retriggered, so it
  // sounds like a control room and not like a notification.
  alarm(on) {
    if (!this.ready || on === this.alarmOn) return;
    this.alarmOn = on;
    if (!on) {
      if (this.klax) {
        this.klax.gain.setTargetAtTime(0, this.ctx.currentTime, 0.08);
        clearInterval(this.klaxTimer); this.klaxTimer = null;
      }
      return;
    }
    if (!this.klax) {
      const ctx = this.ctx;
      const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = 620;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1400;
      const g = ctx.createGain(); g.gain.value = 0;
      o.connect(lp).connect(g).connect(this.master);
      o.start();
      this.klax = { gain: g.gain, freq: o.frequency };
    }
    const k = this.klax;
    let hi = false;
    const beat = () => {
      if (!this.alarmOn) return;
      const t = this.ctx.currentTime;
      hi = !hi;
      k.freq.setValueAtTime(hi ? 660 : 495, t);
      k.gain.cancelScheduledValues(t);
      k.gain.setValueAtTime(0.0001, t);
      k.gain.linearRampToValueAtTime(this.muted ? 0 : 0.16, t + 0.03);
      k.gain.setValueAtTime(this.muted ? 0 : 0.16, t + 0.30);
      k.gain.exponentialRampToValueAtTime(0.0001, t + 0.44);
    };
    beat();
    this.klaxTimer = setInterval(beat, 500);
  }

  // ---- per-frame mix ------------------------------------------------------
  // The layers follow the model, so the room sounds like what the plants are
  // doing: pumps spinning, water moving, a core boiling itself dry.
  frame(sim) {
    if (!this.ready) return;
    const t = this.ctx.currentTime, ramp = 0.12;
    let pump = 0, flow = 0, boil = 0, grid = 0, bad = false, hottest = 300;
    for (const p of sim.plants) {
      const s = p.sys || {};
      pump = Math.max(pump, (s.rcp ? 1 : 0) * 0.7 + (s.aux || s.rcic ? 0.35 : 0));
      flow = Math.max(flow, Math.max(s.rcp || 0, s.natCirc || 0, s.gravity || 0, s.cmt || 0));
      boil = Math.max(boil, clamp((p.Tclad - 560) / 500, 0, 1) * (p.level > 0.02 ? 1 : 0.25));
      grid = Math.max(grid, s.grid ? 1 : s.diesel ? 0.7 : 0);
      hottest = Math.max(hottest, p.Tclad);
      if (/BREACH|DAMAGE|MELT|FAILURE|DESTROYED|UNCOVERED|BLACKOUT/.test(p.state)) bad = true;
    }
    // Both views are the same station, so both are audible. The old test named
    // a view that no longer exists, which left the inside view silent and put
    // the whole ambience on the site view alone.
    const on = true;
    this.layers.pump.gain.setTargetAtTime(on ? pump * 0.016 : 0, t, ramp);
    this.layers.flow.gain.setTargetAtTime(on ? (0.25 + flow * 0.75) * 0.055 : 0, t, ramp);
    this.layers.boil.gain.setTargetAtTime(on ? boil * 0.05 : 0, t, ramp);
    this.layers.grid.gain.setTargetAtTime(on && grid ? grid * 0.008 : 0, t, ramp);
    this.layers.airA.gain.setTargetAtTime(on ? 0.012 : 0, t, 0.8);
    this.layers.airB.gain.setTargetAtTime(on ? 0.008 : 0, t, 0.8);
    // a hotter core hisses higher
    this.layers.boil.freq.setTargetAtTime(900 + clamp(hottest - 560, 0, 1600) * 0.9, t, 0.3);
    this.alarm(bad);
  }
}

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

// The whole mix. Quieter than it was: an ambience you have to lean into is an
// ambience nobody asks to turn off.
const MASTER = 0.7;

// C major pentatonic across an octave and a half. Warm, open, and incapable of
// a dissonance whatever order it is played in.
const SCALE = [261.63, 293.66, 329.63, 392.00, 440.00, 523.25, 587.33, 659.25];

// The noise everything textural is made of. Brown rather than white, because
// white noise is hiss and brown noise is weather.
//
// Two things matter as much as the colour. It has no DC, because a wandering
// integrator drifts off zero and that offset is inaudible on its own but eats
// headroom and makes filters ring. And its tail is crossfaded into its head,
// with the loop set to start after the head, so the loop point is continuous:
// an uncrossfaded brown loop steps discontinuously every time round and ticks,
// and a tick every three seconds, forever, is its own kind of annoying.
const LOOP_SECONDS = 9, LOOP_FADE = 0.6;
function noiseBuffer(ctx) {
  const rate = ctx.sampleRate;
  const n = Math.floor(rate * LOOP_SECONDS);
  const buf = ctx.createBuffer(1, n, rate);
  const d = buf.getChannelData(0);
  let last = 0, sum = 0;
  for (let i = 0; i < n; i++) {
    last = (last + (Math.random() * 2 - 1) * 0.08) * 0.985;
    d[i] = last * 3.2;
    sum += d[i];
  }
  const dc = sum / n;
  let peak = 1e-6;
  for (let i = 0; i < n; i++) { d[i] -= dc; peak = Math.max(peak, Math.abs(d[i])); }
  for (let i = 0; i < n; i++) d[i] = clamp(d[i] / peak, -1, 1);
  const fade = Math.floor(rate * LOOP_FADE);
  for (let i = 0; i < fade; i++) {
    const k = i / fade;
    d[n - fade + i] = d[n - fade + i] * (1 - k) + d[i] * k;
  }
  return buf;
}

// Pink rather than brown for the water and the air.
//
// Brown noise falls at 6 dB per octave, so however high you set the highpass
// under it the energy piles up right at the corner: measured, the bed was 56%
// inside 120 to 400 Hz and the loudest thing in the room was its own low
// shelf. Pink falls at 3, which is the tilt moving water actually has, and it
// spreads across the band instead of leaning on the bottom of it.
// Paul Kellet's filter, which is three one-poles summed and is accurate to
// about a third of a decibel from 10 Hz up.
function pinkBuffer(ctx) {
  const rate = ctx.sampleRate;
  const n = Math.floor(rate * LOOP_SECONDS);
  const buf = ctx.createBuffer(1, n, rate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, sum = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.0990460;
    b1 = 0.96300 * b1 + w * 0.2965164;
    b2 = 0.57000 * b2 + w * 1.0526913;
    d[i] = b0 + b1 + b2 + w * 0.1848;
    sum += d[i];
  }
  const dc = sum / n;
  let peak = 1e-6;
  for (let i = 0; i < n; i++) { d[i] -= dc; peak = Math.max(peak, Math.abs(d[i])); }
  for (let i = 0; i < n; i++) d[i] = clamp(d[i] / peak, -1, 1);
  const fade = Math.floor(rate * LOOP_FADE);
  for (let i = 0; i < fade; i++) {
    const k = i / fade;
    d[n - fade + i] = d[n - fade + i] * (1 - k) + d[i] * k;
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
    this.noise = noiseBuffer(ctx);
    this.pink = pinkBuffer(ctx);

    const master = this.master = ctx.createGain();
    master.gain.value = this.muted ? 0 : MASTER;
    // a limiter, so a hydrogen explosion during an alarm cannot clip
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 8; comp.attack.value = 0.004;
    master.connect(comp).connect(ctx.destination);

    // ---- the ambience -----------------------------------------------------
    // A quiet coastal station, and it is meant to be a pleasant thing to sit
    // with. That rules out three things, and every one of them was in here:
    //
    //   a sustained tone, at any pitch. A held oscillator is a drone, and a
    //   232 Hz triangle is a reedy buzz. There is no oscillator in the
    //   ambience now, only air and water.
    //
    //   hiss. Noise with energy above about two kilohertz is sibilance, and
    //   half an hour of it is fatiguing however quiet it is. Every bed here
    //   is LOW-passed as well as high-passed, so it is bounded at both ends.
    //
    //   a wall. Noise that never moves is a wall, and a wall is tiring. Each
    //   bed breathes on its own slow oscillator, at rates that share no common
    //   multiple, so the room swells and settles and never repeats.
    //
    // What is left is dark, soft, and slow: the sea beyond the wall and the
    // air in a big building.
    //
    // The bands are where they are because of what came back off the analyser.
    // Rolled off at 620 Hz this was 76% midbass and nothing above 1.2 kHz:
    // no longer a rumble, but muffled, and muffled at 300 Hz is still boom.
    // Moving water and moving air both carry well past a kilohertz; it is only
    // past three or four that they turn into hiss.
    this.layers.sea = this.bed({ hp: 220, lp: 1600, rate: 0.055, depth: 0.45, pink: true });
    this.layers.air = this.bed({ hp: 560, lp: 3000, rate: 0.041, depth: 0.35, pink: true });
    this.layers.mach = this.bed({ hp: 190, lp: 700, rate: 0.093, depth: 0.22 });
    this.layers.boil = this.bed({ hp: 480, lp: 2000, rate: 0.13, depth: 0.3 });
    this.buildChime();
    this.ready = true;
    this.scheduleNote(6);
    if (ctx.state === 'suspended') ctx.resume();
    // Arriving should feel like a door opening on a quiet room, not like a
    // switch being thrown.
    master.gain.setValueAtTime(0, ctx.currentTime);
    master.gain.setTargetAtTime(this.muted ? 0 : MASTER, ctx.currentTime, 2.4);
  }

  // One bed of moving air or water: looping brown noise, bounded above and
  // below, breathing on its own slow oscillator.
  //
  // Two gains in series on purpose. The inner one carries the breath, so the
  // sub-audio oscillator can be summed into it without fighting anything; the
  // outer one is what the simulation rides, so a pump starting does not have
  // to know the room is breathing.
  bed({ hp, lp, rate, depth, peak, pink }) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = pink ? this.pink : this.noise;
    src.loop = true;
    src.loopStart = LOOP_FADE;
    src.loopEnd = LOOP_SECONDS;

    const hi = ctx.createBiquadFilter();
    hi.type = 'highpass'; hi.frequency.value = hp; hi.Q.value = 0.7;
    const lo = ctx.createBiquadFilter();
    lo.type = 'lowpass'; lo.frequency.value = lp; lo.Q.value = 0.7;
    let chain = src.connect(hi).connect(lo);
    if (peak) {
      const pk = ctx.createBiquadFilter();
      pk.type = 'peaking'; pk.frequency.value = peak; pk.Q.value = 1.1; pk.gain.value = 4;
      chain = chain.connect(pk);
    }
    const breath = ctx.createGain();
    breath.gain.value = 1 - depth * 0.5;
    const lfo = ctx.createOscillator();
    lfo.type = 'sine'; lfo.frequency.value = rate;
    const amt = ctx.createGain(); amt.gain.value = depth * 0.5;
    lfo.connect(amt).connect(breath.gain);
    lfo.start();

    const level = ctx.createGain(); level.gain.value = 0;
    chain.connect(breath).connect(level).connect(this.master);
    src.start();
    return { gain: level.gain, freq: lo.frequency };
  }

  // ---- the melody ---------------------------------------------------------
  // Soft bell notes, far apart, over the water. Three rules keep it soothing
  // rather than decorative:
  //
  //   One pentatonic scale and nothing else. No two notes in a pentatonic
  //   scale are a semitone or a tritone apart, so whatever order they arrive
  //   in and however their tails overlap, nothing can sound wrong. There is no
  //   tune to get stuck in your head and no cadence, so it never resolves and
  //   never demands attention.
  //
  //   Slow in and slow out. Half a second to reach full and six to fall away,
  //   so there is no attack to flinch at, and each note is still ringing when
  //   the next arrives.
  //
  //   It stops when the plant is in trouble. Music over a core melting is
  //   grotesque, and its absence says more than another siren would: the room
  //   going quiet is the first sign that something is wrong.
  buildChime() {
    const ctx = this.ctx;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 1900; lp.Q.value = 0.7;
    // A little space round the notes. One delay with feedback is not a room,
    // but at this spacing it is the difference between a beep and a bell.
    const dly = ctx.createDelay(3);
    dly.delayTime.value = 0.62;
    const fb = ctx.createGain(); fb.gain.value = 0.36;
    const wet = ctx.createGain(); wet.gain.value = 0.55;
    const bus = ctx.createGain(); bus.gain.value = 0;
    lp.connect(bus);
    lp.connect(dly); dly.connect(fb); fb.connect(dly); dly.connect(wet); wet.connect(bus);
    bus.connect(this.master);
    this.chimeIn = lp;
    this.chime = bus.gain;
    this.step = 2;
  }

  // A major pentatonic, low enough to be warm and high enough to be clear.
  note(freq) {
    const ctx = this.ctx, t = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.3, t + 0.55);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 6.2);
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = freq;
    // one quiet partial an octave up, which is what makes it a bell and not a
    // test tone
    const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = freq * 2.01;
    const g2 = ctx.createGain(); g2.gain.value = 0.16;
    o.connect(g); o2.connect(g2).connect(g);
    g.connect(this.chimeIn);
    o.start(t); o2.start(t);
    o.stop(t + 6.6); o2.stop(t + 6.6);
  }

  scheduleNote(delay) {
    clearTimeout(this.noteTimer);
    this.noteTimer = setTimeout(() => {
      if (!this.ready) return;
      // wander up and down the scale by a step or two, never jumping
      this.step = clamp(this.step + Math.round((Math.random() - 0.5) * 4), 0, SCALE.length - 1);
      if (!this.muted && !this.grim) this.note(SCALE[this.step]);
      this.scheduleNote(5.5 + Math.random() * 7);
    }, delay * 1000);
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : MASTER, this.ctx.currentTime, 0.05);
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
    let pump = 0, flow = 0, boil = 0, bad = false, hottest = 300;
    for (const p of sim.plants) {
      const s = p.sys || {};
      pump = Math.max(pump, (s.rcp ? 1 : 0) * 0.7 + (s.aux || s.rcic ? 0.35 : 0));
      flow = Math.max(flow, Math.max(s.rcp || 0, s.natCirc || 0, s.gravity || 0, s.cmt || 0));
      boil = Math.max(boil, clamp((p.Tclad - 560) / 500, 0, 1) * (p.level > 0.02 ? 1 : 0.25));
      hottest = Math.max(hottest, p.Tclad);
      if (/BREACH|DAMAGE|MELT|FAILURE|DESTROYED|UNCOVERED|BLACKOUT/.test(p.state)) bad = true;
    }
    // Both views are the same station, so both are audible. The old test named
    // a view that no longer exists, which left the inside view silent and put
    // the whole ambience on the site view alone.
    // The sea is always there and barely moves; the plant's own layers ride on
    // top of it. Every one of these numbers is a fifth of what it was: the
    // room should be something you notice when it stops.
    this.layers.sea.gain.setTargetAtTime((0.62 + flow * 0.38) * 0.05, t, 0.9);
    this.layers.air.gain.setTargetAtTime(0.05, t, 1.4);
    this.layers.mach.gain.setTargetAtTime(0.004 + pump * 0.01, t, ramp);
    this.layers.boil.gain.setTargetAtTime(boil * 0.026, t, ramp);
    // a hotter core opens the boiling layer up, so it brightens as it dries
    this.layers.boil.freq.setTargetAtTime(1100 + clamp(hottest - 560, 0, 1600) * 0.55, t, 0.4);
    // The melody belongs to a plant that is fine. When one stops being fine it
    // fades out over a few seconds and leaves the room to the water.
    this.grim = bad;
    this.chime.setTargetAtTime(bad ? 0 : 0.075, t, bad ? 2.2 : 4);
    this.alarm(bad);
  }
}

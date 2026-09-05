// ---------------------------------------------------------------------------
// colour.js - the one place a temperature becomes a colour.
//
// No three.js here: these return plain [r, g, b] in 0 to 1, in the sRGB the
// numbers were picked in. The three.js side turns them into THREE.Color. That
// keeps the recipe testable without a browser, and it keeps it in ONE place,
// which is the rule the consumer's reviews arrived at the hard way: any call
// site that mixes its own colour breaks the promise that the same orange means
// the same thing everywhere in a picture.
//
// TWO IDEAS, AND THEY ARE BOTH IMPORTANT.
//
// 1. THE RAMP. Blue to orange has to cross low saturation somewhere. Straight
//    from blue to orange passes through brown, and brown water reads as dirty
//    rather than hot; through white, and everything past a fifth of the ramp
//    is milk. So the crossing is made SHORT and it is made through a warm
//    grey-green. Five stops, all saturated.
//
// 2. THE MIX IS IN sRGB, NOT LINEAR. Mixing two colours by their linear
//    components puts a fifth of the way from a saturated blue towards a bright
//    cream most of the way there: a cold leg at a tenth of the ramp came out
//    pale grey-blue. These are the numbers a person picking colours would
//    expect, so they are mixed the way that person means.
//
// 3. THE SCALE IS PER CIRCUIT. An absolute map puts a whole primary loop, 290
//    to 325 C, in one band of orange, and the picture loses the one thing it
//    has to say about that loop: that the water comes back colder than it
//    left. So a circuit's own coldest water is drawn at the cold end of the
//    ramp and its hottest at the hot end. The same orange in two circuits does
//    not mean the same degrees. What it means is "the hot end of this
//    circuit", which is the thing worth seeing.
// ---------------------------------------------------------------------------

const clamp = (v, a, b) => (v >= a ? (v <= b ? v : b) : a);

// The ramp, as bytes, because that is how they were picked.
const STOPS = [
  [0.00, [0x0d, 0x5c, 0x9c]],   // cold: a saturated blue
  [0.28, [0x2f, 0x95, 0xcf]],
  [0.46, [0x74, 0xb0, 0xc0]],   // the crossing, kept short
  [0.62, [0xc9, 0x92, 0x52]],
  [0.82, [0xe0, 0x6a, 0x28]],
  [1.00, [0xd8, 0x38, 0x14]]    // hot: a saturated red-orange
];

// Where on the ramp a circuit's colours are allowed to sit. Neither end goes
// all the way: pure cold reads as ink and pure hot as rust.
export const BAND_LO = 0.06, BAND_HI = 0.84;

const _out = [0, 0, 0];

function mix(a, b, f, out) {
  out[0] = (a[0] + (b[0] - a[0]) * f) / 255;
  out[1] = (a[1] + (b[1] - a[1]) * f) / 255;
  out[2] = (a[2] + (b[2] - a[2]) * f) / 255;
  return out;
}

// The ramp at u, 0 to 1. Returns [r, g, b] in 0 to 1, sRGB.
export function ramp(u, out = [0, 0, 0]) {
  const t = clamp(u, 0, 1);
  for (let i = 1; i < STOPS.length; i++) {
    if (t <= STOPS[i][0] || i === STOPS.length - 1) {
      const a = STOPS[i - 1], b = STOPS[i];
      return mix(a[1], b[1], (t - a[0]) / (b[0] - a[0]), out);
    }
  }
  return mix(STOPS[0][1], STOPS[0][1], 0, out);
}

// Lighten towards white, in sRGB.
export function pale(c, f, out = c) {
  const g = clamp(f, 0, 1);
  out[0] = c[0] + (1 - c[0]) * g;
  out[1] = c[1] + (1 - c[1]) * g;
  out[2] = c[2] + (1 - c[2]) * g;
  return out;
}

// The colour of fluid at u along the ramp. A little white at the hot end keeps
// the orange off rust, and a little at the cold end keeps the blue off ink.
// A LIT body carries no tint of its own, unlike a transmissive one, so these
// figures are close to the ramp itself: whitened by a third, as a transmissive
// body wanted, they came out as white pipes.
export function fluidColour(u, out = [0, 0, 0]) {
  const t = clamp(u, 0, 1);
  return pale(ramp(t, out), 0.05 + t * 0.09);
}

// A temperature, inside a span, as a colour. THIS IS THE ONLY WAY A
// TEMPERATURE BECOMES A COLOUR. `range` is {lo, hi} in kelvin or in degrees,
// as long as it is the same units as T.
//
// A span narrower than `deadband` is drawn at the cold end rather than
// stretched: a circuit sitting at one temperature has nothing to say, and
// dividing by its own noise makes it flicker between blue and orange.
export function colourIn(range, T, out = [0, 0, 0], deadband = 2) {
  const lo = range ? range.lo : 0, hi = range ? range.hi : 0;
  const span = hi - lo;
  const f = span < deadband ? 0 : clamp((T - lo) / span, 0, 1);
  return fluidColour(BAND_LO + (BAND_HI - BAND_LO) * f, out);
}

// The coldest and hottest thing in a set of temperatures. `extra` is for
// temperatures a circuit holds but its runs do not carry, such as the water
// standing in a boiler.
export function rangeOf(temps, extra) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < temps.length; i++) {
    const t = temps[i];
    if (!Number.isFinite(t)) continue;
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  if (extra) {
    for (let i = 0; i < extra.length; i++) {
      const t = extra[i];
      if (!Number.isFinite(t)) continue;
      if (t < lo) lo = t;
      if (t > hi) hi = t;
    }
  }
  if (!Number.isFinite(lo)) { lo = 0; hi = 0; }
  return { lo, hi };
}

// Glowing metal, for anything hot enough to be its own light source: fuel, a
// melt, a surface a fire has reached. Kelvin in, [r, g, b] out.
const HEAT = [[560, [0x8a, 0x6a, 0x4a]], [900, [0xd0, 0x6a, 0x28]],
  [1400, [0xf0, 0x35, 0x16]], [2200, [0xff, 0x3a, 0x18]], [3200, [0xff, 0x8a, 0x55]]];
export function glowColour(K, out = [0, 0, 0]) {
  if (!(K > HEAT[0][0])) return mix(HEAT[0][1], HEAT[0][1], 0, out);
  for (let i = 1; i < HEAT.length; i++) {
    if (K <= HEAT[i][0]) {
      return mix(HEAT[i - 1][1], HEAT[i][1], (K - HEAT[i - 1][0]) / (HEAT[i][0] - HEAT[i - 1][0]), out);
    }
  }
  return mix(HEAT[HEAT.length - 1][1], HEAT[HEAT.length - 1][1], 0, out);
}

// A hex integer, for a host that wants one. sRGB, so it is the number a colour
// picker would show.
export function toHex(c) {
  const b = (v) => Math.round(clamp(v, 0, 1) * 255);
  return (b(c[0]) << 16) | (b(c[1]) << 8) | b(c[2]);
}

// Scratch, for a caller that does not want to allocate one.
export const scratch = () => _out.slice();

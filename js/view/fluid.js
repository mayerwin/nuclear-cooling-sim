// ---------------------------------------------------------------------------
// fluid.js - what the water looks like. NOW A THIN LAYER OVER THE LIBRARY.
//
// Every line of this used to be here. It has moved to the reusable library
// next door, `3d-fluid-simulator`, vendored under vendor/fluidsim, and what is
// left is the handful of names this project spells differently plus the one
// constant that is about this station rather than about fluids.
//
// WHY VENDORED AND NOT IMPORTED FROM THE SIBLING FOLDER. tools/serve.mjs is
// rooted at this repository, so a relative import reaching outside it resolves
// to a path the browser cannot fetch. A copy under vendor/ is served like
// anything else, is stamped like anything else, and keeps the promise that
// this app has no build step. To take an update: copy the library's `src/`
// over vendor/fluidsim, run `node tools/stamp.mjs`, then run the gate. The
// stamp step is not optional. GitHub Pages serves these files with a long
// max-age, and the vendored library is the part of the app that decides what
// every circuit does, so a returning visitor holding a cached copy of it is
// running last week's physics against this week's plant. It used to be left
// out of the stamp along with three, which is pinned and never edited; it is
// in the hash now, and its own internal imports carry the query too, which is
// the one way the vendored copy differs from the library's source.
//
// The library carries its own reasons for each of these decisions in the files
// they came from, and they are not repeated here.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import {
  flowNormal, rippleNormal, streakTexture,
  gradientise, twoOctaveFlow,
  liquidMaterial, steamMaterial, surfaceMaterial, bodyMaterial,
  fleckMaterial, bubbleMaterial, dropMaterial, puffMaterial, casingMaterial,
  FLUID_TIME, advanceTime, quality, setQuality
} from '../../vendor/fluidsim/three/materials.js?v=a7f82a57a1';
import {
  Tracers, Riser, Drip, PuffCloud, frameOf
} from '../../vendor/fluidsim/three/particles.js?v=a7f82a57a1';

export {
  flowNormal, rippleNormal, streakTexture,
  gradientise, twoOctaveFlow,
  liquidMaterial, steamMaterial, surfaceMaterial, bodyMaterial,
  fleckMaterial, bubbleMaterial, dropMaterial, puffMaterial, casingMaterial,
  FLUID_TIME, advanceTime, setQuality,
  Riser, Drip, PuffCloud, frameOf
};

// The library calls them tracers, because that is what they are: specks
// carried along to show the flow, and not air. This project has called them
// bubbles since the first commit, and unit.js and parts.js both say so.
export { Tracers as Bubbles };

// The library keeps the quality settings in one object so a tuner can change
// them together; this project reads a bare flag. Read at module load, as it
// always was, so nothing that captured it at build time shifts under it.
export const LOWFX = quality.lowfx;

// Set both ends of a run's gradient at once. The library's own paint() does
// more than this: it neutralises the attenuation and the emissive, and it
// refuses to put the temperature ramp on vapour. unit.js already does the
// first two for itself in paintFluid(), and it tints the turbine's steam by
// its base colour, so this stays exactly the two lines it always was.
export function setGradient(mat, c0, c1 = c0) {
  const g = mat.userData.g;
  if (!g) return;
  g.c0.value.copy(c0);
  g.c1.value.copy(c1);
}

// One ripple tile of sea, in metres. This is about THIS STATION and not about
// fluids: the open water, the forebay and the channel all set their repeat
// from their own size divided by it, so the three read as one surface rather
// than as three patches meeting at a line. It stays here.
export const SEA_TILE = 5.4;

// The three colours the old file named, kept because unit.js still refers to
// them when it builds a body of water that belongs to no circuit.
export const LIQUID = { COLD: 0x1f6fa8, HOT: 0xd8571e, STEAM: 0xdcecf8 };

export { THREE };

// ---------------------------------------------------------------------------
// The three.js adapter: everything that turns a solved network into a picture.
//
//   import { attach } from '3d-fluid-simulator/three';
//
// The core knows nothing about this module and never imports three.js. This is
// the only place a number becomes a mesh.
// ---------------------------------------------------------------------------

export {
  FLUID_TIME, advanceTime, quality, setQuality, forget,
  flowNormal, rippleNormal, streakTexture,
  gradientise, twoOctaveFlow,
  paint, tintVapour, colourOf, colourAt, glowOf,
  liquidMaterial, surfaceMaterial, bodyMaterial, steamMaterial,
  fleckMaterial, bubbleMaterial, dropMaterial, puffMaterial, casingMaterial,
  build
} from './materials.js?v=03485aad37';

export {
  V, toPoints, roundedPath, pipe, fluidRod, vessel, waterColumn, ripple
} from './pipe.js?v=03485aad37';

export {
  frameOf, Tracers, Riser, Drip, PuffCloud, Plume, puffPointMaterial
} from './particles.js?v=03485aad37';

export {
  planeAt, sectionFrame, halfCut, aim, applyCut, SectionCap, enableClipping
} from './cut.js?v=03485aad37';

// The join between the two halves: a network and a scene in, fluid bodies out,
// and one call a frame that reads the solver and paints what it built.
export { attach } from './attach.js?v=03485aad37';
export { FluidFrame } from './frame.js?v=03485aad37';

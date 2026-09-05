// ---------------------------------------------------------------------------
// index.js - the core barrel.
//
// Everything a consumer needs to describe a network, solve it and read the
// answer, and NOTHING from outside src/core. There is no three.js here, no
// DOM, no clock and no dependency: this module runs identically in a browser,
// in node under `node --test` and in a Blender preview.
//
// The renderer lives behind its own entry point (`src/three`), so a host that
// only wants numbers never loads a line of it.
// ---------------------------------------------------------------------------

export { Network, validate, NetworkError, autoRuns, components, DEFAULTS } from './network.js';
export { Solver, DEFAULT_OPTS } from './solver.js';
export { Surface } from './surface.js';
export * as props from './props.js';
export * as geometry from './geometry.js';
export * as colour from './colour.js';

export const VERSION = '0.1.0';

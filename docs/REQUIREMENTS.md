# Requirements register

Every piece of feedback given on this project, kept as a numbered requirement
with an acceptance test. The point is not the list; the point is that each line
can be checked again later, so a fix that quietly comes undone is caught.

**Status** is one of `DONE` (implemented and verified by the stated check),
`OPEN` (not yet met), or `WATCH` (met, but fragile enough that it has regressed
at least once).

**How to re-verify.** Start a static server (`python3 -m http.server 8099`) and
use the project's own tools:

- `node tools/check.mjs` runs nine accident scenarios plus a phone viewport and
  fails on any console or page error. This is the gate.
- `node tools/look.mjs <camera>` parks the camera on one machine and screenshots
  it big. `PICK=x,y node tools/look.mjs <camera>` names whatever is actually
  drawn under that point, with clipping and opacity accounted for, so a shape in
  a screenshot can be identified rather than guessed at.
- Colour claims are checked by sampling pixels out of those screenshots, not by
  eye. Where a requirement says "measured", the figures are in the commit that
  closed it.

---

## Fluids and colour

| # | Requirement | Status | Check |
|---|---|---|---|
| F1 | Tracers in the water read as flowing water, not as bubbles or white balls | DONE | `look rpv`, `look head`: streaks along the bore. Root cause was `mats.fleck` missing from the unit's material table, so Three fell back to a white `MeshBasicMaterial` |
| F2 | Colour never changes abruptly anywhere; every change is a gradient | WATCH | One recipe: `fluidColour(u)` + `paintFluid(mat, c0, c1)`. Any new call site that mixes its own colour breaks this |
| F3 | Condensate and feedwater are the same water at the same temperature, so the same colour | DONE | `look sump`: pool and suction line measured within 7% per channel |
| F4 | Reactor water visibly warms towards the top, in the body of the water and not painted in front | DONE | `look rpv`. Vertical ramp on `coreWater`, cold at the bottom to `wTop` at the surface |
| F5 | Fluid speeds are consistent between pipes, the boiler and the dome | DONE | One compression law `drawV(v)` drives every scroll, tracer and riser |
| F6 | Pipe-to-vessel junctions are seamless: no colour step, no grey rod, no sleeve | DONE | `look head`, `look dome`. Legs run to the divider plate; all ten collars deleted |
| F7 | The incoming water pipe is properly connected to what it feeds | DONE | `look dome`: feed line runs to a ring at the head of the downcomer |
| F8 | The blue pipe into the boiler reads as fluid entering a bigger tank | DONE | `look dome` |
| F9 | Water is rendered the way real-time work renders water, not as flat plastic | DONE | Two-octave flow map, Beer-Lambert absorption by path length, Fresnel edge. See the long note in `js/view/fluid.js` |
| F10 | Sea water leaves the condenser warmer than it arrives: orange, but less than the reactor | DONE | `look turbine`: intake blue, outfall amber, reactor deeper orange |
| F11 | The INCOMING sea water is cold and blue | DONE | `look turbine`: intake blue at the end it arrives, outfall amber at the end it leaves, inlet box blue below the divider and amber above. The first tube pass FLOWS right-to-left while its geometry runs left-to-right, so its gradient is reversed to match |
| F12 | The open sea, the forebay and the channel are one continuous surface | DONE | All three set their ripple repeat from `SEA_TILE`, and all three use the two-octave flow |

## Geometry and clutter

| # | Requirement | Status | Check |
|---|---|---|---|
| G1 | No network of pipes wrapped round the containment | DONE | 28 buttresses removed; steam and feed leave in one corner |
| G2 | No rings round the containment | DONE | Three tori deleted: springline, plinth, cut rim |
| G3 | No small white dome in the middle of the containment | DONE | It was 110 particle instances stacked on the origin. `Riser`, `Drip` and `Bubbles` now start hidden |
| G4 | No grey metal rings on any pipe | DONE | Flanges removed from `pipe()`; all collars deleted |
| G5 | Pumps have no rims cutting across their water | DONE | Casing is open-ended and shorter than the water in it |
| G6 | Nothing grey hides the sea lines under the turbine | DONE | Condenser lid removed, floor reduced to 0.12 m |
| G7 | No unexplained grey shapes at the bottom of the condenser | DONE | Two causes: the plinth torus passing through it, and vapour drawn as clipped spheres |
| G8 | No grey cylinder between the blue tube and the boiler | DONE | `look dome` |
| G9 | The emergency pump stands between the tank and what it feeds | DONE | `look tank`: suction from the tank, discharge to the cold leg |
| G10 | The emergency tank is in front of the boiler's legs, where it can be seen | DONE | `L.tank.z = 0` |
| G11 | The vent is a hole in the containment: nothing protrudes inside, no column under the stack | DONE | Path starts flush at `-R_IN` |
| G12 | The containment concrete does not read as hollow | WATCH | Cut faces capped up both cut planes, in the liner's grey. The dome's edge is deliberately left open (see G13) |
| G13 | No grey band or arch across the middle of the view | DONE | The dome cap arch runs over the crown by construction, so it is not drawn at all |
| G14 | Bubbles stay inside the vessel they belong to | DONE | Each riser is clipped on its own vessel's plane |
| G15 | Steam enters the turbine at the side, and the casing reads as a real machine cut open | DONE | Closed-ended casing with end walls, floating hoops removed, steam in along the axis |
| G16 | The path from the wheel to the condenser is legible | DONE | Glass throat with vapour falling through it, in one stream from the inlet |
| G17 | Breaking a pipe opens a hole with water coming out, and no black ring | DONE | Torn lip in the pipe's own steel, oriented as a hole in the wall |

## Interface and platform

| # | Requirement | Status | Check |
|---|---|---|---|
| U1 | The phone renders correctly while moving around, and the inside view is not blank | DONE | `check.mjs` phone shots; visual-viewport sizing, context-loss handling, `LOWFX` |
| U2 | The welcome card is short and makes people want to start | DONE | `index.html` |
| U3 | A settings wheel switches each expensive feature on its own | DONE | Seven toggles, live counters |
| U4 | W A S D moves the Site view | DONE | `nudgeSite` |
| U5 | A pleasant sea and a soothing melody; no synthetic white noise | DONE | Real MIT-licensed recording, equal-power crossfade loop, pentatonic bells |
| U6 | The frame rate is not limited by how the fluids are drawn | DONE | 73 transmissive materials removed: 862 draw calls / 569 ms to 514 / 12.3 ms |
| U7 | Nothing expensive runs until the welcome card is dismissed | DONE | `boot()` in `js/main.js`; probe shows `units: 0` before, `2` after |
| U8 | Commits carry the repository owner's authorship | DONE | Author and committer are the owner on every commit |
| U9 | No em dashes in interface copy | DONE | `grep` over `index.html`, `js/ui.js`, `js/view/labels.js`, `js/scenarios.js` |

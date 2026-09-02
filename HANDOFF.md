# Handoff

Read this before touching anything. It is the one document an agent needs to
take this project over cold. Keep it true: when you finish a piece of work,
update the sections it touched in the same commit (see AGENTS.md).

## What this is

A static, no-build browser app: two nuclear stations side by side, one with
active (pumped) cooling and one with passive cooling, driven through historical
accidents so a worried layperson can see why passive cooling is safer. Two
views: **Site** (Canvas-2D isometric island) and **Inside** (Three.js WebGL
cutaway). Deployed by GitHub Pages from the repository's default branch at
`https://mayerwin.github.io/nuclear-cooling-sim/`.

Owner: mayerwin. Development branch: **`main`** (commit and push there; do not
create other branches or pull requests unless asked). Commits carry the owner's
authorship; the harness appends its own trailer.

## The one rule that governs everything

**Every piece of review feedback is a numbered requirement with a proof
screenshot, and nothing is marked done until its picture has been read against
its caption.** The record is `docs/requirements.json`, rendered to
`docs/requirements.html` (filter, sort, thumbnails) and linked from the app's
help card. GitHub issue #1 is the owner's own tick list, nothing more.

Statuses: `DONE` (met, picture read), `WATCH` (met but fragile or below the bar
asked for), `OPEN` (not met). Never mark DONE from code alone.

## How to work

```
python3 -m http.server 8099                # static server (tools expect 8099)
node tools/stamp.mjs                       # after ANY edit to js/ or css/: content-hashes
                                           # every module URL; --check fails if stale
node tools/check.mjs                       # THE GATE: nine scenarios + a phone viewport,
                                           # fails on any console or page error
node tools/look.mjs <camera> [scen] [min]  # park the camera on one machine, 1500x950
PICK=0.5,0.42 node tools/look.mjs <cam>    # name what is actually drawn under a point
REFRACT=1 node tools/look.mjs <cam>        # with real refraction switched on
node tools/proof.mjs [all|specials|cameras]# re-capture every proof image from THIS build
node tools/reqpage.mjs                     # rebuild docs/requirements.html from the json
```

Renders run on SwiftShader here (1-3 min each), so drive the plant clock rather
than waiting on frames; `look.mjs` already does. Read the rendered PNG yourself
before claiming anything. Sample pixels for colour claims (PIL is available).

A probe that only opens the welcome card misses every error in the plant view;
`check.mjs` enters the plant view, and any quick probe must too.

The loop for a change: edit -> `stamp` -> quick plant-view probe -> `look` the
part you changed and READ it -> `check` -> `proof` -> read the new proofs ->
update `requirements.json` (status, verified date, check text, proof caption)
-> `reqpage` -> commit on main -> push. Re-capture proof after any change to
materials, layout or the section: the pictures must be from the build shipped.

## Architecture (js/)

- `main.js` boot, input, frame loop. **Nothing heavy runs before the welcome
  card is dismissed** (`boot()`); the UI is rebound to the stage then
  (`ui.bindStage`). `floodDepthNow()` is the one flood-height formula.
- `sim.js`, `plant.js`, `scenarios.js` the plant model and the accidents.
- `flow.js` 1-D network hydraulics: `Leg` (velocity, and **temperature**:
  `T0`, `T1`, `dT`, display `gain`), `Circuit.setFlow`, `Circuit.setTemps`
  (walks legs in flow order), `Circuit.range()` (coldest/hottest water).
- `view/unit.js` (~2400 lines) the whole station as geometry, and the per-frame
  `update()`: `solve()` flows, then **`solveTemps()`** sets one inlet
  temperature per circuit and the `dT` of the legs that exchange heat (core,
  boiler tubes, condenser's cold pipe, pool coil). `colourIn(range, T)` is the
  only place a temperature becomes a colour; `paintFluid()` the only way a
  fluid material is painted. **Nothing is told a colour directly.**
- `view/fluid.js` the fluid shader: two-octave aperiodic flow map,
  Beer-Lambert absorption by path length, Fresnel edge; `gradientise()`
  installs it; `FLUID_TIME` is the shared clock; `SEA_TILE` the one ripple
  size for every piece of sea. No transmission by default (`wetTr` is what a
  material would use if the Refraction toggle is on).
- `view/materials.js` surfaces; `waterColor` ramp mixed in sRGB (five stops,
  no white).
- `view/parts.js` `pipe()` (casing, capped liquid/steam core, tracers),
  `vessel`, `tube`, `slab`.
- `view/plume.js` `Plume` (rising smoke/steam) and `PuffCloud` (a body of
  vapour in a space); the sprite is noise, not a radial blur.
- `view/stage.js` renderer, lights, section (stencil caps in
  `view/section.js`), quality toggles (`setQuality`), flood sheet, sea.
- `view/labels.js` captions, measured in the label layer's own coordinates.
- `site/*` the isometric island.

Layout constants (`L` in unit.js) put every machine in one vertical plane;
`CUT_AZ` is the heading the section faces. Local +z is the removed half.

## Current state (2026-09-02)

47 requirements: 43 DONE, 4 WATCH, 0 OPEN. The WATCH lines are the honest
frontier:

- **F9** water quality: a defensible real-time model, not a shipped-game one.
- **F12** the forebay still reads flatter than the open sea at the bay camera.
- **F2** one colour recipe: any new call site that mixes its own colour breaks
  it. Grep `fluidColour(` in unit.js; only `colourIn`/`colourOfT` may call it.
- **U12** every-option-on frame rate: mechanisms in place (refraction target at
  a quarter of the pixels, pixel density capped at 1.5x, bloom at a ninth);
  only measured on the software renderer (772 ms vs 10.4 ms defaults). The
  owner's laptop number is what closes it.

The condenser was rebuilt last: steam leaves the casing through its right-hand
end wall into a glass box under the generator holding ONE vertical cold
sea-water pipe; the warm return runs outside the box. Colour is scaled within
each circuit's own temperature span (`Circuit.range`), so a 290-325 C primary
loop shows its cold leg blue and its hot leg red.

## Traps that have already bitten (do not rediscover them)

- An `InstancedMesh` whose matrices were never written draws every instance at
  the origin: it looked like a white dome on the containment floor. Particle
  systems start hidden.
- 73 transmissive materials cost 862 draw calls and 569 ms a frame; refraction
  is an opt-in toggle, never the default.
- The tint used to be multiplied into `gl_FragColor` AFTER tone mapping, so
  everything washed out; it multiplies the diffuse. The ramp used to be mixed
  in linear space, so blue went grey a fifth of the way up; it is mixed in sRGB.
- Capping the section's cut planes with flat quads put a concrete arch across
  the middle of the view (the two faces of a wedge meet on the axis). Section
  caps are stencil-based.
- The flood sheet had a hole cut round the containment and was never painted;
  it stood in wall time so tools never saw it rise. It reaches in, is sea
  coloured, rises at 2.5 m/s and snaps for tools (`dt > 5`).
- The lazy boot wired the settings panel before the stage existed: seven
  disabled boxes. `ui.bindStage(stage)` after boot.
- A tube built left-to-right whose water flows right-to-left paints backwards:
  say `flowDir: -1` on the run, or build it in flow order.
- A materials/layout edit while a render batch is loading pages is fine, but
  `stamp` mid-batch can hand a page a half-written module; stamp between
  batches.
- The vent, the emergency tank and the wall caps have each regressed at least
  once; check G11, G10, G12/G13 first after touching the containment.

## Owner's standing rules (from review)

- Fix what is asked; never "not going to claim". Verify by rendering, never by
  reading code. Include the proof.
- Colours never change abruptly; every change is a gradient along a run.
- No grey rings on pipes, no collars, no unexplained objects, nothing hollow.
- No em dashes in interface copy.
- Do not add work the owner did not ask for (a PR, an extra branch, a tracker
  that duplicates the page).

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
node tools/serve.mjs . 8099                # static server (tools expect 8099). NOT python's
                                           # http.server on Windows: it serves .mjs as
                                           # text/plain, the physics module fails to load
                                           # and the machines silently run on the fallback
node tools/stamp.mjs                       # after ANY edit to js/ or css/: content-hashes
                                           # every module URL; --check fails if stale
node tools/check.mjs                       # THE GATE: nine scenarios + a phone viewport,
                                           # fails on any console or page error
node tools/look.mjs <camera> [scen] [min]  # park the camera on one machine, 1500x950
PICK=0.5,0.42 node tools/look.mjs <cam>    # name what is actually drawn under a point
REFRACT=1 node tools/look.mjs <cam>        # with real refraction switched on
LABELS=0 node tools/look.mjs <cam>         # captions hidden (proof.mjs does this for every machine close-up)
node tools/proof.mjs [all|specials|cameras]# re-capture every proof image from THIS build
node tools/reqpage.mjs                     # rebuild docs/requirements.html from the json
node tools/perf.mjs                        # frame cost of the inside view (mean/median/p90 ms, calls, tris)
```

The station's steel is designed in Blender and imported (see "The model comes
from Blender" below). To change a machine:

```
edit assets/layout.json and/or tools/blender/plant.py
py -3 tools/bl.py run ~/Apps/blender-mcp/reset-scene.py            # empty the live Blender
py -3 tools/bl.py run ~/Apps/blender-mcp/run-plant.py --shot x.png # rebuild in it and screenshot the viewport
py -3 tools/bl.py run ~/Apps/blender-mcp/view-inside.py --shot y.png  # building hidden
py -3 tools/bl.py run tools/blender/glshot.py --out z.png          # viewport rendered offscreen (never black)
~/Apps/blender-5.2.1-windows-x64/blender.exe -b -P tools/blender/plant.py -- --export assets/plant.glb
```

then `look` it in the app: the app reads the glb, and the water in unit.js
reads the same numbers from layout.json (the constants in unit.js's `L` must
agree with it: they are the same numbers today; move them into the json when
you next touch them).

Renders run on SwiftShader on the Linux box (1-3 min each), so drive the plant
clock rather than waiting on frames; `look.mjs` already does. Read the rendered
PNG yourself before claiming anything. Sample pixels for colour claims (PIL is
available; on Windows it is under `py -3`).

The tools find the browser through `tools/pw.mjs`. On the Linux box nothing
needs setting. Anywhere else (the owner's Windows laptop, say):

```
PW_MODULE=<path to playwright/index.mjs>   # any npm install of playwright
PW_CHROME=chrome                           # the installed Chrome, or a path to a binary
PW_GPU=1 PW_HEADED=1                       # the real GPU, vsync off, in a visible window
PW_URL=http://<lan ip>:8099/index.html     # when 127.0.0.1 is not reachable (see traps)
```

Frame-rate numbers only mean anything with `PW_GPU=1`: SwiftShader's ratios
are not a GPU's. Time the gap between animation frames, never a loop of
`render()` calls, which on a GPU measures how fast the calls are submitted.

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
  `view/section.js`), quality toggles (`setQuality`), the render scale
  (`setScale`, a multiplier under the hidpi toggle), flood sheet, sea.
- `view/autoq.js` the first-run tuner: measures the wall-clock frame gap the
  first time the inside view is drawn and takes options off, cheapest loss
  first (`LADDER`), until the median is under 37 ms or the ladder is used up.
  Stores the result in `localStorage` (`ncs.gfx`) and re-applies it next visit;
  a hand-set box is stored as the visitor's own and ends tuning; the panel's
  Measure again re-runs it. Stands down under `navigator.webdriver` unless
  `?tune=1`, so the tools measure the shipped settings; `?tune=0` stands it
  down anywhere.
- `view/labels.js` captions, measured in the label layer's own coordinates.
- `site/*` the isometric island.

Layout constants (`L` in unit.js) put every machine in one vertical plane;
`CUT_AZ` is the heading the section faces. Local +z is the removed half.

## Seventh round (2026-09-05): the turbine hall, and every junction walked again

88 requirements: 82 DONE, 5 WATCH, 1 OPEN (L4, L5 are the library agent's).
The owner's screenshot of the turbine hall, and a re-review of the whole app
(register R13 to R15):

- STEAM IN THROUGH THE TOP. The steam line used to arrive on the casing's
  axis, so the shaft ran inside the steam pipe. It now comes down into the
  top of the casing near its narrow end (layout `pipes.steam`, last two
  points; trim to the sloped cone). The shaft alone owns the axis.
- A TABLE, NOT FLOATING BLOCKS. `turbine.table` in the layout: a beam behind
  the cut on two columns to the ground, a block under each bearing up to its
  housing, a block under the generator; the generator moved 0.4 m right so
  the bearing between it and the casing is clear; the end shields (collars
  on the shaft) are gone. `plant.py build_turbine` reads all of it.
- THE TANK AND THE COLUMNS. The boiler's columns ran through the emergency
  tank under it. The tank is at z 0.6, 4.0 m deep (`L.tank` in unit.js and
  `active.tank` in the layout agree); the columns stand at z -2.2 behind it.
- JUNCTIONS RE-WALKED (R15). The feed's casing now runs on inside the
  boiler shell to the downcomer (trim 0.8 instead of stopping at the wall,
  which left a bare rod of water crossing the steam space); the gravity
  fill's water stops just inside the head wall (`IN` at base + 16.4) instead
  of 0.8 m into the empty head.
- NOT DONE ON PURPOSE: recolouring the sea outfall. Its ten-degree rise is
  drawn with gain 10 and painted on its own span, so it leaves as red as the
  hot leg. Painting it on a wider span put the outlet on the palette's
  cream midpoint and the sea left the condenser brown. The palette
  (blue, cream, orange) has no "slightly warm blue"; leave the outfall red
  until the palette changes, and say so if the owner asks.
- `tools/eval.mjs`: `EXPR='...' node tools/eval.mjs` boots the plant view
  and prints a value from the running model, for reading a number instead
  of guessing at it.

## Sixth round (2026-09-04): junctions, supports, the reactor's rings, the passive side

85 requirements: 79 DONE, 5 WATCH, 1 OPEN (L5 and the WATCH L4 belong to the
library agent, see below). The owner's review of the Blender-built station,
all fixed in the model and its placement (register R8 to R12):

- JUNCTIONS. Every pipe in `assets/layout.json` carries a `trim` [t0, t1]:
  `plant.py` shortens the CASING by that much at each end so the steel stops
  at the wall it enters (buried a few centimetres, more where the wall is
  sloped or curved), while the app's water keeps the untrimmed centreline and
  runs on inside. The water bodies FILL their vessels now (the boiler head's
  water is the shell's own head profile less a finger, the vessel's water is
  r 3.12 in a 3.2 barrel): drawn smaller, a band of inside wall showed round
  the water and the cut pipe troughs crossing it read as fins on the joint.
- SUPPORTS. Nothing structural is cut by the plane any more: bearing
  pedestals, saddles and the boiler's two columns live wholly in the kept
  half; the reactor pedestal and the sea pump's plinth are `half_cylinder()`
  solids with a flat face at z = -0.02. A cut box or cylinder shows its
  inside (two-sided materials, no caps) and reads hollow: do not place one
  across z = 0.
- REACTOR. No flange ring, no studs, no fuel mark, no level ring: every ring
  round the vessel read as an unexplained object. `rpv_skirt` is now the
  plain pedestal (same name: the app hides it when the vessel fails).
- PASSIVE SIDE. One straight gravity line from the pool floor into the head
  with the valve on it (stem along -x); the floor-to-tee riser is gone (the
  recirculation leg still carries flow in the solver, nothing draws it). The
  residual heat loop is one hairpin under the pool water on the vessel's
  right, its two legs a metre apart; the serpentine and its nine-metre span
  are gone. `coil` is now APP_DRAWN in model.js (the app draws its water).
- NO exhaust flange at the shell top; no nozzle stubs anywhere (R8, G4).
- ROUND HEADS. The reactor's two heads and the boiler's dome are elliptical
  arcs of eight points in `assets/layout.json` (`rpv.profile`, `sg.profile`;
  `rpv.head_from` indexes where the top head starts). Three facets read as a
  pointed dome in every wide shot. The boiler's channel head is unchanged
  because the app's head water is cut to it.

SHARED WORKING TREE. While this round was done, the agent building
`../3d-fluid-simulator` was editing this same checkout: `js/view/fluid.js`
became a thin layer over their library vendored at `vendor/fluidsim/`, and
they added register lines L1 to L5 and a paragraph below. Their changes were
uncommitted for eleven hours; this round's commit includes them so that HEAD
is the tree the gate ran on and the proofs were shot from. Two agents in one
checkout is a hazard: read `git status` before assuming the tree is yours.

## The model comes from Blender (2026-09-04, fifth round)

75 requirements: 71 DONE, 4 WATCH (F2, F9, F12, U14), 0 OPEN. Lines B1 to
B5 are this round; every earlier proof was re-captured from this build.

The owner asked for the 3D model to be designed properly, in Blender, with
the agent seeing what it does, and for the half cutout to stay a render-time
effect. That is how it is built now:

- `assets/layout.json` is the one description of the station in metres:
  every vessel profile, pipe centreline, pump, the turbine, condenser, sea
  circuit, vent, pool and tank. Local x runs across the picture, y up, z is
  depth; the cut plane is z = 0 and the far half (z < 0) is kept.
- `tools/blender/plant.py` builds every static part from it with bpy (264
  objects: lathes for the vessels, bevelled curves for the pipes with real
  elbows, boxes, tori, an empty per rotor with the wheel or impeller under
  it) and exports `assets/plant.glb` (y-up, 1.7 MB). It runs headless with
  `-b -P ... -- --export`, or inside the live Blender.
- `js/view/model.js` loads the glb once. `instantiate({passive, cut})`
  gives a unit its own copy: the other design's parts dropped by name
  (`pool_*`, `coil`, `pipe_prhr_*`... vs `tank_*`, `eccs_*`...), the parts
  the app draws itself dropped (`wall`, `dome`, `liner*`, `slab`, `floor`,
  `fuel_rod_*`, `sg_tube_*`, `cond_tube_*`), the live parts kept as objects
  (`*_rotor`, `*_lamp`, `lamp_bulb`, `lamp_bus_*`, `grav_valve`,
  `rpv_skirt`, `gen_body`, `cond_shell`) and everything else merged into
  one mesh per material: 16 draw calls for a unit's steel instead of 250.
  Every material is cloned per unit, DoubleSide, cut on the unit's plane.
- `unit.js` builds only what is wet, moving or glowing: water bodies,
  steam, the tube banks (fluid rods with gradients), tracers, drips, the
  fuel, the level ring, the lights. Pipes are built with
  `{ casing: false, cut: this.cut }` (`this.pipeOpts`): `parts.pipe()` then
  makes no casing (the model's is there) and clips the core on the plane,
  so a water run is a trough in a trough, the way a cutaway drawing has
  it. Tracers use a per-unit clone of the fleck material, cut the same.
- The building (wall, dome, liner, floor, breach plug, section caps) stays
  procedural: it is what the stencil caps and the breach need.
- No nozzle stubs, no collars: the model's pipes end inside the walls they
  serve and the app's water runs on through, which is what G4, F6 and G8
  ask. A first export had bosses at every penetration; cut on the plane
  they read as the grey collars the owner had already rejected.

Seeing Blender: the official Blender Lab MCP add-on (`bl_ext.user_default.mcp`,
Blender 5.1+; the portable 5.2.1 LTS is under `~/Apps`) listens on
192.168.1.38:9876 with autostart and online access on; the MCP server is
`~/Apps/blender-mcp/.venv` (`blender-mcp` 1.0.0 with `mcp[cli]<2`), registered
in `~/.claude.json` as `blender`. `tools/bl.py` drives it from a shell:
`run <file|-> [--shot out.png] [--window]` executes Python in the live Blender
and screenshots the 3D viewport (`shot`, `objects` too). Blender's screenshot
of the viewport is the feedback loop; read it, then `look` the app.

Frame cost after the change, inside view, the tools' 1500x950 window at 1x on
the laptop's Intel Arc: see B5 in the register (numbers there).

## The fluids come from the library now (2026-09-04)

The fluid code has been pulled out into the reusable library next door,
`../3d-fluid-simulator` (a local repository, no GitHub yet), and **this project
now draws its water with it**. Read that repository's `HANDOFF.md` before
touching anything to do with fluids here.

What changed, and it is one file:

- `js/view/fluid.js` was 620 lines and is now 72. It is a thin layer over
  `vendor/fluidsim/three/`: it re-exports what the library provides, renames
  `Tracers` back to `Bubbles` because this project has called them that since
  the first commit, keeps `setGradient` as the two lines it always was (the
  library's own `paint()` does more, and `unit.js` already does those parts
  itself in `paintFluid()`), and keeps `SEA_TILE`, which is about this station
  rather than about fluids.
- `vendor/fluidsim/` is a copy of the library's `src/`. **VENDORED, not
  imported from the sibling folder**: `tools/serve.mjs` is rooted at this
  repository, so a relative import reaching outside it resolves to a path the
  browser cannot fetch. To take an update, copy the library's `src/` over
  `vendor/fluidsim/` again, run `node tools/stamp.mjs`, then run the gate.
- **THE STAMP NOW COVERS `vendor/fluidsim/` AND IT DID NOT AT FIRST.** Vendor
  files were excluded from the hash and from the query strings, which is right
  for three, pinned by version and never edited here, and wrong for a library
  that is this project's own physics and changes whenever that library does.
  Pages are served with a long max-age, so it was the one part of the app a
  returning visitor could hold a stale copy of, and it is the part that decides
  what every circuit does. It is in the hash now and its own internal imports
  carry the query, which is the only way the vendored copy differs from the
  library's `src/`: a plain diff of the two shows those lines and nothing else.
- Taken again on 2026-09-04 after the library's second performance pass, which
  fixed three real defects in the solver rather than only making it faster (a
  sparsity pattern that went stale when a host imposed a pressure, a conjugate
  gradient budget that returned an ascent direction on a big network, and an
  Armijo test that rejected every capped step). The gate passes with it: nine
  scenarios, the phone, no console or page errors, and every scenario ends
  where it should. The register's proof images were NOT re-captured, and that
  is deliberate: this project does not use the library's solver yet, so none of
  those fixes can change a number here, and a capture of moving water differs
  from the last one by more than any of this would.
- Nothing else moved. `unit.js`, `parts.js`, `materials.js`, `stage.js` and
  `plume.js` are untouched and `js/flow.js` still does the hydraulics, so every
  number and every picture is what it was.

WHAT HAS NOT HAPPENED YET, and it is the bigger half. The library has a real
network solver: volumes as nodes carrying pressure and inventory, one mass flow
per edge from a momentum equation, the flows from a nodal Newton, and circuits
DERIVED rather than authored. This project still uses its own `js/flow.js` and
`unit.js`'s `solve()` and `solveTemps()`, so **`unit.js` has not shrunk**.

Moving onto the library's solver WILL CHANGE THE NUMBERS, because real friction
and a real pump curve will not reproduce the hand-set flows that four review
rounds approved. The plan the library's design work settled on is to impose the
present flows and temperatures on day one so the picture is byte-identical,
then release one circuit at a time with a proof capture between each. The sea
circuit is the least visually loaded and so the safest to release first; the
primary loop is the most visible and should be last. That order is a question
for the owner, and it is open question 5 in the library's HANDOFF.

## Current state (2026-09-02, fourth round)

69 requirements: 65 DONE, 4 WATCH, 0 OPEN. This round re-read every proof
against its line (the owner's ask), rewrote the lines whose text still
described the old condenser (G18, G15, G16, G6, G7, F10, F11, F3, F6, F7,
G21, G23), and changed three things:

- NO GLASS. The glass fronts of the third round are gone, at the owner's
  request: the liquid behind them was still cut, so they explained nothing.
  Everything is built whole and the near half is removed at render time by
  the unit's one plane, walls and liquids alike; the simulation never
  knows. Steam runs get `section: this.steamSection` in `pipe()`, which
  gives them a solid far casing (a water run's opaque core needs none).
- THE SITE VIEW MOVES AT 2 ms. `Renderer.layerBlit()` draws the ocean and
  the sorted pass into layers a third wider than the window each way and
  blits them panned and zoomed; the pass is redrawn only when the view
  leaves the margin, the zoom drifts past an eighth, or the plant changes.
  Dragging went from 44 ms a frame to 1.6.
- THE INSIDE VIEW AT 9 ms on the owner's full window: one interior lamp per
  unit (four point lights were a quarter of the frame), pixel density
  capped at 1.25x (1.5x cost another quarter for nothing visible).
  `?aa=0` switches the canvas's multisampling off for measuring.

The third review had set two rules that still hold: EVERY PIPE END IS
BURIED inside the water of what it serves, and CAPTIONS SHOW IN BOTH VIEWS.

## Earlier (2026-09-02, third review)

69 requirements: 65 DONE, 4 WATCH, 0 OPEN. The third review (G26 to G30,
U16) set three rules that every future change must keep:

- EVERY PIPE END IS BURIED. A pipe starts and ends inside the water of the
  body it serves (a vessel's water, a pump's water, a plate), never on a
  surface. No caps, no openings drawn on walls, no gaps.
- (Glass fronts: tried in this review, removed in the fourth round. Do not
  put them back; the section is walls and liquids alike.)
- CAPTIONS SHOW IN BOTH VIEWS on a wide screen, each station's in the margin
  on its own side; a column that overflows shares its height evenly.

The turbine exhaust is a pipe (`this.exhaust`, in `pipes`), from inside the
casing to inside the shell. The condenser's end plates are 0.25 m; the tube
runs and the two nozzles meet inside the sea-side plate at the rows' own
heights. The condensate pool lies in the bottom of the shell and the drops'
floor is its surface.

Before that, the second review (G19 to G25, U15): The last thing done was the
owner's second review of the machines (G19 to G25) and the performance
question (U15):

- The boiler's steam space is drawn; the feed line runs straight over the
  reactor into the boiler's right side; the downcomer ring stands just
  outside the water column so its blue-to-orange mixing shows as the two
  strips of a cut ring (inside the column it was behind opaque water).
- The boiler's legs and divider are gone (one pedestal behind the cut); the
  hot leg ends on the channel head at an opening, the cold leg leaves from
  one. The reactor's core barrel is gone.
- The turbine exhaust is a funnel in the casing floor into a textbook surface
  condenser under the machine: water boxes, a two-pass tube bank (in cold
  below, out warm above), hotwell, condensate pump. The sea has a circulating
  pump at the forebay; in on the near side, out on the far side, no crossing.
  `L.turb` stays at 26; the casing is t.x-6.5..t.x-1.7, the generator at
  t.x+0.6, the forebay at t.x+5.8. look.mjs cameras follow.
- Performance (U15, docs/proof/U15_performance.txt): the slow view was the
  2-D SITE at 79 ms a frame on the owner's full window, not the 3-D. The
  panels' backdrop blur cost 35 ms of it and is gone; the sorted Canvas-2D
  pass is drawn into a layer (`renderer.layer`) and reused until the camera,
  `world.propsVersion` or a station's `stateKey()` changes, with the boats,
  fire glows and corium glow drawn live over it; the vignette is the `#vig`
  CSS overlay. Site view 2.9 ms idle; inside 12 ms defaults on the Intel GPU.
  On the RTX 4070 the page runs at 6 ms: Chrome's GPU choice is a Windows
  setting, not the page's.

Before that, the code review (R1 to R6) had found six bugs and halved the
frame. The last thing done was a full
code review (register lines R1 to R6): the site's intake pumphouse had never
drawn (a NaN sort key), Reset did not heal a broken pipe, the Bubbles and
Steam toggles were overwritten every frame (and Bubbles hid the fuel rods),
keys typed into the resolution slider paused or reset the plant, the flood
sheet overrode the sea's ripple tile, and the frame was spending most of its
CPU on caption layout thrash, hidden tracers and finished plumes. Desktop
defaults went from 17 ms to 7.8 ms a frame at 1500x950; every option on from
24 ms to 14.6 ms. The condenser's steam cloud, built and never stepped, now
drifts down onto the cold pipe (faint, opacity 0.1).

Conventions that came out of the review:

- The units decide the visibility of their own tracers, risers, drips and
  vapour every frame from `stage.q.particles` / `stage.q.steam`. Do not set
  visibility for those from `setQuality`; it lasts one frame.
- `Unit.reset()` is called from `sim.onReset`; anything a break adds to the
  scene goes in `breakFx` so reset can take it out again.
- Captions (`labels.js`) measure their boxes only when their text changed or
  `invalidate()` was called (main.js calls it on resize). Never read a
  bounding rect every frame in the frame loop.
- The shadow map redraws on alternate frames (`shadowMap.autoUpdate` is
  false; `render()` sets `needsUpdate`). Toggling shadows sets it too.
- `Plume` hides itself when nothing is alive; `PuffCloud` starts hidden.
- Scratch `THREE.Color`s at the top of unit.js; do not allocate colours in
  `update()`.
- Anything on the site view that changes every frame must be drawn LIVE
  (after the layer blit in `drawSite`), not in `drawProp`/`collect`; anything
  the layer depends on must be in `world.propsVersion` or `PlantView.stateKey`.
- Do not put `backdrop-filter` back on anything that sits over a canvas.

The WATCH lines are the honest frontier:

- **F9** water quality: a defensible real-time model, not a shipped-game one.
- **F12** the forebay still reads flatter than the open sea at the bay camera.
- **F2** one colour recipe: any new call site that mixes its own colour breaks
  it. Grep `fluidColour(` in unit.js; only `colourIn`/`colourOfT` may call it.
- **U14** a Pixel 10 number. Nothing has been measured on a real phone. The
  laptop's Android emulator was reachable through Playwright's `_android`
  (see `android-tune.mjs` in the session notes below) until the VPN cut
  loopback. The tuner (U13) is what makes a slow phone acceptable in the
  meantime; a measured Pixel 10 frame time is what closes the line.

U12 closed on the laptop's GPU: every option on went from 76 ms a frame to
21 ms at 1500x950 (186 ms to 40 ms on the full window at 1.5x), and the code
review then took it to 14.6 ms. The whole of
the collapse was bloom's composer target resolving depth and stencil (below).
Chrome runs on the laptop's Intel Arc, not its RTX 4070; that is Windows' per-
app graphics preference and not something the page can choose.

The last thing built was the first-run tuner (U13) and the register lines
U12 to U14. Before that, the condenser was rebuilt: steam leaves the casing through its right-hand
end wall into a glass box under the generator holding ONE vertical cold
sea-water pipe; the warm return runs outside the box. Colour is scaled within
each circuit's own temperature span (`Circuit.range`), so a 290-325 C primary
loop shows its cold leg blue and its hot leg red.

## Traps that have already bitten (do not rediscover them)

- Blender: the official MCP add-on needs Blender 5.1+ (4.2 will not load
  it); `mcp` 2.x breaks the server (`mcp[cli]<2`); the add-on will not
  start its server until `preferences.system.use_online_access` is on; the
  screenshot tool's parameter is `area_ui_type`, not `area_type`; on this
  laptop 127.0.0.1 is dead (VPN), so the add-on binds the LAN address.
- glTF: the exporter turns bevelled curves into meshes only with
  `export_apply=True`; the y-up conversion leaves a child's local axes as
  built, which is why the rotors are empties positioned at the wheel with
  children in local coordinates. `mergeGeometries` needs identical
  attribute sets: model.js strips everything but position and normal.
- `pipe()` with `casing: false` returns the core as `casing`, which is what
  main.js raycasts to break a pipe; keep it that way.
- `tools/proof.mjs`: the camera map is extended below its literal with
  `CAMS.x.push(...)` and `CAMS.x = (CAMS.x || []).concat(...)`; a plain
  `CAMS.x = [...]` there silently drops every crop the literal listed for
  that camera (B3 went missing that way).
- Patching a CRLF file from Python: read and write in BINARY. In text mode
  Windows Python turns an explicit `
` into `
` on write, and on
  read turns the lone `
` into a blank line, so the next anchor never
  matches and the file grows blank lines. This round did exactly that to
  five files before noticing.

- `Camera.applyTransform` SETS the canvas matrix. Anything meant to shift it
  (the cached layers' margin) goes through `cam.ox/oy`, not a translate before
  it. Getting this wrong drew the whole site a third of a window off and an
  alignment test that compared two frames with the same bug passed: check a
  site-view SCREENSHOT after touching renderer.js.
- Steam runs are cut on the plane, casing and vapour (`opts.section` in
  `pipe()`); water runs keep a whole opaque core inside a far-wall casing.
- The condenser's three runs nest: outer run lowest and highest row.
- The GPU tools need `PW_HEADED=1`. Without it headless Chrome renders on
  SwiftShader and a single look.mjs takes seven minutes; it looks like a hang.
- Git Bash mangles `/v` `/d` `/f` into paths, so `reg add` fails with
  "Invalid syntax": do registry work from PowerShell.
- The working tree is CRLF (autocrlf). A patch script must normalise line
  endings before matching or every anchor misses.
- Edits to module files while a proof or check batch is running hand a page
  a half-written module. Wait for the batch.

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
- A multisampled render target that RESOLVES its depth and stencil costs
  60 ms a frame on an Intel GPU through ANGLE; that was the whole price of
  bloom. The composer target says `resolveDepthBuffer: false,
  resolveStencilBuffer: false`: nothing after the scene pass reads them.
- Timing `render()` in a loop measures CPU submit time. On SwiftShader that
  is the frame; on a GPU it is nothing like it. Time the animation-frame gap.
- The tuner used to throw away a two-second window with fewer than twelve
  frames as a stall, so on a device at five frames a second it never decided
  anything. A window is two seconds AND at least four frames.
- The tuner must stand down under automation, or every proof taken on
  SwiftShader has all its options stripped first. `navigator.webdriver` is
  the guard; `?tune=1` lifts it for testing the tuner itself.
- On the Windows checkout `core.autocrlf` gives every file CRLF endings.
  `stamp.mjs` hashes over LF so the stamp is the same on both machines; any
  patching script has to match against LF and write back CRLF.
- Python's `http.server` on Windows serves `.mjs` as text/plain (registry
  MIME map); the physics module fails to load and everything still looks
  fine. `tools/serve.mjs` instead.
- A VPN client on the laptop (hide.me, with Tailscale also up) blocked TCP
  over 127.0.0.1 mid-session: `connect` fails with "address not available"
  while ping works. adb and anything on localhost dies with it. `PW_URL` with
  the LAN address keeps the tools going; the emulator does not come back until
  loopback does.

## Owner's standing rules (from review)

- Fix what is asked; never "not going to claim". Verify by rendering, never by
  reading code. Include the proof.
- Colours never change abruptly; every change is a gradient along a run.
- No grey rings on pipes, no collars, no unexplained objects, nothing hollow.
- No em dashes in interface copy.
- Do not add work the owner did not ask for (a PR, an extra branch, a tracker
  that duplicates the page).

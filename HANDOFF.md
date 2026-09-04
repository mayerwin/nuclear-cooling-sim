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
```

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

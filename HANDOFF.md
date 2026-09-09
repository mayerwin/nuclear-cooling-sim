# Handoff

Read `AGENTS.md` first: the rules, the tools, the loop. This file says where
the work stands as of 2026-09-08 and what to do next, in order. When it
changes, rewrite it; never append to it.

## What this is, and what done means

Two nuclear stations side by side, one with pumped cooling and one with
passive cooling, taken through historical accidents so a worried layperson
can see why passive cooling is safer. A Site view (an island from above) and
an Inside view (both buildings cut open in WebGL, every vessel sliced down its
axis). The steel is a Blender model built from `assets/layout.json`; the water,
the steam and every pipe's contents are drawn by the owner's fluid library
from its own solver, which runs every circuit of the plant in the frame loop.

Done means two things, in this order:

1. This app is perfect: every line of the register is DONE with a proof from
   the shipped build, and the owner's own walk through the app finds nothing.
2. The library `../3d-fluid-simulator` is complete (every line of its own
   register DONE, or WATCH for a reason the owner accepts) and then published
   on GitHub on the owner's word. The last step of this project is to check
   that it has been published.

## Where it stands

- The model. Every vessel is a wall with a nozzle bored through it for each
  line; every casing passes its wall and ends open inside; the cut faces are
  drawn solid; the steam, feed and vent lines pass the containment wall in
  sleeves. The condensate pump and the sea pump are can pumps with their
  bowls under the floor and in the bay. The picture is the library's, drawn
  from the solver's state (`?draw=sim` shows the old hand-built one, kept for
  comparison only). Proofs: `docs/proof/R27_*.png`.
- The physics. The library's solver runs the sea circuit, the primary, the
  secondary and every accident line; the plant model owns the vessel
  pressures and the reactor's level and hands the solver its valve and pump
  commands. The health table (`docs/proof/R26_health.txt`) reads zero mass
  adrift on every row of every scenario on both units and two to four
  unconverged steps a row, all of them the release on day one.
- The register: 101 lines, 93 DONE, 7 WATCH, 1 OPEN (`docs/requirements.html`).
- The library: 92 lines, 89 DONE, 3 WATCH (C8 is physics on purpose; R6 and
  P7 need a real phone). Vendored at 7e95ec0. Its session is named
  `3d-fluid-simulator-03` today (ListAgents shows the current one; it has
  read both repositories' AGENTS files).
- Frame cost: the library's drawing costs about 1.5 ms a frame more than the
  old one at 1500x950, measured under the trading workstation's GPU load.

## Do this, in order

1. Walk the app as the owner would: every scenario, both units, Site and
   Inside, the phone viewport, every machine close up (`node tools/look.mjs`
   has a camera for each). Hold it against the rules in `AGENTS.md`. Fix what
   fails, with a proof for each fix. The owner's last complaint was pipes
   blocked by walls; it is fixed, but the owner has not yet walked this build.

2. Close the register's open and watch lines, each with what it needs:
   - L5 OPEN. `unit.js` still carries the sim's own water bodies, pipe cores
     and tube banks, hidden under the library's drawing. Remove them and
     what only they used, drop `?draw=sim`, and `unit.js` becomes placement
     plus what moves or glows. The plant model still reads `flow.js` legs;
     leave those.
   - R26 WATCH. Day one's two release steps (the condensate pump's junction,
     the library's open C16). The harness reproduces them: `node
     tools/network.mjs --run 40 --dt 2 --free-secondary --pin-vessels
     --govern` reads 2 of 20. The lever is what the pinned vessels do in the
     first two steps of the release, or a ramp of the hold over a few steps.
     They book nothing; take them only if the walk is otherwise clean.
   - L4 WATCH. Re-measure the frame cost on a quiet GPU (close the trading
     workstation first, or measure on another machine). If the 1.5 ms stands,
     the library has offered to go at its instance-buffer uploads next.
   - F12 WATCH. The forebay's boundary with the open sea needs its own shot.
   - F2, F9 WATCH. Standing rules rather than work; leave them WATCH unless the
     walk finds a break.
   - U14 WATCH. Needs a Pixel-class phone, which is the owner's to provide.
   - Not on the register yet: the injection tee. The cold leg's casing has no
     hole where the injection line enters (its casing ends on the leg with a
     saddle). Bore it in `plant.py` (the cold leg's casing is shared by both
     designs, so it needs an active-only variant or a tee body).

3. Pilot the library to completion. Completion is every line of its register
   DONE or WATCH with a reason the owner accepts, its gate green, and its
   HANDOFF a short takeover document (today it is 1637 lines of appended
   rounds; its session has been told to stop appending and rewrite it). Then
   the owner decides publication.
   - Only by messages. Send it acceptance cases measured on this station
     (harness flags, health rows, `FAILS=n` dumps), one paragraph per event,
     numbers first. Measure every claim before vendoring; vendor with its
     tool; never touch its tree.
   - Its remaining lines: C8 (a heated loop's limit cycle, physics, leave it),
     R6 and P7 (the owner's phone). It has nothing else outstanding. Do not
     invent work for it; the sim's needs come first: C16 only if the two
     release steps are wanted and the sim's levers fail; the frame cost if
     L4 stands.
   - The owner's decisions on record for it: C18 first (done), six generic
     body kinds (done), no turbine kind, nothing named after a plant part in
     its schema, no GitHub remote until this app is perfect.

4. When 1 to 3 are done, tell the owner, with the register page and the
   health table, and ask for the walk and the publication decision. Then do
   the final check.

## What a newcomer must know

- `js/main.js` boot, input, frame loop; nothing heavy before the welcome card
  is dismissed. `js/sim.js`, `plant.js`, `scenarios.js` the plant model and
  the accidents. `js/flow.js` the plant model's own legs (velocity and
  temperature per pipe), read by the plant, written from the solver.
  `js/view/hydro.js` the library in the frame loop: what the plant holds on
  the solver (vessel pressures, the reactor's level, the pool and tank
  levels), what it releases, the feed valve's law, the isolation regime after
  a trip (steam, exhaust, downcomer and recirculation held at zero, the
  condensate pump stopped and the regulating valve shut), the health
  counters and the failing steps' ring. `js/view/unit.js` the station's
  placement and what moves or glows, plus the old bodies (see L5).
  `js/view/model.js` the glb, merged per material, the walled parts kept
  apart for the stencil; `section.js` the stencil caps; `stage.js` renderer,
  lights, quality toggles; `autoq.js` the first-run tuner; `site/` the island.
- `tools/network.mjs` writes the fluid network from the layout: nodes (volumes
  and junctions), edges with centrelines, devices (pumps, valves, checks),
  heat links, runs (what a colour span is normalised over), design tags so
  each unit builds only its design's lines. The two pump cans are stated once
  in the layout (`cond_pump.can`, `sea.pump.can`) and the network puts each
  junction at its bowl. Every edge's end sits on its junction.
- The drawing is the library's `attach()` over that network, painted every
  frame from the solver. Display hints (range, gradient, split, bundle) are
  documented in the library's `docs/authoring.md`; a split's angle counts
  from +z through +x, so the far half starts at +x when it is zero.
- The library's day one: the solver seeds every edge's temperature from the
  network's nodes, holds the circuits' flows for one step, then releases.
- The register's statuses and proofs are the only record of review; git is
  the only record of history. Memory of what the owner decided lives in
  `AGENTS.md` and this file, nowhere else. The traps that still bite are in
  `AGENTS.md`; the longer list of past ones, and every round's story, is in
  the previous HANDOFF (`git show cbdf0cb:HANDOFF.md`), and the library keeps
  its own behaviour facts in `../3d-fluid-simulator/docs/traps.md`.

## Waiting on the owner

- A Pixel-class phone, for U14 here and R6 and P7 in the library.
- The walk, then the library's publication.

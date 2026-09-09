# Agents

This is `nuclear-cooling-sim`: a static, no-build browser app (Three.js) that
shows two nuclear stations side by side, one cooled by pumps and one cooled
passively, through the same accidents. It is deployed by GitHub Pages from
`main` at https://mayerwin.github.io/nuclear-cooling-sim/. The owner is
mayerwin. The fluid physics and the drawing of every body of water come from
the owner's library `../3d-fluid-simulator`, vendored under `vendor/fluidsim`;
a separate agent session builds that library, and this repository's agent
pilots it.

Read `HANDOFF.md` next: where the work stands and what to do first.

## The owner's rules

- Fix what is asked. Do not add work that was not asked for: no extra
  branches, no pull requests, no trackers, no documents beyond the ones below.
- Verify by rendering and reading the picture, never by reading code. A claim
  about the picture comes with the screenshot that shows it.
- Every review point is a numbered line in `docs/requirements.json` with a
  proof screenshot captured from the shipped build (`node tools/proof.mjs`)
  and read against its caption. DONE only then; WATCH when met but fragile or
  below the bar; OPEN when not met.
- The model has no holes and no blocks: every vessel is a wall with a bore for
  each line, every pipe passes its wall and ends buried in the water it
  serves; no glass, no collars, rings or unexplained objects; nothing hollow
  that should read solid.
- Colours never change abruptly: every change is a gradient along a run, and a
  colour is only ever made from a temperature.
- No em dashes in any copy.
- A fluid engine knows nothing about what a component is: nothing named after
  a plant part goes into the library's schema; a component acts on the fluid
  through a pressure drop and a heat sink.
- Work on `main`, commit with the owner's git identity, and run the gate
  (`node tools/check.mjs`) before every push.
- The library is local-only until the owner says; never create a remote for it.

## Documents

- `AGENTS.md` (this file): standing instructions. Change it only when a rule
  or a tool changes.
- `HANDOFF.md`: the takeover document, a few pages, rewritten from scratch
  when it changes. Never append a round to it: history is in git, evidence is
  in the register.
- `docs/requirements.json`: the register, rendered by `node tools/reqpage.mjs`
  to `docs/requirements.html` and linked from the app's help card. `SPECS.md`
  is the owner's specification; `README.md` is for visitors.
- Agents coordinate by messages (SendMessage to the library's session), never
  through files in either tree. Do not edit the library's tree; the library's
  session does not edit this one (it vendors only on this session's word, with
  its own tool, and never runs git checkout, restore, reset or stash here).

## How to work

Node 22, no build step:

```
node tools/serve.mjs . 8099            static server; the tools expect 8099 (not python's
                                       http.server: on Windows it serves .mjs as text/plain)
node tools/stamp.mjs                   after any edit under js/, css/ or vendor/: content-hashes
                                       every module URL (--check fails if stale)
node tools/look.mjs <camera> [scenario] [minutes]   one machine close up, 1500x950 (LABELS=0 hides captions)
node tools/check.mjs                   THE GATE: every scenario and a phone viewport, fails on any console or page error
node tools/proof.mjs                   every proof screenshot, from this build, into docs/proof
node tools/reqpage.mjs                 rebuild docs/requirements.html
node tools/perf.mjs                    frame cost of the inside view (Q='?draw=sim' measures the old drawing)
node tools/health.mjs [scenario ...]   the solver's health per scenario at 1000x: unconverged steps, mass
                                       adrift, junctions at bounds, levels (FAILS=n dumps the failing steps'
                                       reports with the step before each; DUMP=n the trace ring)
node tools/network.mjs [--run s ...]   writes assets/network.json from the layout and steps the library's
                                       solver headless (its header lists the flags). EVERY plain run rewrites
                                       assets/network.json: never run it during a gate or a proof run;
                                       NETWORK_OUT=<path> writes elsewhere
```

The loop for a change: edit, stamp, look at what changed and read the picture,
check, proof, read the new proofs, update the register line (status, date,
check text, caption), reqpage, commit on main, push.

The model. `assets/layout.json` is the one description of the station: metres,
unit-local, y up, the cut plane z = 0, and every vessel profile is its CAVITY
with the wall standing outside it. `tools/blender/plant.py` builds the steel
from it in Blender and exports `assets/plant.glb` headless:

```
~/Apps/blender-5.2.1-windows-x64/blender.exe -b -P tools/blender/plant.py -- --export assets/plant.glb
```

`js/view/model.js` imports the glb; `tools/network.mjs` writes the fluid
network from the same layout. Change a machine in the layout, re-export,
regenerate the network, look at it. Never hand-edit the glb. The live Blender
can be driven with `py -3 tools/bl.py` (its header says how; a viewport
screenshot of a covered window comes back black, use `tools/blender/glshot.py`).

The library. Vendor with its own tool, then stamp, then the harness, the
health table and the gate:

```
node ../3d-fluid-simulator/tools/vendor.mjs vendor/fluidsim
node tools/stamp.mjs
```

`vendor/fluidsim/VERSION` says what is vendored. Pilot the library's session
with acceptance cases measured on this station (the harness's flags, the
health table's rows, the failing steps' reports); report every defect with
its reproduction; measure what it claims before vendoring it.

## The owner's laptop

Windows 11. Git Bash runs the tools; PowerShell does process and registry
work. `py -3` is Python. Playwright is not global: set
`PW_MODULE=<path to playwright/index.mjs> PW_CHROME=chrome PW_GPU=1 PW_HEADED=1`
and `PW_URL=http://<lan ip>:8099/`, because a VPN kills loopback. One headed
GPU browser at a time: `tools/pw.mjs` takes an advisory lock
(`fluidsim-browser.lock` in the temp directory, shared with the library's
tools; the `.log` beside it says who held it and when; read it before killing
anything). The GPU has tenants the lock cannot see (the owner's trading
workstation runs an embedded Chromium): quote frame costs only against a run
taken under the same load.

## Traps

- Write patch scripts with a file-writing tool and run them with node.
  Heredocs and `node -e` strings eat backslashes here; a lock regex lost its
  backslash that way and matched nothing for two days.
- The tree is CRLF. A patch matches on LF and writes CRLF back; `stamp.mjs`
  hashes over LF.
- Do not edit modules or run `network.mjs` while a gate or proof run is
  loading pages. Commit only on a "proof exit 0" and a "gate exit 0" you have
  read; a proof run can die on a browser hiccup half way and leave
  `docs/proof` a mix of two builds.
- Bisect one variable at a time with `node tools/health.mjs <scenario>` before
  believing any story about a solver regression. The harness holds the flows
  the app lets go: `--free-secondary --pin-vessels --govern` is the app's
  regime, and a harness run without the right flags is no comparison.
- An edge's centreline is the solver's geometry: an end that sits off its
  junction puts a static head round every loop through it (0.3 m was a tonne
  a second in a 0.9 m bore). The library's validate() warns about it.
- The page's first frame is not the plant's day one; hydro.js waits for the
  plant's first tick before the solver's first step.
- Python's `http.server` serves `.mjs` as text/plain on Windows; the physics
  silently falls back and everything still looks fine. Use `tools/serve.mjs`.

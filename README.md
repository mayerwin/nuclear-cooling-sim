# ☢ Passive vs Active Nuclear Cooling — an isometric accident simulator

**[▶ Open the simulator](https://mayerwin.github.io/nuclear-cooling-sim/)** — works in any
desktop or mobile browser, no install, no build step.

An isometric, RollerCoaster-Tycoon-flavoured simulation that runs **two nuclear stations
side by side on the same coastline** and hits them with the *same* catastrophe at the *same*
instant. The only difference between them is how they get decay heat out of the core:

| | **Unit A — Active cooling** | **Unit B — Passive cooling** |
|---|---|---|
| Generation | Gen II (Fukushima, TMI, most of today's fleet) | Gen III+ (AP1000, ESBWR, most SMRs) |
| Moves heat with | Motor-driven pumps | Gravity, natural circulation, evaporation |
| Needs | Grid → diesels → batteries → operators | Nothing. Valves *open* when power is lost |
| Ultimate heat sink | The sea or a river, via more pumps | A tank above the core, then the atmosphere |
| Grace period with no help | **4–8 hours of battery** | **72 hours** |

Trigger a tsunami and watch one plant boil dry, generate a tonne of hydrogen, blow the roof
off its reactor building and put a caesium plume over the town downwind — while the other one
sits at 347 °C with a water level of 100% and nobody on site.

## Two views of the same running model

**🏭 Site** — the isometric map: both stations, the coastline, the river, the town and the
farmland downwind. This is where the hazard arrives and where the consequences land.

Each unit carries a banner naming it and the step it has reached, at every zoom, so the two
islands are never just two islands. Once something is released, dashed rings show how far the
consequences reach, with a key giving each one a radius and a meaning. Picking a camera holds
it: the event cinematics stop stealing the framing back.

**🔬 Cutaway** — the circuit itself, drawn as a schematic, both plants side by side. This is
the one that answers *why*. Each side shows the containment line, the reactor with its fuel
rods, the boiler above it, the pump, and the spare water — above the reactor on the passive
unit, in the basement behind a pump on the active one. The water is drawn *inside* the
reactor on the route it really takes: back down the outside of the core, across the bottom,
and **up between the fuel rods**, which is where it turns from blue to orange. When the level
drops below the top of the rods they go grey → orange → red, and the headline under each
title names the step that plant has reached.

One caution the drawing is careful about: the big pump is a normal-running machine on *both*
plants, and when it stops both loops keep creeping round on their own by natural circulation.
The difference is not that pump — it is whether what happens next needs pumps at all. The
captions under each one say so.

Two readings are worth knowing. If the loop is orange **all the way round**, nothing is taking
the heat away and the return leg is carrying the same heat straight back into the fuel — the
picture only draws returning water as cool water if something actually cooled it. And under
each reactor is the number that makes the whole subject make sense: **how much heat the fuel
is still making**, because shutting a reactor down stops the chain reaction, not the heat.

Only one thing differs between the two drawings, and it is the whole argument: where the
spare water sits and what has to work to get it into the reactor. On the passive side it is
already above the core and falls in; on the active side it is in the basement and has to be
pumped the full height of the building.

The boiler is drawn above the reactor because that is where it is: hot water rises, cool water
sinks, so the loop keeps turning after the pump stops. **Every animated flow is read from the
model on the step it computed the heat balance** — if a loop is moving on screen it is moving
in the physics, and if it has stopped, the physics stopped it.

---

## Why decay heat is the whole story

Pushing SCRAM stops the chain reaction, not the heat. Fission-product decay leaves about
**6.5% of full power** in the core at the instant of shutdown, ~1.3% an hour later and ~0.5%
after a day. For a 3,400 MW thermal core that is **220 MW falling to 17 MW** — enough to boil
the reactor dry and melt it in hours if nothing carries the heat away.

Every severe accident in the historical record is a story about losing that heat path:

| Scenario in the sim | Real event | What was actually lost |
|---|---|---|
| 🌊 Tsunami | Fukushima Daiichi, 2011 (INES 7) | Diesels, seawater pumps and DC switchgear, all at grade, in 90 seconds |
| 🔌 Station blackout | The dominant core-damage risk in every Gen-II PRA | Grid, then every diesel |
| 💥 Large-break LOCA | Design-basis double-ended guillotine | Inventory faster than any pump can replace it |
| 🎛️ Stuck valve + operators | Three Mile Island 2, 1979 (INES 5) | A relief valve that read "closed", and a crew that throttled the ECCS |
| ☢️ Power excursion | Chernobyl 4, 1986 (INES 7) | A positive void coefficient and no containment |
| 🏜️ Loss of heat sink | European heatwaves; Fermi-1 flow blockage, 1966 | The river itself |
| 🏚️ Beyond-design quake | Kashiwazaki-Kariwa, 2007 | Alignment, piping, the switchyard, two of three diesels |
| 🔥 Cable-room fire | Browns Ferry 1 & 2, 1975 | 1,600 control cables, and with them the ECCS |
| 💀 Everything at once | Beyond-design stress test | All of the above, simultaneously |

## What the model actually computes

This is a teaching tool, not a licensing code — but nothing in it is hand-waved:

- **Decay heat** — Way–Wigner: `q(t) = 0.066·(t^-0.2 − (t+t₀)^-0.2)`
- **Inventory** — latent-heat boil-off at 1.9 MJ/kg against the net heat imbalance, plus
  injection from whatever system is still alive
- **Cladding** — lumped thermal node with radiative and steam-convective losses once uncovered
- **Zr + 2H₂O → ZrO₂ + 2H₂** — Arrhenius rate above 1100 K, its **6.5 MJ/kg exotherm** (which
  is what makes the runaway a runaway) and its **0.044 kg H₂ per kg Zr** yield; 24 t of cladding
  is good for roughly a tonne of hydrogen
- **Containment** — saturated-pool energy balance, `p = p_air(T) + p_sat(T) + p_H₂`, design
  pressure 0.45 MPa, ultimate capacity roughly twice that; hardened venting needs power, air
  and a person
- **Hydrogen migration** — negligible while the containment is intact and below design pressure,
  significant through a vent path (this is how Fukushima filled its reactor buildings), free
  once the containment fails
- **Source term** — fraction of Cs-137 mobilised from the fuel × a containment transmission
  factor, anchored so a Fukushima-like sequence gives ~1–2% of core inventory and an open-core
  Chernobyl-like one gives ~30%
- **Consequences** — contaminated area, exclusion radius, displaced population, cleanup cost and
  collective dose scaled from the measured outcomes at Fukushima (≈15 PBq Cs-137) and Chernobyl
  (≈85 PBq). The latent-cancer figure is a straight LNT extrapolation and is shown because people
  ask for it, not because the model believes it precisely.

The passive plant models the AP1000 safety chain: PRHR heat exchanger on natural circulation,
core makeup tanks, automatic depressurisation, nitrogen accumulators, IRWST gravity injection
with sump recirculation, and a steel containment cooled by a natural air draught plus a
3,000-tonne evaporating water film. The Gen-II plant gets the passive kit it really has —
nitrogen accumulators that dump on low pressure — and they behave the way they really do:
about a minute of water, and then you need a running pump again.

**Not convinced the passive kit is doing the work?** Flip *Disable passive systems (what-if)*
and run the same scenario. Unit B melts down too — faster than Unit A, since it has no
steam-driven pump to fall back on. That toggle is in the UI precisely so the comparison can be
falsified.

## So when does passive cooling *not* work?

Worth asking, and the simulator is built so you can check rather than take anyone's word.
Run the scenarios and read the numbers off the clock:

| What breaks | Passive unit | Active unit |
|---|---|---|
| Fukushima tsunami | still full at 80 h | fuel uncovered 9.6 h, vessel breached 11.0 h |
| Station blackout, no operators | still full at 80 h | fuel uncovered 13.1 h, breached 14.6 h |
| Beyond-design quake — **the pool above the reactor cracks and drains** | still full at 80 h | fuel uncovered 13.3 h, breached 14.8 h |
| Everything at once — pool cracked **and** the passive heat exchanger broken | still full at 80 h | fuel uncovered 3.3 h, breached 4.5 h |
| Everything at once, **and the containment breached** at 6 h | fuel uncovered 10.8 h, breached 12.3 h | already gone |
| Everything at once, with *disable passive systems* on | fuel uncovered 2.8 h, breached 3.9 h | already gone |

The cracked-tank case is the interesting one, and the answer is not the obvious one: it does
not melt the reactor down. The water in that tank never leaves the building. It runs onto the
containment floor, and the same gravity that would have drained the tank into the vessel now
drains the floor into the vessel. What the core boils off condenses on the inside of the cold
steel shell and runs back down. It is a closed loop, and the earthquake broke a component
inside it, not the loop.

So the honest failure list for the passive unit is short, and it is about the *loop*, not the
kit: **lose the containment** and the water leaves as steam; **turn the passive systems off**
and there is nothing driving it. Both are in the UI, both melt it down, and both are in the
table above. Everything else on that list it rides out.

The fractions of water assumed to come back each pass are a guess, stated as one in the
fidelity ledger inside the app. They are what decides whether the passive unit rides out a
total blackout for days or for weeks — not whether it rides it out at all.

## Controls

| | |
|---|---|
| Pan | Drag (or one finger) |
| Zoom | Wheel, pinch, or double-tap |
| Site view / Cutaway view | `V` / `C` |
| Pause / resume | `Space` |
| Camera: active / overview / passive | `1` / `2` / `3` |
| Reset | `R` |
| Faster / slower | `+` / `−` |

**AUTO** is the default clock: it compresses the quiet hours (up to 1800×) and automatically
slows to near real time when a core is uncovering, oxidising or coming apart. A full Fukushima
sequence — quake, wave, blackout, boil-off, oxidation, hydrogen explosion, plume — takes two to
three minutes of wall-clock time.

## Running it locally

There is no build step and there are no dependencies. Any static server will do:

```bash
git clone https://github.com/mayerwin/nuclear-cooling-sim.git
cd nuclear-cooling-sim
python3 -m http.server 8000     # or: npx http-server -p 8000
# open http://localhost:8000
```

(It must be served over HTTP rather than opened as a `file://` URL, because it uses ES modules.)

## How it is built

Vanilla ES modules and a single 2-D canvas. **Every pixel of art is generated at runtime** —
there is not one image file in this repository. Concrete, ribbed siding, brick, glazing, rusted
steel, terracotta and cooling-tower formwork are all procedural canvases used as pattern fills
on skewed isometric faces; the terrain, trees and buildings are baked into cached layers and
only the things that actually change are redrawn each frame.

```
js/
  util.js        RNG, value noise, fbm, colour and formatting helpers
  iso.js         projection, camera, and the flat-shaded solid primitives
  world.js       terrain generation, contamination / scorch / flood fields
  props.js       trees, houses, barns, boats — and their burnt, flattened, irradiated states
  plantview.js   the two stations as they appear on the map, emitted as sorted pieces
  cutaway.js     the cross-section view: vessels, pools, pipes, flows, hydrogen
  plant.js       the physics: decay heat, boil-off, oxidation, containment, source term
  scenarios.js   the historical initiating events and why each one matters
  fx.js          steam, smoke, fire, debris, shockwaves and the advected radioactive plume
  renderer.js    scene composition for both views
  sim.js         clock, scenario timeline, hazards, cinematics, consequence ledger
  ui.js          control-room panels, gauges, event feed
  main.js        boot, input, animation loop
tools/
  review.mjs      headless harness: 24 labelled screenshots across scenarios,
                  viewports and pixel ratios, and it fails on any console error
  determinism.mjs freezes the clock and diffs two frames — the site view to the
                  subpixel, the cutaway by its serialized SVG
  robustness.mjs  hammers the UI: rapid scenario and view switches, resizes,
                  extreme viewports, and a check that no model number went NaN
  captions.mjs    drives the model through every combination of the flags the
                  cutaway's wording reads from and measures each caption against
                  the box it sits in
```

### The one rule that makes an isometric scene behave

Every solid with a ground footprint goes into **one** list, sorted on `x + y + (w + d) / 2`,
painted back to front. Not one list per category — the moment buildings sort separately from
scenery, a tree draws through a wall. Structures the eye passes under (a fence, a gantry, a
pipe bridge) are registered as separate pieces so each sorts on its own depth. Nothing is
cached in a static layer, because a cached layer is how objects end up popping in and out as
their state flips them between the cached and live sets. All scenery variation comes from a
hash of the object's own coordinates rather than `Math.random()`, or the whole world shimmers
every frame.

Those conventions, and the headless-verification discipline, come from the
[learnscape](https://github.com/LaurentiuGabriel/learnscape) isometric-explainer skill, which
is vendored into `.claude/skills/` so the next session inherits it.

## Caveats worth stating plainly

- Distances on the map are stylised. One tile is roughly 25 m, so the contamination footprint you
  see is a schematic of the plume, not a dispersion calculation.
- Both units are modelled at the same 3,400 MW thermal power so the comparison is like-for-like.
  Real Gen-II plants vary enormously in containment type, and a Mark-I BWR is a harder case than
  the large dry PWR containment drawn here.
- The consequence numbers are scaling laws fitted to two data points. They are the right order of
  magnitude and no more than that.
- Passive plants are not magic. They are still LWRs with the same fuel, the same fission products
  and the same need for a competent operator on the days that matter. What they remove is the
  dependency chain — and the dependency chain is what failed at Fukushima.

## Licence

MIT.

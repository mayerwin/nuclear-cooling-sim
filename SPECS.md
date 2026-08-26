# Specification

Everything asked for, in one place. Each item is numbered so it can be pointed
at. "Done" means it is implemented and verified in the running app, not that it
was attempted.

---

## 1. Purpose

| # | Requirement |
|---|---|
| 1.1 | Show someone who is worried about nuclear accidents **how safe modern passive cooling is** — by letting them watch it work, not by asserting it. |
| 1.2 | Show, just as clearly, **the cases where it is not enough**. Specifically: an earthquake that cracks the tank above the reactor; losing the containment; disabling the passive systems. |
| 1.3 | Understandable by a **14-year-old** and by an adult with no nuclear background. |
| 1.4 | **Museum quality.** It should be worth standing in front of. |
| 1.5 | Didactic above all. Every claim on screen has to be readable from the model, and every phrase has to mean something — "needed only for power" was not clear enough; "Pump — not safety kit" meant nothing. |
| 1.6 | Show **normal operation first**, then each failure step, clearly separated. |
| 1.7 | No fluff. Minimal verbosity. |
| 1.8 | Fact-check the design against reality rather than inventing plausible-looking machinery. |

## 2. How it must look

| # | Requirement |
|---|---|
| 2.1 | **Not SVG.** SVG is the wrong tool for this job. |
| 2.1b | When told to redo something, **redo it**. Do not keep half the old thing and bolt the new one on. |
| 2.2 | Use a **proper 2D isometric or 3D engine**, not hand-rolled drawing code. |
| 2.3 | Use **proven libraries and real assets**. Do not reinvent the wheel and do not hand-roll badly. |
| 2.4 | **Semi-realistic and satisfying to watch** — the RollerCoaster Tycoon / Factorio bar — while staying **schematic enough to be instantly understandable**. |
| 2.5 | Water must look like **real water**, not a coloured line. |
| 2.6 | Hot water may be drawn **reddish** even though real hot water is not red. That trade is accepted for legibility. |
| 2.7 | Fluid must visibly be **inside the pipes**, and must actually **flow**. |
| 2.8 | No pipe borders that block or interrupt the flow. |
| 2.9 | **Physics must be right.** Not a half-broken schematic: real continuity, real directions, real speeds. |
| 2.10 | Dimensional scale is not important. The **circuit** — what is connected to what, and what is moving — is what matters. |

## 3. The machinery that must be shown

| # | Requirement |
|---|---|
| 3.1 | The **pump must visibly move water**, and its impeller must turn **in the same direction the water is going**. |
| 3.2 | A **stopped pump must not look like a running one**. Natural circulation continues, but visibly far slower. |
| 3.3 | Show **what the boiler actually does**: reactor water on one side, a second circuit on the other, the two never mixing. |
| 3.4 | Show **how the reactor makes electricity**: steam in a pipe → **one simple turbine** → a generator → electricity. No large turbine hall; a single basic turbine is enough. |
| 3.5 | **Steam must be visualised inside its pipes** the same way water is. |
| 3.6 | Water must not appear in the upper tank for no visible reason. If the model refills it, the picture must show why. |
| 3.7 | Water must not leave the containment through the roof for no visible reason. If the model vents, the picture must show the route and say why. |
| 3.8 | After a meltdown the **containment itself must show damage**, not only the reactor. |
| 3.9 | The route the water takes inside the reactor, the fuel it covers, and the level against the top of the fuel must be visible and must agree with the model's own numbers. |

## 4. Sound

| # | Requirement |
|---|---|
| 4.1 | Sound effects for the **phases of each scenario**. |
| 4.2 | An **alarm** when a failure is detected on a reactor. |
| 4.3 | It should be **fun to watch**. |

## 5. Correctness

| # | Requirement |
|---|---|
| 5.1 | The picture may never contradict the model. Water level, temperature, flow, power, damage — all read from the simulation. |
| 5.2 | Fixed: water rose inside a reactor that had already melted down. |
| 5.3 | Deterministic rendering: a frozen frame is a still frame. |
| 5.4 | Every caption fits its box, on desktop and on a phone. |
| 5.5 | No console or page errors in any scenario, at any viewport. |

## 6. Process

| # | Requirement |
|---|---|
| 6.1 | Develop, commit and push only on `claude/nuclear-cooling-simulator-5x0cvm`. |
| 6.2 | No pull request unless asked for one. |
| 6.3 | Commit author `2272127+mayerwin@users.noreply.github.com`. |
| 6.4 | No model identifier in any committed artifact. |
| 6.5 | Replies: no hedging, no "to be honest", no excuses. Do the work. |
| 6.6 | No em dashes in the interface copy. Separate ideas another way. |

---

## Implementation, which engine does which job

The app is one WebGL scene. There is no second renderer and no leftover canvas.

| Job | Tool | Why that one |
|---|---|---|
| The whole picture | **Three.js** (WebGL2) | Real 3-D. Real lathes, tubes and extrusions instead of hand-drawn ellipses. Real lights and shadows. Physically based metal, and glass with actual transmission, so you look through a vessel wall at the water rather than at a symbol for it. |
| The cutaway | **Three.js clipping planes** | The near quarter of the building and the near half of every vessel are removed by real clipping planes. It is a true section, not a drawing of one. |
| Glow | **UnrealBloomPass** | Hot fuel, moving water and the generator glow because they are emissive and the bloom pass finds them. |
| Rotating machinery | **Rapier 2D** (dimforge, WASM) | A real rigid-body solver. The impeller, the turbine-generator shaft and the backup pump are dynamic bodies with real moments of inertia and damping. Torque goes in, angle comes out. |
| Labels | **CSS2DRenderer** | Labels are HTML anchored to 3-D points, so typography is CSS and nothing has to be shrunk to fit. |
| Flow in the pipes | **1-D network hydraulics** (`flow.js`) | The one place with no library to reach for, deliberately. Rapier, Box2D, Matter and every SPH engine solve free bodies or free-surface fluid in an open domain under gravity. Closed pressurised pipe flow is a different problem and the tool for it is mass conservation round the loop with `v = Q / A`, which is what RELAP5 and TRACE use. An SPH fluid in a pipe would be wrong and unreadable. |
| Free surfaces | Shallow-water solve (`flow.js`) | The water surface in each vessel is a row of columns under the shallow-water equations, displacing real mesh vertices. Waves cross it, reflect and die away. |

### What the flow model produces

The plant model gives a heat balance. The network turns it into one mass flow
per circuit, and each leg turns that into its own velocity. Nothing below was
chosen to look right:

| Leg | Model | Real 4-loop PWR |
|---|---|---|
| Primary mass flow | 17,662 kg/s | ~18,000 kg/s |
| Hot leg | 12.6 m/s | 12 to 15 |
| Cold leg | 15.9 m/s | 14 to 17 |
| Through the core | 10.6 m/s | ~10 |
| Main steam | 35.6 m/s | 30 to 50 |
| Feedwater | 6.0 m/s | 4 to 7 |
| Natural circulation | ~5 % of rated | 3 to 5 % |

The steam line runs twenty times faster than the feed line carrying the same
kilograms, because steam at 70 bar is twenty times lighter. Natural circulation
comes from balancing buoyancy head against quadratic friction, which leaves the
flow on the cube root of the power.

### File map

```
js/plant.js       the physics of the reactor itself, unchanged and verified
js/scenarios.js   the historical events
js/audio.js       every sound, synthesised
js/flow.js        pipe-network hydraulics and shallow-water free surfaces
js/machines.js    the rotating kit, on Rapier
js/sim.js         the clock, the scenarios, the log
js/ui.js          the panels
js/view/stage.js  renderer, camera, lights, environment, bloom
js/view/unit.js   one power station as real geometry
js/view/parts.js  reusable pieces: pipes with elbows, vessels, railings
js/view/plume.js  steam and smoke
js/view/labels.js HTML labels on 3-D anchors
js/view/state.js  what the picture is saying, read off the model
```

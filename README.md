# Passive vs active nuclear cooling

Two nuclear power stations, side by side, taken through the same accidents. One
keeps its core cool with pumps and needs electricity to run them. The other uses
gravity, boiling and the outside air, and needs nothing at all. Pick an event and
watch which one survives.

There are two views of the same simulation. **Site** is the island from above:
both stations, the town, the sea, and where anything that gets out would go.
**Inside** opens both buildings up in WebGL.

The inside view is one **Three.js** scene. The buildings are cut open with real
clipping planes and every vessel is sliced down its own axis, so the near half
comes off and the far half stands behind the water as steel. The water is a
refractive body filling the bore rather than a coloured line: the renderer bends
the background through it at an index of refraction of 1.333, ripples scroll
along it at the leg's own metres per second, and what is carried in it moves at
the same speed and is stretched into streaks by it, so you can see how fast it
is going and which way. Steam is the other half of that: a pale body with torn
streaks running through it at its own speed. Each pipe runs at the speed
continuity gives it, so the thin lines run fast and the fat ones run slow, and
the primary loop is coloured from its own temperatures, hot out of the reactor
and cold back from the boiler. The rotating machinery is on a rigid-body solver:
torque in, angle out.

`SPECS.md` sets out every requirement, which engine does which job, and why the
pipe flow is the one part that is not on an off-the-shelf physics engine.

## Running it

It is a static site with no build step. Serve the folder and open `index.html`.

```
python3 -m http.server 8099
```

## Checking it

```
node tools/check.mjs
```

Boots the app, screenshots both views and all three focus modes, drives all nine
scenarios, checks a phone viewport, and fails on any console or page error.

```
node tools/look.mjs rpv        # or pump, loop, sg, steam, turbine, pool, prhr
node tools/look.mjs focusA            # the frame the app itself picks
node tools/look.mjs floor tmi 260     # a shot after 260 minutes of a scenario
```

Parks the camera on one piece of plant and screenshots it big, which is the only
way to judge whether the fluids look right.

# Passive vs active nuclear cooling

Two nuclear power stations, side by side, taken through the same accidents. One
keeps its core cool with pumps and needs electricity to run them. The other uses
gravity, boiling and the outside air, and needs nothing at all. Pick an event and
watch which one survives.

Everything is one WebGL scene built with **Three.js**. The buildings are cut open
with real clipping planes, the vessels are glass with real transmission so you
look through them at the water, and the water in every pipe moves at the speed
continuity gives it. The rotating machinery is on a rigid-body solver: torque in,
angle out.

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

Boots the app, drives all nine scenarios, fails on any console or page error and
writes a screenshot set.

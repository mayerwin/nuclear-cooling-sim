# Agents

Before doing anything in this repository, read **`HANDOFF.md`** at the root. It
is the handover document: what the project is, how to run and verify it, the
architecture, the current state, the standing rules from review, and the traps
that have already cost time.

When you finish a piece of work, **update `HANDOFF.md` in the same commit**:
the "Current state" section, any trap you hit, any tool or convention you
added or changed. Write it so that an agent who has never seen this
conversation can take over from the file alone.

The requirements register (`docs/requirements.json`, rendered to
`docs/requirements.html`) is the record of every review point and its proof.
A line is DONE only when its screenshot, captured from the shipped build by
`node tools/proof.mjs`, has been read against its caption. Keep it current in
the same commit as the change it describes.

The station's steel is a Blender model: `assets/layout.json` describes it,
`tools/blender/plant.py` builds and exports it, `js/view/model.js` imports it.
Change a machine there, re-export `assets/plant.glb`, then `look` at it in the
app; never hand-edit the glb, and keep the water in `unit.js` reading the same
numbers. HANDOFF.md says how to see Blender while you work.

Work on `main`. Run `node tools/check.mjs` before every push.

// ---------------------------------------------------------------------------
// main.js - boot and the frame loop.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { Sim } from './sim.js';
import { Stage } from './view/stage.js';
import { Unit } from './view/unit.js';
import { Labels } from './view/labels.js';
import { UI } from './ui.js';
import { initPhysics } from './machines.js';
import { state } from './view/state.js';

const host = document.getElementById('scene');
const labelHost = document.getElementById('labels');

await initPhysics();
const sim = new Sim();
const stage = new Stage(host, labelHost);
const SPAN = 112;
const units = sim.plants.map((p, i) => new Unit(p, stage, i === 0 ? -SPAN : SPAN));
for (const u of units) stage.scene.add(u.root);
const labels = new Labels(stage, units);
const ui = new UI(sim, { focus: (f) => setFocus(f), stage });

let firstFocus = true;
function setFocus(f) {
  sim.focus = f;
  const t = new THREE.Vector3();
  if (f === 'both') { t.set(10, 26, 0); stage.focusOn(t, 445, 1.32, 0.235, firstFocus); }
  else {
    const u = units[f === 'active' ? 0 : 1];
    t.set(u.worldX + 9, 24, 3);
    stage.focusOn(t, 158, 0.92, 0.24, firstFocus);
  }
  firstFocus = false;
  labels.setFocus(f);
}
setFocus('both');

window.addEventListener('resize', () => stage.resize());

let last = performance.now(), acc = 0;
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.06);
  last = now;
  sim.update(dt);
  for (const u of units) u.update(state(u.plant), dt);
  labels.update();
  stage.update(dt);
  stage.render();
  acc += dt;
  if (acc > 0.22) { ui.update(); acc = 0; }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

sim.announce('Both units at 100% power. Grid connected, all systems normal.', 'ok');
window.__sim = sim;
window.__units = units;
window.__stage = stage;
window.__labels = labels;

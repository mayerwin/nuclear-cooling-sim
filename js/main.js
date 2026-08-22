// ---------------------------------------------------------------------------
// main.js — boot, input handling, animation loop
// ---------------------------------------------------------------------------
import { Sim } from './sim.js';
import { Renderer } from './renderer.js';
import { UI } from './ui.js';
import { buildMaterials } from './textures.js';
import { PlantView } from './plantview.js';
import { clamp } from './util.js';
import { drawProp } from './props.js';

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');

let wasWide = null;
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';
  if (!sim) return;
  sim.cam.resize(canvas.width, canvas.height);
  const wide = window.innerWidth > 860;
  if (wasWide !== wide) { wasWide = wide; sim.overview(); }
}

buildMaterials(ctx);
let sim = new Sim(canvas);
resize();
sim.world.bakeTerrain();
sim.world.bakeOverlay();
sim.propsFn = (g, p, w, t) => drawProp(g, p, w, t);
sim.bakeScene();

const renderer = new Renderer(canvas, sim.world);
renderer.buildOcean();

const ui = new UI(sim);
ui.renderFeed();
sim.announce('Both units at 100% power. Grid connected, all systems normal.', 'ok');

window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 250));

// ---------------------------------------------------------------- input
let drag = null, pinch = null;
const pointers = new Map();

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) {
    drag = { x: e.clientX, y: e.clientY, cx: sim.cam.tx, cy: sim.cam.ty, moved: 0 };
    sim.cine = null;
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: sim.cam.targetZoom };
    drag = null;
  }
});
canvas.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    sim.cam.targetZoom = clamp(pinch.z * (d / pinch.d), 0.28, 2.6);
    return;
  }
  if (!drag) return;
  const dpr = canvas.width / window.innerWidth;
  const dx = (e.clientX - drag.x) * dpr / sim.cam.zoom;
  const dy = (e.clientY - drag.y) * dpr / sim.cam.zoom;
  drag.moved += Math.abs(dx) + Math.abs(dy);
  // invert the isometric basis
  const wx = (dy / 16 + dx / 32) / 2, wy = (dy / 16 - dx / 32) / 2;
  sim.cam.tx = clamp(drag.cx - wx, -10, 62);
  sim.cam.ty = clamp(drag.cy - wy, -10, 62);
  sim.cam.x = sim.cam.tx; sim.cam.y = sim.cam.ty;
});
const endPointer = (e) => {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (pointers.size === 0) drag = null;
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  sim.cam.targetZoom = clamp(sim.cam.targetZoom * (e.deltaY > 0 ? 0.9 : 1.11), 0.28, 2.6);
}, { passive: false });

let lastTap = 0;
canvas.addEventListener('pointerup', (e) => {
  const now = performance.now();
  if (now - lastTap < 300) {
    sim.cam.targetZoom = sim.cam.targetZoom > sim.fitZoom() * 1.4 ? sim.fitZoom() : sim.fitZoom() * 2.1;
  }
  lastTap = now;
});

window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === ' ') { e.preventDefault(); sim.speedIdx = sim.speedIdx === 0 ? 3 : 0; sim.cine = null; }
  if (k === '1') sim.cam.focus(sim.world.sites.active.x + 7, sim.world.sites.active.y + 7, 1.05);
  if (k === '2') sim.overview();
  if (k === '3') sim.cam.focus(sim.world.sites.passive.x + 7, sim.world.sites.passive.y + 7, 1.05);
  if (k === 'r') document.getElementById('btnReset').click();
  if (k === '+' || k === '=') sim.speedIdx = Math.min(5, sim.speedIdx + 1);
  if (k === '-') sim.speedIdx = Math.max(0, sim.speedIdx - 1);
});

// ---------------------------------------------------------------- loop
let last = performance.now(), acc = 0;
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.06);
  last = now;
  sim.update(dt);
  renderer.draw(sim);
  acc += dt;
  if (acc > 0.22) { ui.update(); acc = 0; }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// expose for debugging
window.__sim = sim;
window.__r = renderer;
window.__ui = ui;

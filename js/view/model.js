// ---------------------------------------------------------------------------
// model.js - the station's steel, from Blender.
//
// tools/blender/plant.py builds every static part of the station in Blender
// from assets/layout.json and exports assets/plant.glb. This loads it once and
// hands each unit its own instance: the other design's parts dropped, the
// parts the frame loop turns or lights kept by name, and everything else
// merged into one mesh per material, so a unit's steel is a dozen draw calls
// rather than two hundred and fifty. Materials are the unit's own, cut on its
// plane. Everything wet stays procedural in unit.js, drawn from the same
// layout into the hollows this leaves.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

let gltf = null;
let layout = null;

export async function loadPlant(base = '') {
  if (!gltf) {
    const loader = new GLTFLoader();
    [gltf, layout] = await Promise.all([
      loader.loadAsync(base + 'assets/plant.glb'),
      fetch(base + 'assets/layout.json').then((r) => r.json())
    ]);
  }
  return { gltf, layout };
}

export function getLayout() { return layout; }

// Parts that belong to one design only, by name prefix.
const PASSIVE_ONLY = /^(pool_|coil$|pipe_prhr_|pipe_gravity|pipe_recirc|pipe_fill|grav_)/;
const ACTIVE_ONLY = /^(tank_|eccs_|pipe_suction|pipe_injection)/;
// Parts the app draws itself (they carry the water, the glow or the section
// caps), so the Blender copies are dropped.
const APP_DRAWN = /^(wall$|dome$|liner|slab$|floor$|fuel_rod_|sg_tube_|cond_tube_|sg_divider$)/;
// Parts the frame loop moves, lights or hides, kept as their own objects.
const LIVE = /^(turb_rotor$|.*_rotor$|.*_lamp$|lamp_bulb$|lamp_bus_|grav_valve$|rpv_skirt$|gen_body$|cond_shell$)/;

function prepare(m, cut) {
  m.side = THREE.DoubleSide;
  m.clippingPlanes = cut;
  m.clipShadows = true;
  if (m.transparent) m.depthWrite = false;
  return m;
}

// One instance of the station for one unit.
//   passive: which design's parts to keep
//   cut: the unit's clipping planes, set on every material
export function instantiate({ passive, cut }) {
  const src = gltf.scene.clone(true);
  src.updateMatrixWorld(true);
  const group = new THREE.Group();
  const byName = {};
  const skip = passive ? ACTIVE_ONLY : PASSIVE_ONLY;
  // meshes to merge, by material
  const bins = new Map();
  const live = [];
  src.traverse((n) => {
    if (APP_DRAWN.test(n.name) || skip.test(n.name)) return;
    let p = n.parent, under = false;
    while (p && p !== src) { if (LIVE.test(p.name) || APP_DRAWN.test(p.name) || skip.test(p.name)) under = true; p = p.parent; }
    if (under) return;               // handled with its parent
    if (LIVE.test(n.name)) { live.push(n); return; }
    if (!n.isMesh) return;
    const key = n.material.name || n.material.uuid;
    if (!bins.has(key)) bins.set(key, { mat: n.material, geos: [] });
    const g = n.geometry.clone();
    // position and normal only: the materials carry no textures, and merged
    // geometry needs every piece to have the same attributes
    for (const a of Object.keys(g.attributes)) if (a !== 'position' && a !== 'normal') g.deleteAttribute(a);
    g.applyMatrix4(n.matrixWorld);
    bins.get(key).geos.push(g);
  });
  for (const [key, bin] of bins) {
    const merged = mergeGeometries(bin.geos, false);
    for (const g of bin.geos) g.dispose();
    if (!merged) continue;
    const m = prepare(bin.mat.clone(), cut);
    const mesh = new THREE.Mesh(merged, m);
    mesh.name = 'steel_' + key;
    mesh.castShadow = !m.transparent;
    mesh.receiveShadow = true;
    group.add(mesh);
    byName[mesh.name] = mesh;
  }
  // the live parts keep their own objects, re-parented to the instance with
  // their world transform, so a rotor still turns about its own axis
  const inv = new THREE.Matrix4();
  for (const n of live) {
    const c = n.isMesh ? n.clone(false) : new THREE.Object3D();
    c.name = n.name;
    c.matrix.copy(n.matrixWorld);
    c.matrix.decompose(c.position, c.quaternion, c.scale);
    if (c.isMesh) {
      c.material = prepare(c.material.clone(), cut);
      c.castShadow = !c.material.transparent;
      c.receiveShadow = true;
    }
    byName[c.name] = c;
    // A rotor's thirty-two blades, hub, disc and shroud are one mesh per
    // material under the empty, in its frame, so a wheel is one draw call.
    inv.copy(n.matrixWorld).invert();
    const sub = new Map();
    n.traverse((k) => {
      if (k === n || !k.isMesh) return;
      const key = k.material.name || k.material.uuid;
      if (!sub.has(key)) sub.set(key, { mat: k.material, geos: [] });
      const g = k.geometry.clone();
      for (const a of Object.keys(g.attributes)) if (a !== 'position' && a !== 'normal') g.deleteAttribute(a);
      g.applyMatrix4(k.matrixWorld).applyMatrix4(inv);
      sub.get(key).geos.push(g);
    });
    for (const [key, bin] of sub) {
      const merged = mergeGeometries(bin.geos, false);
      for (const g of bin.geos) g.dispose();
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, prepare(bin.mat.clone(), cut));
      mesh.name = n.name + '_' + key;
      mesh.castShadow = !mesh.material.transparent;
      mesh.receiveShadow = true;
      c.add(mesh);
    }
    group.add(c);
  }
  return { group, byName };
}

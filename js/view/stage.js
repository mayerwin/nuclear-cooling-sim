// ---------------------------------------------------------------------------
// stage.js - the renderer, the camera and the light.
//
// One WebGL scene for the whole app. Real lights, real shadows, an image-based
// environment for the metal and the glass, and a bloom pass so anything hot or
// electrified actually glows.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { build as buildMaterials } from './materials.js';
import { surfaceMaterial, setGradient } from './fluid.js';

// A vertical sky gradient, baked once into an equirectangular strip.
function skyTexture() {
  const c = document.createElement('canvas');
  c.width = 8; c.height = 256;
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0.00, '#1d4c78');
  g.addColorStop(0.38, '#5c93bd');
  g.addColorStop(0.62, '#9dc4dc');
  g.addColorStop(0.78, '#c6dbe6');
  g.addColorStop(1.00, '#4b574f');
  x.fillStyle = g; x.fillRect(0, 0, 8, 256);
  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Stage {
  constructor(host, labelHost) {
    this.host = host;
    // A phone GPU handed a 3x-density canvas, refraction and bloom kills the
    // context and the view goes black. Everything scales down on mobile.
    const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
    this.renderer = new THREE.WebGLRenderer({
      antialias: !mobile, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(mobile ? 1.3 : 2, window.devicePixelRatio || 1));
    // If the context is lost anyway, let the browser restore it instead of
    // staying black for the rest of the session.
    this.renderer.domElement.addEventListener('webglcontextlost',
      (e) => e.preventDefault(), false);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.localClippingEnabled = true;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.96;
    // The refraction pass is a second render of the whole scene. Half
    // resolution costs nothing visible, because refraction blurs anyway.
    this.renderer.transmissionResolutionScale = mobile ? 0.22 : 0.4;
    host.appendChild(this.renderer.domElement);

    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'labelLayer';
    labelHost.appendChild(this.labels.domElement);

    this.scene = new THREE.Scene();
    // A sky rather than a void: the site view is broad daylight, and an
    // interior that floats in black reads as a screensaver, not a place.
    this.scene.background = skyTexture();
    this.scene.fog = new THREE.Fog(0x93b3c9, 620, 1800);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;

    this.camera = new THREE.PerspectiveCamera(26, 1, 0.5, 900);
    this.camera.position.set(96, 74, 118);

    const key = new THREE.DirectionalLight(0xfff2e2, 2.0);
    key.position.set(90, 130, 70);
    key.castShadow = true;
    key.shadow.mapSize.set(1536, 1536);
    const s = key.shadow.camera;
    s.left = -140; s.right = 140; s.top = 120; s.bottom = -120; s.near = 20; s.far = 400;
    key.shadow.bias = -0.0007;
    key.shadow.normalBias = 0.35;
    this.scene.add(key);
    this.key = key;
    this.scene.add(new THREE.HemisphereLight(0xbfe0ff, 0x2c3630, 0.85));
    const rim = new THREE.DirectionalLight(0x6fa8ff, 0.8);
    rim.position.set(-80, 40, -90);
    this.scene.add(rim);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.minPolarAngle = 0.18;
    this.controls.maxPolarAngle = Math.PI * 0.47;
    this.controls.minDistance = 40;
    this.controls.maxDistance = 700;
    this.controls.target.set(0, 20, 0);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.16, 0.5, 2.1);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.mat = buildMaterials();

    // Ground, so the buildings stand on something and the shadows land.
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(1600, 1600).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x3c4a41, roughness: 0.98, metalness: 0.0 }));
    ground.position.y = -3;
    ground.receiveShadow = true;
    this.scene.add(ground);
    const grid = new THREE.GridHelper(1600, 80, 0x4e5f54, 0x46564c);
    grid.position.y = -2.96;
    grid.material.transparent = true;
    grid.material.opacity = 0.28;
    this.scene.add(grid);

    this.resize();
  }

  // Water standing on the site after a wave has been over it: one sheet across
  // the whole model, because the sea does not stop at a property line, with a
  // hole punched where each sealed containment stands, because a flood does
  // not pass through a metre of concrete. Built once the unit positions are
  // known, so the holes are exactly where the buildings are.
  buildFlood(centres) {
    const floodShape = new THREE.Shape();
    floodShape.moveTo(-700, -700);
    floodShape.lineTo(700, -700); floodShape.lineTo(700, 700);
    floodShape.lineTo(-700, 700); floodShape.closePath();
    for (const [ux, uz] of centres) {
      const hole = new THREE.Path();
      // Shape space is x, y; after rotateX(-PI/2) shape y maps to world -z.
      hole.absarc(ux, -uz, 17.0, 0, Math.PI * 2, true);
      floodShape.holes.push(hole);
    }
    this.flood = new THREE.Mesh(
      new THREE.ShapeGeometry(floodShape, 48).rotateX(-Math.PI / 2), surfaceMaterial(4));
    this.flood.material.attenuationDistance = 4;
    this.flood.material.clearcoat = 0;
    this.flood.material.emissiveIntensity = 0.04;
    this.flood.material.roughness = 0.3;
    this.flood.material.normalMap.repeat.set(60, 60);
    this.flood.visible = false;
    this.scene.add(this.flood);
  }


  // depth is metres of water standing above grade. The drawn level chases the
  // model's level instead of jumping to it: the wave arrives in a moment in
  // the log, but water on the ground rises, it does not teleport.
  setFlood(depth, dt) {
    if (!this.flood) return;
    const cur = this.floodDepth || 0;
    const next = cur + Math.sign(depth - cur) * Math.min(Math.abs(depth - cur), dt * 0.9);
    this.floodDepth = next;
    this.flood.visible = next > 0.05;
    if (!this.flood.visible) return;
    this.flood.position.y = -2.6 + next;
    const m = this.flood.material;
    m.normalMap.offset.x += dt * 0.012;
    m.normalMap.offset.y += dt * 0.008;
  }

  resize() {
    const w = this.host.clientWidth || window.innerWidth;
    const h = this.host.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w, h);
    this.labels.setSize(w, h);
  }

  // Move the camera without snapping. dolly is the distance from the target.
  focusOn(target, dolly, azimuth = 0.72, elev = 0.62, snap = false) {
    this.want = { target: target.clone(), dolly, azimuth, elev };
    if (snap) {
      this.controls.target.copy(this.want.target);
      this.camera.position.copy(this.offsetFor(this.want));
      this.controls.update();
      this.want = null;
    }
  }

  // Frame a set of objects so all of it lands inside the part of the window
  // that is not covered by the panels. Guessing a distance and hoping is how
  // you end up looking at half a turbine.
  frame(objects, opts = {}) {
    const box = this.boxOf(objects);
    if (!box) return;
    this.frameBox(box, opts);
  }

  boxOf(objects) {
    // Solid parts only: a particle plume drifts for a hundred metres and would
    // drag the frame out with it.
    const box = new THREE.Box3(), b = new THREE.Box3();
    for (const o of objects) {
      o.updateWorldMatrix(true, true);
      o.traverse((n) => {
        if (!n.isMesh || !n.visible || !n.geometry) return;
        // Things that are drawn but must not drag the frame out: the line
        // leaving the site, the plume, anything marked as scenery.
        if (n.userData.noFrame) return;
        if (!n.geometry.boundingBox) n.geometry.computeBoundingBox();
        b.copy(n.geometry.boundingBox).applyMatrix4(n.matrixWorld);
        box.union(b);
      });
    }
    return box.isEmpty() ? null : box;
  }

  frameBox(box, opts = {}) {
    const target = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    const azimuth = opts.azimuth ?? 1.36, elev = opts.elev ?? 0.26;

    // camera basis for that heading
    const dir = new THREE.Vector3(
      Math.cos(azimuth) * Math.cos(elev), Math.sin(elev), Math.sin(azimuth) * Math.cos(elev));
    const fwd = dir.clone().negate();
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, fwd).normalize();

    let halfW = 0, halfH = 0, halfD = 0;
    for (let i = 0; i < 8; i++) {
      const c = new THREE.Vector3(
        (i & 1 ? 1 : -1) * size.x, (i & 2 ? 1 : -1) * size.y, (i & 4 ? 1 : -1) * size.z);
      halfW = Math.max(halfW, Math.abs(c.dot(right)));
      halfH = Math.max(halfH, Math.abs(c.dot(up)));
      halfD = Math.max(halfD, Math.abs(c.dot(fwd)));
    }
    const vTan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const hTan = vTan * this.camera.aspect;
    const usableW = opts.usableW ?? 1, usableH = opts.usableH ?? 1;
    const dolly = (Math.max(halfW / (hTan * usableW), halfH / (vTan * usableH)) + halfD)
      * (opts.fill ?? 1) + (opts.pad || 0);
    this.focusOn(target, dolly, azimuth, elev, opts.snap);
  }

  offsetFor(w) {
    return new THREE.Vector3(
      Math.cos(w.azimuth) * Math.cos(w.elev),
      Math.sin(w.elev),
      Math.sin(w.azimuth) * Math.cos(w.elev)
    ).multiplyScalar(w.dolly).add(w.target);
  }

  update(dt) {
    if (this.want) {
      const k = 1 - Math.pow(0.006, dt);
      this.controls.target.lerp(this.want.target, k);
      const off = this.offsetFor(this.want);
      this.camera.position.lerp(off, k);
      if (this.camera.position.distanceTo(off) < 0.35) this.want = null;
    }
    this.controls.update();
  }

  render() {
    this.composer.render();
    this.labels.render(this.scene, this.camera);
  }
}

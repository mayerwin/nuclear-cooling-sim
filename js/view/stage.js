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
import { build as buildMaterials } from './materials.js?v=8e3dc0c488';
import { surfaceMaterial, setGradient, rippleNormal, LOWFX, FLUID_TIME,
  twoOctaveFlow, SEA_TILE } from './fluid.js?v=8e3dc0c488';

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
    const mobile = LOWFX;
    this.mobile = mobile;
    this.renderer = new THREE.WebGLRenderer({
      antialias: !mobile, powerPreference: 'high-performance' });
    // One device pixel per pixel on a handset. At 3x the same frame costs nine
    // times the fill, and this scene is fill-bound.
    this.renderer.setPixelRatio(Math.min(mobile ? 1 : 2, window.devicePixelRatio || 1));
    // Losing the context used to be terminal: the default was prevented, which
    // asks the browser to restore it, and then nothing listened for the
    // restore, so the canvas stayed blank for the rest of the session. Now the
    // frame loop stops while it is gone and picks up again when it comes back.
    this.lost = false;
    this.renderer.domElement.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
      if (this.onLost) this.onLost();
    }, false);
    this.renderer.domElement.addEventListener('webglcontextrestored', () => {
      this.lost = false;
      this.renderer.shadowMap.needsUpdate = true;
      if (this.onRestored) this.onRestored();
    }, false);
    // Shadow maps are a second pass over every caster. A phone spends that
    // budget better on the machinery itself.
    this.renderer.shadowMap.enabled = !mobile;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.localClippingEnabled = true;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.96;
    // The refraction pass is a second render of the whole scene. Half
    // resolution costs nothing visible, because refraction blurs anyway.
    this.renderer.transmissionResolutionScale = mobile ? 0.2 : 0.4;
    host.appendChild(this.renderer.domElement);

    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'labelLayer';
    labelHost.appendChild(this.labels.domElement);

    this.scene = new THREE.Scene();
    // A sky rather than a void: the site view is broad daylight, and an
    // interior that floats in black reads as a screensaver, not a place.
    this.scene.background = skyTexture();
    this.scene.fog = new THREE.Fog(0x93b3c9, 900, 2600);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this.envTex;
    this.scene.environmentIntensity = 0.55;

    this.camera = new THREE.PerspectiveCamera(26, 1, 0.5, 2600);
    this.camera.position.set(96, 74, 118);

    const key = new THREE.DirectionalLight(0xfff2e2, 2.0);
    key.position.set(90, 130, 70);
    key.castShadow = !mobile;
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
    this.controls.minDistance = 6;
    // 420 was less than the distance a portrait phone needs to fit both
    // stations, so the frame was silently clamped and both units were cut off
    // at the edges however the framing was computed.
    this.controls.maxDistance = 900;
    this.controls.target.set(0, 20, 0);
    // Two fingers pans and zooms, one finger orbits: the gesture set every
    // map and model viewer uses, so it needs no explaining.
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this.controls.enablePan = true;
    this.controls.screenSpacePanning = true;

    // What is switched on. A phone starts with the expensive half off; the
    // settings panel lets any of it be turned back on, one at a time, which is
    // the only way to find out which one a given device cannot afford.
    this.q = {
      refraction: false, bloom: !mobile, shadows: !mobile,
      reflections: true, hidpi: !mobile, particles: true, steam: true
    };

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
      hole.absarc(ux, -uz, 21.0, 0, Math.PI * 2, true);
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


  // The sea. One sheet for the whole site, set back behind the buildings and
  // running past the edges of the frame in both directions, because the point
  // of the sea in a power station is that there is no end to it. The
  // condensers' intake and outfall lines reach back into this.
  buildSea(az) {
    const n = new THREE.Vector3(-Math.cos(az), 0, -Math.sin(az));
    // Opaque, not refractive. Nine hundred metres of transmissive surface is
    // both ruinous to draw and reads as haze rather than as water.
    const mat = new THREE.MeshStandardMaterial({
      color: 0x1d5f86, roughness: 0.22, metalness: 0.1,
      normalMap: rippleNormal().clone(),
      normalScale: new THREE.Vector2(0.55, 0.55)
    });
    mat.normalMap.needsUpdate = true;
    // One tile every SEA_TILE metres, the same figure the forebay and the
    // channel use, and two octaves of it so a fourteen-hundred-metre sheet
    // does not read as one pattern stamped over and over.
    mat.normalMap.repeat.set(1400 / SEA_TILE, 1500 / SEA_TILE);
    twoOctaveFlow(mat);
    // Deep enough to reach the horizon. A three hundred metre strip left a
    // band of grass beyond it, which is the one thing the sea must not have.
    const sea = new THREE.Mesh(
      new THREE.PlaneGeometry(1400, 1500).rotateX(-Math.PI / 2), mat);
    sea.rotation.y = Math.PI / 2 - az;
    // Just below grade, which the flood sheet puts at -2.6. At -1.6 the sea
    // stood a metre ABOVE the yard it is supposed to cool, so every intake
    // that reached it read as a tub of water sitting on the grass.
    sea.position.set(n.x * 780, -2.9, n.z * 780);
    this.scene.add(sea);
    this.sea = sea;
    // the strip of shore between the yard and the water, so the edge of the
    // land is somewhere rather than a colour change in mid air
    const shore = new THREE.Mesh(
      new THREE.PlaneGeometry(1400, 12).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x6b6a5c, roughness: 0.98 }));
    shore.rotation.y = Math.PI / 2 - az;
    shore.position.set(n.x * 30, -2.75, n.z * 30);
    this.scene.add(shore);
  }

  // depth is metres of water standing above grade. The drawn level chases the
  // model's level instead of jumping to it: the wave arrives in a moment in
  // the log, but water on the ground rises, it does not teleport.
  setFlood(depth, dt) {
    if (this.sea) {
      this.sea.material.normalMap.offset.x += dt * 0.008;
      this.sea.material.normalMap.offset.y += dt * 0.005;
    }
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

  // Sized from what the page tells it, because the host is display:none while
  // the site view is up and a hidden element measures zero.
  resize(fw, fh) {
    const w = fw || this.host.clientWidth || window.innerWidth;
    const h = fh || this.host.clientHeight || window.innerHeight;
    this.lastW = w; this.lastH = h;
    this.camera.aspect = w / h;
    // A portrait phone is a keyhole, and 26 degrees is a telephoto lens. Fitting
    // a station eighty metres wide through both put the camera three quarters
    // of a kilometre away, past the controls' own limit and into the fog, so
    // the frame was clamped and both units were cut off at the edges. A wider
    // lens frames the same thing from a sane distance.
    this.camera.fov = this.camera.aspect < 0.8 ? 44 : 26;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    // Bloom at three fifths. It is a chain of blurs of a blur: at full
    // resolution it is four times the fill for a glow nobody can tell apart
    // from this one.
    this.bloom.setSize(Math.max(2, Math.round(w * 0.6)), Math.max(2, Math.round(h * 0.6)));
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
    const pts = [];
    for (let i = 0; i < 8; i++) {
      pts.push(new THREE.Vector3(
        i & 1 ? box.max.x : box.min.x,
        i & 2 ? box.max.y : box.min.y,
        i & 4 ? box.max.z : box.min.z));
    }
    this.framePoints(pts, opts);
  }

  // Frame a set of world points, measured ALONG THE CAMERA'S OWN AXES.
  //
  // It used to measure an axis-aligned world box instead. Every station in
  // this model is turned to face the cut, so its world box is far bigger than
  // the station: on a portrait phone that overestimate pushed the camera back
  // far enough that the two units filled barely half the width, with the rest
  // of the screen empty grass. Measuring the real corners against the real
  // basis frames what is actually there.
  framePoints(pts, opts = {}) {
    const azimuth = opts.azimuth ?? 1.36, elev = opts.elev ?? 0.26;
    const dir = new THREE.Vector3(
      Math.cos(azimuth) * Math.cos(elev), Math.sin(elev), Math.sin(azimuth) * Math.cos(elev));
    const fwd = dir.clone().negate();
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, fwd).normalize();

    let minR = Infinity, maxR = -Infinity, minU = Infinity, maxU = -Infinity;
    let minF = Infinity, maxF = -Infinity;
    for (const p of pts) {
      const r = p.dot(right), u = p.dot(up), f = p.dot(fwd);
      if (r < minR) minR = r; if (r > maxR) maxR = r;
      if (u < minU) minU = u; if (u > maxU) maxU = u;
      if (f < minF) minF = f; if (f > maxF) maxF = f;
    }
    const halfW = (maxR - minR) / 2, halfH = (maxU - minU) / 2, halfD = (maxF - minF) / 2;
    // The centre of the extents, not the centroid: a cloud of points weighted
    // to one end would otherwise pull the frame off to that side.
    const target = new THREE.Vector3()
      .addScaledVector(right, (minR + maxR) / 2)
      .addScaledVector(up, (minU + maxU) / 2)
      .addScaledVector(fwd, (minF + maxF) / 2);

    const vTan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const hTan = vTan * this.camera.aspect;
    const usableW = opts.usableW ?? 1, usableH = opts.usableH ?? 1;
    // Three fifths of the half-depth, not all of it. The full figure is the
    // safe answer for a cube seen corner-on; for a station laid out in a plane
    // and viewed square to it, it is most of a second station's worth of dolly
    // spent on nothing.
    const dolly = (Math.max(halfW / (hTan * usableW), halfH / (vTan * usableH)) + halfD * 0.6)
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

  // WASD, applied in the camera's own frame: A and D slide the view sideways,
  // W and S move it in and out along the line of sight. The target moves with
  // the camera, so the model does not swing round as you go.
  // A and D slide the view sideways, W and S lift and lower it. Both move the
  // camera and its target together, so the model does not swing round as you
  // go. Zooming is left to the wheel, which already means forward and back.
  nudge(keys, dt) {
    const up = (keys.has('w') ? 1 : 0) - (keys.has('s') ? 1 : 0);
    const r = (keys.has('d') ? 1 : 0) - (keys.has('a') ? 1 : 0);
    if (!up && !r) return;
    this.want = null;
    const dist = this.camera.position.distanceTo(this.controls.target);
    const step = Math.max(6, dist * 0.5) * dt;
    const fwd = new THREE.Vector3().subVectors(this.controls.target, this.camera.position);
    fwd.y = 0; fwd.normalize();
    // cross(forward, up) is screen-right, so D is +right. It was negated.
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    const move = new THREE.Vector3()
      .addScaledVector(right, r * step).addScaledVector(new THREE.Vector3(0, 1, 0), up * step);
    this.camera.position.add(move);
    this.controls.target.add(move);
    this.clampView();
  }

  // The camera stays above the ground and under the sky, and what it is
  // looking at stays somewhere on the plant.
  clampView() {
    const GROUND = 1.5, CEIL = 150;
    if (this.camera.position.y < GROUND) this.camera.position.y = GROUND;
    if (this.camera.position.y > CEIL) this.camera.position.y = CEIL;
    this.controls.target.y = Math.max(-2, Math.min(70, this.controls.target.y));
  }

  update(dt) {
    // One clock for every fluid in the scene. The second octave of the flow
    // map drifts on it, which is what stops a scrolling texture reading as
    // sliding wallpaper.
    FLUID_TIME.value += dt;
    if (this.want) {
      const k = 1 - Math.pow(0.006, dt);
      this.controls.target.lerp(this.want.target, k);
      const off = this.offsetFor(this.want);
      this.camera.position.lerp(off, k);
      if (this.camera.position.distanceTo(off) < 0.35) this.want = null;
    }
    this.controls.update();
    this.clampView();
  }

  render() {
    // Nothing to draw into while the context is gone, and calling in anyway
    // throws every frame until it comes back.
    if (this.lost) return;
    // Counted by hand rather than left on auto: three resets the counters at
    // the top of every render call, so with a post chain the panel would only
    // ever see the last full-screen quad. Reset once a frame and the number is
    // what the whole frame cost, post included.
    this.renderer.info.autoReset = false;
    this.renderer.info.reset();
    // The bloom pass is two more full-screen passes plus a chain of blurs.
    if (this.q.bloom) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }

  // ---- quality ------------------------------------------------------------
  // Each of these is one of the things that costs a phone its frame, and each
  // can be turned off on its own so it can be told which one it was.
  setQuality(key, on) {
    this.q[key] = on;
    const r = this.renderer;
    switch (key) {
      case 'refraction':
        // OFF by default and an option, not the way the picture is built: see
        // the note in fluid.js. A material that wants real refraction carries
        // the transmission it would use in userData.wetTr; turning this on
        // gives it back. Changing transmission changes the shader, so the
        // program has to be rebuilt.
        this.eachMaterial((m) => {
          if (!m.isMeshPhysicalMaterial || !m.userData.wetTr) return;
          m.transmission = on ? m.userData.wetTr : 0;
          m.needsUpdate = true;
        });
        break;
      case 'bloom': break;                       // read in render()
      case 'shadows':
        r.shadowMap.enabled = on;
        this.key.castShadow = on;
        r.shadowMap.needsUpdate = true;
        this.eachMaterial((m) => { m.needsUpdate = true; });
        break;
      case 'reflections':
        this.scene.environment = on ? this.envTex : null;
        break;
      case 'hidpi':
        r.setPixelRatio(on ? Math.min(2, window.devicePixelRatio || 1) : 1);
        this.resize(this.lastW, this.lastH);
        break;
      case 'particles':
        this.scene.traverse((n) => { if (n.isInstancedMesh) n.visible = on; });
        break;
      case 'steam':
        this.scene.traverse((n) => {
          if (n.isMesh && n.material && n.material.userData.steam) n.visible = on;
        });
        break;
      default: break;
    }
  }

  eachMaterial(fn) {
    const seen = new Set();
    this.scene.traverse((n) => {
      if (!n.isMesh && !n.isPoints && !n.isLine) return;
      for (const m of (Array.isArray(n.material) ? n.material : [n.material])) {
        if (!m || seen.has(m.uuid)) continue;
        seen.add(m.uuid);
        fn(m);
      }
    });
  }

  // What the last frame actually cost, for the settings panel to show.
  stats() {
    const i = this.renderer.info;
    return { calls: i.render.calls, tris: i.render.triangles,
      programs: i.programs ? i.programs.length : 0, textures: i.memory.textures };
  }
}

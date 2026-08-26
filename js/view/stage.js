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

export class Stage {
  constructor(host, labelHost) {
    this.host = host;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.localClippingEnabled = true;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.94;
    host.appendChild(this.renderer.domElement);

    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'labelLayer';
    labelHost.appendChild(this.labels.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x070c12);
    this.scene.fog = new THREE.Fog(0x070c12, 260, 620);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.34;

    this.camera = new THREE.PerspectiveCamera(26, 1, 0.5, 900);
    this.camera.position.set(96, 74, 118);

    const key = new THREE.DirectionalLight(0xfff2e2, 2.7);
    key.position.set(90, 130, 70);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const s = key.shadow.camera;
    s.left = -140; s.right = 140; s.top = 120; s.bottom = -120; s.near = 20; s.far = 400;
    key.shadow.bias = -0.0007;
    key.shadow.normalBias = 0.35;
    this.scene.add(key);
    this.key = key;
    this.scene.add(new THREE.HemisphereLight(0x9ccbff, 0x1b232b, 1.05));
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
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.26, 0.55, 1.05);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.mat = buildMaterials();

    // Ground, so the buildings stand on something and the shadows land.
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(1600, 1600).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x1a2229, roughness: 0.96, metalness: 0.04 }));
    ground.position.y = -3;
    ground.receiveShadow = true;
    this.scene.add(ground);
    const grid = new THREE.GridHelper(1600, 80, 0x2c3b47, 0x222d36);
    grid.position.y = -2.96;
    grid.material.transparent = true;
    grid.material.opacity = 0.5;
    this.scene.add(grid);

    this.resize();
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

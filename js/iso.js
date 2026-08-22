// ---------------------------------------------------------------------------
// iso.js — isometric projection, camera, depth sorting helpers
// ---------------------------------------------------------------------------

export const TW = 64;          // tile width  (screen px at zoom 1)
export const TH = 32;          // tile height (screen px at zoom 1)
export const EH = 20;          // one elevation unit in screen px

export class Camera {
  constructor(w, h) {
    this.x = 0; this.y = 0;          // world-space centre (in tiles)
    this.zoom = 1;
    this.w = w; this.h = h;
    this.targetZoom = 1;
    this.tx = 0; this.ty = 0;
    this.shake = 0;
  }
  resize(w, h) { this.w = w; this.h = h; }
  // world tile coords (+ elevation z) -> screen px
  project(x, y, z = 0) {
    const sx = (x - y) * (TW / 2);
    const sy = (x + y) * (TH / 2) - z * EH;
    return [sx, sy];
  }
  // full transform applied by ctx; these give absolute screen coords
  toScreen(x, y, z = 0) {
    const [px, py] = this.project(x, y, z);
    const [cx, cy] = this.project(this.x, this.y, 0);
    return [(px - cx) * this.zoom + this.w / 2, (py - cy) * this.zoom + this.h / 2];
  }
  screenToWorld(sx, sy) {
    const [cx, cy] = this.project(this.x, this.y, 0);
    const px = (sx - this.w / 2) / this.zoom + cx;
    const py = (sy - this.h / 2) / this.zoom + cy;
    const x = (py / (TH / 2) + px / (TW / 2)) / 2;
    const y = (py / (TH / 2) - px / (TW / 2)) / 2;
    return [x, y];
  }
  applyTransform(ctx) {
    const [cx, cy] = this.project(this.x, this.y, 0);
    let shx = 0, shy = 0;
    if (this.shake > 0.001) {
      shx = (Math.random() - 0.5) * this.shake * 26;
      shy = (Math.random() - 0.5) * this.shake * 26;
    }
    ctx.setTransform(this.zoom, 0, 0, this.zoom,
      this.w / 2 - cx * this.zoom + shx, this.h / 2 - cy * this.zoom + shy);
  }
  update(dt) {
    this.zoom += (this.targetZoom - this.zoom) * Math.min(1, dt * 9);
    this.x += (this.tx - this.x) * Math.min(1, dt * 5);
    this.y += (this.ty - this.y) * Math.min(1, dt * 5);
    this.shake *= Math.pow(0.06, dt);
    if (this.shake < 0.002) this.shake = 0;
  }
  focus(x, y, zoom) {
    this.tx = x; this.ty = y;
    if (zoom) this.targetZoom = zoom;
  }
  jolt(a) { this.shake = Math.min(1.6, this.shake + a); }
}

// depth key for painter's algorithm
export const depth = (x, y, z = 0) => (x + y) * 1000 + z * 0.5;

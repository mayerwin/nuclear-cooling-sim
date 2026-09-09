// ---------------------------------------------------------------------------
// cut.js - the cutaway.
//
// NOTHING LEAKS OUT OF A CUTAWAY. The cut is a RENDER-TIME effect on the
// materials; the fluid bodies are whole and the simulation never knows about
// it. That rule is why there are no glass fronts here, no half-vessels, and no
// water modelled to stop at a plane: build everything whole and take the near
// half off at render time, walls and liquids alike.
//
// A clipping plane removes half of a mesh and leaves the other half OPEN: you
// look into a shell and see its two skins with nothing between them, so a
// metre-thick concrete wall reads as hollow. The fix is the standard stencil
// one, which is three.js's own clipping_stencil example: draw the clipped
// solid's back faces into the stencil buffer with increment and its front
// faces with decrement, and where the count is not zero the plane passes
// through solid material. A single flat quad drawn on the plane through that
// stencil test becomes the exact cross-section, whatever shape the solid is,
// with nothing drawn anywhere else.
//
// Carried over from nuclear-cooling-sim's js/view/section.js.
// ---------------------------------------------------------------------------

import * as THREE from 'three';

// A vertical plane through a point, facing a heading. `az` is the compass
// direction the cut faces, so it can be pointed at wherever the camera lives
// and the section always opens towards the viewer.
//
// THREE CUTS AWAY THE NEGATIVE SIDE. A fragment whose signed distance to the
// plane is negative is discarded and the positive side is what you keep. The
// normal here therefore points AT the camera, so the near half is the half
// that goes. Getting this backwards removes the half you meant to keep, which
// looks exactly like the model failing to load.
export function planeAt(az, x = 0, y = 0, z = 0) {
  const n = new THREE.Vector3(-Math.cos(az), 0, -Math.sin(az));
  return new THREE.Plane(n, -(n.x * x + n.y * y + n.z * z));
}

// THE WHOLE CUTAWAY CONVENTION, IN ONE CALL, because half of it is a rotation
// and the other half is a plane and they have to agree.
//
// Build your model in a LOCAL frame: x runs across the picture, y is up, z is
// depth, and the cut is the plane z = 0 with the near half, +z, the half that
// comes off. Put it under a group turned by the `rotationY` this returns, give
// every material the `planes` it returns, and park the camera at `az`. Then
// the section always opens towards the viewer, whatever heading you chose, and
// a run laid along local x is cut ALONG ITS LENGTH so you look into the bore.
//
// A run laid across the cut instead gets chopped in half partway along, which
// is the mistake this call exists to prevent.
export function sectionFrame(az, x = 0, z = 0) {
  return {
    az,
    planes: [planeAt(az, x, 0, z)],
    // Local +x lands in the plane of the cut, local +z on the camera's side.
    rotationY: Math.PI / 2 - az,
    // Along the face of the cut, and into the half that is kept. Anything
    // meant to be seen in section lies along the first and is nudged back
    // along the second.
    along: new THREE.Vector3(-Math.sin(az), 0, Math.cos(az)),
    into: new THREE.Vector3(-Math.cos(az), 0, -Math.sin(az))
  };
}

// A plane through a vessel's own axis, so the near half comes off and you look
// straight in at the water.
export function halfCut(x, z, az = Math.PI * 0.25) {
  return [planeAt(az, x, 0, z)];
}

// Point every plane in a set at a new heading, without rebuilding anything the
// materials already hold: a host can turn the cut to follow the camera and the
// picture follows within a frame.
export function aim(planes, az, x = 0, y = 0, z = 0) {
  for (const p of planes) {
    p.normal.set(-Math.cos(az), 0, -Math.sin(az));
    p.constant = -(p.normal.x * x + p.normal.y * y + p.normal.z * z);
  }
  return planes;
}

// Apply a set of planes to every material under an object, cloning each
// material once so one model's cut does not follow a copy of it somewhere
// else. Returns the materials it touched, so they can be released later.
export function applyCut(root, planes, opts = {}) {
  const seen = new Map();
  const touched = [];
  root.traverse((o) => {
    if (!o.material) return;
    const list = Array.isArray(o.material) ? o.material : [o.material];
    const out = list.map((m) => {
      let c = seen.get(m);
      if (!c) {
        c = opts.clone === false ? m : m.clone();
        c.clippingPlanes = planes;
        c.clipIntersection = !!opts.intersection;
        c.clipShadows = opts.shadows !== false;
        // A clipped solid is not capped, so with front faces only the near
        // half vanishes and the far half is back-facing and culled: the body
        // is there and draws nothing. Everything cut is double-sided.
        if (opts.doubleSide !== false) c.side = THREE.DoubleSide;
        seen.set(m, c);
        touched.push(c);
      }
      return c;
    });
    o.material = Array.isArray(o.material) ? out : out[0];
  });
  return touched;
}

export class SectionCap {
  // plane: the world-space clipping plane the shell is cut by.
  constructor(plane) {
    this.plane = plane;
    const base = {
      depthWrite: false, depthTest: false, colorWrite: false,
      stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc,
      clippingPlanes: [plane], clipIntersection: false
    };
    const inc = {
      stencilFail: THREE.IncrementWrapStencilOp,
      stencilZFail: THREE.IncrementWrapStencilOp,
      stencilZPass: THREE.IncrementWrapStencilOp
    };
    const dec = {
      stencilFail: THREE.DecrementWrapStencilOp,
      stencilZFail: THREE.DecrementWrapStencilOp,
      stencilZPass: THREE.DecrementWrapStencilOp
    };
    const mk = (side, ops) => new THREE.MeshBasicMaterial(Object.assign({ side }, base, ops));
    // Seeing a surface's back means the ray is INSIDE the material: count up.
    // Seeing its front means the ray is leaving it: count down.
    this.outward = [mk(THREE.BackSide, inc), mk(THREE.FrontSide, dec)];
    // For a skin whose mesh normals point INTO the material, such as the inner
    // face of a wall built from an ordinary cylinder, the roles are the other
    // way round: its geometric back is the material's front.
    this.inward = [mk(THREE.BackSide, dec), mk(THREE.FrontSide, inc)];
  }

  // Mirror one mesh of the shell into the stencil pass. Returns the two
  // stencil meshes, so the caller can parent them where the original lives and
  // they hide and show with it.
  //
  // The count only means anything if every surface's front face points OUT of
  // the material. A cylinder's normals point away from its axis, which is out
  // of the material for the outer skin of a wall and INTO it for the inner
  // skin; pass inward = true for the inner skin, and for a floor whose normal
  // points up into the wall, and the two roles swap.
  mirror(mesh, inward = false) {
    const out = [];
    for (const mat of inward ? this.inward : this.outward) {
      const m = new THREE.Mesh(mesh.geometry, mat);
      m.position.copy(mesh.position);
      m.rotation.copy(mesh.rotation);
      m.scale.copy(mesh.scale);
      m.renderOrder = 1;
      m.frustumCulled = false;
      out.push(m);
    }
    return out;
  }

  // The face itself: a quad lying on the plane, drawn only where the stencil
  // says the plane is inside the solid, and clearing the stencil as it goes.
  //
  // Capping the cut with a plain flat quad instead puts a slab across the
  // middle of the view: the two faces of a wedge meet on the axis, and a quad
  // covers everything between them. Section caps are stencil-based for that
  // reason and no other.
  cap(width, height, localNormal, centre, material) {
    const mat = material.clone();
    Object.assign(mat, {
      side: THREE.DoubleSide,
      clippingPlanes: [], clipIntersection: false,
      stencilWrite: true, stencilRef: 0,
      stencilFunc: THREE.NotEqualStencilFunc,
      stencilFail: THREE.ReplaceStencilOp,
      stencilZFail: THREE.ReplaceStencilOp,
      stencilZPass: THREE.ReplaceStencilOp
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(width, height), mat);
    quad.position.copy(centre);
    quad.lookAt(centre.clone().add(localNormal));
    quad.renderOrder = 2;
    quad.frustumCulled = false;
    quad.receiveShadow = true;
    return quad;
  }

  dispose() {
    for (const m of [...this.outward, ...this.inward]) m.dispose();
  }
}

// The renderer must be told to do any of this at all. Called once by a host
// that did not already set it up.
export function enableClipping(renderer) {
  renderer.localClippingEnabled = true;
  return renderer;
}

export { THREE };

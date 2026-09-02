// ---------------------------------------------------------------------------
// section.js - the cut face of a sectioned solid.
//
// A clipping plane removes half of a mesh and leaves the other half open: you
// look into the shell and see its two skins with nothing between them, so a
// metre-thick concrete wall reads as hollow. The fix is the standard one (it is
// three.js's own clipping_stencil example): draw the clipped solid's back
// faces into the stencil buffer with increment and its front faces with
// decrement, and where the count is not zero the plane passes through solid
// material. A single flat quad drawn on the plane through that stencil test
// becomes the exact cross-section, whatever shape the solid is - wall, dome,
// or a hole torn in either - with nothing drawn anywhere else.
// ---------------------------------------------------------------------------
import * as THREE from 'three';

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
      stencilZPass: THREE.IncrementWrapStencilOp };
    const dec = {
      stencilFail: THREE.DecrementWrapStencilOp,
      stencilZFail: THREE.DecrementWrapStencilOp,
      stencilZPass: THREE.DecrementWrapStencilOp };
    const mk = (side, ops) => new THREE.MeshBasicMaterial(Object.assign({ side }, base, ops));
    // Seeing a surface's back means the ray is INSIDE the material: count up.
    // Seeing its front means the ray is leaving it: count down.
    this.outward = [mk(THREE.BackSide, inc), mk(THREE.FrontSide, dec)];
    // For a skin whose mesh normals point INTO the material - the inner face of
    // a wall built from an ordinary cylinder - the roles are the other way
    // round: its geometric back is the material's front.
    this.inward = [mk(THREE.BackSide, dec), mk(THREE.FrontSide, inc)];
  }

  // Mirror one mesh of the shell into the stencil pass. Returns the two
  // stencil meshes so the caller can parent them where the original lives and
  // they hide and show with it.
  //
  // The count only means anything if every surface's front face points OUT of
  // the material. A cylinder's normals point away from its axis, which is out
  // of the material for the outer skin of a wall and INTO it for the inner
  // skin; pass inward = true for the inner skin (and for a floor whose normal
  // points up into the wall) and the two roles are swapped.
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
  // localNormal and centre are in the parent's frame.
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
}

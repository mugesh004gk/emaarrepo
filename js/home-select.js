import * as THREE from 'three';
import { toWorld, localScale } from './geo.js';

/**
 * Hover and selection feedback for single homes, plus fast picking.
 *
 * Picking tests one box per home (the colour-overlay boxes, Nara's own pick boxes and the apartment
 * buildings) instead of the full house geometry, so hovering costs well under a millisecond and the
 * home under the cursor is exactly the one that gets selected.
 *
 * Feedback:
 *  - hover: a soft white box around the home under the cursor
 *  - selected: an amber outline and fill (Nara's selection colour) that pulses gently, and a tag
 *    above the roof that stays attached to the home while the camera moves
 */
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
const UNIT_EDGES = new THREE.EdgesGeometry(UNIT_BOX);
const AMBER = 0xffb703;

export function createHomeSelection(scene) {
  const root = new THREE.Group();
  root.name = 'HomeSelection';
  scene.add(root);
  function makeMarker(color, fillOpacity, edgeOpacity) {
    const g = new THREE.Group();
    const fill = new THREE.Mesh(UNIT_BOX, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: fillOpacity, depthWrite: false }));
    const edges = new THREE.LineSegments(UNIT_EDGES, new THREE.LineBasicMaterial({ color, transparent: true, opacity: edgeOpacity, depthTest: false }));
    fill.renderOrder = 8;
    edges.renderOrder = 9;
    g.add(fill, edges);
    g.matrixAutoUpdate = false;
    g.visible = false;
    g.userData = { fill, edges, baseFill: fillOpacity };
    root.add(g);
    return g;
  }
  const hover = makeMarker(0x16b8a6, 0.32, 1); // brand teal: "this is the one you will get"
  const selected = makeMarker(AMBER, 0.3, 1);
  const top = new THREE.Vector3();
  let pulseT0 = -1;
  const PULSE_MS = 1400;

  function place(marker, m) {
    if (!m) { marker.visible = false; return; }
    marker.matrix.copy(m);
    marker.matrixWorldNeedsUpdate = true;
    marker.visible = true;
  }
  return {
    setHover(m) { place(hover, m); },
    setSelected(m) {
      place(selected, m);
      if (m) { top.set(0, 1.25, 0).applyMatrix4(m); pulseT0 = performance.now(); } // tag sits a little above the roof
    },
    /** hide both markers away from the aerial view (street level, inside, show home) */
    setVisible(v) { root.visible = v; },
    get hasSelection() { return selected.visible; },
    get hoverVisible() { return hover.visible; },
    /** World point above the selected home's roof (for its tag) */
    tagPoint: () => top,
    /** Two soft pulses right after a home is chosen, then a steady fill (no continuous redraws).
     *  Returns true while the pulse still needs frames. */
    tick(now) {
      if (!selected.visible || pulseT0 < 0) return false;
      const t = (now - pulseT0) / PULSE_MS;
      const mat = selected.userData.fill.material;
      if (t >= 1) { mat.opacity = 0.3; pulseT0 = -1; return true; }
      mat.opacity = 0.3 + 0.25 * Math.sin(t * Math.PI * 4) * (1 - t);
      return true;
    },
  };
}

/**
 * Ray picking over many unit-box matrices. A tight bounding-sphere loop over typed arrays finds the
 * few candidates, then an exact box test in each candidate's own frame gives the nearest hit.
 * Cheap enough to run on mouse move (measured in the README).
 */
export function createPickIndex(entries) {
  const n = entries.length;
  const cx = new Float32Array(n), cy = new Float32Array(n), cz = new Float32Array(n), r2 = new Float32Array(n);
  const inv = new Array(n);
  const sx = new THREE.Vector3(), sy = new THREE.Vector3(), sz = new THREE.Vector3(), c = new THREE.Vector3();
  entries.forEach((e, i) => {
    const m = e.matrix;
    c.set(0, 0.5, 0).applyMatrix4(m);
    m.extractBasis(sx, sy, sz);
    cx[i] = c.x; cy[i] = c.y; cz[i] = c.z;
    r2[i] = 0.25 * (sx.lengthSq() + sy.lengthSq() + sz.lengthSq());
    inv[i] = m.clone().invert();
  });
  const box = new THREE.Box3(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1, 0.5));
  const local = new THREE.Ray(), hitL = new THREE.Vector3(), hitW = new THREE.Vector3();
  return {
    /** nearest entry hit by the ray: { entry, distance, point } or null */
    pick(ray, maxDist = Infinity) {
      const ox = ray.origin.x, oy = ray.origin.y, oz = ray.origin.z;
      const dx = ray.direction.x, dy = ray.direction.y, dz = ray.direction.z;
      let best = null, bestD = maxDist;
      for (let i = 0; i < n; i++) {
        const vx = cx[i] - ox, vy = cy[i] - oy, vz = cz[i] - oz;
        const t = vx * dx + vy * dy + vz * dz;
        if (t < 0) continue;
        const d2 = vx * vx + vy * vy + vz * vz - t * t;
        if (d2 > r2[i]) continue;
        if (t - Math.sqrt(r2[i]) > bestD) continue;
        local.copy(ray).applyMatrix4(inv[i]);
        if (!local.intersectBox(box, hitL)) continue;
        hitW.copy(hitL).applyMatrix4(entries[i].matrix);
        const d = hitW.distanceTo(ray.origin);
        if (d < bestD) { bestD = d; best = { entry: entries[i], distance: d, point: hitW.clone() }; }
      }
      return best;
    },
  };
}

/** Box matrix (unit box, base at y=0) for an apartment building record */
export function apartmentBoxMatrix(a) {
  const w = toWorld(a.lat, a.lng);
  const h = 8.5 + (a.storeys || 8) * 3.2 + 1.2;
  const ls = localScale(a.lat);
  return new THREE.Matrix4().compose(
    new THREE.Vector3(w.x, 0, w.z),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI - THREE.MathUtils.degToRad(a.frontBearing)),
    new THREE.Vector3((a.L + 0.6) * ls, h, (a.D + 0.6) * ls),
  );
}

/** Box matrix for a Nara home from its pick box (a centred BoxGeometry) */
export function naraBoxMatrix(pickMesh) {
  const g = pickMesh.geometry;
  if (!g.boundingBox) g.computeBoundingBox();
  const size = g.boundingBox.getSize(new THREE.Vector3());
  const c = g.boundingBox.getCenter(new THREE.Vector3());
  pickMesh.updateWorldMatrix(true, false);
  return pickMesh.matrixWorld.clone().multiply(new THREE.Matrix4().compose(
    new THREE.Vector3(c.x, c.y - size.y / 2, c.z), new THREE.Quaternion(), new THREE.Vector3(size.x + 0.4, size.y + 0.5, size.z + 0.4)));
}

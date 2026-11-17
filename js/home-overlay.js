import * as THREE from 'three';
import { BED_COLORS, STATUS_COLORS, projectStatus } from './projects-layer.js';

/**
 * Colour / filter highlight for every 3D home outside Nara (Nara has its own, js/nara/community.js):
 * one translucent box per home over its house, coloured by bedrooms or project status, and dimmed
 * when the home does not match the explorer filters. One InstancedMesh, one draw call.
 */
const DIM = new THREE.Color(0x1e293b);
export function createHomeOverlay(scene, homes, projectsById) {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  geo.translate(0, 0.5, 0);
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false, emissive: 0x222222 });
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, homes.length));
  mesh.name = 'HomeOverlay';
  mesh.renderOrder = 5;
  homes.forEach((h, i) => mesh.setMatrixAt(i, h.overlayMatrix));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.visible = false;
  mesh.userData.homes = homes;
  scene.add(mesh);
  const c = new THREE.Color();

  /** mode: 'realistic' | 'bedrooms' | 'status' | others; match(home) -> bool or null (no filter) */
  function update(mode, match) {
    const colourMode = mode === 'bedrooms' || mode === 'status';
    mesh.visible = colourMode || !!match;
    if (!mesh.visible) return;
    homes.forEach((h, i) => {
      const ok = !match || match(h);
      if (!ok) c.copy(DIM);
      else if (mode === 'status') c.set(STATUS_COLORS[projectStatus(projectsById.get(h.project) || {})]);
      else c.set(BED_COLORS[Math.min(6, h.beds)] || '#ffffff');
      mesh.setColorAt(i, c);
    });
    mesh.instanceColor.needsUpdate = true;
  }
  return { mesh, update, homes };
}

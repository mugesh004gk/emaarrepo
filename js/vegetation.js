import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Vegetation and street furniture with a natural look (replaces the solid-shape trees):
 *  - broadleaf trees: branching trunk + a canopy of leaf-textured cards with alpha cut-out and
 *    rounded (canopy-centred) normals, so the crown reads as soft foliage, not a solid shape;
 *  - palms: ringed trunk + arching fronds with a cut-out leaflet texture;
 *  - shrubs: low leaf-card mounds (green, olive, flowering bougainvillea) and grass tufts;
 *  - street lamps: pole, arm and lit head.
 * Everything is instanced per species (one draw call per species per cell).
 * Sizes are real metres, multiplied by the caller's sizeScale.
 */
let seed = 1234567;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

// ---- textures ---------------------------------------------------------------------------------
function leafTexture(greens, blossom = null, blossomShare = 0) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  seed = 99 + greens[0].length * 7 + (blossom ? 31 : 0);
  for (let i = 0; i < 420; i++) {
    // leaves cluster toward the centre, sparse at the rim (cut-out silhouette)
    const a = rnd() * Math.PI * 2, r = Math.pow(rnd(), 0.75) * 118;
    const x = 128 + Math.cos(a) * r, y = 128 + Math.sin(a) * r;
    const col = blossom && rnd() < blossomShare ? blossom[Math.floor(rnd() * blossom.length)] : greens[Math.floor(rnd() * greens.length)];
    g.fillStyle = col;
    g.beginPath();
    g.ellipse(x, y, 7 + rnd() * 7, 3 + rnd() * 3, rnd() * Math.PI, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
function frondTexture() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 256;
  const g = c.getContext('2d');
  g.strokeStyle = '#5d7a2e';
  g.lineWidth = 3;
  g.beginPath(); g.moveTo(32, 0); g.lineTo(32, 256); g.stroke(); // rib
  for (let y = 4; y < 252; y += 5) {
    const w = 30 * Math.sin((y / 256) * Math.PI) ** 0.6 + 2;
    g.strokeStyle = ['#3f6b24', '#4c7a2a', '#5a8a32', '#44702a'][(y / 5) % 4 | 0];
    g.lineWidth = 2.2;
    g.beginPath(); g.moveTo(32, y); g.lineTo(32 - w, y + 9); g.stroke();
    g.beginPath(); g.moveTo(32, y); g.lineTo(32 + w, y + 9); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
function leafMaterial(tex) {
  const m = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.85, metalness: 0 });
  m.userData.depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: tex, alphaTest: 0.45, side: THREE.DoubleSide });
  return m;
}

// ---- geometry -----------------------------------------------------------------------------------
/** Canopy of leaf cards inside an ellipsoid at height cy; normals point out from the canopy centre. */
function canopyGeometry(rx, ry, cy, cards, cardSize) {
  const parts = [];
  for (let i = 0; i < cards; i++) {
    const a = rnd() * Math.PI * 2, e = Math.acos(2 * rnd() - 1), r = 0.45 + rnd() * 0.5;
    const p = new THREE.Vector3(Math.sin(e) * Math.cos(a) * rx * r, Math.cos(e) * ry * r + cy, Math.sin(e) * Math.sin(a) * rx * r);
    const s = cardSize * (0.75 + rnd() * 0.5);
    for (let k = 0; k < 2; k++) {
      const q = new THREE.PlaneGeometry(s, s);
      q.rotateX((rnd() - 0.5) * 1.2);
      q.rotateY(rnd() * Math.PI + (k * Math.PI) / 2);
      q.translate(p.x, p.y, p.z);
      parts.push(q);
    }
  }
  const g = mergeGeometries(parts, false);
  const pos = g.attributes.position, nor = g.attributes.normal, v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.set(pos.getX(i), (pos.getY(i) - cy) * (rx / ry) + ry * 0.35, pos.getZ(i)).normalize();
    nor.setXYZ(i, v.x, v.y, v.z);
  }
  return g;
}
function trunkGeometry(h, r, branches = 3) {
  const parts = [new THREE.CylinderGeometry(r * 0.6, r, h, 7).translate(0, h / 2, 0)];
  for (let b = 0; b < branches; b++) {
    const bl = h * 0.55, br = new THREE.CylinderGeometry(r * 0.25, r * 0.5, bl, 5).translate(0, bl / 2, 0);
    br.rotateZ(0.55 + rnd() * 0.3);
    br.rotateY((b / branches) * Math.PI * 2 + rnd());
    br.translate(0, h * 0.72, 0);
    parts.push(br);
  }
  return mergeGeometries(parts, false);
}
function palmGeometry(h, fronds, len) {
  const trunk = new THREE.CylinderGeometry(0.16, 0.26, h, 8, 8).translate(0, h / 2, 0);
  const tp = trunk.attributes.position; // slight ring bulges
  for (let i = 0; i < tp.count; i++) { const k = 1 + 0.07 * Math.sin(tp.getY(i) * 9); tp.setX(i, tp.getX(i) * k); tp.setZ(i, tp.getZ(i) * k); }
  trunk.computeVertexNormals();
  const parts = [];
  const SEG = 6;
  for (let f = 0; f < fronds; f++) {
    const yaw = (f / fronds) * Math.PI * 2 + rnd() * 0.3;
    const lift = 0.9 - (f % 3) * 0.45 + rnd() * 0.2; // some upright, some drooping
    const pos = [], uv = [], idx = [];
    for (let s = 0; s <= SEG; s++) {
      const t = s / SEG;
      const out = len * t * 0.95, y = h + len * (lift * t - 0.75 * t * t);
      const w = 0.55 * len * 0.28 * (0.5 + Math.sin(t * Math.PI) * 0.9);
      const cx = Math.cos(yaw) * out, cz = Math.sin(yaw) * out;
      const nx = -Math.sin(yaw), nz = Math.cos(yaw);
      pos.push(cx - nx * w, y - 0.12 * w, cz - nz * w, cx + nx * w, y - 0.12 * w, cz + nz * w);
      uv.push(0, t, 1, t);
      if (s < SEG) { const b = s * 2; idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    parts.push(g);
  }
  return { trunk, fronds: mergeGeometries(parts, false) };
}

// ---- species kit (built once) ------------------------------------------------------------------------
let KIT = null;
function kit() {
  if (KIT) return KIT;
  const G = {
    deep: ['#2f5a22', '#3a6a28', '#48792f', '#27501f'],
    fresh: ['#4c8a34', '#5c9a3c', '#3f7a2c', '#6aa646'],
    olive: ['#6f7f4a', '#7d8c58', '#5d6d3e', '#8a9864'],
    ghaf: ['#6a8a48', '#7a9a55', '#587a3c', '#8aa862'],
  };
  const bark = new THREE.MeshStandardMaterial({ color: 0x6b5a48, roughness: 0.95 });
  const palmBark = new THREE.MeshStandardMaterial({ color: 0x8a7458, roughness: 0.95 });
  const frondMat = leafMaterial(frondTexture());
  const broad = (h, rx, ry, cards, size, tex, trunkR = 0.16) => {
    seed = 4242 + Math.round(h * 100);
    return { trunk: trunkGeometry(h * 0.5, trunkR), trunkMat: bark, leaf: canopyGeometry(rx, ry, h * 0.5 + ry * 0.75, cards, size), leafMat: leafMaterial(tex) };
  };
  seed = 777;
  const date = palmGeometry(8.5, 18, 3.4), wash = palmGeometry(11.5, 14, 2.6);
  KIT = {
    trees: {
      flameTree: broad(7.5, 3.6, 1.7, 22, 2.6, leafTexture(G.fresh, ['#e2552a', '#f0702e', '#d8401f'], 0.3)),
      neem: broad(8.5, 3.0, 2.6, 26, 2.5, leafTexture(G.deep)),
      ghaf: broad(7, 3.2, 2.0, 22, 2.4, leafTexture(G.ghaf)),
      olive: broad(5, 2.2, 1.7, 18, 1.9, leafTexture(G.olive), 0.2),
      frangipani: broad(4.2, 2.0, 1.4, 16, 1.7, leafTexture(G.fresh, ['#fff6e0', '#ffe9a8', '#ffffff'], 0.18), 0.14),
      datePalm: { trunk: date.trunk, trunkMat: palmBark, leaf: date.fronds, leafMat: frondMat },
      washingtonia: { trunk: wash.trunk, trunkMat: palmBark, leaf: wash.fronds, leafMat: frondMat },
    },
    shrubs: (() => {
      seed = 555;
      const mound = (r, h, cards, size) => canopyGeometry(r, h, h * 0.8, cards, size);
      return [
        { geo: mound(0.7, 0.45, 9, 0.95), mat: leafMaterial(leafTexture(G.deep)) },
        { geo: mound(0.75, 0.5, 9, 1.0), mat: leafMaterial(leafTexture(G.fresh, ['#c2337f', '#d84c94', '#b02a70'], 0.35)) }, // bougainvillea
        { geo: mound(0.5, 0.55, 8, 0.8), mat: leafMaterial(leafTexture(['#a8b070', '#b8bc80', '#98a060', '#c4c488'])) }, // ornamental grass
      ];
    })(),
    lamp: (() => {
      const pole = mergeGeometries([
        new THREE.CylinderGeometry(0.05, 0.08, 4.4, 8).translate(0, 2.2, 0),
        new THREE.BoxGeometry(1.1, 0.06, 0.06).translate(0.5, 4.38, 0),
        new THREE.CylinderGeometry(0.12, 0.12, 0.25, 8).translate(0, 0.12, 0),
      ], false);
      const head = new THREE.BoxGeometry(0.5, 0.07, 0.2).translate(0.95, 4.32, 0);
      return { pole, head, poleMat: new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.5, metalness: 0.7 }),
        headMat: new THREE.MeshStandardMaterial({ color: 0xfff4d6, emissive: 0xffe9b0, emissiveIntensity: 0.8 }) };
    })(),
  };
  return KIT;
}

function instanced(geo, mat, items, place, shadow = true, tint = false) {
  const im = new THREE.InstancedMesh(geo, mat, items.length);
  const d = new THREE.Object3D(), c = new THREE.Color();
  items.forEach((it, i) => {
    place(d, it, i);
    d.updateMatrix();
    im.setMatrixAt(i, d.matrix);
    if (tint) { const k = 0.82 + ((i * 53) % 19) / 100; im.setColorAt(i, c.setRGB(k, k + 0.03, k)); }
  });
  im.castShadow = shadow;
  im.receiveShadow = true;
  if (mat.userData.depth) im.customDepthMaterial = mat.userData.depth;
  return im;
}

/** trees: [{wx, wz, species, radius}] -> Group */
export function buildTrees(trees, sizeScale = 1) {
  const K = kit();
  const group = new THREE.Group();
  group.name = 'Trees';
  const by = {};
  for (const t of trees) (by[K.trees[t.species] ? t.species : 'neem'] ||= []).push(t);
  for (const [sp, list] of Object.entries(by)) {
    const k = K.trees[sp];
    const place = (d, t, i) => {
      const s = sizeScale * THREE.MathUtils.clamp((t.radius || 2.4) / 2.4, 0.7, 1.25) * (0.88 + ((i * 37) % 25) / 100);
      d.position.set(t.wx, 0, t.wz);
      d.rotation.set(0, i * 2.39, 0);
      d.scale.set(s, s * (0.94 + ((i * 11) % 13) / 100), s);
    };
    group.add(instanced(k.trunk, k.trunkMat, list, place), instanced(k.leaf, k.leafMat, list, place, true, true));
  }
  return group;
}

/** plants: [{x, z, kind 0..2, rot}] -> Group of low shrubs */
export function buildShrubs(plants, sizeScale = 1) {
  const K = kit();
  const g = new THREE.Group();
  for (let kind = 0; kind < 3; kind++) {
    const list = plants.filter((p) => p.kind === kind);
    if (!list.length) continue;
    g.add(instanced(K.shrubs[kind].geo, K.shrubs[kind].mat, list, (d, p, i) => {
      const s = sizeScale * (0.75 + ((i * 29) % 30) / 100);
      d.position.set(p.x, 0, p.z);
      d.rotation.set(0, p.rot || i, 0);
      d.scale.setScalar(s);
    }, false, true));
  }
  return g;
}

/** lamps: [{x, z, yaw}] -> Group */
export function buildLamps(lamps) {
  const L = kit().lamp;
  const g = new THREE.Group();
  const place = (d, p) => { d.position.set(p.x, 0, p.z); d.rotation.set(0, p.yaw, 0); d.scale.setScalar(1); };
  g.add(instanced(L.pole, L.poleMat, lamps, place), instanced(L.head, L.headMat, lamps, place, false));
  return g;
}

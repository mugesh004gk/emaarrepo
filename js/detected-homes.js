import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { toWorld, localScale } from './geo.js';
import { estimateBeds } from './projects-layer.js';
import { applyWallRelief } from './realism.js';

/**
 * Homes detected from current satellite imagery (scripts/satellite, data/homes_detected.json),
 * built in 3D in the Nara townhouse language: two storeys, setback first floor with a glass
 * balcony, parapet roof, accent fin, carport canopy, and Nara-style facades (door, glazing,
 * sliding doors, upper windows) drawn on the walls.
 *
 * Row position, length, depth and street side come from the imagery; the split into homes and
 * the design are representative until each project's brochure cluster map is traced.
 *
 * One level of detail only (~200 triangles a home, so no LOD switching and nothing pops), one
 * THREE.BatchedMesh per material for the whole community (a handful of draw calls), every home
 * an instance that three.js frustum-culls individually, for the camera and the sun's shadows.
 */
const W0 = 7.8; // nominal home width the template is built at (m)
const HD0 = 11.5; // nominal house depth (m)
const GF = 3.6, FF = 3.3, PARAPET = 0.8, SETBACK = 1.6;
const STYLES = ['aston', 'palma', 'charm'];

function facadeTexture(kind, style) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const g = c.getContext('2d');
  const wall = { aston: '#ecebe7', palma: '#f3efe6', charm: '#f6f5f2' }[style];
  const accent = { aston: '#8f8a83', palma: '#b59a7a', charm: '#d9d6cf' }[style];
  g.fillStyle = wall;
  g.fillRect(0, 0, 512, 256);
  // fine plaster grain
  let s = kind.length * 977 + style.length * 131;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 2600; i++) {
    g.fillStyle = `rgba(0,0,0,${0.02 + rnd() * 0.03})`;
    g.fillRect(rnd() * 512, rnd() * 256, 1.5, 1.5);
  }
  const glass = (x, y, w, h, mull = 2) => {
    g.fillStyle = '#20262c';
    g.fillRect(x - 4, y - 4, w + 8, h + 8);
    const gr = g.createLinearGradient(x, y, x + w, y + h);
    gr.addColorStop(0, '#6f8796');
    gr.addColorStop(0.55, '#2f3c45');
    gr.addColorStop(1, '#4f6572');
    g.fillStyle = gr;
    g.fillRect(x, y, w, h);
    g.fillStyle = '#1b2025';
    for (let k = 1; k < mull; k++) g.fillRect(x + (w * k) / mull - 2, y, 4, h);
    g.fillStyle = 'rgba(255,255,255,0.18)';
    g.fillRect(x + 4, y + 4, w * 0.25, h * 0.5);
  };
  const band = (y, h) => { g.fillStyle = accent; g.fillRect(0, y, 512, h); };
  if (kind === 'gfFront') {
    // entrance door (timber) + feature panel + large window
    g.fillStyle = '#6b4a33';
    g.fillRect(56, 70, 70, 186);
    for (let k = 0; k < 9; k++) { g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(60 + k * 7.5, 74, 2, 180); }
    g.fillStyle = accent;
    g.fillRect(150, 24, 44, 232);
    glass(232, 60, 236, 150, 3);
    band(236, 20);
  } else if (kind === 'gfBack') {
    glass(40, 40, 432, 196, 4); // sliding doors to the garden
  } else if (kind === 'ffFront') {
    glass(48, 60, 180, 140, 2);
    glass(290, 60, 170, 140, 2);
    band(0, 14);
  } else if (kind === 'ffBack') {
    glass(70, 50, 140, 150, 2);
    glass(300, 50, 140, 150, 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Plane facing +normal, centred at (x, y, z), size w x h, rotated to face the given axis. */
function plane(w, h, x, y, z, face) {
  const p = new THREE.PlaneGeometry(w, h);
  if (face === '+z') { /* default faces +z */ }
  if (face === '-z') p.rotateY(Math.PI);
  if (face === '+x') p.rotateY(Math.PI / 2);
  if (face === '-x') p.rotateY(-Math.PI / 2);
  if (face === '+y') p.rotateX(-Math.PI / 2);
  p.translate(x, y, z);
  return p;
}
function box(w, h, d, x, y, z) {
  const b = new THREE.BoxGeometry(w, h, d);
  b.translate(x, y, z);
  return b;
}
function clean(g) {
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', g.getAttribute('position'));
  out.setAttribute('normal', g.getAttribute('normal'));
  out.setAttribute('uv', g.getAttribute('uv'));
  out.setIndex(g.index ? g.index : null);
  return out.index ? out : out.toNonIndexed();
}
function merged(list) {
  return mergeGeometries(list.map((g) => clean(g.index ? g : g)), false);
}

/** House template (nominal W0 x HD0), front at +z, origin at the middle of the house footprint. */
function houseParts(style) {
  const w = W0, d = HD0, zf = d / 2, zb = -d / 2, zff = zf - SETBACK;
  const parts = {
    [`gfFront_${style}`]: [plane(w, GF, 0, GF / 2, zf, '+z')],
    [`gfBack_${style}`]: [plane(w, GF, 0, GF / 2, zb, '-z')],
    [`ffFront_${style}`]: [plane(w, FF, 0, GF + FF / 2, zff, '+z')],
    [`ffBack_${style}`]: [plane(w, FF, 0, GF + FF / 2, zb, '-z')],
    [`wall_${style}`]: [
      plane(d, GF, w / 2, GF / 2, 0, '+x'), plane(d, GF, -w / 2, GF / 2, 0, '-x'),
      plane(d - SETBACK, FF, w / 2, GF + FF / 2, -SETBACK / 2, '+x'), plane(d - SETBACK, FF, -w / 2, GF + FF / 2, -SETBACK / 2, '-x'),
      // parapet ring (inner faces included by the boxes)
      box(w, PARAPET, 0.25, 0, GF + FF + PARAPET / 2, zff - 0.125),
      box(w, PARAPET, 0.25, 0, GF + FF + PARAPET / 2, zb + 0.125),
      box(0.25, PARAPET, d - SETBACK, w / 2 - 0.125, GF + FF + PARAPET / 2, -SETBACK / 2),
      box(0.25, PARAPET, d - SETBACK, -w / 2 + 0.125, GF + FF + PARAPET / 2, -SETBACK / 2),
      // balcony upstand on the setback
      box(w, 0.25, 0.25, 0, GF + 0.12, zf - 0.125),
    ],
    roof: [plane(w - 0.5, d - SETBACK - 0.5, 0, GF + FF + 0.02, -SETBACK / 2, '+y')],
    // parapet copings + party-wall fins: each home reads as its own unit from the air
    coping: [
      box(w + 0.04, 0.08, 0.34, 0, GF + FF + PARAPET + 0.04, zff - 0.125),
      box(w + 0.04, 0.08, 0.34, 0, GF + FF + PARAPET + 0.04, zb + 0.125),
      box(0.36, 0.5, d - SETBACK + 0.1, w / 2, GF + FF + PARAPET + 0.25, -SETBACK / 2),
      box(0.3, GF + FF + PARAPET, 0.18, w / 2, (GF + FF + PARAPET) / 2, zf + 0.09 - SETBACK),
    ],
    // rooftop plant and the stair bulkhead (roof silhouette rhythm, as in the Nara homes)
    plant: [
      box(0.95, 0.75, 0.85, w * 0.18, GF + FF + 0.4, zb + 2.2),
      box(0.95, 0.75, 0.85, w * 0.18 + 1.2, GF + FF + 0.4, zb + 2.2),
      box(2.3, 1.25, 2.7, -w * 0.22, GF + FF + 0.62, zb + 3.2),
    ],
    terrace: [plane(w, SETBACK, 0, GF + 0.01, zf - SETBACK / 2, '+y')],
    glass: [plane(w * 0.86, 1.05, 0, GF + 0.25 + 0.52, zf - 0.06, '+z')],
    [`accent_${style}`]: [
      box(0.38, GF + FF + PARAPET, 0.42, w / 2 - 0.45, (GF + FF + PARAPET) / 2, zf + 0.2),
      // colour-blocked frame around half of the upper front (Aston taupe, Palma timber, Charm louvres)
      box(w * 0.46, FF + 0.35, 0.34, -w * 0.25, GF + FF / 2 + 0.1, zff + 0.17),
    ],
  };
  return parts;
}
function canopyParts() {
  // nominal 1 m deep canopy (scaled to the carport depth), front at +z, origin at its back edge middle
  return {
    canopy: [box(W0 - 0.3, 0.22, 1, 0, 3.32, 0.5), box(0.22, 3.2, 0.22, W0 / 2 - 0.4, 1.6, 0.92), box(0.22, 3.2, 0.22, -W0 / 2 + 0.4, 1.6, 0.92)],
  };
}

// Closest Nara design for each project, from Emaar's renders: white walls with timber screens
// (Palma) for most of The Valley, sand/taupe facades (Aston) for Orania and Talia, all-white
// townhouses (Charm) for Eden and Nima. Other communities keep a stable mix.
const PROJECT_STYLE = {
  // The Valley
  'orania-at-the-valley': 'aston', talia: 'aston', eden: 'charm', nima: 'charm',
  // Arabian Ranches III: white with timber accents (Palma); June grey with dark frames; Elie Saab all white
  june: 'aston', 'elie-saab-at-arabian-ranches-iii': 'charm',
  // Emaar South: sand facades with timber at Urbana; white townhouses and villas elsewhere
  urbana: 'aston', 'urbana-iii': 'aston',
};
const COMMUNITY_STYLE = { 'arabian-ranches-3': 'palma', 'emaar-south': 'charm' };
function styleFor(projectId) {
  if (!projectId) return 'charm'; // home not assigned to a project (far from every built project)
  if (PROJECT_STYLE[projectId]) return PROJECT_STYLE[projectId];
  if (/-at-the-valley|^(lillia|alana|rivana|elora|the-farm-gardens|farm-gardens-2)$/.test(projectId)) return 'palma';
  if (/^(may|anya|anya-2|raya|bliss|bliss-2|caya-2|ruba|joy|spring|sun)$/.test(projectId)) return COMMUNITY_STYLE['arabian-ranches-3'];
  if (/emaar-south|^(golf-|green|fairway|expo-golf)/.test(projectId)) return COMMUNITY_STYLE['emaar-south'];
  let h = 0;
  for (const ch of projectId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return ['aston', 'palma', 'charm'][h % 3];
}

// Storeys printed on the developer sheets ("MASSING PLAN G + P + 10"); others are representative.
const PRINTED_MASSING = { 'golf-trails-at-emaar-south': 10, 'vista-ridge-at-emaar-south': 10, 'grove-ridge-at-emaar-south': 11 };
const REP_STOREYS = 8;

function gridTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#efece6';
  g.fillRect(0, 0, 256, 256);
  // one bay x one storey: slab band, window with frame, balcony glass line
  g.fillStyle = '#d9d4ca';
  g.fillRect(0, 0, 256, 26);
  g.fillStyle = '#1f262c';
  g.fillRect(26, 52, 204, 170);
  const gr = g.createLinearGradient(0, 56, 256, 220);
  gr.addColorStop(0, '#7891a0');
  gr.addColorStop(0.6, '#33424c');
  gr.addColorStop(1, '#55707e');
  g.fillStyle = gr;
  g.fillRect(32, 58, 192, 158);
  g.fillStyle = '#1b2025';
  g.fillRect(126, 58, 5, 158);
  g.fillStyle = 'rgba(255,255,255,0.35)';
  g.fillRect(20, 160, 216, 4);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}
function podiumTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#c9c2b6';
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#26323a';
  g.fillRect(14, 40, 228, 200);
  g.fillStyle = 'rgba(255,255,255,0.15)';
  g.fillRect(20, 46, 70, 120);
  g.fillStyle = '#1a1f24';
  for (let x = 14; x < 242; x += 57) g.fillRect(x, 40, 4, 200);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
/** Box with UVs in bays (3.6 m) and storeys (3.2 m) so the window grid keeps its real size. */
function gridBox(L, H, D, bay = 3.6, storey = 3.2) {
  const g = new THREE.BoxGeometry(L, H, D);
  const uv = g.getAttribute('uv');
  const faceW = [D, D, L, L, L, L]; // +x, -x, +y, -y, +z, -z
  const faceH = [H, H, D, D, H, H];
  for (let f = 0; f < 6; f++) for (let k = 0; k < 4; k++) {
    const i = f * 4 + k;
    uv.setXY(i, uv.getX(i) * (faceW[f] / bay), uv.getY(i) * (faceH[f] / storey));
  }
  return g;
}

export function createDetectedHomes(scene, data, projectsById, mats) {
  const group = new THREE.Group();
  group.name = 'DetectedHomes';
  scene.add(group);

  // ---- materials ---------------------------------------------------------------------------------
  const M = {};
  for (const st of STYLES) {
    for (const k of ['gfFront', 'gfBack', 'ffFront', 'ffBack']) {
      M[`${k}_${st}`] = new THREE.MeshStandardMaterial({ map: facadeTexture(k, st), roughness: 0.82, metalness: 0.02 });
    }
    M[`wall_${st}`] = new THREE.MeshStandardMaterial({ color: { aston: 0xeae9e5, palma: 0xf1ede4, charm: 0xf5f4f1 }[st], roughness: 0.88 });
    M[`accent_${st}`] = st === 'palma' ? mats.walnutWood : st === 'aston' ? mats.wallAstonTaupe : mats.charmLouver || mats.wallCharmWhite;
  }
  M.roof = new THREE.MeshStandardMaterial({ color: 0xb9b3a8, roughness: 0.96 });
  M.coping = new THREE.MeshStandardMaterial({ color: 0xf4f2ee, roughness: 0.7 });
  applyWallRelief(STYLES.map((st) => M[`wall_${st}`]));
  M.plant = new THREE.MeshStandardMaterial({ color: 0xcfcfcc, roughness: 0.6, metalness: 0.2 });
  M.terrace = mats.floorTerrace || mats.parapetCoping;
  M.glass = mats.balconyGlass;
  M.canopy = new THREE.MeshStandardMaterial({ color: 0xf2f1ed, roughness: 0.85 });

  // ---- template geometries per material key -----------------------------------------------------
  const templates = {};
  for (const st of STYLES) for (const [k, list] of Object.entries(houseParts(st))) templates[k] = templates[k] || merged(list);
  for (const [k, list] of Object.entries(canopyParts())) templates[k] = merged(list);

  // ---- homes -> instances (house: one per material key; canopy where the row has room) -------------
  const homes = [];
  const apartments = [];
  const perKey = new Map(); // 'community|material key' -> [{ matrix, home }] (one set of batches per community)
  const push = (k, m, h) => { const key = `${h.community}|${k}`; if (!perKey.has(key)) perKey.set(key, []); perKey.get(key).push({ m, h }); };
  // one group per community: only the open community is drawn (and checked against the view) at all
  const cgroups = {};
  const cgroup = (cid) => cgroups[cid] || (cgroups[cid] = Object.assign(new THREE.Group(), { name: `DetectedHomes_${cid}` }), group.add(cgroups[cid]), cgroups[cid]);
  const mRow = new THREE.Matrix4(), mU = new THREE.Matrix4(), mS = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  for (const [cid, rows] of Object.entries(data.communities)) {
    for (const r of rows) {
      if (r.kind === 'apartment') { apartments.push({ ...r, community: cid }); continue; }
      const w0 = toWorld(r.lat, r.lng);
      const ls = localScale(r.lat);
      const theta = THREE.MathUtils.degToRad(r.frontBearing);
      q.setFromAxisAngle(up, Math.PI - theta); // plan +z faces the front bearing (as in Nara)
      mRow.compose(new THREE.Vector3(w0.x, 0, w0.z), q, new THREE.Vector3(ls, 1, ls));
      const widths = r.unitWidths && r.unitWidths.length ? r.unitWidths : Array(r.units).fill(r.L / r.units);
      const villa = r.kind === 'villa';
      const hd = Math.min(r.D, villa ? 14 : 12.2);
      const cd = r.D - hd; // carport zone in front of the house
      const st = styleFor(r.project);
      let x0 = -r.L / 2;
      for (let i = 0; i < widths.length; i++) {
        const slot = widths[i];
        const w = villa ? Math.max(6, slot - 1.6) : slot; // villas stand apart
        const x = x0 + slot / 2;
        x0 += slot;
        const hp = new THREE.Vector3(x, 0, 0).applyMatrix4(mRow);
        const home = { community: cid, project: r.project, row: r, index: i, style: st, id: homes.length, wx: hp.x, wz: hp.z, instances: [] };
        homes.push(home);
        // house: back edge at -D/2, front of the house at -D/2 + hd
        mU.makeTranslation(x, 0, -r.D / 2 + hd / 2);
        mS.makeScale((w - 0.02) / W0, 1, hd / HD0);
        const m = mRow.clone().multiply(mU).multiply(mS);
        for (const k of Object.keys(houseParts(st))) push(k, m, home);
        home.kind = r.kind || 'townhouse';
        home.beds = estimateBeds(projectsById.get(r.project), home.kind, i, widths.length, slot);
        home.width = slot;
        home.overlayMatrix = m.clone().multiply(new THREE.Matrix4().compose(new THREE.Vector3(0, 0, 0), new THREE.Quaternion(), new THREE.Vector3(W0 + 0.3, GF + FF + PARAPET + 0.4, HD0 + 0.3)));
        if (cd >= 2.5) {
          mU.makeTranslation(x, 0, -r.D / 2 + hd);
          mS.makeScale((w - 0.02) / W0, 1, Math.min(cd, 6.5));
          push('canopy', mRow.clone().multiply(mU).multiply(mS), home);
        }
      }
    }
  }

  const batches = [];
  for (const [key, list] of perKey) {
    const [cid, k] = key.split('|');
    const geo = templates[k];
    const b = new THREE.BatchedMesh(list.length, geo.attributes.position.count, geo.index ? geo.index.count : 0, M[k]);
    b.castShadow = k !== 'glass';
    b.receiveShadow = true;
    b.perObjectFrustumCulled = true;
    b.sortObjects = k === 'glass';
    const gid = b.addGeometry(geo);
    b.userData.homes = [];
    for (const { m, h } of list) {
      const id = b.addInstance(gid);
      b.setMatrixAt(id, m);
      b.userData.homes[id] = h;
      h.instances.push([b, id]);
    }
    b.computeBoundingBox();
    b.computeBoundingSphere();
    b.name = `Detected_${k}`;
    b.userData.community = cid;
    cgroup(cid).add(b);
    batches.push(b);
  }


  // ---- apartment buildings: podium (ground + P) + typical floors, window grid at real scale ---------
  const aptMats = [
    new THREE.MeshStandardMaterial({ map: gridTexture(), roughness: 0.6, metalness: 0.05 }),
    new THREE.MeshStandardMaterial({ map: podiumTexture(), roughness: 0.5, metalness: 0.1 }),
    new THREE.MeshStandardMaterial({ color: 0xb9b3a8, roughness: 0.95 }),
  ];
  const aptGeoBy = {}; // community -> { tower, podium, roof }
  for (const a of apartments) {
    const storeys = PRINTED_MASSING[a.project] ?? REP_STOREYS;
    a.storeys = storeys;
    a.storeysPrinted = a.project in PRINTED_MASSING;
    const podiumH = 4.5 + 4.0;
    const towerH = storeys * 3.2;
    const w0 = toWorld(a.lat, a.lng);
    const m = new THREE.Matrix4().compose(new THREE.Vector3(w0.x, 0, w0.z), new THREE.Quaternion().setFromAxisAngle(up, Math.PI - THREE.MathUtils.degToRad(a.frontBearing)), new THREE.Vector3(1, 1, 1).multiplyScalar(localScale(a.lat)));
    const pod = gridBox(a.L, podiumH, a.D, 6, podiumH);
    pod.translate(0, podiumH / 2, 0);
    const tw = gridBox(a.L - 1.2, towerH, a.D - 1.2);
    tw.translate(0, podiumH + towerH / 2, 0);
    const rf = new THREE.BoxGeometry(a.L - 0.6, 1.2, a.D - 0.6);
    rf.translate(0, podiumH + towerH + 0.6, 0);
    const plant = new THREE.BoxGeometry(Math.min(12, a.L * 0.3), 3, Math.min(8, a.D * 0.4));
    plant.translate(-a.L * 0.15, podiumH + towerH + 1.5, 0);
    const aptGeo = aptGeoBy[a.community] || (aptGeoBy[a.community] = { tower: [], podium: [], roof: [] });
    for (const [k, g] of [['podium', pod], ['tower', tw], ['roof', rf], ['roof', plant]]) {
      g.applyMatrix4(m);
      aptGeo[k].push(clean(g));
    }
    homes.push({ community: a.community, project: a.project, row: a, apartment: true, id: homes.length });
  }
  const aptMeshes = [];
  for (const [cid, aptGeo] of Object.entries(aptGeoBy)) {
    for (const [k, mi] of [['tower', 0], ['podium', 1], ['roof', 2]]) {
      if (!aptGeo[k].length) continue;
      // the tower and podium carry the window grid on their sides; their caps use the roof material
      const g = mergeGeometries(aptGeo[k], false);
      const mesh = new THREE.Mesh(g, aptMats[mi]);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = `DetectedApartments_${k}`;
      mesh.userData.apartments = apartments.filter((a) => a.community === cid);
      cgroup(cid).add(mesh);
      aptMeshes.push(mesh);
    }
  }

  return {
    group,
    homes,
    batches,
    apartments,
    pickables: () => (group.visible ? [...batches.filter((b) => b.parent.visible && (b.name.startsWith('Detected_wall') || b.name.startsWith('Detected_gf') || b.name.startsWith('Detected_ff'))), ...aptMeshes.filter((m) => m.parent.visible)] : []),
    /** one community open: the others are not drawn or culled at all (null = all) */
    setScope(id) { for (const [cid, g] of Object.entries(cgroups)) g.visible = !id || cid === id; },
    homeFromHit: (hit) => {
      if (hit.object.userData.apartments) {
        // nearest apartment building to the hit point
        let best = null, bd = Infinity;
        for (const a of hit.object.userData.apartments) {
          const w = toWorld(a.lat, a.lng);
          const d = Math.hypot(w.x - hit.point.x, w.z - hit.point.z);
          if (d < bd) { bd = d; best = a; }
        }
        return best && { project: best.project, apartment: true, row: best, community: best.community };
      }
      return hit.object.userData.homes?.[hit.batchId];
    },
    stats: { homes: homes.length, apartmentBuildings: apartments.length, batches: batches.length, instances: batches.reduce((s, b) => s + b.instanceCount, 0) },
  };
}

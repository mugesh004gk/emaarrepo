import * as THREE from 'three';
import { toWorld, localScale } from './geo.js';
import { estimateBeds } from './projects-layer.js';
import { tex, texRepeat } from './realism.js';
import { buildShrubs, buildLamps } from './vegetation.js';
import { createPlanExteriorTemplate, buildUnitPlotAndGarden, createCarTemplates, buildAll1231Trees, createPocketParkPlayArea, createFitnessStation, createPicnicPergola } from './nara/community.js';
import { normaliseGeometry } from './culling.js';

/**
 * The Valley at Nara detail: every home detected from the satellite imagery is rebuilt from the
 * reference Nara templates (house + plot: carport, car, driveway pavers, lawn, boundary walls,
 * gate pillar), in rows that start and end with mirrored end units like Nara's terraces; every
 * OpenStreetMap street gets Nara's street kit (asphalt and lane marks, paved footpaths, green
 * verges) and street trees (date palms on the main roads, flame trees and neem on the streets).
 *
 * Performance
 *  - Homes: one THREE.BatchedMesh per material across all homes, each home an instance that is
 *    frustum-culled on its own (camera and sun shadow).
 *  - Level of detail by 160 m cells: within ~500 m of the camera a cell shows the full Nara homes,
 *    trees and street furniture; further out it shows the light homes (js/detected-homes.js). A
 *    50 m hysteresis keeps a cell from flickering at the boundary.
 */
const STYLE_PLANS = {
  aston: { endL: 'A4A', endR: 'A4B', mid: ['A3A', 'A3B'] },
  palma: { endL: 'P4A', endR: 'P4B', mid: ['P3A', 'P3B'] },
  charm: { endL: 'C4A', endR: 'C4B', mid: ['C3A', 'C3B'] },
};
const CELL = 160;
const NEAR_IN = 750;
const NEAR_OUT = 800;

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

export function createValleyDetail(scene, { naraData, mats, rows, streets, massing, projectsById, greens = [], communityId = 'the-valley' }) {
  const group = new THREE.Group();
  group.name = 'ValleyDetail';
  scene.add(group);
  const plans = naraData.plans;
  const cars = createCarTemplates(mats);

  const STEP_BACK_MAX = { 'rivera-at-the-valley-phase-2': 6 }; // metres a map-placed row may move back off a road (default 4)
  // not built yet (bare desert on the satellite): no landscaped grass pad around their rows - the homes keep their
  // own plots (garden, driveway) and the satellite ground shows around them
  const NO_GROUND = new Set(['avelia-at-the-valley', 'ovelle-at-the-valley']);

  // ---- 1. variant templates: house shell + plot, merged per material in the unit frame ------------
  let droppedOverlaps = 0, gardensTrimmed = 0, slid = 0, steppedBack = 0;
  const flagged = []; // homes on official plots that need a look (on a road / touching), never moved
  const variants = []; // { key, plan, pdata, perMat: Map(matKey -> {material, geometry, cast, receive}) }
  const variantIndex = new Map(); // `${planKey}#${k}` -> variant
  for (const sp of Object.values(STYLE_PLANS)) {
    for (const planKey of [sp.endL, sp.endR, ...sp.mid]) {
      const pd = plans[planKey];
      if (!pd) continue;
      const shell = createPlanExteriorTemplate(pd, mats);
      const reps = naraData.units.filter((u) => u.planType === planKey).slice(0, 2);
      if (!reps.length) reps.push({ ...naraData.units.find((u) => plans[u.planType].style === pd.style), planType: planKey });
      reps.forEach((u, k) => for2(u, k));
      function for2(u, k) {
       for (const compact of [false, true]) {
        const root = new THREE.Group();
        root.add(shell.clone());
        root.add(buildUnitPlotAndGarden(u, pd, mats, cars));
        root.updateMatrixWorld(true);
        const perMat = new Map();
        const rearEdge = 6.15 - pd.anchorZ; // house back wall in the unit frame
        const box = new THREE.Box3();
        const built = new THREE.Box3(); // house, garage, carport, pergola - not lawns, paving or thin plot walls
        root.traverse((o) => {
          if (!o.isMesh || o.isInstancedMesh || Array.isArray(o.material)) return;
          if (o.material.transparent && o.material.opacity === 0) return;
          if (compact) {
            // back-to-back rows: drop the rear garden (lawn, beds, terrace, rear walls, gate)
            box.setFromObject(o);
            if ((box.min.z + box.max.z) / 2 < rearEdge - 0.2 || (box.max.z < rearEdge + 0.3 && box.max.y < 2.2)) return;
          }
          box.setFromObject(o);
          const thin = Math.min(box.max.x - box.min.x, box.max.z - box.min.z) < 0.6 && box.max.y < 2.6;
          if (box.max.y > 1.2 && !thin) built.union(box);
          const key = `${o.material.uuid}|${o.castShadow !== false ? 1 : 0}`;
          if (!perMat.has(key)) perMat.set(key, { material: o.material, parts: [], cast: true });
          const g = normaliseGeometry(o.geometry, new Map()).clone();
          g.applyMatrix4(o.matrixWorld);
          perMat.get(key).parts.push(g);
        });
        for (const v of perMat.values()) v.geometry = mergeIndexed(v.parts);
        // the whole home on the ground (plot walls, garden, house, garage, carport, driveway) in the unit frame
        const foot = new THREE.Box3();
        for (const v of perMat.values()) { v.geometry.computeBoundingBox(); foot.union(v.geometry.boundingBox); }
        const variant = { key: `${planKey}#${k}${compact ? 'c' : ''}`, planKey, pdata: pd, perMat, foot, built };
        variants.push(variant);
        variantIndex.set(variant.key, variant);
       }
      }
    }
  }

  // ---- 2. rows -> Nara-style units --------------------------------------------------------------------
  const units = []; // { variant, matrix, project, cell, row }
  const up = new THREE.Vector3(0, 1, 0);
  // back-to-back test: is there another row directly behind this one?
  const rowRects = rows.map((r) => {
    const t = THREE.MathUtils.degToRad(r.frontBearing);
    const c = toWorld(r.lat, r.lng);
    return { c, f: [Math.sin(t), -Math.cos(t)], u: [-Math.cos(t), -Math.sin(t)], L: r.L, D: r.D };
  });
  const grid = new Map();
  rowRects.forEach((q, i) => { const k = cellKey(q.c.x, q.c.z); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
  const inRect = (q, x, z) => {
    const dx = x - q.c.x, dz = z - q.c.z;
    return Math.abs(dx * q.u[0] + dz * q.u[1]) <= q.L / 2 + 0.5 && Math.abs(dx * q.f[0] + dz * q.f[1]) <= q.D / 2 + 0.5;
  };
  const hasRowBehind = (i) => {
    const q = rowRects[i];
    for (const t of [-0.3, 0, 0.3]) {
      const x = q.c.x - q.f[0] * (q.D / 2 + 3.5) + q.u[0] * q.L * t;
      const z = q.c.z - q.f[1] * (q.D / 2 + 3.5) + q.u[1] * q.L * t;
      const [gi, gj] = cellKey(x, z).split(',').map(Number);
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
        for (const j2 of grid.get(`${gi + a},${gj + b}`) || []) if (j2 !== i && inRect(rowRects[j2], x, z)) return true;
      }
    }
    return false;
  };

  rows.forEach((r, ri) => {
    const sp = STYLE_PLANS[styleFor(r.project)];
    const widths = r.unitWidths && r.unitWidths.length ? r.unitWidths : [r.L];
    const villa = r.kind === 'villa';
    const terrace = (n) => (n <= 1 ? [sp.endL] : [sp.endL, ...Array.from({ length: n - 2 }, (_, i) => sp.mid[i % 2]), sp.endR]);
    const seq = villa ? widths.map((_, i) => (i % 2 ? sp.endR : sp.endL)) : terrace(widths.length);
    const theta = THREE.MathUtils.degToRad(r.frontBearing);
    const f = new THREE.Vector3(Math.sin(theta), 0, -Math.cos(theta)); // toward the street
    const rr = new THREE.Vector3(-Math.cos(theta), 0, -Math.sin(theta)); // plan +x along the row
    const c = toWorld(r.lat, r.lng);
    const ls = localScale(r.lat);
    const q = new THREE.Quaternion().setFromAxisAngle(up, Math.PI - theta);
    const compact = !villa && hasRowBehind(ri) ? 'c' : '';
    // townhouses: one stretch factor for the whole row; villas: each villa to its measured width
    const nominal = seq.reduce((s2, k) => s2 + plans[k].plot.w, 0);
    // keep Nara's proportions; a row from an official site plan fits its plots exactly (down to 78 %)
    const rowSx = THREE.MathUtils.clamp(r.L / nominal, r.placement === 'verified-siteplan' ? 0.78 : 0.9, 1.12);
    let x = villa ? -r.L / 2 : -(nominal * rowSx) / 2;
    seq.forEach((planKey, i) => {
      const pd = plans[planKey];
      // villas keep side yards; a narrow villa plot gets a narrower villa (down to 75 %) or none at all
      let sx = rowSx;
      if (villa) {
        const fit = (widths[i] - 2) / pd.plot.w;
        sx = fit >= 0.9 ? Math.min(fit, 1.15) : (widths[i] - 0.6) / pd.plot.w;
        if (sx < 0.75) { x += widths[i]; return; }
      }
      const slot = villa ? widths[i] : pd.plot.w * sx;
      const h = ((Math.round(r.lat * 1e6) * 31 + i * 17) >>> 0) % 2;
      const variant = variantIndex.get(`${planKey}#${h}${compact}`) || variantIndex.get(`${planKey}#0${compact}`);
      // centre the plot in its slot; the house back wall sits on the detected roof's back edge
      const ax = x + (slot - pd.plot.w * sx) / 2 + pd.anchorX * sx;
      const zoff = -r.D / 2 + (pd.anchorZ - 6.15);
      const pos = new THREE.Vector3(c.x, 0, c.z).addScaledVector(rr, ax * ls).addScaledVector(f, zoff * ls);
      const m = new THREE.Matrix4().compose(pos, q, new THREE.Vector3(sx * ls, 1, ls));
      // overlay box over the house (as Nara's pick box): house x-extent, 6.15-17.2 m in plan depth
      const hw = pd.houseX[1] - pd.houseX[0];
      const ov = m.clone().multiply(new THREE.Matrix4().compose(
        new THREE.Vector3(0.5 * (pd.houseX[0] + pd.houseX[1]) - pd.anchorX, 0, 11.675 - pd.anchorZ), new THREE.Quaternion(), new THREE.Vector3(hw + 0.2, 8.2, 11.3)));
      units.push({ variant, matrix: m, pd, fdir: f.clone(), ls, project: r.project, row: r, cell: cellKey(pos.x, pos.z), pos, kind: villa ? 'villa' : 'townhouse',
        beds: r.unitPlans?.[i]?.beds ?? estimateBeds(projectsById?.get(r.project), villa ? 'villa' : 'townhouse', i, seq.length, slot), width: slot,
        unitNo: r.unitPlans?.[i]?.no, unitPlan: r.unitPlans?.[i],
        endUnit: i === 0 || i === seq.length - 1, overlayMatrix: ov });
      x += slot;
    });
  });

  // ---- 2a. no home on a road ----------------------------------------------------------------------------
  // A home's whole plot (house, carport, driveway) must stay off every carriageway: a home that reaches
  // a road is moved back into its own garden (up to 6 m); one that still would is left out.
  let offRoad = 0, droppedOnRoad = 0;
  {
    const segs = [];
    for (const st of streets) {
      if (st.cls === 'path') continue;
      const P = st.pts.map(([lng, lat]) => { const w = toWorld(lat, lng); return [w.x, w.z]; });
      for (let i = 0; i + 1 < P.length; i++) segs.push([P[i][0], P[i][1], P[i + 1][0], P[i + 1][1], (st.width || 7.3) / 2]);
    }
    const sg = new Map();
    for (const q of segs) {
      for (let gx = Math.floor(Math.min(q[0], q[2]) / 50) - 1; gx <= Math.floor(Math.max(q[0], q[2]) / 50) + 1; gx++) {
        for (let gz = Math.floor(Math.min(q[1], q[3]) / 50) - 1; gz <= Math.floor(Math.max(q[1], q[3]) / 50) + 1; gz++) {
          const k = `${gx},${gz}`; if (!sg.has(k)) sg.set(k, []); sg.get(k).push(q);
        }
      }
    }
    const onRoad = (x, z) => {
      for (const q of sg.get(`${Math.floor(x / 50)},${Math.floor(z / 50)}`) || []) {
        const vx = q[2] - q[0], vz = q[3] - q[1], l2 = vx * vx + vz * vz || 1;
        const t = Math.max(0, Math.min(1, ((x - q[0]) * vx + (z - q[1]) * vz) / l2));
        if (Math.hypot(x - q[0] - vx * t, z - q[1] - vz * t) < q[4] - 0.2) return true;
      }
      return false;
    };
    const v = new THREE.Vector3();
    const plotHits = (u, back) => {
      const pd = u.pd, W = pd.plot.w;
      for (const px of [0.3, W * 0.5, W - 0.3]) for (const pz of [6.15, 12, 17.2, 20.5, pd.plot.d - 0.2]) {
        v.set(px - pd.anchorX, 0, pz - pd.anchorZ).applyMatrix4(u.matrix);
        if (onRoad(v.x - u.fdir.x * back, v.z - u.fdir.z * back)) return true;
      }
      return false;
    };
    // a terrace moves back as one (no staggered homes); a home that cannot clear the road is left out
    const byRow = new Map();
    for (const u of units) { if (!byRow.has(u.row)) byRow.set(u.row, []); byRow.get(u.row).push(u); }
    const drop = new Set();
    for (const list of byRow.values()) {
      if (!list.some((u) => plotHits(u, 0))) continue;
      if (list[0].row.placement === 'verified-siteplan') {
        // a row from an official plan keeps its line: it may step back as one (up to 4 m) into its own rear
        // garden, which it then gives up (compact model); a home that still reaches a road is listed for review
        // per-project limit (STEP_BACK_MAX): Rivera's map plots are shallower than the reference villa plot, so its
        // twin villas may step back further into their own rear garden (house and exterior unchanged)
        const maxB = STEP_BACK_MAX[list[0].project] ?? 4;
        let b = 0.5;
        while (b <= maxB && list.some((u) => plotHits(u, b))) b += 0.5;
        if (b > maxB) {
          for (const u of list) if (plotHits(u, 0)) flagged.push({ why: 'road', project: u.project, block: u.row.block, pos: [+u.pos.x.toFixed(1), +u.pos.z.toFixed(1)] });
          continue;
        }
        const shv = new THREE.Matrix4();
        for (const u of list) {
          shv.makeTranslation(-u.fdir.x * b, 0, -u.fdir.z * b);
          u.matrix.premultiply(shv); u.overlayMatrix.premultiply(shv);
          u.pos.addScaledVector(u.fdir, -b); u.cell = cellKey(u.pos.x, u.pos.z);
          if (!u.variant.key.endsWith('c')) u.variant = variantIndex.get(u.variant.key + 'c') || u.variant;
          steppedBack++;
        }
        continue;
      }
      let back = 0.5;
      while (back <= 6 && list.some((u) => plotHits(u, back))) back += 0.5;
      if (back > 6) {
        // the row cannot clear as a whole: keep the homes that are off the road where they stand
        for (const u of list) if (plotHits(u, 0)) drop.add(u);
        continue;
      }
      const sh = new THREE.Matrix4();
      for (const u of list) {
        sh.makeTranslation(-u.fdir.x * back, 0, -u.fdir.z * back);
        u.matrix.premultiply(sh);
        u.overlayMatrix.premultiply(sh);
        u.pos.addScaledVector(u.fdir, -back);
        u.cell = cellKey(u.pos.x, u.pos.z);
        offRoad++;
      }
    }
    for (let k = units.length - 1; k >= 0; k--) if (drop.has(units[k])) { units.splice(k, 1); droppedOnRoad++; }
  }

  // ---- 2b. no two homes in one place -----------------------------------------------------------------------
  // Tested with the model's real extent on the ground, not a nominal house box:
  //  - buildings (house, garage, carport, pergola) of two homes never touch: a home whose buildings would
  //    meet the buildings of a home placed before it slides along its row up to 2 m, then is left out;
  //  - whole plots (walls, gardens, driveway) do not cross: a home whose plot runs into another plot
  //    drops its rear garden (the compact model used for back-to-back rows).
  // Longer rows are placed first. Plots of one terrace share their side walls, so plots are taken
  // 0.3 m inside their walls.
  {
    const v = new THREE.Vector3();
    const rect = (m, b, inset) => {
      const x0 = b.min.x + inset, x1 = b.max.x - inset, z0 = b.min.z + inset, z1 = b.max.z - inset;
      const pts = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]].map(([x, z]) => { v.set(x, 0, z).applyMatrix4(m); return [v.x, v.z]; });
      const cx = (pts[0][0] + pts[2][0]) / 2, cz = (pts[0][1] + pts[2][1]) / 2;
      return { pts, cx, cz, rad: Math.hypot(pts[0][0] - cx, pts[0][1] - cz) };
    };
    // homes on official site-plan plots first (they are never moved), then longer rows first
    const ver = (u) => (u.row.placement === 'verified-siteplan' ? 1 : 0);
    const order = units.map((u, k) => k).sort((a, b) => ver(units[b]) - ver(units[a]) || (units[b].row.units || 1) - (units[a].row.units || 1) || a - b);
    const kept = new Set();
    const gB = new Map(), gP = new Map();
    const g = (x, z) => `${Math.floor(x / 40)},${Math.floor(z / 40)}`;
    const add = (grid, R) => { const k = g(R.cx, R.cz); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(R); };
    // otherRowsOnly: a terrace from an official site plan shares its party walls (2c), so only homes of
    // other rows count as touching it
    const hits = (grid, R, tol, row, otherRowsOnly) => {
      const [gx, gz] = g(R.cx, R.cz).split(',').map(Number);
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
        for (const Q of grid.get(`${gx + a},${gz + b}`) || []) {
          if (otherRowsOnly && Q.row === row) continue;
          if (Math.hypot(R.cx - Q.cx, R.cz - Q.cz) > R.rad + Q.rad) continue;
          // homes of one terrace share a side wall: they may touch, never slide into each other
          if (overlapArea(R.pts, Q.pts) > (Q.row === row ? Math.max(tol, 2.5) : tol)) return true;
        }
      }
      return false;
    };
    const along = new THREE.Vector3();
    const sh = new THREE.Matrix4();
    for (const k of order) {
      const u = units[k];
      // buildings: in place, else slide along the row (0.5 m steps, up to 2 m either way)
      along.set(u.fdir.z, 0, -u.fdir.x);
      let shift = null;
      const fixedPlot = u.row.placement === 'verified-siteplan';
      for (const d of fixedPlot ? [0] : [0, 0.5, -0.5, 1, -1, 1.5, -1.5, 2, -2]) {
        sh.makeTranslation(along.x * d, 0, along.z * d);
        const m = u.matrix.clone().premultiply(sh);
        if (!hits(gB, rect(m, u.variant.built, 0.05), 0.05, u.row, fixedPlot)) { shift = d; break; }
      }
      if (shift === null && fixedPlot) {
        flagged.push({ why: 'touches', project: u.project, block: u.row.block, pos: [+u.pos.x.toFixed(1), +u.pos.z.toFixed(1)] });
        shift = 0; // kept on its plot, listed for review
      }
      if (shift === null) continue;
      if (shift) {
        sh.makeTranslation(along.x * shift, 0, along.z * shift);
        u.matrix.premultiply(sh); u.overlayMatrix.premultiply(sh);
        u.pos.addScaledVector(along, shift); u.cell = cellKey(u.pos.x, u.pos.z);
        slid++;
      }
      // plots: full garden if it fits, else the compact model
      let P = rect(u.matrix, u.variant.foot, 0.3);
      if (hits(gP, P, 0.5, u.row) && !u.variant.key.endsWith('c')) {
        const compact = variantIndex.get(u.variant.key + 'c');
        if (compact) { u.variant = compact; P = rect(u.matrix, compact.foot, 0.3); gardensTrimmed++; }
      }
      kept.add(k);
      const Bq = rect(u.matrix, u.variant.built, 0.05); Bq.row = u.row; P.row = u.row;
      add(gB, Bq);
      add(gP, P);
    }
    const before = units.length;
    for (let k = units.length - 1; k >= 0; k--) if (!kept.has(k)) units.splice(k, 1);
    droppedOverlaps = before - units.length;
  }

  // solid houses for walking / driving (house box of every placed home, on a 40 m grid)
  const solid = new Map();
  for (const u of units) {
    const R = houseRect(u);
    const k = `${Math.floor(R.cx / 40)},${Math.floor(R.cz / 40)}`;
    if (!solid.has(k)) solid.set(k, []);
    solid.get(k).push(R);
  }
  function collide(x, z, r = 0.4) {
    const gx = Math.floor(x / 40), gz = Math.floor(z / 40);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      for (const R of solid.get(`${gx + a},${gz + b}`) || []) {
        if (Math.hypot(x - R.cx, z - R.cz) > R.rad + r) continue;
        if (insideQuad(x, z, R.pts, r)) return true;
      }
    }
    return false;
  }

  // ---- 2c. party walls: each home of a terrace reads as its own home ------------------------------------
  // Between two attached townhouses of one row: a thin wall 0.3 m wide that rises 0.45 m above the roof
  // line and stands 0.15 m proud of the front and back facades, in a slightly warmer tone than the walls.
  {
    const A = new THREE.Vector3(), B = new THREE.Vector3(), C1 = new THREE.Vector3(), C2 = new THREE.Vector3();
    const q = new THREE.Quaternion(), sc = new THREE.Vector3(), tp = new THREE.Vector3();
    for (let k = 0; k + 1 < units.length; k++) {
      const a = units[k], b = units[k + 1];
      if (a.row !== b.row || a.kind !== 'townhouse') continue;
      A.set(0.5, 0, 0).applyMatrix4(a.overlayMatrix);
      B.set(-0.5, 0, 0).applyMatrix4(b.overlayMatrix);
      if (A.distanceTo(B) > 1.2) continue; // not attached
      C1.set(0.5, 0, 0.5).applyMatrix4(a.overlayMatrix);
      C2.set(0.5, 0, -0.5).applyMatrix4(a.overlayMatrix);
      const depth = C1.distanceTo(C2) + 0.3;
      a.matrix.decompose(tp, q, sc);
      a.partyWall = new THREE.Matrix4().compose(A.clone().add(B).multiplyScalar(0.5).setY(0), q, new THREE.Vector3(0.3, 1, depth));
    }
  }

  // ---- 3. homes: one GPU-instanced mesh per (home design, material) -----------------------------------------
  // Only homes in cells near the camera are drawn (see 5.). Instancing draws all of them in one call per
  // design and material; a batch item per home and material meant 9,000-18,000 separate draws per pass
  // (Chrome on Mac issues each batch item as its own draw). Same matrices and shading as before.
  const anchor = new THREE.Vector3();
  units.forEach((u) => anchor.add(u.pos));
  anchor.divideScalar(Math.max(1, units.length)).setY(0).round();
  const toLocal = new THREE.Matrix4().makeTranslation(-anchor.x, 0, -anchor.z);
  const homesGroup = new THREE.Group();
  homesGroup.position.copy(anchor); // instance matrices stay small: no precision loss far from origin
  group.add(homesGroup);
  const slots = new Map(); // `${matKey}|${geometry.uuid}` -> { material, geometry, units: [], byCell: Map(cellKey -> units), mesh }
  for (const u of units) {
    u.localMatrix = u.matrix.clone().premultiply(toLocal);
    u.slots = [];
    for (const [mk, v] of u.variant.perMat) {
      const key = `${mk}|${v.geometry.uuid}`;
      let e = slots.get(key);
      if (!e) slots.set(key, (e = { material: v.material, geometry: v.geometry, units: [], byCell: new Map(), dirty: false }));
      e.units.push(u);
      if (!e.byCell.has(u.cell)) e.byCell.set(u.cell, []);
      e.byCell.get(u.cell).push(u);
      u.slots.push(e);
    }
  }
  // party walls: one more instanced slot, placed with each home's own party-wall matrix
  const partyGeo = new THREE.BoxGeometry(1, 8.35, 1).translate(0, 8.35 / 2, 0);
  const partyMat = new THREE.MeshStandardMaterial({ color: 0xe2ddd3, roughness: 0.9 });
  const partySlot = { material: partyMat, geometry: partyGeo, units: [], byCell: new Map(), party: true };
  for (const u of units) {
    if (!u.partyWall) continue;
    u.partyLocal = u.partyWall.clone().premultiply(toLocal);
    partySlot.units.push(u);
    if (!partySlot.byCell.has(u.cell)) partySlot.byCell.set(u.cell, []);
    partySlot.byCell.get(u.cell).push(u);
    u.slots.push(partySlot);
  }
  if (partySlot.units.length) slots.set('partywall', partySlot);
  const batches = []; // the instanced meshes (kept under this name for callers)
  for (const e of slots.values()) {
    const im = new THREE.InstancedMesh(e.geometry, e.material, e.units.length);
    im.count = 0;
    im.visible = false;
    im.castShadow = true;
    im.receiveShadow = true;
    im.userData.units = []; // instanceId -> unit (for picking)
    e.mesh = im;
    homesGroup.add(im);
    batches.push(im);
  }
  const dirtySlots = new Set();
  function rebuildSlots() {
    for (const e of dirtySlots) {
      const im = e.mesh;
      let n = 0;
      for (const [ck, us] of e.byCell) {
        if (!cells.get(ck)?.near) continue;
        for (const u of us) { im.setMatrixAt(n, e.party ? u.partyLocal : u.localMatrix); im.userData.units[n] = u; n++; }
      }
      im.count = n;
      im.userData.units.length = n;
      im.visible = n > 0;
      im.instanceMatrix.needsUpdate = true;
      if (n) im.computeBoundingSphere();
    }
    dirtySlots.clear();
  }

  // ---- 4. streets: Nara's street kit + street trees, per cell -----------------------------------------
  const cells = new Map(); // key -> { cx, cz, units:[], massing:[], streets: Group, near:false }
  const cellOf = (k, x, z) => {
    if (!cells.has(k)) {
      const [i, j] = k.split(',').map(Number);
      cells.set(k, { key: k, cx: (i + 0.5) * CELL, cz: (j + 0.5) * CELL, units: [], massing: [], extra: null, near: false });
    }
    return cells.get(k);
  };
  for (const u of units) cellOf(u.cell).units.push(u);
  for (const h of massing.homes) {
    if (h.community !== communityId || !h.instances) continue;
    const k = cellKey(h.wx, h.wz);
    cellOf(k).massing.push(h);
  }
  // Clean ground under every neighbourhood: a paved pad around each row (plot + street side), so the
  // satellite photo (old roofs, construction, washed-out patches) does not show between the homes.
  {
    const pads = [];
    for (const r of rows) {
      if (NO_GROUND.has(r.project)) continue;
      const t = THREE.MathUtils.degToRad(r.frontBearing);
      const f = [Math.sin(t), -Math.cos(t)], u = [-Math.cos(t), -Math.sin(t)];
      const c = toWorld(r.lat, r.lng);
      const hl = r.L / 2 + 13, hb = r.D / 2 + 9, hf = r.D / 2 + 17;
      const P = [[-hl, -hb], [hl, -hb], [hl, hf], [-hl, hf]].map(([a2, b2]) => [c.x + u[0] * a2 + f[0] * b2, c.z + u[1] * a2 + f[1] * b2]);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(P.flatMap(([x, z]) => [x, 0.004, z]), 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(P.flatMap(([x, z]) => [x / 6, z / 6]), 2));
      g.setIndex([0, 2, 1, 0, 3, 2]);
      pads.push(g);
    }
    if (pads.length) {
      // landscaped grass between the homes (not bare paving): a green, lived-in neighbourhood
      const padMat = new THREE.MeshStandardMaterial({ map: texRepeat('leafy_grass_diffuse.jpg', 0.7, 0.7), color: 0x8fbf6e, roughness: 0.95, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 });
      const pad = new THREE.Mesh(mergeIndexed(pads), padMat);
      pad.receiveShadow = true;
      pad.name = 'NeighbourhoodPad';
      group.add(pad);
    }
  }
  const streetMeshes = buildStreets(streets, mats);
  for (const m of streetMeshes) group.add(m);

  // street trees and low planting, grouped by cell so they only exist near the camera
  const treesByCell = new Map();
  const plantsByCell = new Map();
  const lampsByCell = new Map();
  for (const s of streets) {
    if (s.cls !== 'minor' && s.cls !== 'tertiary') continue;
    const pts = s.pts.map(([lng, lat]) => toWorld(lat, lng));
    let acc = 7;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 1) continue;
      const dx = (b.x - a.x) / len, dz = (b.z - a.z) / len, nx = -dz, nz = dx;
      while (acc < len) {
        for (const side of [1, -1]) {
          const off = s.width / 2 + 1.25;
          const wx = a.x + dx * acc + nx * off * side, wz = a.z + dz * acc + nz * off * side;
          const n = treesByCell.size + acc;
          const mix = ['flameTree', 'neem', 'ghaf', 'flameTree', 'olive', 'frangipani'];
          const species = s.cls === 'tertiary' ? (Math.floor(acc / 11) % 4 === 3 ? 'washingtonia' : 'datePalm') : mix[(Math.floor(acc / 14) + (side > 0 ? 0 : 3)) % mix.length];
          const k = cellKey(wx, wz);
          if (!treesByCell.has(k)) treesByCell.set(k, []);
          treesByCell.get(k).push({ wx, wz, species, radius: species === 'datePalm' || species === 'washingtonia' ? 2.6 : 2.2, setting: 'street' });
          // low planting between the trees on the verge: shrubs, flowering bougainvillea, grasses
          for (let q = 1; q <= 3; q++) {
            const t2 = acc + (q * (s.cls === 'tertiary' ? 11 : 14)) / 4;
            if (t2 >= len) break;
            const px = a.x + dx * t2 + nx * off * side, pz = a.z + dz * t2 + nz * off * side;
            const kk = cellKey(px, pz);
            if (!plantsByCell.has(kk)) plantsByCell.set(kk, []);
            plantsByCell.get(kk).push({ x: px, z: pz, kind: (q + Math.floor(acc)) % 3, rot: acc * 1.7 + q });
          }
        }
        // street lamp every second tree spacing, alternating sides, arm over the road
        if (Math.floor(acc / (s.cls === 'tertiary' ? 11 : 14)) % 2 === 0) {
          const side = Math.floor(acc / 28) % 2 ? 1 : -1, off = s.width / 2 + 0.7, t3 = Math.min(len, acc + 5);
          const lx = a.x + dx * t3 + nx * off * side, lz = a.z + dz * t3 + nz * off * side;
          const lk = cellKey(lx, lz);
          if (!lampsByCell.has(lk)) lampsByCell.set(lk, []);
          lampsByCell.get(lk).push({ x: lx, z: lz, yaw: Math.atan2(nz * side, -nx * side) });
        }
        acc += s.cls === 'tertiary' ? 11 : 14;
      }
      acc -= len;
    }
  }
  // ---- parks and green spaces: lawn surface (always), planting and park furniture (near the camera) ----
  const lawnGeos = [];
  const furnitureByCell = new Map();
  greens.forEach((g, gi) => {
    const ring = g.ring.map(([lng, lat]) => { const w = toWorld(lat, lng); return [w.x, w.z]; });
    if (ring.length < 3) return;
    const shape = new THREE.Shape(ring.map(([x, z]) => new THREE.Vector2(x, -z)));
    const lg = new THREE.ShapeGeometry(shape);
    lg.rotateX(-Math.PI / 2);
    lg.translate(0, 0.012, 0); // under the streets (0.019-0.032), so a road always crosses a lawn
    // texture coordinates in metres (lawn texture repeats every 4 m)
    const pa = lg.attributes.position, uv = lg.attributes.uv;
    for (let i = 0; i < pa.count; i++) uv.setXY(i, pa.getX(i) / 4, pa.getZ(i) / 4);
    lawnGeos.push(lg);
    if (g.kind === 'base') return; // landscaped base under a planned project: lawn only (street trees line its roads)
    // planting: trees on a jittered grid inside, shrubs and palms along the edge
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of ring) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
    const inside = (x, z) => pointIn(x, z, ring) && edgeDist(x, z, ring) > 1.8;
    const step = g.kind === 'golf' ? 34 : g.kind === 'park' ? 10 : 12;
    let seed = (gi * 7919) >>> 0;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const parkSpecies = ['flameTree', 'neem', 'olive', 'frangipani', 'ghaf'];
    for (let x = minX + step / 2; x < maxX; x += step) for (let z = minZ + step / 2; z < maxZ; z += step) {
      const tx = x + (rnd() - 0.5) * step * 0.6, tz = z + (rnd() - 0.5) * step * 0.6;
      if (!inside(tx, tz)) continue;
      if (g.kind === 'golf' && edgeDist(tx, tz, ring) > 18) continue; // fairways stay open
      const sp = parkSpecies[Math.floor(rnd() * parkSpecies.length)];
      pushTree(tx, tz, sp, sp === 'olive' ? 1.8 : 2.4, 'park');
    }
    // palms along the edge of parks (as in Emaar's renders), shrubs on lawn strips
    let acc = 0;
    for (let i = 0; i < ring.length; i++) {
      const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
      const len = Math.hypot(bx - ax, bz - az);
      while (acc < len) {
        const t = acc / len;
        const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
        // step 1.5 m inwards
        const nx = -(bz - az) / len, nz = (bx - ax) / len;
        const ix = pointIn(x + nx * 1.5, z + nz * 1.5, ring) ? x + nx * 1.5 : x - nx * 1.5;
        const iz = pointIn(x + nx * 1.5, z + nz * 1.5, ring) ? z + nz * 1.5 : z - nz * 1.5;
        if (g.kind === 'park' || g.kind === 'golf') pushTree(ix, iz, rnd() < 0.8 ? 'datePalm' : 'washingtonia', 2.6, 'park');
        else pushTree(ix, iz, 'olive', 1.4, 'sikka');
        acc += g.kind === 'park' ? 13 : g.kind === 'golf' ? 22 : 9;
      }
      acc -= len;
    }
    // park furniture in larger parks: play area, picnic pergola, fitness station (Nara's own models)
    if (g.kind === 'park' && g.areaM2 >= 1200) {
      const cx = ring.reduce((s2, p) => s2 + p[0], 0) / ring.length, cz = ring.reduce((s2, p) => s2 + p[1], 0) / ring.length;
      if (inside(cx, cz)) {
        const which = gi % 3;
        const k = cellKey(cx, cz);
        if (!furnitureByCell.has(k)) furnitureByCell.set(k, []);
        furnitureByCell.get(k).push({ x: cx, z: cz, which, yaw: rnd() * Math.PI * 2 });
      }
    }
  });
  function pushTree(wx, wz, species, radius, setting) {
    const k = cellKey(wx, wz);
    if (!treesByCell.has(k)) treesByCell.set(k, []);
    treesByCell.get(k).push({ wx, wz, species, radius, setting });
  }
  if (lawnGeos.length) {
    // Nara's lawn texture, toned to the irrigated grass in the imagery (less saturated, slightly darker)
    const base = mats.lawnGrass || mats.parkGrass;
    const lawnMat = base.clone();
    // photo-scanned grass (UVs are metres / 4), toned to Dubai's irrigated lawns
    lawnMat.map = texRepeat('leafy_grass_diffuse.jpg', 0.5, 0.5);
    lawnMat.normalMap = texRepeat('leafy_grass_nor_gl.jpg', 0.5, 0.5, false);
    lawnMat.normalScale = new THREE.Vector2(0.5, 0.5);
    lawnMat.color = new THREE.Color(0x9ccf7e);
    lawnMat.roughness = 0.95;
    lawnMat.polygonOffset = false; // stacked by height: roads (0.02-0.16 m) always draw over lawns (0.012 m)
    const lawn = new THREE.Mesh(mergeIndexed(lawnGeos.map((g) => (g.index ? g : g))), lawnMat);
    lawn.receiveShadow = true;
    lawn.name = 'Greens_lawn';
    group.add(lawn);
  }
  for (const [k, list] of furnitureByCell) cellOf(k).furniture = list;
  for (const [k, list] of plantsByCell) cellOf(k).plants = list;
  for (const [k, list] of lampsByCell) cellOf(k).lamps = list;

  // drop trees that would stand inside a home
  const homeBoxes = units.map((u) => ({ x: u.pos.x, z: u.pos.z }));
  for (const [k, list] of treesByCell) {
    const kept = list.filter((t) => !homeBoxes.some((h) => (h.x - t.wx) ** 2 + (h.z - t.wz) ** 2 < 64));
    if (!kept.length) continue;
    const cell = cellOf(k);
    cell.treeList = kept;
  }

  // ---- 5. level of detail by cell -------------------------------------------------------------------------
  const lastCam = new THREE.Vector3(1e9, 0, 0);
  let nearCount = 0;
  function setNear(cell, near) {
    if (cell.near === near) return;
    cell.near = near;
    for (const u of cell.units) for (const e of u.slots) dirtySlots.add(e);
    for (const h of cell.massing) for (const [bm, id] of h.instances) bm.setVisibleAt(id, !near);
    if (cell.treeList || cell.furniture || cell.plants || cell.lamps) {
      if (near && !cell.extra) {
        cell.extra = cell.treeList ? buildAll1231Trees(cell.treeList, mats, 0.45) : new THREE.Group();
        if (cell.plants) cell.extra.add(buildShrubs(cell.plants, 0.8));
        if (cell.lamps) cell.extra.add(buildLamps(cell.lamps));
        for (const f of cell.furniture || []) {
          const m = [createPocketParkPlayArea, createPicnicPergola, createFitnessStation][f.which](mats);
          m.position.set(f.x, 0, f.z);
          m.rotation.y = f.yaw;
          cell.extra.add(m);
        }
        cell.extra.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
        group.add(cell.extra);
      }
      if (cell.extra) cell.extra.visible = near;
    }
    nearCount += near ? 1 : -1;
  }
  function update(camera) {
    if (camera.position.distanceToSquared(lastCam) < 400) return false;
    lastCam.copy(camera.position);
    let changed = false;
    for (const cell of cells.values()) {
      const d = Math.hypot(cell.cx - camera.position.x, cell.cz - camera.position.z, camera.position.y);
      const want = cell.near ? d < NEAR_OUT : d < NEAR_IN;
      if (want !== cell.near) { setNear(cell, want); changed = true; }
    }
    if (dirtySlots.size) rebuildSlots();
    return changed;
  }

  return {
    group,
    batches,
    units,
    update,
    pickables: () => batches.filter((b) => b.visible),
    collide,
    unitFromHit: (hit) => hit.object.userData.units?.[hit.instanceId ?? hit.batchId],
    communityId,
    get stats() { return { community: communityId, units: units.length, droppedOverlaps, gardensTrimmed, slid, steppedBack, verified: units.filter((u) => u.row.placement === 'verified-siteplan').length, flagged, offRoad, droppedOnRoad, variants: variants.length, batches: batches.length, cells: cells.size, nearCells: nearCount, streets: streets.length }; },
  };
}

// ---- low planting: rounded shrubs (3 greens), flowering bougainvillea, ornamental grass clumps ----
let PLANT_KIT = null;
function plantKit() {
  if (PLANT_KIT) return PLANT_KIT;
  const shrub = new THREE.IcosahedronGeometry(0.55, 1);
  shrub.scale(1.25, 0.75, 1.1);
  shrub.translate(0, 0.38, 0);
  const pos = shrub.attributes.position; // lumpy leaf mass
  for (let i = 0; i < pos.count; i++) {
    const k = 1 + 0.12 * Math.sin(pos.getX(i) * 9.1 + pos.getZ(i) * 7.3) * Math.cos(pos.getY(i) * 11.7);
    pos.setXYZ(i, pos.getX(i) * k, pos.getY(i) * k, pos.getZ(i) * k);
  }
  shrub.computeVertexNormals();
  const grass = new THREE.ConeGeometry(0.06, 0.7, 4);
  const blades = [];
  for (let b = 0; b < 9; b++) {
    const g2 = grass.clone();
    g2.rotateZ((Math.sin(b * 2.3) * 0.5));
    g2.rotateY(b * 0.7);
    g2.translate(Math.cos(b * 2.1) * 0.12, 0.3, Math.sin(b * 2.1) * 0.12);
    blades.push(g2);
  }
  const grassClump = mergeIndexed(blades.map((g2) => { const n = g2.toNonIndexed(); n.setIndex([...Array(n.attributes.position.count).keys()]); return n; }));
  const lambert = (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9, flatShading: true });
  PLANT_KIT = {
    geos: [shrub, shrub, grassClump],
    mats: [[lambert(0x3f6b2e), lambert(0x557d38), lambert(0x2f5a2a)], [lambert(0xc0267a), lambert(0xd9468f), lambert(0x9c1f63)], [lambert(0x9aa86a), lambert(0xb7b07a), lambert(0x7f9152)]],
  };
  return PLANT_KIT;
}
function buildPlants(list) {
  const kit = plantKit();
  const g = new THREE.Group();
  const dummy = new THREE.Object3D();
  for (let kind = 0; kind < 3; kind++) {
    for (let shade = 0; shade < 3; shade++) {
      const items = list.filter((p, i) => p.kind === kind && i % 3 === shade);
      if (!items.length) continue;
      const im = new THREE.InstancedMesh(kit.geos[kind], kit.mats[kind][shade], items.length);
      items.forEach((p, i) => {
        const sc = 0.7 + ((i * 37) % 10) / 20;
        dummy.position.set(p.x, 0, p.z);
        dummy.rotation.set(0, p.rot, 0);
        dummy.scale.set(sc, sc * (kind === 1 ? 1.25 : 1), sc);
        dummy.updateMatrix();
        im.setMatrixAt(i, dummy.matrix);
      });
      im.castShadow = true;
      im.receiveShadow = true;
      g.add(im);
    }
  }
  return g;
}

function pointIn(x, z, ring) {
  let ins = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) ins = !ins;
  }
  return ins;
}
function edgeDist(x, z, ring) {
  let d = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, az] = ring[j], [bx, bz] = ring[i];
    const vx = bx - ax, vz = bz - az, l2 = vx * vx + vz * vz || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / l2));
    d = Math.min(d, Math.hypot(x - ax - vx * t, z - az - vz * t));
  }
  return d;
}

export function cellKey(x, z) {
  return `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
}

function mergeIndexed(list) {
  let nv = 0, ni = 0;
  for (const g of list) { nv += g.attributes.position.count; ni += g.index.count; }
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), idx = new Uint32Array(ni);
  let ov = 0, oi = 0;
  for (const g of list) {
    pos.set(g.attributes.position.array.length === g.attributes.position.count * 3 ? g.attributes.position.array : Float32Array.from({ length: g.attributes.position.count * 3 }, (_, i) => g.attributes.position.getComponent(Math.floor(i / 3), i % 3)), ov * 3);
    const n = g.attributes.normal;
    for (let i = 0; i < n.count; i++) { nor[(ov + i) * 3] = n.getX(i); nor[(ov + i) * 3 + 1] = n.getY(i); nor[(ov + i) * 3 + 2] = n.getZ(i); }
    const t = g.attributes.uv;
    for (let i = 0; i < t.count; i++) { uv[(ov + i) * 2] = t.getX(i); uv[(ov + i) * 2 + 1] = t.getY(i); }
    const gi = g.index.array;
    for (let i = 0; i < gi.length; i++) idx[oi + i] = gi[i] + ov;
    ov += g.attributes.position.count;
    oi += gi.length;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

// Road surface: dark asphalt with aggregate grain and tyre-worn lanes (canvas texture, metres-scaled)
let ROAD_MATS = null;
function roadMaterials(mats) {
  if (ROAD_MATS) return ROAD_MATS;
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#2a2c30';
  g.fillRect(0, 0, 512, 512);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 60000; i++) {
    const v = 30 + Math.floor(rnd() * 34);
    g.fillStyle = `rgb(${v},${v + 1},${v + 3})`;
    g.fillRect(rnd() * 512, rnd() * 512, 1.6, 1.6);
  }
  // darker wheel tracks along the lane (u = across, v = along)
  for (const x of [0.2, 0.32, 0.68, 0.8]) {
    const gr = g.createLinearGradient((x - 0.05) * 512, 0, (x + 0.05) * 512, 0);
    gr.addColorStop(0, 'rgba(0,0,0,0)');
    gr.addColorStop(0.5, 'rgba(0,0,0,0.18)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.fillRect((x - 0.05) * 512, 0, 0.1 * 512, 512);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  const mk = (o) => new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, ...o });
  ROAD_MATS = {
    asphalt: mk({ map: texRepeat('asphalt_02_diffuse.jpg', 1, 1), normalMap: texRepeat('asphalt_02_nor_gl.jpg', 1, 1, false), normalScale: new THREE.Vector2(0.6, 0.6), color: 0x8a8a8a, roughness: 0.95, metalness: 0.0 }),
    line: mk({ color: 0xf1f1ee, roughness: 0.6, emissive: 0x222222 }),
    kerb: mk({ color: 0xc9c6bf, roughness: 0.8 }),
    footpath: mats.footpathPaver.clone(),
    verge: mats.plantingBed.clone(),
  };
  // Nara's paving/planting materials pull themselves forward in depth (polygon offset); here the
  // layers are stacked by height instead, so the offset is switched off or the paving hides the road
  for (const m of [ROAD_MATS.footpath, ROAD_MATS.verge]) { m.side = THREE.DoubleSide; }
  // draw order by depth offset: streets always win over house-plot paving (which Nara offsets by -1/-2),
  // at any zoom; within a street: footpath < verge < kerb < asphalt < lines
  [['footpath', -3], ['verge', -4], ['kerb', -5], ['asphalt', -6], ['line', -7]].forEach(([k, o]) => {
    ROAD_MATS[k].polygonOffset = true; ROAD_MATS[k].polygonOffsetFactor = o; ROAD_MATS[k].polygonOffsetUnits = o;
  });
  // footpath: interlocking concrete pavers (ribbon UVs: across 0-1, along metres / 5)
  ROAD_MATS.footpath.map = texRepeat('interlocking_concrete_pavers_diffuse.jpg', 2, 2.5);
  ROAD_MATS.footpath.normalMap = texRepeat('interlocking_concrete_pavers_nor_gl.jpg', 2, 2.5, false);
  ROAD_MATS.footpath.color = new THREE.Color(0xd8d4cc);
  ROAD_MATS.verge.map = texRepeat('leafy_grass_diffuse.jpg', 0.6, 1.5);
  ROAD_MATS.verge.color = new THREE.Color(0x9ccf7e);
  return ROAD_MATS;
}

/** Street kit along polylines (world metres): verge, paved footpath, kerb, asphalt, edge and centre lines. */
function buildStreets(streets, mats) {
  const geo = { footpath: [], verge: [], kerb: [], asphalt: [], line: [] };
  for (const s of streets) {
    const pts = s.pts.map(([lng, lat]) => { const w = toWorld(lat, lng); return [w.x, w.z]; });
    if (s.cls === 'path') { geo.footpath.push(ribbon(pts, s.width, 0.03)); continue; }
    geo.footpath.push(ribbon(pts, s.width + 5.2, 0.02));
    geo.verge.push(ribbon(pts, s.width + 2.4, 0.06));
    geo.kerb.push(ribbon(pts, s.width + 0.5, 0.1));
    geo.asphalt.push(ribbon(pts, s.width, 0.13, s.width));
    // white edge lines and a dashed centre line
    if (s.cls !== 'service' && s.source !== 'derived') geo.line.push(dashes(pts, 0.16));
  }
  const out = [];
  const M = roadMaterials(mats);
  for (const [k, list] of Object.entries(geo)) {
    const parts = list.filter(Boolean);
    if (!parts.length) continue;
    const m = new THREE.Mesh(mergeIndexed(parts), M[k]);
    m.receiveShadow = true;
    m.name = `Street_${k}`;
    out.push(m);
  }
  return out;
}

function offsetRibbon(pts, off, width, y) {
  const o = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
    o.push([pts[i][0] - (dz / l) * off, pts[i][1] + (dx / l) * off]);
  }
  return ribbon(o, width, y);
}

function ribbon(pts, width, y, texAcross = 1) {
  if (pts.length < 2) return null;
  const pos = [], uv = [], idx = [];
  const h = width / 2;
  let dist = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (i) dist += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]);
    let tx = 0, tz = 0;
    if (i < pts.length - 1) { const dx = pts[i + 1][0] - p[0], dz = pts[i + 1][1] - p[1], l = Math.hypot(dx, dz) || 1; tx += dx / l; tz += dz / l; }
    if (i > 0) { const dx = p[0] - pts[i - 1][0], dz = p[1] - pts[i - 1][1], l = Math.hypot(dx, dz) || 1; tx += dx / l; tz += dz / l; }
    const tl = Math.hypot(tx, tz) || 1;
    const nx = -tz / tl, nz = tx / tl;
    pos.push(p[0] - nx * h, y, p[1] - nz * h, p[0] + nx * h, y, p[1] + nz * h);
    uv.push(0, dist / (texAcross > 1 ? texAcross : 5), 1, dist / (texAcross > 1 ? texAcross : 5));
    if (i < pts.length - 1) { const b = i * 2; idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); } // Nara's winding
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

function dashes(pts, y) {
  const parts = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 3) continue;
    const dx = (bx - ax) / len, dz = (bz - az) / len;
    for (let d = 1.5; d + 2.2 < len; d += 6) {
      const cx = ax + dx * (d + 1), cz = az + dz * (d + 1);
      parts.push(ribbon([[cx - dx, cz - dz], [cx + dx, cz + dz]], 0.14, y));
    }
  }
  return parts.length ? mergeIndexed(parts) : null;
}

// house footprint of a placed home (its overlay box: house width x 11.3 m plan depth), in world x/z
function houseRect(u) {
  const v = new THREE.Vector3();
  const pts = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].map(([x, z]) => { v.set(x, 0, z).applyMatrix4(u.overlayMatrix); return [v.x, v.z]; });
  const cx = (pts[0][0] + pts[2][0]) / 2, cz = (pts[0][1] + pts[2][1]) / 2;
  return { pts, cx, cz, rad: Math.hypot(pts[0][0] - cx, pts[0][1] - cz), area: Math.abs(signedArea(pts)) };
}
function signedArea(P) {
  let a = 0;
  for (let i = 0; i < P.length; i++) { const [x1, z1] = P[i], [x2, z2] = P[(i + 1) % P.length]; a += x1 * z2 - x2 * z1; }
  return a / 2;
}
// area shared by two convex quads (Sutherland-Hodgman). Works in metres around A's first corner and
// clips with signed distances, so the many exactly collinear edges of homes in one row stay exact.
function overlapArea(A, B) {
  const ox = A[0][0], oz = A[0][1];
  let out = A.map(([x, z]) => [x - ox, z - oz]);
  const b = B.map(([x, z]) => [x - ox, z - oz]);
  const s = Math.sign(signedArea(b)) || 1;
  for (let i = 0; i < b.length && out.length; i++) {
    const p0 = b[i], p1 = b[(i + 1) % b.length];
    const ex = p1[0] - p0[0], ez = p1[1] - p0[1];
    const len = Math.hypot(ex, ez) || 1;
    const dist = (p) => (s * (ex * (p[1] - p0[1]) - ez * (p[0] - p0[0]))) / len; // + inside, metres
    const inp = out;
    out = [];
    for (let j = 0; j < inp.length; j++) {
      const P = inp[j], Q = inp[(j + 1) % inp.length];
      const dp = dist(P), dq = dist(Q);
      const pin = dp >= -1e-6, qin = dq >= -1e-6;
      if (pin) out.push(P);
      if (pin !== qin) { const t = dp / (dp - dq); out.push([P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t]); }
    }
  }
  return out.length > 2 ? Math.abs(signedArea(out)) : 0;
}

// point within r metres of (or inside) a convex quad
function insideQuad(x, z, P, r) {
  let inside = true, dmin = Infinity;
  const s = Math.sign(signedArea(P)) || 1;
  for (let i = 0; i < P.length; i++) {
    const [ax, az] = P[i], [bx, bz] = P[(i + 1) % P.length];
    const ex = bx - ax, ez = bz - az, len = Math.hypot(ex, ez) || 1;
    const d = (s * (ex * (z - az) - ez * (x - ax))) / len; // + inside
    if (d < 0) inside = false;
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (len * len)));
    dmin = Math.min(dmin, Math.hypot(x - ax - ex * t, z - az - ez * t));
  }
  return inside || dmin < r;
}

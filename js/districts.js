import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { toWorld } from './geo.js';

/**
 * Dubai district map drawn on the map surface:
 *  - official community / district boundaries (OpenStreetMap) as thin lines, names as labels;
 *  - each Emaar community's footprint as an accent outline + soft fill. The Valley uses its
 *    OSM boundary; Arabian Ranches III and Emaar South have none in OSM, so their outline is
 *    the rounded hull around Emaar's own project pins (labelled as such in the legend).
 */
export function createDistrictLayer(groundScene, districts, communities, labels) {
  const group = new THREE.Group();
  group.name = 'DistrictMap';
  groundScene.add(group);
  const materials = [];

  // ---- official boundaries -------------------------------------------------
  const pos = [];
  for (const d of districts) {
    if (d.layer !== 'admin' || d.kind === 'sector') continue;
    for (const ring of d.rings) {
      for (let i = 0; i < ring.length - 1; i++) {
        const a = toWorld(ring[i][1], ring[i][0]);
        const b = toWorld(ring[i + 1][1], ring[i + 1][0]);
        pos.push(a.x, 0, a.z, b.x, 0, b.z);
      }
    }
  }
  const lineGeo = new LineSegmentsGeometry().setPositions(pos);
  const lineMat = new LineMaterial({ color: 0xffffff, linewidth: 1.2, transparent: true, opacity: 0.55, depthTest: false, depthWrite: false });
  materials.push(lineMat);
  const districtLabels = [];
  let linesWanted = true, scoped = false;
  const lines = new LineSegments2(lineGeo, lineMat);
  lines.renderOrder = -50;
  lines.frustumCulled = false;
  group.add(lines);

  for (const d of districts) {
    if (d.layer !== 'admin' || d.kind === 'sector' || !d.areaKm2) continue;
    const ring = d.rings.reduce((best, r) => (r.length > best.length ? r : best), d.rings[0]);
    const c = polygonCentroid(ring);
    const w = toWorld(c[1], c[0]);
    districtLabels.push(labels.add({
      x: w.x, z: w.z, className: 'lbl-district',
      html: `<span>${escapeHtml(d.name)}</span>`,
      priority: 10 + Math.min(40, d.areaKm2), minDist: 2500, maxDist: 60000,
    }));
  }

  // ---- Emaar community footprints ---------------------------------------------
  const outlines = {};
  for (const c of communities) {
    let ringWorld;
    let source;
    const osm = districts.find((d) => d.layer === 'districts' && d.name === c.osmName);
    if (osm) {
      ringWorld = osm.rings[0].map(([lng, lat]) => { const w = toWorld(lat, lng); return [w.x, w.z]; });
      source = 'OpenStreetMap boundary';
    } else {
      const pts = c.projects.filter((p) => p.lat && !p.pinFlag).map((p) => { const w = toWorld(p.lat, p.lng); return [w.x, w.z]; });
      ringWorld = roundedHull(pts, 260);
      source = 'Outline around Emaar project pins';
    }
    const shape = new THREE.Shape(ringWorld.map(([x, z]) => new THREE.Vector2(x, -z)));
    const fillGeo = new THREE.ShapeGeometry(shape);
    fillGeo.rotateX(-Math.PI / 2);
    const fill = new THREE.Mesh(fillGeo, new THREE.MeshBasicMaterial({ color: 0x16b8a6, transparent: true, opacity: 0.07, depthTest: false, depthWrite: false }));
    fill.renderOrder = -56;
    group.add(fill);
    const lp = [];
    for (let i = 0; i < ringWorld.length; i++) {
      const a = ringWorld[i], b = ringWorld[(i + 1) % ringWorld.length];
      lp.push(a[0], 0, a[1], b[0], 0, b[1]);
    }
    const om = new LineMaterial({ color: 0x16b8a6, linewidth: 2.6, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false });
    materials.push(om);
    const ol = new LineSegments2(new LineSegmentsGeometry().setPositions(lp), om);
    ol.renderOrder = -49;
    ol.frustumCulled = false;
    group.add(ol);
    outlines[c.id] = { fill, line: ol, source, ring: ringWorld };
  }

  function setResolution(w, h) {
    for (const m of materials) m.resolution.set(w, h);
  }

  function highlight(communityId) {
    for (const [id, o] of Object.entries(outlines)) {
      const on = id === communityId;
      o.fill.material.opacity = on ? 0.1 : 0.05;
      o.line.material.opacity = on ? 1 : 0.7;
      o.line.material.linewidth = on ? 3 : 2;
    }
  }

  return {
    group,
    lines,
    outlines,
    setResolution,
    highlight,
    setVisible(v) { linesWanted = v; lines.visible = v && !scoped; },
    /** inside one community: no Dubai district lines, names or community outlines (the mask edge shows it) */
    setScope(id) {
      scoped = !!id;
      lines.visible = linesWanted && !scoped;
      for (const it of districtLabels) if (it) it.enabled = !scoped;
      for (const o of Object.values(outlines)) { o.fill.visible = !scoped; o.line.visible = !scoped; }
    },
  };
}

function polygonCentroid(ring) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[i + 1];
    const f = x0 * y1 - x1 * y0;
    a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f;
  }
  if (Math.abs(a) < 1e-12) return ring[0];
  return [cx / (3 * a), cy / (3 * a)];
}

function convexHull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (const q of p.reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function roundedHull(points, r) {
  const ring = [];
  for (const [x, z] of points) for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    ring.push([x + Math.cos(a) * r, z + Math.sin(a) * r]);
  }
  return convexHull(ring);
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

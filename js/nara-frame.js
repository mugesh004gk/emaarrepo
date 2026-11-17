import { toWorld } from './geo.js';

/**
 * Re-express the Nara data bundle in the shared Dubai world frame.
 *
 * Nara's own model works in local metres (wx, wz) around its site origin. Every one of the 372
 * homes also carries its surveyed lat/lon, so we fit an affine map local -> world by least
 * squares over all homes and apply it to every coordinate in the bundle (homes, trees,
 * amenities, roads, paths, water). Nara's builders and its walk / inside / cut-away code then
 * run unchanged, and each home sits on its own roof in the satellite imagery.
 */
export function placeNaraInWorld(data) {
  const pts = data.units.filter((u) => Number.isFinite(u.lat) && Number.isFinite(u.lon));
  // normal equations for [x z 1] * [a b c]^T
  const fit = (target) => {
    let sxx = 0, sxz = 0, sx = 0, szz = 0, sz = 0, n = 0, tx = 0, tz = 0, t1 = 0;
    for (const u of pts) {
      const x = u.wx, z = u.wz, t = target(u);
      sxx += x * x; sxz += x * z; sx += x; szz += z * z; sz += z; n += 1;
      tx += x * t; tz += z * t; t1 += t;
    }
    return solve3([[sxx, sxz, sx], [sxz, szz, sz], [sx, sz, n]], [tx, tz, t1]);
  };
  const W = new Map(pts.map((u) => [u, toWorld(u.lat, u.lon)]));
  const [a, b, c] = fit((u) => W.get(u).x);
  const [d, e, f] = fit((u) => W.get(u).z);
  const tf = (x, z) => [a * x + b * z + c, d * x + e * z + f];

  // fit quality (metres): how far each home's transformed position is from its lat/lon
  let maxErr = 0, sumErr = 0;
  for (const u of pts) {
    const [x, z] = tf(u.wx, u.wz);
    const w = W.get(u);
    const err = Math.hypot(x - w.x, z - w.z);
    maxErr = Math.max(maxErr, err);
    sumErr += err;
  }
  const rotationDeg = (Math.atan2(d, a) * 180) / Math.PI;

  const pair = (p) => {
    const [x, z] = tf(p[0], p[1]);
    p[0] = x;
    p[1] = z;
  };
  const ring = (r) => r && r.forEach(pair);
  const walk = (o) => {
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (!o || typeof o !== 'object') return;
    if (Number.isFinite(o.wx) && Number.isFinite(o.wz)) {
      const [x, z] = tf(o.wx, o.wz);
      o.wx = x;
      o.wz = z;
    }
    for (const k of ['outer', 'pts', 'poly']) if (Array.isArray(o[k]) && Array.isArray(o[k][0])) ring(o[k]);
    if (Array.isArray(o.holes)) o.holes.forEach(ring);
  };
  data.units.forEach((u) => {
    const [x, z] = tf(u.wx, u.wz);
    u.wx = x;
    u.wz = z;
    // the fit's rotation is applied to bearings so homes keep facing their true street
    u.frontBearing = (u.frontBearing + rotationDeg + 360) % 360;
    u.gardenBearing = (u.gardenBearing + rotationDeg + 360) % 360;
  });
  Object.values(data.site).forEach(walk);
  clipSiteToNara(data);

  const cx = pts.reduce((s, u) => s + u.wx, 0) / pts.length;
  const cz = pts.reduce((s, u) => s + u.wz, 0) / pts.length;
  data.meta.worldCenter = { x: cx, z: cz };
  data.meta.worldFit = {
    homes: pts.length,
    meanErrorM: +(sumErr / pts.length).toFixed(2),
    maxErrorM: +maxErr.toFixed(2),
    rotationDeg: +rotationDeg.toFixed(3),
    scaleX: +Math.hypot(a, d).toFixed(5),
    scaleZ: +Math.hypot(b, e).toFixed(5),
  };
  return data.meta.worldFit;
}

/**
 * Nara's site plan also traces the road network of the neighbouring Eden cluster across the main
 * avenue (one road polygon whose holes do not cover every Eden block). Drawn here it laid pale gravel
 * and asphalt over Eden's homes and doubled Eden's own streets. Keep Nara's roads, markings, paths
 * and trees to Nara itself: the outline of its 372 homes (+15 m), plus its amenities (community
 * centre, mosque, sikkas, wadi gardens), which are all kept.
 */
function clipSiteToNara(data) {
  const s = data.site;
  const hull = grow(convexHull(data.units.map((u) => [u.wx, u.wz])), 15);
  const am = (s.amenityAreas || []).map((a) => a.outer).filter((r) => r && r.length > 2);
  const nearAmenity = (x, z) => am.some((r) => inRing(x, z, r) || ringDist(x, z, r) < 10);
  const keep = (x, z) => inRing(x, z, hull) || nearAmenity(x, z);
  const before = { roads: s.roadCentrelines?.length, paths: s.paths?.length, trees: s.trees?.length };
  if (s.roadSurfaces) {
    s.roadSurfaces = s.roadSurfaces
      .map((rs) => ({ ...rs, outer: clipConvex(rs.outer, hull), holes: (rs.holes || []).map((h) => clipConvex(h, hull)).filter((h) => h.length > 2) }))
      .filter((rs) => rs.outer.length > 2);
  }
  if (s.roadCentrelines) {
    // the neighbouring cluster's roads from the site plan are kept aside: the app draws them as normal
    // streets of The Valley (data.meta.outsideRoads), without Nara's gravel and road surfaces
    data.meta.outsideRoads = s.roadCentrelines.filter((c) => !c.pts.some(([x, z]) => inRing(x, z, hull)));
    s.roadCentrelines = s.roadCentrelines.filter((c) => c.pts.some(([x, z]) => inRing(x, z, hull)));
  }
  if (s.paths) s.paths = s.paths.filter((p) => p.pts.some(([x, z]) => keep(x, z)));
  if (s.trees) s.trees = s.trees.filter((t) => keep(t.wx, t.wz));
  data.meta.siteClip = { before, after: { roads: s.roadCentrelines?.length, paths: s.paths?.length, trees: s.trees?.length } };
}

function convexHull(points) {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1)); // counter-clockwise in (x, z)
}

function grow(ring, m) {
  // offset a convex counter-clockwise ring outwards by m metres (miter, capped)
  const n = ring.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = ring[(i - 1 + n) % n], p = ring[i], b = ring[(i + 1) % n];
    const n1 = norm([p[1] - a[1], -(p[0] - a[0])]), n2 = norm([b[1] - p[1], -(b[0] - p[0])]);
    const bis = norm([n1[0] + n2[0], n1[1] + n2[1]]);
    const k = m / Math.max(0.35, bis[0] * n1[0] + bis[1] * n1[1]);
    out.push([p[0] + bis[0] * k, p[1] + bis[1] * k]);
  }
  return out;
}
const norm = (v) => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };

function inRing(x, z, r) {
  let ins = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, zi] = r[i], [xj, zj] = r[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) ins = !ins;
  }
  return ins;
}

function ringDist(x, z, r) {
  let d = Infinity;
  for (let i = 0; i < r.length; i++) {
    const [ax, az] = r[i], [bx, bz] = r[(i + 1) % r.length];
    const vx = bx - ax, vz = bz - az, l2 = vx * vx + vz * vz || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / l2));
    d = Math.min(d, Math.hypot(x - ax - vx * t, z - az - vz * t));
  }
  return d;
}

// Sutherland-Hodgman: polygon clipped by a convex ring (either winding)
function clipConvex(poly, clip) {
  let area = 0;
  for (let i = 0; i < clip.length; i++) { const [x1, z1] = clip[i], [x2, z2] = clip[(i + 1) % clip.length]; area += x1 * z2 - x2 * z1; }
  const s = Math.sign(area) || 1;
  const inside = (p, a, b) => s * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) >= 0;
  const cut = (p, q, a, b) => {
    const a1 = b[1] - a[1], b1 = a[0] - b[0], c1 = a1 * a[0] + b1 * a[1];
    const a2 = q[1] - p[1], b2 = p[0] - q[0], c2 = a2 * p[0] + b2 * p[1];
    const det = a1 * b2 - a2 * b1 || 1e-12;
    return [(b2 * c1 - b1 * c2) / det, (a1 * c2 - a2 * c1) / det];
  };
  let out = poly.slice();
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i], b = clip[(i + 1) % clip.length];
    const inp = out;
    out = [];
    for (let j = 0; j < inp.length; j++) {
      const p = inp[j], q = inp[(j + 1) % inp.length];
      const pin = inside(p, a, b), qin = inside(q, a, b);
      if (pin) out.push(p);
      if (pin !== qin) out.push(cut(p, q, a, b));
    }
  }
  return out;
}

function solve3(M, v) {
  const A = M.map((r, i) => [...r, v[i]]);
  for (let i = 0; i < 3; i++) {
    let p = i;
    for (let r = i + 1; r < 3; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    [A[i], A[p]] = [A[p], A[i]];
    for (let r = 0; r < 3; r++) {
      if (r === i) continue;
      const k = A[r][i] / A[i][i];
      for (let c = i; c < 4; c++) A[r][c] -= k * A[i][c];
    }
  }
  return [A[0][3] / A[0][0], A[1][3] / A[1][1], A[2][3] / A[2][2]];
}

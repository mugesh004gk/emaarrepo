// Site data inside each community compound from OpenStreetMap (OpenFreeMap vector tiles, z14):
// streets (with names, for labels), green areas (grass, parks, pitches, playgrounds) and water
// (lakes, ponds, pools). Clipped to data/compounds.json; Nara (surveyed model) is left out.
//   node scripts/build_site.mjs            -> data/site.json
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import fs from 'node:fs';

const T = 'https://tiles.openfreemap.org/planet/20261101_080013_pt';
const z = 14;
const compounds = JSON.parse(fs.readFileSync('data/compounds.json'));
const nara = JSON.parse(fs.readFileSync('data/nara_data.json'));
const KEEP = { minor: 7.3, tertiary: 10.5, secondary: 12, service: 5.6, path: 2.2 };

const inPoly = (pt, poly) => {
  let ins = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
};
const hull = (pts, grow = 1.06) => {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  const h = lo.slice(0, -1).concat(up.slice(0, -1));
  const cx = h.reduce((s, q) => s + q[0], 0) / h.length, cy = h.reduce((s, q) => s + q[1], 0) / h.length;
  return h.map(([x, y]) => [cx + (x - cx) * grow, cy + (y - cy) * grow]);
};
const naraHull = hull(nara.units.map((u) => [u.lon, u.lat]));
const lon2x = (lon) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat) => Math.floor(((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z);
const r7 = (p) => [+p[0].toFixed(7), +p[1].toFixed(7)];

const out = { source: 'OpenStreetMap via OpenFreeMap vector tiles (ODbL); clipped to data/compounds.json', communities: {} };
for (const [cid, rings] of Object.entries(compounds)) {
  if (cid === 'source') continue;
  const inside = (pt) => rings.some((r) => inPoly(pt, r)) && !inPoly(pt, naraHull);
  const all = rings.flat();
  const lons = all.map((q) => q[0]), lats = all.map((q) => q[1]);
  const streets = [], greens = [], water = [];
  const seenPoly = new Set();
  for (let x = lon2x(Math.min(...lons)); x <= lon2x(Math.max(...lons)); x++) {
    for (let y = lat2y(Math.max(...lats)); y <= lat2y(Math.min(...lats)); y++) {
      const vt = new VectorTile(new Pbf(Buffer.from(await (await fetch(`${T}/${z}/${x}/${y}.pbf`)).arrayBuffer())));
      const tr = vt.layers.transportation, names = vt.layers.transportation_name;
      if (tr) for (let i = 0; i < tr.length; i++) {
        const f = tr.feature(i);
        const cls = f.properties.class;
        if (!(cls in KEEP) || f.properties.service === 'parking_aisle' || f.properties.brunnel === 'tunnel') continue;
        const g = f.toGeoJSON(x, y, z).geometry;
        const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
        for (const line of lines) {
          let cur = [];
          for (const pt of line) {
            if (inside(pt)) cur.push(r7(pt));
            else { if (cur.length > 1) streets.push({ cls, width: KEEP[cls], pts: cur }); cur = []; }
          }
          if (cur.length > 1) streets.push({ cls, width: KEEP[cls], pts: cur });
        }
      }
      // street names (separate layer): attach to the nearest street piece later
      if (names) for (let i = 0; i < names.length; i++) {
        const f = names.feature(i);
        const nm = f.properties['name:en'] || f.properties.name_en || f.properties.name;
        if (!nm || !(f.properties.class in KEEP)) continue;
        const g = f.toGeoJSON(x, y, z).geometry;
        const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
        for (const line of lines) {
          const mid = line[Math.floor(line.length / 2)];
          if (inside(mid)) (out._names ||= []).push({ cid, name: nm, at: r7(mid), a: r7(line[0]), b: r7(line[line.length - 1]) });
        }
      }
      for (const [layer, kinds, into] of [['landcover', ['grass', 'wood', 'farmland'], greens], ['park', ['park', 'garden'], greens], ['landuse', ['pitch', 'playground', 'park', 'garden'], greens], ['water', ['lake', 'pond', 'swimming_pool', 'reservoir'], water]]) {
        const L = vt.layers[layer];
        if (!L) continue;
        for (let i = 0; i < L.length; i++) {
          const f = L.feature(i);
          const k = f.properties.class || f.properties.subclass;
          if (!kinds.includes(k)) continue;
          const g = f.toGeoJSON(x, y, z).geometry;
          const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
          for (const poly of polys) {
            const ring = poly[0];
            const c = ring.reduce((s, p) => [s[0] + p[0] / ring.length, s[1] + p[1] / ring.length], [0, 0]);
            if (!inside(c)) continue;
            const key = `${k}:${c[0].toFixed(5)},${c[1].toFixed(5)}`;
            if (seenPoly.has(key)) continue; // polygons repeat across tile edges
            seenPoly.add(key);
            into.push({ kind: k, ring: ring.map(r7) });
          }
        }
      }
    }
  }
  out.communities[cid] = { streets, greens, water, names: (out._names || []).filter((n) => n.cid === cid).map(({ cid: _, ...n }) => n) };
  const km = streets.reduce((s, l) => { let d = 0; for (let i = 1; i < l.pts.length; i++) { const [a, b] = [l.pts[i - 1], l.pts[i]]; d += Math.hypot((b[0] - a[0]) * 101000, (b[1] - a[1]) * 110600); } return s + d; }, 0) / 1000;
  console.log(cid, `${streets.length} street pieces (${km.toFixed(1)} km), ${out.communities[cid].names.length} names, ${greens.length} green areas, ${water.length} water`);
}
delete out._names;
fs.writeFileSync('data/site.json', JSON.stringify(out));

// Streets inside a community from OpenStreetMap (OpenFreeMap vector tiles, z14) -> data/streets.json
//   node scripts/build_streets.mjs the-valley
// Keeps residential classes (minor, service, tertiary, path), clips to the community boundary and
// leaves out Nara, which has its own surveyed street model.
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import fs from 'node:fs';

const cid = process.argv[2] || 'the-valley';
const T = 'https://tiles.openfreemap.org/planet/20261101_080013_pt';
const z = 14;
const districts = JSON.parse(fs.readFileSync('data/districts.json'));
const projects = JSON.parse(fs.readFileSync('data/projects.json'));
const nara = JSON.parse(fs.readFileSync('data/nara_data.json'));
const c = projects.communities.find((x) => x.id === cid);
const osm = c.osmName && districts.find((d) => d.layer === 'districts' && d.name === c.osmName);
const ring = osm ? osm.rings[0] : null;
const inPoly = (pt, poly) => {
  let ins = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
};
// Nara hull (lon/lat) with ~25 m margin
const np = nara.units.map((u) => [u.lon, u.lat]);
const hull = (() => {
  const p = np.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  const h = lo.slice(0, -1).concat(up.slice(0, -1));
  const cx = h.reduce((s, q) => s + q[0], 0) / h.length, cy = h.reduce((s, q) => s + q[1], 0) / h.length;
  return h.map(([x, y]) => [cx + (x - cx) * 1.06, cy + (y - cy) * 1.06]);
})();

const lats = ring ? ring.map((q) => q[1]) : c.projects.map((p) => p.lat);
const lons = ring ? ring.map((q) => q[0]) : c.projects.map((p) => p.lng);
const lon2x = (lon) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat) => Math.floor(((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z);
const KEEP = { minor: 7.3, tertiary: 10.5, service: 5.6, path: 2.2 };
const out = [];
for (let x = lon2x(Math.min(...lons)); x <= lon2x(Math.max(...lons)); x++) {
  for (let y = lat2y(Math.max(...lats)); y <= lat2y(Math.min(...lats)); y++) {
    const vt = new VectorTile(new Pbf(Buffer.from(await (await fetch(`${T}/${z}/${x}/${y}.pbf`)).arrayBuffer())));
    const L = vt.layers.transportation;
    if (!L) continue;
    for (let i = 0; i < L.length; i++) {
      const f = L.feature(i);
      const cls = f.properties.class;
      if (!(cls in KEEP) || f.properties.service === 'parking_aisle' || f.properties.brunnel === 'tunnel') continue;
      const g = f.toGeoJSON(x, y, z).geometry;
      const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
      for (const line of lines) {
        // split where the line leaves the community or enters Nara
        let cur = [];
        for (const pt of line) {
          const ok = (!ring || inPoly(pt, ring)) && !inPoly(pt, hull);
          if (ok) cur.push([+pt[0].toFixed(7), +pt[1].toFixed(7)]);
          else { if (cur.length > 1) out.push({ cls, width: KEEP[cls], pts: cur }); cur = []; }
        }
        if (cur.length > 1) out.push({ cls, width: KEEP[cls], pts: cur });
      }
    }
  }
}
const path = 'data/streets.json';
const data = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path)) : { source: 'OpenStreetMap via OpenFreeMap vector tiles (ODbL)', communities: {} };
data.communities[cid] = out;
fs.writeFileSync(path, JSON.stringify(data));
const km = out.reduce((s, l) => { let d = 0; for (let i = 1; i < l.pts.length; i++) { const [a, b] = [l.pts[i - 1], l.pts[i]]; d += Math.hypot((b[0] - a[0]) * 101000, (b[1] - a[1]) * 110600); } return s + d; }, 0) / 1000;
console.log(cid, out.length, 'street pieces,', km.toFixed(1), 'km', Object.entries(out.reduce((m, l) => ((m[l.cls] = (m[l.cls] || 0) + 1), m), {})));

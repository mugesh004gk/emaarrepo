// validate one project in the real app (needs playwright-core and Chrome):  ROOT=<app dir> node validate_app.mjs <projectId> <outDir> [unitNo ...]
// prints JSON: homes rendered, unit numbers, cross-row building overlaps, road / touch flags, panel text
// of the clicked units; saves top / 45deg / street views and the panel of the first clicked unit.
import { chromium } from 'playwright-core';
import fs from 'node:fs'; import path from 'node:path';
const ROOT = process.env.ROOT; const [PROJ, OUT, ...NOS] = process.argv.slice(2);
fs.mkdirSync(OUT, { recursive: true });
const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf' };
await p.route('http://app.local/**', async (r) => { let f = decodeURIComponent(new globalThis.URL(r.request().url()).pathname); if (f.endsWith('/')) f += 'index.html'; try { await r.fulfill({ body: fs.readFileSync(fs.realpathSync(path.join(ROOT, f))), headers: { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' } }); } catch { await r.fulfill({ status: 404, body: '' }); } });
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
await p.goto('http://app.local/#the-valley');
await p.waitForFunction(() => window.APP_READY, null, { timeout: 150000 });
await p.evaluate(() => window.EMAAR_APP.selectCommunity('the-valley', { noIntro: true }));
await p.waitForTimeout(8000);
const res = await p.evaluate((PROJ) => {
  const A = window.EMAAR_APP, V = A.valleyDetail;
  const st = Array.isArray(V.stats) ? V.stats.find((s) => s.community === 'the-valley') : V.stats;
  const all = V.units;
  const rect = (u, box) => { const e = u.matrix.elements; return [[box.min.x, box.min.z], [box.max.x, box.min.z], [box.max.x, box.max.z], [box.min.x, box.max.z]].map(([x, z]) => [e[0] * x + e[8] * z + e[12], e[2] * x + e[10] * z + e[14]]); };
  const sgn = (P) => { let s = 0; for (let i = 0; i < P.length; i++) { const x = P[i], y = P[(i + 1) % P.length]; s += x[0] * y[1] - y[0] * x[1]; } return s; };
  const area = (P) => Math.abs(sgn(P)) / 2;
  const clip = (S, C) => { let out = S; for (let i = 0; i < C.length; i++) { const a = C[i], b2 = C[(i + 1) % C.length]; const inp = out; out = []; const side = (q) => (b2[0] - a[0]) * (q[1] - a[1]) - (b2[1] - a[1]) * (q[0] - a[0]); for (let j = 0; j < inp.length; j++) { const P1 = inp[j], Q = inp[(j + 1) % inp.length]; const sp = side(P1), sq = side(Q); if (sp >= 0) out.push(P1); if ((sp >= 0) !== (sq >= 0)) { const t = sp / (sp - sq); out.push([P1[0] + (Q[0] - P1[0]) * t, P1[1] + (Q[1] - P1[1]) * t]); } } if (!out.length) break; } return out; };
  const ov = (a, c) => { if (sgn(a) < 0) a = [...a].reverse(); if (sgn(c) < 0) c = [...c].reverse(); return area(clip(a, c)); };
  const mine = all.filter((u) => u.project === PROJ);
  const nums = mine.map((u) => u.unitNo).filter((n) => n != null);
  const cross = [], sameRow = [];
  for (const u of mine) {
    const R = rect(u, u.variant.built);
    for (const w of all) {
      if (w === u || Math.hypot(w.pos.x - u.pos.x, w.pos.z - u.pos.z) > 35) continue;
      const a = ov(R, rect(w, w.variant.built));
      if (w.row !== u.row && a > 0.05) cross.push({ u: u.unitNo, w: w.unitNo ?? null, wProject: w.project, area: +a.toFixed(2) });
      else if (w.row === u.row && a > 2.5) sameRow.push(u.unitNo);
    }
  }
  const flagged = st.flagged.filter((f) => f.project === PROJ);
  const cx = mine.reduce((s, u) => s + u.pos.x, 0) / mine.length, cz = mine.reduce((s, u) => s + u.pos.z, 0) / mine.length;
  const ext = Math.max(...mine.map((u) => Math.hypot(u.pos.x - cx, u.pos.z - cz)));
  return { homes: mine.length, numbered: nums.length, unique: new Set(nums).size, maxNo: Math.max(...nums),
    beds: mine.reduce((m, u) => ((m[u.beds] = (m[u.beds] || 0) + 1), m), {}),
    withPlan: mine.filter((u) => u.unitPlan?.page).length,
    crossRowOverlaps: cross.length, crossSample: cross.slice(0, 8), sameRowPartyWalls: new Set(sameRow).size,
    flaggedRoad: flagged.filter((f) => f.why === 'road').length, flaggedTouch: flagged.filter((f) => f.why === 'touches').length,
    steppedBack: st.steppedBack, centre: [cx, cz], ext };
}, PROJ);
const view = async (name, fn) => { await p.evaluate(fn, res); await p.waitForTimeout(4500); await p.screenshot({ path: path.join(OUT, name) }); };
await p.evaluate(() => { for (const id of ['btn-close-project', 'btn-collapse-projects']) document.getElementById(id)?.click(); });
const setCam = (r, off) => { const A = window.EMAAR_APP; A.state.flyAnim = null; A.controls.enableDamping = false; const [x, z] = r.centre; A.controls.target.set(x + off.tx, 0, z + off.tz); A.camera.position.set(x + off.x, off.y, z + off.z); A.camera.lookAt(x + off.tx, 0, z + off.tz); A.controls.update(); };
await view('top.png', (r) => { const A = window.EMAAR_APP; A.state.flyAnim = null; A.controls.enableDamping = false; const [x, z] = r.centre; A.controls.target.set(x, 0, z); A.camera.position.set(x, r.ext * 2.3 + 60, z + 0.5); A.camera.lookAt(x, 0, z); A.controls.update(); });
await view('aerial45.png', (r) => { const A = window.EMAAR_APP; A.state.flyAnim = null; A.controls.enableDamping = false; const [x, z] = r.centre; const d = r.ext * 1.15 + 40; A.controls.target.set(x, 0, z); A.camera.position.set(x + d * 0.6, d, z + d * 0.8); A.camera.lookAt(x, 0, z); A.controls.update(); });
await view('street.png', (r) => { const A = window.EMAAR_APP; A.state.flyAnim = null; A.controls.enableDamping = false; const [x, z] = r.centre; A.controls.target.set(x, 4, z); A.camera.position.set(x + 45, 9, z + 45); A.camera.lookAt(x, 4, z); A.controls.update(); });
const panels = [];
for (const no of NOS.map(Number)) {
  const ok = await p.evaluate(({ no, PROJ }) => window.EMAAR_APP.app.selectMapUnit?.(PROJ, no), { no, PROJ });
  await p.waitForTimeout(3500);
  const txt = await p.evaluate(() => document.querySelector('#pj-home')?.innerText.replace(/\s+/g, ' ').trim());
  panels.push({ no, selected: ok, panel: txt?.slice(0, 300) });
  if (panels.length === 1) await p.screenshot({ path: path.join(OUT, `unit-${no}.png`) });
}
// a click on the 3D home (not the finder) must select the same unit
let clickCheck = null;
if (NOS.length) {
  const no = Number(NOS[0]);
  const xy = await p.evaluate(({ no, PROJ }) => { const A = window.EMAAR_APP; A.clearHome?.(); const u = A.valleyDetail.units.find((x) => x.project === PROJ && x.unitNo === no); A.state.flyAnim = null; A.controls.enableDamping = false; const t = u.pos; A.controls.target.set(t.x, 0, t.z); A.camera.position.set(t.x + 30, 70, t.z + 30); A.camera.lookAt(t.x, 0, t.z); A.controls.update(); return null; }, { no, PROJ });
  await p.waitForTimeout(3500);
  const sxy = await p.evaluate(({ no, PROJ }) => { const A = window.EMAAR_APP; const u = A.valleyDetail.units.find((x) => x.project === PROJ && x.unitNo === no); const v = u.pos.clone(); v.y = 4; v.project(A.camera); return [(v.x + 1) / 2 * innerWidth, (1 - v.y) / 2 * innerHeight]; }, { no, PROJ });
  await p.mouse.click(sxy[0], sxy[1]);
  await p.waitForTimeout(1500);
  clickCheck = await p.evaluate(() => document.querySelector('#pj-home')?.innerText.replace(/\s+/g, ' ').trim().slice(0, 120));
  await p.screenshot({ path: path.join(OUT, `click-${no}.png`) });
}
console.log(JSON.stringify({ project: PROJ, ...res, panels, clickCheck, pageErrors: errs }, null, 1));
await b.close();

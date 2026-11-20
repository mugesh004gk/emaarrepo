// After a push: open THIS commit's version of the 3D app, capture the property (or community) the commit is about,
// and attach the screenshots to the commit's update on the client progress tracker.
//
//   COMMITS="<sha> <sha>"  TRACKER_UPLOAD_SECRET=...  node .github/tracker/capture.mjs
//
// The app is served from the checked-out files (no deployment needed), so the picture shows exactly what was pushed.
// A commit with no tracker update (e.g. "[skip tracker]") is skipped. Nothing is marked complete here.
import fs from 'node:fs';
import path from 'node:path';

const TRACKER = process.env.TRACKER_URL || 'https://emaar-progress-tracker.vercel.app';
// the upload key: GitHub Actions secret, or on this computer ~/.emaar-tracker/upload-secret
const SECRET = process.env.TRACKER_UPLOAD_SECRET || (() => { try { return fs.readFileSync(path.join(process.env.HOME || '', '.emaar-tracker', 'upload-secret'), 'utf8').trim(); } catch { return ''; } })();
const ROOT = path.resolve(process.env.APP_ROOT || '.');
const COMMITS = (process.env.COMMITS || '').split(/\s+/).filter(Boolean).slice(-5);
const { chromium } = await import(process.env.PW_MODULE || 'playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

if (!SECRET) { console.log('TRACKER_UPLOAD_SECRET is not set: nothing to do'); process.exit(0); }
if (!COMMITS.length) { console.log('no commits'); process.exit(0); }

// 1. the tracker update of each commit (the GitHub webhook creates it within seconds of the push)
async function updateFor(sha) {
  for (let i = 0; i < 24; i++) {
    try {
      const r = await fetch(`${TRACKER}/api/attach`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` }, body: JSON.stringify({ commit: sha.slice(0, 12), lookup: true }) });
      if (r.ok) return await r.json();
    } catch { /* retry */ }
    await sleep(5000);
  }
  return null;
}
const jobs = [];
// test mode: TEST_PROPERTY=<id> DRY_DIR=<dir> captures that property and writes the images to DRY_DIR (no upload)
if (process.env.TEST_PROPERTY) jobs.push({ sha: '0000000', u: { propertyId: process.env.TEST_PROPERTY, community: process.env.TEST_COMMUNITY || 'the-valley', title: 'test' } });
for (const sha of process.env.TEST_PROPERTY ? [] : COMMITS) {
  const u = await updateFor(sha);
  if (!u) { log(sha.slice(0, 7), 'no tracker update (skipped or not posted): nothing to capture'); continue; }
  jobs.push({ sha, u });
  log(sha.slice(0, 7), '->', u.propertyId || u.community, '|', u.title);
}
if (!jobs.length) process.exit(0);

// 2. the app, served from the checkout
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.hdr': 'application/octet-stream', '.glb': 'model/gltf-binary', '.pdf': 'application/pdf' };
const browser = await chromium.launch({
  headless: true,
  channel: process.env.PW_CHANNEL || undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
});
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })).newPage();
page.on('pageerror', (e) => log('page error:', String(e).slice(0, 160)));
await page.route('http://app.local/**', async (r) => {
  let f = decodeURIComponent(new URL(r.request().url()).pathname);
  if (f.endsWith('/')) f += 'index.html';
  const file = path.join(ROOT, f);
  if (!file.startsWith(ROOT)) return r.fulfill({ status: 403, body: '' });
  try { await r.fulfill({ body: fs.readFileSync(fs.realpathSync(file)), headers: { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' } }); }
  catch { await r.fulfill({ status: 404, body: '' }); }
});

// wait for N rendered frames (not wall time: software rendering is slow) and for the map tiles to come in
async function settle(frames = 90) {
  await page.evaluate((n) => new Promise((res) => { let k = 0; const f = () => (++k >= n ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); }), frames);
  await sleep(4000);
}
const shoot = async () => `data:image/jpeg;base64,${(await page.screenshot({ type: 'jpeg', quality: 78 })).toString('base64')}`;
const hidePanels = (hide) => page.evaluate((h) => {
  for (const s of ['#left-panel', '#right-panel', '.panel-left', '.panel-right', '#projects-panel', '#project-panel']) document.querySelectorAll(s).forEach((e) => (e.style.visibility = h ? 'hidden' : ''));
}, hide);

let loadedCommunity = null;
for (const { sha, u } of jobs) {
  const community = u.community || 'the-valley';
  if (loadedCommunity !== community) {
    await page.goto(`http://app.local/#${community}`);
    await page.waitForFunction(() => window.APP_READY, null, { timeout: 300000 });
    await page.evaluate((c) => window.EMAAR_APP.selectCommunity(c, { noIntro: true }), community);
    await sleep(12000);
    loadedCommunity = community;
  }
  const images = [];
  if (u.propertyId) {
    // the property selected (its panel open) without the fly animation: with software rendering the app draws few
    // frames a second and its animations advance per frame, so the camera is set directly on the property's homes
    await page.evaluate((pid) => window.EMAAR_APP.selectProject(pid, { fly: false }), u.propertyId);
    const box = await page.evaluate((pid) => {
      const us = (window.EMAAR_APP.valleyDetail?.units || []).filter((x) => x.project === pid);
      if (!us.length) return null;
      const cx = us.reduce((s, x) => s + x.pos.x, 0) / us.length, cz = us.reduce((s, x) => s + x.pos.z, 0) / us.length;
      const mid = us[Math.floor(us.length / 2)];
      return { cx, cz, ext: Math.max(...us.map((x) => Math.hypot(x.pos.x - cx, x.pos.z - cz))), ux: mid.pos.x, uz: mid.pos.z, fx: mid.fdir.x, fz: mid.fdir.z };
    }, u.propertyId);
    if (box) {
      const views = [
        ['3D app · property view', [box.cx + box.ext * 0.9 + 60, box.ext * 0.8 + 70, box.cz + box.ext * 0.9 + 60], [box.cx, 0, box.cz], true],
      ];
      for (const [caption, pos, tgt, clean] of views) {
        await hidePanels(clean);
        await page.evaluate(({ pos, tgt }) => {
          const A = window.EMAAR_APP; A.state.flyAnim = null; A.controls.enableDamping = false;
          A.controls.target.set(...tgt); A.camera.position.set(...pos); A.camera.lookAt(...tgt); A.controls.update();
        }, { pos, tgt });
        await settle();
        images.push({ dataUrl: await shoot(), caption });
      }
      await hidePanels(false);
    } else {
      // a property without homes in the 3D yet: the app's own view of it after selection
      await page.evaluate((pid) => window.EMAAR_APP.selectProject(pid), u.propertyId);
      await settle(400);
      images.push({ dataUrl: await shoot(), caption: '3D app · property view' });
    }
  } else {
    await page.evaluate((c) => window.EMAAR_APP.selectCommunity(c, { noIntro: true }), community);
    await sleep(12000);
    images.push({ dataUrl: await shoot(), caption: '3D app · community view' });
  }
  if (process.env.DRY_DIR) {
    images.forEach((im, i) => fs.writeFileSync(path.join(process.env.DRY_DIR, `shot-${i + 1}.jpg`), Buffer.from(im.dataUrl.split(',')[1], 'base64')));
    log('dry run: wrote', images.length, 'images to', process.env.DRY_DIR); continue;
  }
  // 3. attach (the update exists already; retry in case of a brief network error)
  for (let i = 0; i < 4; i++) {
    const r = await fetch(`${TRACKER}/api/attach`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` }, body: JSON.stringify({ commit: sha.slice(0, 12), images }) });
    const j = await r.json().catch(() => ({}));
    log(sha.slice(0, 7), 'attach', r.status, JSON.stringify(j));
    if (r.ok || r.status === 401 || r.status === 400) break;
    await sleep(8000);
  }
}
await browser.close();

import * as THREE from 'three';
import { tileBounds, tileAt } from './geo.js';

/**
 * The Dubai map surface: streamed slippy-map tiles laid on the ground plane at their exact
 * projected position (same projection as the homes), refined by screen size around the camera.
 *
 * - Quadtree from z8 to z19 (Esri imagery is real to z19, ~0.3 m/px over the communities).
 * - Only tiles inside the view frustum are refined or fetched (frustum culling for the ground).
 * - A tile that is still loading is covered by its nearest loaded ancestor, and new tiles fade
 *   in over it, so the ground never shows holes or hard pops.
 * - Drawn coarse-to-fine without depth writes (painter's order): no z-fighting between levels.
 * - Imagery is unlit (it already contains real light); sun shadows are added by a ShadowMaterial
 *   catcher on top, so the photo is not darkened twice.
 */
const PROVIDERS = {
  satellite: {
    url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    maxZoom: 19,
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
  },
  map: {
    url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/${z}/${y}/${x}`,
    maxZoom: 19,
    attribution: 'Street map © Esri, HERE, Garmin, OpenStreetMap contributors',
  },
  labels: {
    url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/${z}/${y}/${x}`,
    maxZoom: 19,
    attribution: 'Places © Esri',
  },
};

const ROOT_Z = 8;
const REGION = { latS: 24.35, latN: 25.65, lngW: 54.6, lngE: 56.0 }; // Dubai + horizon
const MAX_INFLIGHT = 10;
const CACHE_MAX = 700;
const FADE_MS = 260;

class TileSet {
  constructor(name, renderer, onChange) {
    this.p = PROVIDERS[name];
    this.name = name;
    this.renderer = renderer;
    this.onChange = onChange;
    this.cache = new Map(); // key -> { tex, state:'loading'|'ready'|'error', readyAt, lastUsed, ctrl }
    this.queue = [];
    this.inflight = 0;
    this.aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    this.frame = 0;
  }

  get(z, x, y) {
    return this.cache.get(`${z}/${x}/${y}`);
  }

  ready(z, x, y) {
    const t = this.get(z, x, y);
    return t && t.state === 'ready';
  }

  request(z, x, y, priority) {
    const key = `${z}/${x}/${y}`;
    let t = this.cache.get(key);
    if (t) {
      t.lastUsed = this.frame;
      if (t.state === 'queued') t.priority = Math.max(t.priority, priority);
      return t;
    }
    t = { key, z, x, y, state: 'queued', priority, lastUsed: this.frame, tex: null, readyAt: 0 };
    this.cache.set(key, t);
    this.queue.push(t);
    return t;
  }

  pump() {
    if (this.inflight >= MAX_INFLIGHT || !this.queue.length) return;
    // drop queued tiles nobody asked for this frame, then fetch the most important first
    this.queue = this.queue.filter((t) => {
      if (t.state !== 'queued') return false;
      if (t.lastUsed < this.frame - 1) { this.cache.delete(t.key); return false; }
      return true;
    });
    this.queue.sort((a, b) => b.priority - a.priority);
    while (this.inflight < MAX_INFLIGHT && this.queue.length) this.load(this.queue.shift());
  }

  async load(t) {
    t.state = 'loading';
    this.inflight++;
    try {
      const res = await fetch(this.p.url(t.z, t.x, t.y), { mode: 'cors' });
      if (!res.ok) throw new Error(res.status);
      const blob = await res.blob();
      // Esri answers z>available with a tiny "no data" tile: treat as missing
      if (this.name !== 'labels' && blob.size < 3000 && t.z >= 18) throw new Error('nodata');
      const bmp = await createImageBitmap(blob, { imageOrientation: 'flipY' });
      const tex = new THREE.Texture(bmp);
      tex.flipY = false;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = this.aniso;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.generateMipmaps = true;
      tex.needsUpdate = true;
      t.tex = tex;
      t.state = 'ready';
      t.readyAt = performance.now();
    } catch {
      t.state = 'error';
    }
    this.inflight--;
    this.onChange();
    this.pump();
  }

  evict(keepFrame) {
    if (this.cache.size <= CACHE_MAX) return;
    const old = [...this.cache.values()]
      .filter((t) => t.lastUsed < keepFrame && (t.state === 'ready' || t.state === 'error') && t.z > ROOT_Z + 1)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const t of old.slice(0, this.cache.size - CACHE_MAX)) {
      if (t.tex) { t.tex.image?.close?.(); t.tex.dispose(); }
      this.cache.delete(t.key);
    }
  }
}

/**
 * @param groundScene rendered first each frame (map tiles + sky), writes no depth
 * @param scene       main scene (gets the shadow catcher)
 */
export function createGround(renderer, groundScene, scene, onChange) {
  const group = new THREE.Group();
  group.name = 'DubaiMapSurface';
  groundScene.add(group);

  const sets = {
    satellite: new TileSet('satellite', renderer, onChange),
    map: new TileSet('map', renderer, onChange),
    labels: new TileSet('labels', renderer, onChange),
  };
  let base = 'satellite';
  let labelsOn = true;

  // root tiles covering the region
  const roots = [];
  {
    const a = tileAt(REGION.latN, REGION.lngW, ROOT_Z);
    const b = tileAt(REGION.latS, REGION.lngE, ROOT_Z);
    for (let x = a.x; x <= b.x; x++) for (let y = a.y; y <= b.y; y++) roots.push([ROOT_Z, x, y]);
  }

  // pooled meshes: one shared unit quad, one material per drawn tile slot
  const quad = new THREE.PlaneGeometry(1, 1);
  quad.rotateX(-Math.PI / 2);
  quad.translate(0.5, 0, 0.5);
  const pool = [];
  let used = 0;
  function slot() {
    let m = pool[used];
    if (!m) {
      // toneMapped: false keeps the photo's real colours (it is not lit by the scene)
      const mat = new THREE.MeshBasicMaterial({ depthWrite: false, depthTest: false, transparent: true, fog: true, toneMapped: false });
      m = new THREE.Mesh(quad, mat);
      m.frustumCulled = false; // culled by the quadtree itself
      m.matrixAutoUpdate = false;
      group.add(m);
      pool.push(m);
    }
    used++;
    m.visible = true;
    return m;
  }

  function place(m, z, x, y, tex, opacity, order) {
    const b = tileBounds(z, x, y);
    m.position.set(b.x0, 0, b.z0);
    m.scale.set(b.x1 - b.x0, 1, b.z1 - b.z0);
    m.updateMatrix();
    m.material.map = tex;
    m.material.opacity = opacity;
    m.material.needsUpdate = m.material.userData.hadMap !== true;
    m.material.userData.hadMap = true;
    m.renderOrder = order;
  }

  // shadow catcher: receives sun shadows only, drawn over the imagery
  const shadowCatcher = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    new THREE.ShadowMaterial({ opacity: 0.32, depthWrite: false, transparent: true })
  );
  shadowCatcher.receiveShadow = true;
  shadowCatcher.renderOrder = -10;
  shadowCatcher.position.y = 0.005;
  shadowCatcher.material.polygonOffset = true;
  shadowCatcher.material.polygonOffsetFactor = 2;
  shadowCatcher.material.polygonOffsetUnits = 2;
  scene.add(shadowCatcher);

  const frustum = new THREE.Frustum();
  const m4 = new THREE.Matrix4();
  const box = new THREE.Box3();
  const tmp = new THREE.Vector3();
  let stats = { drawn: 0, leaves: 0, maxZ: 0 };
  let clip = null; // (x0, x1, z0, z1) => false when that area is covered (js/scope-mask.js): tile not needed
  // z18 tiles whose z19 imagery is an older capture than z18 (scripts/satellite/stale_z19.py): the satellite
  // stops at z18 there, so zooming in never swaps the current photo for the old one (hard-edged bare-sand patches)
  let staleZ19 = new Set();
  fetch('data/stale_z19.json').then((r) => (r.ok ? r.json() : null)).then((d) => { if (d?.z18) { staleZ19 = new Set(d.z18); onChange?.(); } }).catch(() => {});
  let fading = false;

  function update(camera, viewportH, quality = 1) {
    const set = sets[base];
    set.frame++;
    sets.labels.frame++;
    m4.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(m4, camera.coordinateSystem, camera.reversedDepth);
    const k = viewportH / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    const threshold = 300 / quality; // refine while a 256-px tile would cover > ~300 px on screen
    const cam = camera.position;

    const leaves = [];
    const stack = roots.map((r) => r.slice());
    while (stack.length) {
      const [z, x, y] = stack.pop();
      const b = tileBounds(z, x, y);
      box.min.set(Math.min(b.x0, b.x1), -1, Math.min(b.z0, b.z1));
      box.max.set(Math.max(b.x0, b.x1), 40, Math.max(b.z0, b.z1));
      if (!frustum.intersectsBox(box)) continue;
      if (clip && !clip(box.min.x, box.max.x, box.min.z, box.max.z)) continue; // fully under the community mask
      box.clampPoint(cam, tmp);
      const d = Math.max(1, tmp.distanceTo(cam));
      const screen = ((b.x1 - b.x0) * k) / d;
      if (screen > threshold && z < set.p.maxZoom && !(z === 18 && base === 'satellite' && staleZ19.has(`${x}/${y}`))) {
        stack.push([z + 1, 2 * x, 2 * y], [z + 1, 2 * x + 1, 2 * y], [z + 1, 2 * x, 2 * y + 1], [z + 1, 2 * x + 1, 2 * y + 1]);
      } else {
        leaves.push({ z, x, y, screen });
      }
    }

    used = 0;
    fading = false;
    const now = performance.now();
    const drawnAncestors = new Set();
    let maxZ = 0;

    // keep the coarse levels resident (always-available fallback)
    for (const [z, x, y] of roots) set.request(z, x, y, 1e9);

    for (const L of leaves) {
      maxZ = Math.max(maxZ, L.z);
      const t = set.request(L.z, L.x, L.y, L.screen + L.z * 10);
      let opacity = 0;
      if (t.state === 'ready') opacity = Math.min(1, (now - t.readyAt) / FADE_MS);
      if (opacity < 1) {
        // nearest ready ancestor underneath (painter's order keeps it below)
        let z = L.z, x = L.x, y = L.y;
        while (z > ROOT_Z) {
          z--; x >>= 1; y >>= 1;
          const a = set.get(z, x, y);
          if (a && a.state === 'ready') {
            a.lastUsed = set.frame;
            const key = `${z}/${x}/${y}`;
            if (!drawnAncestors.has(key)) {
              drawnAncestors.add(key);
              place(slot(), z, x, y, a.tex, 1, -100 + z);
            }
            break;
          }
        }
        if (t.state === 'error') {
          // beyond the imagery's real depth: let the ancestor stand in permanently
          continue;
        }
      }
      if (opacity > 0) {
        place(slot(), L.z, L.x, L.y, t.tex, opacity, -100 + L.z);
        if (opacity < 1) fading = true;
      }
      // label overlay on the satellite base, one level coarser so text stays legible
      if (base === 'satellite' && labelsOn && L.z >= 11) {
        const lz = Math.min(L.z, sets.labels.p.maxZoom);
        const shift = L.z - lz;
        const lx = L.x >> shift, ly = L.y >> shift;
        const key = `L${lz}/${lx}/${ly}`;
        if (!drawnAncestors.has(key)) {
          drawnAncestors.add(key);
          const lt = sets.labels.request(lz, lx, ly, L.screen);
          if (lt.state === 'ready') {
            const o = Math.min(1, (now - lt.readyAt) / FADE_MS);
            place(slot(), lz, lx, ly, lt.tex, o * 0.95, -60);
            if (o < 1) fading = true;
          }
        }
      }
    }
    for (let i = used; i < pool.length; i++) pool[i].visible = false;

    set.pump();
    sets.labels.pump();
    set.evict(set.frame - 2);
    sets.labels.evict(sets.labels.frame - 2);
    stats = { drawn: used, leaves: leaves.length, maxZ, inflight: set.inflight + sets.labels.inflight };
    return fading || set.inflight > 0;
  }

  /** Keep the shadow catcher under the shadow camera's footprint. */
  function setShadowArea(cx, cz, size) {
    shadowCatcher.position.x = cx;
    shadowCatcher.position.z = cz;
    shadowCatcher.scale.set(size * 2.2, 1, size * 2.2);
  }

  return {
    group,
    update,
    setShadowArea,
    shadowCatcher,
    setBase(name) { base = name; onChange(); },
    get base() { return base; },
    setLabels(v) { labelsOn = v; onChange(); },
    setClip(fn) { clip = fn; onChange(); },
    get labels() { return labelsOn; },
    attribution: () => (base === 'satellite' ? `${PROVIDERS.satellite.attribution}${labelsOn ? ' · Labels ' + PROVIDERS.labels.attribution : ''}` : PROVIDERS.map.attribution),
    get stats() { return stats; },
  };
}

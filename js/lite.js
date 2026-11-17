/**
 * Map version for devices whose browser cannot start 3D graphics (no WebGL: GPU blocklisted, graphics
 * acceleration unavailable, old drivers, remote desktops). Uses no WebGL at all: Leaflet draws the
 * satellite map with plain images, and homes as 2D footprints on a canvas. The explorer, project panels,
 * brochures, floor plans, filters and bedroom colours are the same as in the 3D app.
 */
import { initProjectsUI } from './ui/projects-ui.js';
import { BED_COLORS, bedSwatches, formatAED, projectStatus, estimateBeds } from './projects-layer.js';
import { escapeHtml as esc } from './districts.js';
import { createBlocks3D } from './blocks3d.js';
import { createCommunityPicker, startCommunityRouting } from './ui/community-picker.js';

function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  return new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'vendor/leaflet/leaflet.css';
    document.head.appendChild(css);
    const s = document.createElement('script');
    s.src = 'vendor/leaflet/leaflet.js';
    s.onload = () => resolve(window.L);
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

const getJSON = (u) => fetch(u, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);

export async function startLite(reason) {
  document.body.classList.add('lite-mode');
  const [L, projectsData, floorplans, homes, status, compounds, nara] = await Promise.all([
    loadLeaflet(), getJSON('data/projects.json'), getJSON('data/floorplans.json'), getJSON('data/homes_detected.json'),
    getJSON('data/project_status.json'), getJSON('data/compounds.json'), getJSON('data/nara_data.json'),
  ]);
  const communities = projectsData.communities;
  const byId = new Map(communities.flatMap((c) => c.projects.map((p) => [p.id, p])));
  for (const c of communities) for (const p of c.projects) {
    p.communityId = c.id;
    p.buildStatus = status?.[p.id] || null;
  }
  for (const rows of Object.values(homes?.communities || {})) for (const r of rows) {
    const p = byId.get(r.project);
    if (!p) continue;
    if (r.kind === 'apartment') p.detectedBuildings = (p.detectedBuildings || 0) + 1;
    else p.detectedHomes = (p.detectedHomes || 0) + r.units;
  }

  // ---- map ------------------------------------------------------------------------------------------
  const el = document.createElement('div');
  el.id = 'lite-map';
  document.getElementById('viewport-container').appendChild(el);
  const map = L.map(el, { zoomControl: false, preferCanvas: true, maxZoom: 19, attributionControl: true }).setView([24.95, 55.30], 11);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  const tileLayers = [
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' }).addTo(map),
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, opacity: 0.9 }).addTo(map),
  ];
  // only the open community: the rest of the map is covered and its tiles are not loaded
  let maskLayer = null;
  function setMask(points) {
    maskLayer?.remove();
    maskLayer = null;
    for (const t of tileLayers) { t.options.bounds = null; }
    if (points && points.length > 2) {
      const lat0 = points[0][0], kx = Math.cos((lat0 * Math.PI) / 180);
      const P = [...new Set(points.map(([la, ln]) => `${la.toFixed(4)},${ln.toFixed(4)}`))].map((s2) => s2.split(',').map(Number)).map(([la, ln]) => [ln * kx, la]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
      const lo = [], up = [];
      for (const q of P) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
      for (const q of P.reverse()) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
      const hull = lo.slice(0, -1).concat(up.slice(0, -1));
      const cx = hull.reduce((a, q) => a + q[0], 0) / hull.length, cy = hull.reduce((a, q) => a + q[1], 0) / hull.length;
      const grow = 250 / 111320; // degrees
      const ring = hull.map(([x, y]) => { const d = Math.hypot(x - cx, y - cy) || 1; return [y + ((y - cy) / d) * grow, (x + ((x - cx) / d) * grow) / kx]; });
      maskLayer = L.polygon([[[-85, -180], [-85, 180], [85, 180], [85, -180]], ring], { stroke: false, fillColor: '#e8eae3', fillOpacity: 1, interactive: false }).addTo(map);
      const bb = L.latLngBounds(ring);
      for (const t of tileLayers) t.options.bounds = bb;
    }
    for (const t of tileLayers) t.redraw();
  }

  const outlines = {}; // community id -> its outline polygons (only the open community's are shown)
  for (const [cid, rings] of Object.entries(compounds || {})) {
    if (cid === 'source') continue;
    outlines[cid] = rings.map((ring) => L.polygon(ring.map(([lng, lat]) => [lat, lng]), { color: '#16b8a6', weight: 2.5, fillOpacity: 0.05, interactive: false }));
  }

  // ---- homes as footprints (canvas) ------------------------------------------------------------------
  const footprints = []; // { block, h } — homes drawn as 3D blocks (js/blocks3d.js, no WebGL)
  const WHITE = '#f3f0ea', WALL = '#e4ddd2';
  const KY = 110574;
  const poly = (lat, lng, bearing, L0, D0, ox = 0) => {
    const kx = 111320 * Math.cos((lat * Math.PI) / 180), a = (bearing * Math.PI) / 180;
    const f = [Math.sin(a), Math.cos(a)], u = [f[1], -f[0]];
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([su, sf]) => {
      const x = u[0] * (ox + (su * L0) / 2) + f[0] * ((sf * D0) / 2), y = u[1] * (ox + (su * L0) / 2) + f[1] * ((sf * D0) / 2);
      return [lat + y / KY, lng + x / kx];
    });
  };
  for (const [cid, rows] of Object.entries(homes?.communities || {})) {
    for (const r of rows) {
      const ws = r.unitWidths?.length ? r.unitWidths : Array(r.units || 1).fill(r.L / (r.units || 1));
      let x = -r.L / 2;
      ws.forEach((w, i) => {
        const p = byId.get(r.project);
        const h = { project: r.project, kind: r.kind, apartment: r.kind === 'apartment', beds: r.kind === 'apartment' ? null : estimateBeds(p, r.kind, i, ws.length, w), planned: r.source === 'planned' };
        const apt = r.kind === 'apartment';
        const block = { ring: poly(r.lat, r.lng, r.frontBearing, w - (r.kind === 'villa' ? 2 : 0.25), apt ? r.D : Math.min(r.D, 12.5), x + w / 2),
          height: apt ? 40 : r.kind === 'villa' ? 8.6 : 7.9, color: WHITE, wall: WALL, ref: r.project };
        footprints.push({ block, h });
        x += w;
      });
    }
  }
  for (const u of nara?.units || []) {
    const h = { project: 'nara', kind: 'townhouse', beds: u.bedrooms };
    footprints.push({ block: { ring: poly(u.lat, u.lon, u.frontBearing, (u.plotW || 8) - 0.3, 11.5), height: 7.9, color: WHITE, wall: WALL, ref: 'nara' }, h });
  }
  const blocks3d = createBlocks3D(L, map, footprints.map((f) => f.block), { minZoom: 15, onClick: (pid) => pid && app.selectProject(pid) });
  const syncHomes = () => {};

  // ---- project pins ---------------------------------------------------------------------------------
  const pins = new Map();
  for (const c of communities) for (const p of c.projects) {
    const at = p.buildStatus?.centroid || (p.pinFlag ? null : [p.lat, p.lng]);
    if (!at) continue;
    const st = projectStatus(p);
    const icon = L.divIcon({ className: `lite-pin lbl-pin status-${st}`, iconSize: null, iconAnchor: [0, 0],
      html: `<div class="pin-card"><span class="pin-beds">${bedSwatches(p)}</span><span class="pin-text"><strong>${esc(p.name)}</strong><small>${esc(p.bedsLabel || '')} BR${p.priceFrom ? ' · ' + formatAED(p.priceFrom) : ''}</small></span></div>` });
    const m = L.marker(at, { icon, riseOnHover: true }).addTo(map);
    m.on('click', () => app.selectProject(p.id));
    pins.set(p.id, { m, at, p });
  }

  // ---- explorer (same UI as the 3D app) ---------------------------------------------------------------
  const state = { communityId: null, projectId: null, colorMode: 'realistic', leftOpen: window.innerWidth > 860, rightOpen: false, cameraMode: 'map' };
  const elLeft = document.getElementById('projects-panel'), elRight = document.getElementById('project-panel');
  const panels = () => {
    elLeft.classList.remove('slot-hidden');
    elLeft.classList.toggle('panel-collapsed', !state.leftOpen);
    elRight.classList.toggle('slot-hidden', !state.projectId);
    elRight.classList.toggle('panel-collapsed', !state.rightOpen);
    document.body.classList.toggle('filters-collapsed', !state.leftOpen);
    document.body.classList.toggle('details-collapsed', !state.rightOpen);
    document.getElementById('btn-reopen-filters')?.classList.toggle('hidden', state.leftOpen);
    document.getElementById('btn-reopen-details')?.classList.toggle('hidden', state.rightOpen || !state.projectId);
  };
  const recolour = () => {
    const f = ui.homeFilter();
    const byBeds = state.colorMode === 'bedrooms';
    for (const { block, h } of footprints) {
      const ok = !f || f(h);
      block.color = !ok ? '#475569' : byBeds && h.beds ? BED_COLORS[Math.min(6, h.beds)] : h.planned ? '#eef3e6' : WHITE;
      block.wall = !ok ? '#334155' : byBeds && h.beds ? block.color : WALL;
    }
    blocks3d.redraw();
  };
  const flyToId = (id) => {
    const pin = pins.get(id);
    if (pin) map.flyTo(pin.at, 17, { duration: 1.2 });
  };
  const app = {
    communities, floorplans, notes: projectsData.notes, state,
    projectsLayer: { setFilter: (set) => { for (const [id, { m }] of pins) m.setOpacity(!set || set.has(id) ? 1 : 0.3); }, setSelected() {} },
    invalidate() {},
    selectCommunity(id, opts = {}) {
      if (!id) { showPicker(opts); return; } // "all communities" = the start screen
      picker.hide();
      if (opts.push !== false) routing.go(id);
      state.communityId = id;
      ui.renderCommunityHeader();
      ui.apply();
      // this community only: its pins and outline, and the map fenced to its area
      for (const { m, p } of pins.values()) { if (p.communityId === id) m.addTo(map); else m.remove(); }
      for (const polys of Object.values(outlines)) for (const pl of polys) pl.remove(); // the mask edge shows the area
      setMask([...footprints.filter(({ h }) => byId.get(h.project)?.communityId === id).map(({ block }) => [block.cLat ?? block.ring[0][0], block.cLng ?? block.ring[0][1]]),
        ...[...pins.values()].filter(({ p }) => p.communityId === id).map(({ at }) => at)]);
      // fit to the community's projects (its official outline also takes in open desert)
      const pts = [...pins.values()].filter(({ p }) => p.communityId === id).map(({ at }) => at);
      if (pts.length) {
        const b = L.latLngBounds(pts);
        map.setMaxBounds(null);
        map.setMinZoom(0);
        if (opts.fly !== false) map.flyToBounds(b, { padding: [60, 60], duration: 1.2 });
        map.once('moveend', () => { map.setMinZoom(Math.max(0, map.getBoundsZoom(b) - 1)); map.setMaxBounds(b.pad(0.35)); });
        if (opts.fly === false) map.fire('moveend');
      }
      document.querySelectorAll('.cm-btn').forEach((b) => b.classList.toggle('active', (b.dataset.community === 'all' && !id) || b.dataset.community === id));
    },
    selectProject(id) {
      const p = byId.get(id);
      if (!p) return;
      if (state.communityId !== p.communityId) app.selectCommunity(p.communityId, { fly: false });
      state.projectId = id;
      ui.showProject(id);
      ui.markSelected?.(id);
      state.rightOpen = true;
      if (window.innerWidth <= 860) state.leftOpen = false;
      panels();
      flyToId(id);
    },
    flyToProject: flyToId,
    openNaraHomes: () => flyToId('nara'),
    setCameraMode() { alert('Street view, walk-through and show home need 3D graphics, which this device\'s browser cannot start.'); },
    setColorMode(m) { state.colorMode = m; ui.renderLegend(); recolour(); },
    onFiltersChanged: () => recolour(),
    clearHome() {},
  };
  const ui = initProjectsUI(app);
  app.projectsUI = ui;
  // start screen: one card per community; '#<community id>' in the address bar opens it directly
  const picker = createCommunityPicker(communities, {
    onPick: (id) => app.selectCommunity(id),
    homesIn3D: (c) => c.projects.reduce((n, p) => n + (p.id === 'nara' ? (nara?.units?.length || 0) : p.detectedHomes || 0), 0),
  });
  const routing = startCommunityRouting(communities, { enter: (id, o) => app.selectCommunity(id, o), home: (o) => showPicker(o) });
  function showPicker(opts = {}) {
    state.communityId = null;
    state.projectId = null;
    state.rightOpen = false;
    map.setMaxBounds(null);
    map.setMinZoom(0);
    for (const { m } of pins.values()) m.remove();
    for (const polys of Object.values(outlines)) for (const pl of polys) pl.remove();
    setMask(null);
    ui.renderCommunityHeader();
    ui.apply();
    panels();
    picker.show();
    if (opts.push !== false) routing.go(null);
  }
  app.showPicker = showPicker;
  if (routing.initial) app.selectCommunity(routing.initial, { push: false });
  else showPicker({ push: false });
  syncHomes();

  // top bar community buttons, search, panel toggles
  document.getElementById('community-switch')?.addEventListener('click', (e) => {
    const b = e.target.closest('.cm-btn');
    if (b) app.selectCommunity(b.dataset.community === 'all' ? null : b.dataset.community);
  });
  document.getElementById('unit-search-form')?.addEventListener('submit', (e) => { e.preventDefault(); ui.search(document.getElementById('unit-search-input').value); });
  document.getElementById('btn-reopen-filters')?.addEventListener('click', () => { state.leftOpen = true; panels(); });
  document.getElementById('btn-reopen-details')?.addEventListener('click', () => { state.rightOpen = true; panels(); });
  document.getElementById('btn-collapse-projects')?.addEventListener('click', () => { state.leftOpen = false; panels(); });
  elRight.addEventListener('click', (e) => {
    if (e.target.closest('#btn-close-project, [aria-label="Hide details"], [aria-label="Close"]')) { state.rightOpen = false; panels(); }
  });

  // notice + reveal
  const note = document.createElement('div');
  note.className = 'lite-note';
  note.innerHTML = `<b>Light 3D mode</b> — this device's browser cannot start 3D graphics${reason ? ` (${esc(reason)})` : ''}, so the homes are drawn in a lighter 3D mode. Every project, price, brochure and floor plan works. Zoom in to see the homes in 3D. <button type="button">OK</button>`;
  note.querySelector('button').onclick = () => note.remove();
  document.body.appendChild(note);
  document.getElementById('loading-overlay')?.classList.add('fade-out');
  window.APP_READY = true;
  window.APP_LITE = { map, app, ui };
  setTimeout(() => map.invalidateSize(), 50);
}

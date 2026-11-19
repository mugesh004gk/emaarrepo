import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { toWorld } from './geo.js';
import { escapeHtml as esc } from './districts.js';

/**
 * Boundary review (for checking the Valley properties with the client):
 *  - every built property's boundary drawn on the map with its name, coloured by how it was placed:
 *    cyan = cluster map matched to the built homes on the satellite photo,
 *    amber = project not built yet, placed from the Valley masterplan (provisional);
 *  - a panel listing each property: how its boundary was made, the cluster map it was traced from,
 *    homes placed / numbered against the official count, and the floor-plan PDF its homes link to.
 * The outlines are our working boundaries (placed homes + margin), NOT DDA GIS plot boundaries -
 * the panel says so on every property. Data: data/property_boundaries.json (export_boundaries.py).
 */
const COLORS = { satellite: 0x22d3ee, masterplan: 0xf59e0b };

export function createBoundaryReview({ scene, groundScene, labels, camera, flyTo, currentAzimuth, projectsUI, selectProject, ensureValley, hideLeft, invalidate }) {
  const group = new THREE.Group();
  group.name = 'BoundaryReview';
  group.visible = false;
  groundScene.add(group);
  // outlines on top of everything (homes, lawns, roads), so the whole edge is always visible
  const top = new THREE.Group();
  top.name = 'BoundaryReviewLines';
  top.visible = false;
  scene.add(top);
  const materials = [];
  const items = new Map();
  let data = null, open = false, selected = null;

  const btn = document.getElementById('btn-boundaries');
  const panel = document.createElement('aside');
  panel.id = 'boundary-panel';
  panel.className = 'boundary-panel hidden';
  panel.setAttribute('aria-label', 'Property boundaries');
  document.body.appendChild(panel);

  const ready = fetch('data/property_boundaries.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null).then((d) => {
    data = d;
    if (!d) return;
    for (const p of d.properties) build(p);
    render();
  });

  function build(p) {
    const ring = p.boundary.map(([lng, lat]) => { const w = toWorld(lat, lng); return [w.x, w.z]; });
    const color = COLORS[p.placement.kind] || 0xffffff;
    const shape = new THREE.Shape(ring.map(([x, z]) => new THREE.Vector2(x, -z)));
    const fg = new THREE.ShapeGeometry(shape);
    fg.rotateX(-Math.PI / 2);
    const fill = new THREE.Mesh(fg, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.1, depthTest: false, depthWrite: false }));
    fill.renderOrder = -40;
    const lp = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      lp.push(a[0], 0.2, a[1], b[0], 0.2, b[1]);
    }
    const mat = new LineMaterial({ color, linewidth: 2.6, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false, dashed: p.placement.kind === 'masterplan', dashSize: 6, gapSize: 4 });
    mat.resolution.set(window.innerWidth, window.innerHeight);
    materials.push(mat);
    const line = new LineSegments2(new LineSegmentsGeometry().setPositions(lp), mat);
    if (mat.dashed) line.computeLineDistances();
    line.renderOrder = 990;
    line.frustumCulled = false;
    group.add(fill);
    top.add(line);
    let cx = 0, cz = 0, ext = 0;
    for (const [x, z] of ring) { cx += x; cz += z; }
    cx /= ring.length; cz /= ring.length;
    for (const [x, z] of ring) ext = Math.max(ext, Math.hypot(x - cx, z - cz));
    const u = p.units;
    const label = labels.add({
      x: cx, z: cz, className: `lbl-boundary lbl-boundary-${p.placement.kind}`,
      html: `<span><b>${esc(p.name)}</b><small>${u.numbered} / ${u.official ?? '?'} homes</small></span>`,
      priority: 60, minDist: 0, maxDist: 9000, onClick: () => select(p.id), data: p.id,
    });
    label.enabled = false;
    items.set(p.id, { p, fill, line, mat, label, cx, cz, ext });
  }

  function floorChip(p) {
    const f = p.floorPlan;
    if (!f.document) return '<span class="bp-chip bad">No floor plan</span>';
    if (p.id === 'kaia-at-the-valley') return '<span class="bp-chip bad">Wrong file</span>';
    if (f.linkedUnits >= p.units.placed) return '<span class="bp-chip ok">Floor plan linked</span>';
    return `<span class="bp-chip warn">Plan ${f.linkedUnits}/${p.units.placed}</span>`;
  }

  function details(p) {
    const u = p.units, f = p.floorPlan, c = p.clusterMap;
    const missing = u.official ? u.official - u.numbered : 0;
    return `<div class="bp-detail">
      <dl>
        <dt>Boundary</dt><dd>${esc(p.boundaryMethod)}</dd>
        <dt>DDA boundary</dt><dd class="bp-pending">Not received yet: it will replace this outline</dd>
        <dt>Placed by</dt><dd>${esc(p.placement.text)}</dd>
        <dt>Cluster map</dt><dd>${esc(c.document)}${c.page && !/\.png$/i.test(c.document) ? `, page ${c.page}` : ''}</dd>
        <dt>Homes</dt><dd>${u.numbered} numbered of ${u.official ?? '?'} official${u.placed > u.numbered ? ` (+${u.placed - u.numbered} placed without a number)` : ''}${missing > 0 ? `; <b>${missing} still missing</b>` : ''}</dd>
        <dt>Floor plan</dt><dd>${f.document ? esc(f.document) : '<b>Not received</b>'}${f.document ? ` · ${f.linkedUnits} of ${u.placed} homes linked` : ''}${f.note ? `<br><small>${esc(f.note)}</small>` : ''}</dd>
      </dl>
      <div class="bp-actions">
        ${c.image ? '<button type="button" class="btn btn-secondary" data-act="map"><svg class="icon"><use href="#i-map" /></svg>Cluster map</button>' : ''}
        ${f.url ? '<button type="button" class="btn btn-secondary" data-act="plan"><svg class="icon"><use href="#i-plan" /></svg>Floor plan</button>' : ''}
        <button type="button" class="btn btn-secondary" data-act="homes"><svg class="icon"><use href="#i-house" /></svg>Show homes</button>
      </div>
    </div>`;
  }

  function render() {
    if (!data) { panel.innerHTML = '<div class="bp-head"><h3>Property boundaries</h3></div><p class="bp-note">Loading…</p>'; return; }
    const ps = data.properties;
    const done = ps.filter((p) => p.status === 'complete').length;
    panel.innerHTML = `<div class="bp-head"><div><h3>Property boundaries</h3><small>The Valley · ${ps.length} properties in 3D · ${done} complete</small></div>
        <button type="button" class="btn-icon" data-act="close" aria-label="Close"><svg class="icon"><use href="#i-x" /></svg></button></div>
      <div class="bp-legend">
        <span><i class="bp-sw satellite"></i>Placed on the built homes (satellite)</span>
        <span><i class="bp-sw masterplan"></i>Not built yet: from the masterplan (provisional)</span>
      </div>
      <p class="bp-note">Each outline is our working boundary: the placed homes plus a 20 m margin. <b>DDA GIS boundaries have not been received yet</b>; each one will replace its outline once it arrives.</p>
      <ul class="bp-list">${ps.map((p) => `<li class="bp-item${selected === p.id ? ' open' : ''}" data-id="${esc(p.id)}">
        <button type="button" class="bp-row" data-act="pick">
          <i class="bp-sw ${p.placement.kind}"></i>
          <span class="bp-name">${esc(p.name)}</span>
          <span class="bp-count">${p.units.numbered}/${p.units.official ?? '?'}</span>
          <span class="bp-chip ${p.status === 'complete' ? 'ok' : 'warn'}">${p.status === 'complete' ? 'Complete' : 'Partial'}</span>
          ${floorChip(p)}
        </button>
        ${selected === p.id ? details(p) : ''}
      </li>`).join('')}</ul>`;
    panel.querySelector('.bp-item.open')?.scrollIntoView({ block: 'nearest' });
  }

  panel.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'close') return setOpen(false);
    const id = b.closest('.bp-item')?.dataset.id;
    const it = items.get(id);
    if (!it) return;
    const p = it.p;
    if (act === 'pick') return select(selected === id ? null : id);
    if (act === 'map') return projectsUI.openImages(`${p.name} · cluster map (${p.clusterMap.document})`, [{ src: p.clusterMap.image }]);
    if (act === 'plan') return projectsUI.openPdf(`${p.name} · ${p.floorPlan.document}`, p.floorPlan.url, 1);
    if (act === 'homes') { setOpen(false); selectProject(p.id); }
  });

  function style() {
    for (const [id, it] of items) {
      const on = id === selected, dim = selected && !on;
      it.mat.linewidth = on ? 4.2 : 2.6;
      it.mat.opacity = dim ? 0.55 : 0.95;
      it.fill.material.opacity = on ? 0.2 : dim ? 0.05 : 0.1;
      it.label.el.classList.toggle('selected', on);
    }
    invalidate(300);
  }

  /** all outlines in view, left of the panel */
  function overview() {
    if (!items.size) return;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const it of items.values()) { x0 = Math.min(x0, it.cx - it.ext); x1 = Math.max(x1, it.cx + it.ext); z0 = Math.min(z0, it.cz - it.ext); z1 = Math.max(z1, it.cz + it.ext); }
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const free = 1 - panel.offsetWidth / window.innerWidth;
    const half = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const dist = Math.max((z1 - z0) / 2 / half, (x1 - x0) / 2 / (half * camera.aspect * free)) * 1.3;
    const visW = 2 * dist * half * camera.aspect;
    flyTo({ target: new THREE.Vector3(cx + (panel.offsetWidth / 2 / window.innerWidth) * visW, 0, cz), dist, polar: THREE.MathUtils.degToRad(8), azimuth: 0 });
  }

  function select(id) {
    selected = id;
    render();
    style();
    const it = id && items.get(id);
    if (!it) return overview();
    // close to a top view, the property left of the panel
    const dist = Math.max(300, it.ext * 3.6);
    const polar = THREE.MathUtils.degToRad(22);
    const az = currentAzimuth();
    const visW = 2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect;
    const shift = (panel.offsetWidth / 2 / window.innerWidth) * visW;
    flyTo({ target: new THREE.Vector3(it.cx + Math.cos(az) * shift, 0, it.cz - Math.sin(az) * shift), dist, polar, azimuth: az });
  }

  async function setOpen(v) {
    open = v;
    btn?.classList.toggle('active', v);
    btn?.setAttribute('aria-pressed', String(v));
    panel.classList.toggle('hidden', !v);
    group.visible = v;
    top.visible = v;
    if (v) {
      ensureValley();
      hideLeft?.(); // more map for the review
      await ready;
      render();
      overview();
    }
    for (const it of items.values()) it.label.enabled = v;
    if (!v) { selected = null; style(); }
    invalidate(400);
  }
  btn?.addEventListener('click', () => setOpen(!open));
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open && document.getElementById('media-modal')?.classList.contains('hidden')) setOpen(false); });

  return {
    group,
    setResolution(w, h) { for (const m of materials) m.resolution.set(w, h); },
    setOpen,
    select,
    isOpen: () => open,
    ready,
  };
}

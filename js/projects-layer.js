import * as THREE from 'three';
import { toWorld } from './geo.js';
import { escapeHtml } from './districts.js';

/** One colour per bedroom count, used everywhere (pins, legend, Nara homes, filters). */
export const BED_COLORS = {
  1: '#f59e0b',
  2: '#ec4899',
  3: '#10b981',
  4: '#3b82f6',
  5: '#8b5cf6',
  6: '#ef4444',
};
export const STATUS_COLORS = { available: '#16a34a', new: '#f59e0b', explore: '#64748b' };

export function bedRange(p) {
  const a = p.bedsMin || 0, b = p.bedsMax || 0;
  const out = [];
  for (let n = a; n <= b && n <= 6; n++) out.push(n);
  return out;
}

export function bedSwatches(p) {
  return bedRange(p)
    .map((n) => `<i style="background:${BED_COLORS[n] || '#999'}" title="${n} bedroom"></i>`)
    .join('');
}

export function projectStatus(p) {
  if (p.unitsLeft > 0) return 'available';
  if (p.isNew) return 'new';
  return 'explore';
}

export function formatAED(v, short = true) {
  if (!v) return 'Price on request';
  if (!short) return `AED ${Math.round(v).toLocaleString('en-US')}`;
  return v >= 1e6 ? `AED ${(v / 1e6).toFixed(v >= 1e7 ? 1 : 2).replace(/\.?0+$/, '')}M` : `AED ${Math.round(v / 1000)}K`;
}

/**
 * Project pins: a coloured ground marker in 3D at the exact Emaar pin, and a floating label.
 * Projects that are modelled in 3D (Nara) show their homes instead of a ground marker.
 */
export function createProjectsLayer(scene, communities, labels, onSelect) {
  const group = new THREE.Group();
  group.name = 'ProjectPins';
  scene.add(group);

  const discGeo = new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2);
  const ringGeo = new THREE.RingGeometry(0.8, 1, 64).rotateX(-Math.PI / 2);
  const records = new Map();
  const communityLabels = {}; // community id -> its name label (hidden inside a community)

  for (const c of communities) {
    for (const p of c.projects) {
      p.communityId = c.id;
      if (!Number.isFinite(p.lat) || p.pinFlag) continue; // flagged pins are not drawn (see build_data.py)
      const w = toWorld(p.lat, p.lng);
      p.world = w;
      p.communityId = c.id;
      const rec = { project: p, community: c, world: w };
      if (!p.modelled) {
        const disc = new THREE.Mesh(discGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, depthWrite: false }));
        const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false }));
        for (const m of [disc, ring]) {
          m.position.set(w.x, 0.35, w.z);
          m.scale.setScalar(55);
          m.renderOrder = 2;
          m.userData.projectId = p.id;
          group.add(m);
        }
        rec.disc = disc;
        rec.ring = ring;
      }
      const html = `
        <div class="pin-card">
          <span class="pin-beds">${bedSwatches(p)}</span>
          <span class="pin-text"><strong>${escapeHtml(p.name)}</strong><small>${escapeHtml(p.bedsLabel || '')} BR${p.priceFrom ? ' · ' + formatAED(p.priceFrom) : ''}</small></span>
          ${p.modelled || p.detectedHomes || p.detectedBuildings ? '<span class="pin-3d" title="Homes shown in 3D">3D</span>' : ''}
        </div>
        <div class="pin-stem"></div>`;
      rec.label = labels.add({
        x: w.x, y: p.modelled ? 12 : 4, z: w.z, html, className: `lbl-pin status-${projectStatus(p)}`,
        priority: 60 + (p.unitsLeft > 0 ? 10 : 0) + (p.modelled ? 30 : 0), minDist: 0, maxDist: 16000,
        onClick: () => onSelect(p.id), data: p.id,
      });
      records.set(p.id, rec);
    }
    // community name, visible from far away
    const cw = toWorld(c.center.lat, c.center.lng);
    c.world = cw;
    communityLabels[c.id] = labels.add({
      x: cw.x, y: 0, z: cw.z, className: 'lbl-community',
      html: `<span class="lc-name">${escapeHtml(c.name)}</span><span class="lc-meta">${c.projects.length} projects</span>`,
      priority: 200, minDist: 7000, maxDist: 400000, onClick: () => onSelect(null, c.id), data: c.id,
    });
  }

  let mode = 'realistic';
  let filterSet = null;
  let selectedId = null;

  function colorFor(p) {
    if (mode === 'status') return STATUS_COLORS[projectStatus(p)];
    const beds = bedRange(p);
    return BED_COLORS[beds[beds.length - 1]] || '#ffffff';
  }

  function refresh() {
    for (const rec of records.values()) {
      const p = rec.project;
      const match = !filterSet || filterSet.has(p.id);
      const sel = p.id === selectedId;
      if (rec.disc) {
        const col = new THREE.Color(colorFor(p));
        rec.disc.material.color.copy(col);
        rec.ring.material.color.copy(sel ? new THREE.Color('#ffb703') : col);
        rec.disc.material.opacity = match ? (sel ? 0.42 : 0.26) : 0.06;
        rec.ring.material.opacity = match ? 0.95 : 0.2;
      }
      rec.label.enabled = match && visibleAll;
      rec.label.el.classList.toggle('selected', sel);
      rec.label.el.classList.toggle('dim', !match);
      rec.label.priority = sel ? 500 : 60 + (p.unitsLeft > 0 ? 10 : 0) + (p.modelled ? 30 : 0);
      rec.label.el.dataset.mode = mode;
    }
  }

  let visibleAll = true;
  refresh();

  // keep ground markers a constant size on screen (about 26 px radius), like map markers
  const tmp = new THREE.Vector3();
  function update(camera, viewportH) {
    const k = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / viewportH;
    for (const rec of records.values()) {
      if (!rec.disc) continue;
      const d = tmp.set(rec.world.x, 0, rec.world.z).distanceTo(camera.position);
      const px = rec.project.id === selectedId ? 34 : 24;
      const r = THREE.MathUtils.clamp(d * k * px, 6, 400);
      rec.disc.scale.setScalar(r);
      rec.ring.scale.setScalar(r);
    }
  }

  return {
    group,
    records,
    update,
    setColorMode(m) { mode = m; refresh(); },
    setFilter(set) { filterSet = set; refresh(); },
    setSelected(id) { selectedId = id; refresh(); },
    setVisible(v) { visibleAll = v; group.visible = v; refresh(); },
    /** inside one community: no community name labels (the top bar names it) */
    setScope(id) { for (const lb of Object.values(communityLabels)) if (lb) lb.enabled = !id; },
    pickables: () => [...records.values()].filter((r) => r.disc && r.disc.visible).map((r) => r.disc),
  };
}

/**
 * Estimated bedrooms of a detected home (Nara homes use their surveyed count).
 * Townhouse rows: end units 4 BR, middle units 3 BR (Emaar's terrace pattern, as in Nara);
 * villas: the project's largest type when the plot is wide (>= 15 m), else its 4 BR type.
 * Always kept inside the project's published bedroom range.
 */
export function estimateBeds(project, kind, index, count, width) {
  const lo = project?.bedsMin || 3, hi = project?.bedsMax || 4;
  let b;
  if (kind === 'villa') b = width >= 15 ? hi : Math.max(4, lo);
  else b = index === 0 || index === count - 1 ? 4 : 3;
  return Math.min(hi, Math.max(lo, b));
}

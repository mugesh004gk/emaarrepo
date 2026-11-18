import { BED_COLORS, STATUS_COLORS, bedRange, bedSwatches, formatAED, projectStatus } from '../projects-layer.js';
import { escapeHtml as esc } from '../districts.js';
import { communityPhoto } from './community-picker.js';

// small preview images: the hosted build (scripts/build_dist.py) ships a 400 px '<name>.thumb.jpg' next to
// every image and marks <html data-thumbs>; locally the originals are used
const THUMBS = document.documentElement.hasAttribute('data-thumbs');
const thumb = (src) => (THUMBS && src && src.startsWith('media/research/') ? src.replace(/\.[a-z0-9]+$/i, '.thumb.jpg') : src);

const STATUS_TEXT = { available: 'Units available', new: 'New launch', explore: 'Other projects' };

/**
 * Explorer UI for the three communities and 67 projects:
 * community switcher, filters + results (left), project details (right), community guide,
 * and the brochure / floor-plan / image viewer.
 */
export function initProjectsUI(app) {
  const { communities } = app;
  const allProjects = communities.flatMap((c) => c.projects);
  const byId = new Map(allProjects.map((p) => [p.id, p]));
  const filters = { beds: 'all', type: 'all', avail: 'all', budget: 0 };

  const elSwitch = document.getElementById('community-switch');
  const elList = document.getElementById('pp-list');
  const elCount = document.getElementById('pp-count');
  const elTotal = document.getElementById('pp-total');
  const elCommunity = document.getElementById('pp-community');
  const elContent = document.getElementById('project-content');
  const elLegend = document.getElementById('pp-legend');

  // ---- community switcher ----------------------------------------------------
  elSwitch.innerHTML =
    `<button class="cm-btn" data-community="all" title="Back to all communities"><svg class="icon"><use href="#i-layers" /></svg><span class="mode-label">Communities</span></button>` +
    communities.map((c) => `<button class="cm-btn" data-community="${c.id}" data-short="${esc({ 'the-valley': 'Valley', 'arabian-ranches-3': 'AR III', 'emaar-south': 'South' }[c.id] || c.name)}" title="${esc(c.name)}"><span class="mode-label">${esc(c.name)}</span><span class="cm-count">${c.projects.length}</span></button>`).join('');
  elSwitch.addEventListener('click', (e) => {
    const b = e.target.closest('.cm-btn');
    if (b) app.selectCommunity(b.dataset.community === 'all' ? null : b.dataset.community);
  });

  // ---- colour key under the filters (only while the homes are coloured) ----------
  const elColour = document.getElementById('pp-colour');
  elColour.addEventListener('change', () => app.setColorMode?.(elColour.checked ? 'bedrooms' : 'realistic'));
  function renderLegend() {
    const mode = app.state.colorMode;
    elColour.checked = mode === 'bedrooms';
    if (mode === 'status') {
      elLegend.innerHTML = Object.entries(STATUS_TEXT).map(([k, t]) => `<span class="lg-item"><i style="background:${STATUS_COLORS[k]}"></i>${t}</span>`).join('');
    } else if (mode === 'bedrooms') {
      elLegend.innerHTML = Object.entries(BED_COLORS).slice(0, 5).map(([n, c]) => `<button type="button" class="lg-item${filters.beds === n ? ' sel' : ''}" data-lg="${n}" title="Show only ${n}${n === '5' ? '+' : ''} bedroom homes"><i style="background:${c}"></i>${n}${n === '5' ? '+' : ''} BR</button>`).join('') +
        `<span class="lg-note">Outside Nara, bedrooms are estimated: end-of-row homes 4 BR, mid-row 3 BR, within each project's range.</span>`;
      elLegend.querySelectorAll('[data-lg]').forEach((b) => (b.onclick = () => {
        const v = filters.beds === b.dataset.lg ? 'all' : b.dataset.lg;
        document.querySelector(`#pp-beds button[data-beds="${v}"]`)?.click();
      }));
    } else elLegend.innerHTML = '';
    elLegend.classList.toggle('hidden', !elLegend.innerHTML);
  }

  // ---- filters ----------------------------------------------------------------
  function bindSeg(id, key, attr) {
    const el = document.getElementById(id);
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      el.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
      filters[key] = b.dataset[attr];
      if (key === 'beds' && filters.beds !== 'all' && app.state.colorMode === 'realistic') app.setColorMode?.('bedrooms');
      apply();
    });
  }
  bindSeg('pp-beds', 'beds', 'beds');
  bindSeg('pp-type', 'type', 'type');
  const elAvailNow = document.getElementById('pp-avail-now');
  elAvailNow.addEventListener('change', () => { filters.avail = elAvailNow.checked ? 'now' : 'all'; apply(); });
  document.getElementById('pp-budget').addEventListener('change', (e) => { filters.budget = Number(e.target.value); apply(); });
  document.getElementById('btn-reset-projects').addEventListener('click', () => {
    Object.assign(filters, { beds: 'all', type: 'all', avail: 'all', budget: 0 });
    for (const [id, attr] of [['pp-beds', 'beds'], ['pp-type', 'type']]) {
      document.querySelectorAll(`#${id} button`).forEach((x) => x.classList.toggle('active', x.dataset[attr] === 'all'));
    }
    document.getElementById('pp-budget').value = '0';
    elAvailNow.checked = false;
    if (app.state.colorMode === 'bedrooms') app.setColorMode?.('realistic');
    apply();
  });

  function matches(p) {
    if (app.state.communityId && p.communityId !== app.state.communityId) return false;
    if (filters.beds !== 'all') {
      const n = Number(filters.beds);
      const r = bedRange(p);
      if (n >= 5 ? !r.some((x) => x >= 5) : !r.includes(n)) return false;
    }
    if (filters.type !== 'all' && !(p.types || []).includes(filters.type)) return false;
    if (filters.avail === 'now' && !(p.unitsLeft > 0)) return false;
    if (filters.avail === '3d' && !p.modelled && !p.detectedHomes && !p.detectedBuildings) return false;
    if (filters.budget && !(p.priceFrom && p.priceFrom <= filters.budget)) return false;
    return true;
  }

  function apply() {
    const list = allProjects.filter(matches);
    const scope = app.state.communityId ? allProjects.filter((p) => p.communityId === app.state.communityId) : allProjects;
    elCount.textContent = list.length;
    elTotal.textContent = scope.length;
    document.getElementById('reopen-filter-count').textContent = list.length;
    const anyFilter = filters.beds !== 'all' || filters.type !== 'all' || filters.avail !== 'all' || filters.budget;
    app.projectsLayer.setFilter(anyFilter || app.state.communityId ? new Set(list.map((p) => p.id)) : null);
    document.getElementById('btn-reset-projects').classList.toggle('hidden', !anyFilter);
    renderList(list);
    renderLegend();
    app.onFiltersChanged?.();
    app.invalidate();
  }

  /** Filter for single homes (null when no filter is set): bedrooms and type per home, availability and
   *  budget per project. The community choice only moves the camera, it does not dim other homes. */
  function homeFilter() {
    const any = filters.beds !== 'all' || filters.type !== 'all' || filters.avail !== 'all' || filters.budget;
    if (!any) return null;
    return (h) => {
      const p = byId.get(h.project);
      if (!p) return false;
      if (filters.avail === 'now' && !(p.unitsLeft > 0)) return false;
      if (filters.budget && !(p.priceFrom && p.priceFrom <= filters.budget)) return false;
      if (filters.beds !== 'all') {
        const n = Number(filters.beds);
        if (h.apartment) { if (!bedRange(p).some((x) => (n >= 5 ? x >= 5 : x === n))) return false; }
        else if (n >= 5 ? h.beds < 5 : h.beds !== n) return false;
      }
      if (filters.type !== 'all') {
        const k = h.apartment ? 'Apartment' : h.kind === 'villa' ? 'Villa' : 'Townhouse';
        if (k !== filters.type) return false;
      }
      return true;
    };
  }

  function renderList(list) {
    if (!list.length) {
      elList.innerHTML = `<div class="empty-note">No project matches these filters.</div>`;
      return;
    }
    const groups = app.state.communityId ? [[null, list]] : communities.map((c) => [c, list.filter((p) => p.communityId === c.id)]).filter(([, l]) => l.length);
    elList.innerHTML = groups.map(([c, l]) => `
      ${c ? `<div class="pl-group">${esc(c.name)} <span>${l.length}</span></div>` : ''}
      ${l.map((p) => {
        const img = (p.images.find((i) => i.kind === 'main') || p.images[0] || {}).src;
        const st = projectStatus(p);
        return `<button type="button" class="project-row${p.id === app.state.projectId ? ' selected' : ''}" data-project="${p.id}">
          <span class="pr-thumb" style="background-image:url('${img ? encodeURI(thumb(img)) : ''}')">${p.modelled || p.detectedHomes || p.detectedBuildings ? '<span class="pr-3d">3D</span>' : ''}</span>
          <span class="pr-main">
            <strong>${esc(p.name)}</strong>
            <span class="pr-meta"><span class="pin-beds">${bedSwatches(p)}</span>${esc(p.bedsLabel || '')} BR${p.types?.length ? ' · ' + p.types.join(', ') : ''}</span>
            ${p.unitsLeft > 0 || st === 'new' ? `<span class="pr-status st-${st}">${p.unitsLeft > 0 ? `${p.unitsLeft} unit${p.unitsLeft === 1 ? '' : 's'} for sale` : STATUS_TEXT[st]}</span>` : ''}
          </span>
          <span class="pr-price">${p.priceFrom ? `<small>from</small>${formatAED(p.priceFrom)}` : '<small>on request</small>'}</span>
        </button>`;
      }).join('')}`).join('');
  }

  function markSelected(id) {
    elList.querySelectorAll('.project-row').forEach((r) => r.classList.toggle('selected', r.dataset.project === id));
  }

  elList.addEventListener('click', (e) => {
    const b = e.target.closest('.project-row');
    if (b) app.selectProject(b.dataset.project);
  });

  // ---- community header in the left panel --------------------------------------
  function renderCommunityHeader() {
    const c = communities.find((x) => x.id === app.state.communityId);
    document.getElementById('pp-title').textContent = c ? c.name : 'Explore projects';
    elSwitch.querySelectorAll('.cm-btn').forEach((b) => b.classList.toggle('active', c ? b.dataset.community === c.id : b.dataset.community === 'all'));
    if (!c) {
      elCommunity.innerHTML = `
        <div class="cm-cards">${communities.map((x) => `
          <button class="cm-card" data-community="${x.id}" style="background-image:linear-gradient(180deg,rgba(0,0,0,0) 30%,rgba(0,0,0,.62)),url('${encodeURI(communityPhoto(x))}')">
            <strong>${esc(x.name)}</strong><span>${x.projects.length} projects · ${esc(x.tagline)}</span>
          </button>`).join('')}</div>`;
      elCommunity.querySelectorAll('.cm-card').forEach((b) => b.addEventListener('click', () => app.selectCommunity(b.dataset.community)));
      return;
    }
    elCommunity.innerHTML = `
      <div class="cm-chips">${[{ id: 'all', name: '← All communities' }, ...communities].map((x) => `<button type="button" class="cm-chip${x.id === c.id ? ' active' : ''}" data-community="${x.id}">${esc(x.name)}</button>`).join('')}</div>
      <button type="button" class="cm-hero" id="btn-community-guide" title="Open the community guide" style="background-image:linear-gradient(180deg,rgba(0,0,0,0) 25%,rgba(0,0,0,.66)),url('${encodeURI(communityPhoto(c))}')">
        <span class="cm-hero-tag">${esc(c.tagline)}</span>
        <span class="cm-hero-link"><svg class="icon"><use href="#i-book" /></svg>Community guide, map &amp; FAQ<svg class="icon"><use href="#i-chevron-right" /></svg></span>
      </button>`;
    document.getElementById('btn-community-guide').addEventListener('click', () => openCommunityGuide(c));
    elCommunity.querySelectorAll('.cm-chip').forEach((b) => b.addEventListener('click', () => app.selectCommunity(b.dataset.community === 'all' ? null : b.dataset.community)));
  }

  // ---- floor-plan types (from scripts/extract_floorplans.py, copied from the developer sheets) ----
  const fmt = (n, d = 0) => (n == null ? '–' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }));
  function planArea(pl) {
    // printed total area of a plan page: per-unit rows (range) or the group's total / built-up / suite area
    const vals = [];
    for (const r of pl.rows || []) vals.push(r);
    for (const g of pl.groups || []) {
      const a = g.areas.TOTAL || g.areas.BUILT_UP || g.areas.SUITE;
      if (a) vals.push(a);
    }
    if (!vals.length) return null;
    const ft = vals.map((v) => v.sqft), m = vals.map((v) => v.sqm);
    return { ftMin: Math.min(...ft), ftMax: Math.max(...ft), mMin: Math.min(...m), mMax: Math.max(...m), derived: vals.some((v) => v.sqmDerived) };
  }
  // a range that rounds to one number is shown as that number with its printed decimals
  const rangeText = (a, b, d) => (fmt(a, d) === fmt(b, d) ? fmt(a, 2) : `${fmt(a, d)}–${fmt(b, d)}`);
  function planUnits(pl) {
    const u = new Set();
    (pl.rows || []).forEach((r) => u.add(r.unit));
    (pl.units || []).forEach((x) => u.add(x));
    (pl.groups || []).forEach((g) => g.units.forEach((x) => u.add(x)));
    return [...u];
  }
  function renderPlans(p) {
    const fp = app.floorplans?.[p.id];
    if (!fp) return '';
    if (!fp.plans.length) {
      return `<section class="detail-section"><h4 class="section-label">Floor-plan types</h4>
        <div class="notice"><svg class="icon"><use href="#i-info" /></svg><span>This floor-plan file is ${fp.pages} pages of images without readable text; open the sheets to read each plan's printed sizes.</span></div></section>`;
    }
    const plans = fp.plans.map((pl) => ({ pl, area: planArea(pl), units: planUnits(pl) })).filter((x) => x.area);
    const byBeds = new Map();
    for (const x of plans) {
      const k = x.pl.beds ?? -1;
      if (!byBeds.has(k)) byBeds.set(k, []);
      byBeds.get(k).push(x);
    }
    const all = plans.map((x) => x.area);
    const range = all.length ? `${fmt(Math.min(...all.map((a) => a.ftMin)))} – ${fmt(Math.max(...all.map((a) => a.ftMax)))} sq ft` : '';
    return `<section class="detail-section">
      <div class="section-title-row"><h4 class="section-label">Floor-plan types · ${plans.length}</h4><span class="section-hint">${range}</span></div>
      ${[...byBeds.entries()].sort((a, b) => a[0] - b[0]).map(([beds, list]) => `
        <div class="plan-group"><span class="pin-beds"><i style="background:${BED_COLORS[beds] || '#999'}"></i></span>${beds === 0 ? 'Studio' : beds > 0 ? `${beds} bedroom` : 'Other'}<span class="pg-count">${list.length}</span></div>
        ${list.map(({ pl, area, units }) => `
          <button type="button" class="plan-row" data-page="${pl.page}" title="Open the developer sheet, page ${pl.page}">
            <span class="plr-main"><strong>${esc(pl.title || 'Plan')}</strong><small>${esc([pl.kind, pl.style].filter(Boolean).join(' · '))}${units.length ? `${pl.kind || pl.style ? ' · ' : ''}${units.length} unit${units.length === 1 ? '' : 's'}: ${esc(units.slice(0, 4).join(', '))}${units.length > 4 ? '…' : ''}` : ''}</small></span>
            <span class="plr-area">${rangeText(area.ftMin, area.ftMax, 0)}<small>sq ft · ${rangeText(area.mMin, area.mMax, 1)} m²${area.derived ? '*' : ''}</small></span>
            <span class="plr-page">p.${pl.page}</span>
          </button>`).join('')}`).join('')}
      <p class="source-note">Areas as printed on the developer's floor-plan sheets (total area; built-up or suite area where no total is printed).${plans.some((x) => x.area.derived) ? ' * m² converted from the printed sq ft.' : ''} Select a plan to open its sheet.</p>
    </section>`;
  }

  /** smallest–largest printed area over a project's floor-plan pages, e.g. "2,051–2,325" */
  function planSpan(p) {
    const a = (app.floorplans?.[p.id]?.plans || []).map(planArea).filter(Boolean);
    if (!a.length) return '';
    const lo = Math.min(...a.map((x) => x.ftMin)), hi = Math.max(...a.map((x) => x.ftMax));
    return Math.round(lo) === Math.round(hi) ? fmt(lo) : `${fmt(lo)}–${fmt(hi)}`;
  }

  const pinKey = (p) => `${p.lat?.toFixed(5)},${p.lng?.toFixed(5)}`;
  const pinGroups = new Map();
  for (const p of allProjects) { const k = pinKey(p); pinGroups.set(k, [...(pinGroups.get(k) || []), p]); }
  const sharedPin = (p) => (p.pinFlag ? 0 : pinGroups.get(pinKey(p)).length);
  const sharedNames = (p) => pinGroups.get(pinKey(p)).map((x) => x.name).join(', ');

  // ---- project details (right panel) -------------------------------------------------
  let gallery = [];
  let galleryIdx = 0;
  let shownId = null;

  function showProject(id) {
    const p = byId.get(id);
    if (!p) return;
    const c = communities.find((x) => x.id === p.communityId);
    gallery = p.images.filter((i) => i.kind !== 'banner');
    if (!gallery.length) gallery = p.images;
    galleryIdx = 0;
    const st = projectStatus(p);
    const sizes = p.figures?.Sizes;
    const in3d = p.modelled ? 372 : p.homesPlaced ?? p.detectedHomes ?? 0;
    const official = p.unitCount?.total ?? null;
    const fromMap = p.modelled ? 372 : p.mapPlaced || 0;
    const stats = [
      ['Bedrooms', `${esc(p.bedsLabel || '—')}`, bedRange(p).length ? `<span class="pin-beds big">${bedSwatches(p)}</span>` : ''],
      ['Price from', p.priceFrom ? formatAED(p.priceFrom) : 'On request', p.priceFrom ? formatAED(p.priceFrom, false) : 'ask Emaar'],
      p.unitsLeft > 0 ? ['For sale', `${p.unitsLeft}`, `unit${p.unitsLeft === 1 ? '' : 's'} listed`]
        : sizes ? ['Sizes', esc(sizes.replace(/ sq ft/, '')), 'sq ft']
        : planSpan(p) ? ['Sizes', planSpan(p), 'sq ft, floor plans']
        : ['Home type', esc((p.types || [])[0] || '—'), (p.types || []).slice(1).join(', ')],
    ];
    // official home count vs homes in 3D, with where the number comes from
    if (!p.detectedBuildings || in3d) stats.push(official
      ? ['Homes', `${official.toLocaleString('en-US')}`, fromMap >= official ? 'all placed from the cluster map' : fromMap ? `${fromMap.toLocaleString('en-US')} placed from the cluster map` : 'per cluster map · 3D layout in progress']
      : ['Homes in 3D', in3d ? in3d.toLocaleString('en-US') : '—', in3d ? 'from satellite · official total awaited' : 'none placed yet']);
    const near = p.distances || [];
    const lm = p.landmarks || [];
    const fp = p.floorplans || [];
    const br = p.brochures || [];
    const modelNote = (p.detectedHomes || p.detectedBuildings) && !p.modelled
      ? `${[p.detectedHomes ? `${p.detectedHomes} homes` : '', p.detectedBuildings ? `${p.detectedBuildings} apartment building${p.detectedBuildings > 1 ? 's' : ''}` : ''].filter(Boolean).join(' and ')} are placed from current satellite imagery (positions, outlines and street sides as built). ${p.detectedBuildings ? (['golf-trails-at-emaar-south', 'vista-ridge-at-emaar-south', 'grove-ridge-at-emaar-south'].includes(p.id) ? 'Building height follows the printed massing (G+P+10/11). ' : 'Building height is representative (G+P+8); not printed for this project. ') : ''}The split into homes, the bedrooms per home and the house design are representative until the brochure cluster map is traced. Nara is the fully surveyed model.`
      : p.modelled ? 'All 372 Nara homes are surveyed: exact plots, plan types, orientations and DLD records.'
      : p.buildStatus && !p.buildStatus.built ? (p.buildStatus.planned
        ? `Not built yet: the plot is still open land in the latest satellite imagery (new launch). The ${p.buildStatus.planned} homes shown here in 3D are an illustrative planned layout of this project's home type, not the final site plan; see the brochure and floor plans for the actual design.`
        : 'Not built yet: the plot is still open land in the latest satellite imagery (new launch or early construction). The brochure and floor plans show the planned homes.') : '';
    elContent.innerHTML = `
      <div id="pj-home" class="pj-home hidden"></div>
      <div class="details-hero pj-hero">
        <img id="pj-hero-img" src="${encodeURI(gallery[0]?.src || '')}" alt="${esc(p.name)}" />
        ${gallery.length > 1 ? `<button class="hero-nav prev" aria-label="Previous image"><svg class="icon"><use href="#i-chevron-left" /></svg></button>
        <button class="hero-nav next" aria-label="Next image"><svg class="icon"><use href="#i-chevron-right" /></svg></button>` : ''}
        <span class="details-hero-caption"><span id="pj-hero-count">1 / ${gallery.length}</span> · Emaar imagery</span>
      </div>
      <div class="details-body">
        <div class="details-header">
          <div class="pj-eyebrow">${esc(c.name)}${(p.types || []).length ? ' · ' + esc(p.types.join(', ')) : ''}</div>
          <h2>${esc(p.name)}</h2>
          <div class="unit-badge-row">
            ${p.unitsLeft > 0 ? `<span class="badge st-badge st-available">${p.unitsLeft} for sale</span>` : st === 'new' ? `<span class="badge st-badge st-new">New launch</span>` : ''}
            ${in3d || p.detectedBuildings ? `<span class="badge badge-3d">${in3d ? `${in3d.toLocaleString('en-US')}${official && fromMap ? ` of ${official.toLocaleString('en-US')}` : ''} homes in 3D` : `${p.detectedBuildings} buildings in 3D`}</span>` : ''}
          </div>
        </div>
        ${p.pinFlag ? `<div class="notice warn"><svg class="icon"><use href="#i-info" /></svg><span>${esc(p.pinFlag.note)} Published pin: ${p.pinFlag.publishedLat.toFixed(5)}, ${p.pinFlag.publishedLng.toFixed(5)}.</span></div>` : ''}
        <div class="key-stats">${stats.map(([l, v, sub]) => `<div class="stat"><span class="stat-label">${l}</span><span class="stat-value${String(v).replace(/<[^>]+>/g, '').length > 8 ? ' sm' : ''}">${v}</span>${sub ? `<span class="stat-sub">${sub}</span>` : ''}</div>`).join('')}</div>
        <div class="primary-actions">
          ${p.modelled ? `<div class="action-row">
            <button class="btn btn-primary" data-act="homes" title="List, filter and open any of the 372 Nara homes"><svg class="icon"><use href="#i-search" /></svg>Find a Nara home</button>
            <button class="btn btn-secondary" data-act="showhome" title="One home type on its own, with both floors"><svg class="icon"><use href="#i-house" /></svg>Show home</button>
          </div>` : ''}
          <div class="action-row">
            ${br.length ? `<button class="btn ${p.modelled ? 'btn-secondary' : 'btn-primary'}" data-act="brochure" title="Open Emaar's brochure (PDF)"><svg class="icon"><use href="#i-file" /></svg>Brochure <small>${br[0].pages || ''}p</small></button>` : ''}
            ${fp.length ? `<button class="btn btn-secondary" data-act="floorplans" title="Open Emaar's floor-plan sheets (PDF)"><svg class="icon"><use href="#i-plan" /></svg>Floor plans <small>${fp[0].pages || ''}p</small></button>` : '<button class="btn btn-secondary" disabled title="Emaar has not published a floor-plan file for this project"><svg class="icon"><use href="#i-plan" /></svg>No floor plans yet</button>'}
          </div>
          <div class="action-row">
            <button class="btn btn-secondary" data-act="fly" title="Move the camera back over this project"><svg class="icon"><use href="#i-navigation" /></svg>Show on map</button>
            <a class="btn btn-secondary" href="${esc(p.url)}" target="_blank" rel="noopener" title="Open this project on emaar.com"><svg class="icon"><use href="#i-external" /></svg>emaar.com</a>
          </div>
        </div>
        ${renderPlans(p)}
        ${p.about?.length ? `<section class="detail-section"><h4 class="section-label">About</h4>${p.about.map((t) => `<p class="prose">${esc(t)}</p>`).join('')}</section>` : ''}
        ${p.highlights?.length ? `<section class="detail-section"><h4 class="section-label">Highlights</h4>${p.highlights.map((h) => `<div class="hl"><strong>${esc(h.title)}</strong><p class="prose">${esc(h.text)}</p></div>`).join('')}</section>` : ''}
        ${p.amenities?.length ? `<section class="detail-section"><h4 class="section-label">Amenities</h4><div class="chip-wrap">${p.amenities.map((a) => `<span class="chip">${esc(a)}</span>`).join('')}</div></section>` : ''}
        ${p.keyFacts?.length || Object.keys(p.figures || {}).length ? `<section class="detail-section"><h4 class="section-label">Key facts</h4><dl class="dl">
          ${(p.keyFacts || []).map((k) => `<div class="dl-row"><dt>${esc(k)}</dt><dd></dd></div>`).join('')}
          ${Object.entries(p.figures || {}).map(([k, v]) => `<div class="dl-row"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}
        </dl></section>` : ''}
        <section class="detail-section">
          <h4 class="section-label">Drive times</h4>
          <dl class="dl dist">
            ${near.map((d) => `<div class="dl-row"><dt>${esc(d.to)}<small>listed nearby by Emaar</small></dt><dd>${d.driveMin ?? '–'} min<small>${d.driveKm ?? '–'} km</small></dd></div>`).join('')}
            ${lm.map((d) => `<div class="dl-row"><dt>${esc(d.to)}</dt><dd>${d.driveMin} min<small>${d.driveKm} km</small></dd></div>`).join('')}
          </dl>
          <p class="source-note">${esc(app.notes?.driveTimes || '')}</p>
        </section>
        <section class="detail-section">
          <h4 class="section-label">Location</h4>
          <dl class="dl">
            <div class="dl-row"><dt>Map pin (Emaar)</dt><dd>${p.lat?.toFixed(5)}° N, ${p.lng?.toFixed(5)}° E</dd></div>
            <div class="dl-row"><dt>Community</dt><dd>${esc(c.name)}</dd></div>
          </dl>
          ${sharedPin(p) > 1 ? `<p class="source-note">Emaar publishes one map pin for ${sharedPin(p)} projects here (${esc(sharedNames(p))}); it marks the area, not this project's exact plot.</p>` : ''}
          <div class="action-row compact">
            <a class="btn-text" href="https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}" target="_blank" rel="noopener"><svg class="icon"><use href="#i-pin" /></svg>Open in Google Maps</a>
          </div>
        </section>
        ${gallery.length > 1 ? `<section class="detail-section"><h4 class="section-label">Images · ${gallery.length}</h4><div class="thumb-grid">${gallery.map((g, i) => `<button class="thumb" data-img="${i}" style="background-image:url('${encodeURI(thumb(g.src))}')" aria-label="Image ${i + 1}"></button>`).join('')}</div></section>` : ''}
        ${p.buildStatus && !p.buildStatus.built && !p.modelled ? `<div class="notice warn"><svg class="icon"><use href="#i-info" /></svg><span>${modelNote}</span></div>` : modelNote ? `<details class="model-note"><summary><svg class="icon"><use href="#i-cube" /></svg>About the 3D homes</summary><p>${modelNote}</p></details>` : ''}
        <p class="source-note">Text, prices, images and documents from emaar.com (retrieved 14 Nov 2026). Prices and availability change; confirm with Emaar.</p>
      </div>`;
    const heroImg = elContent.querySelector('#pj-hero-img');
    const heroCount = elContent.querySelector('#pj-hero-count');
    const step = (d) => {
      galleryIdx = (galleryIdx + d + gallery.length) % gallery.length;
      heroImg.src = encodeURI(gallery[galleryIdx].src);
      heroCount.textContent = `${galleryIdx + 1} / ${gallery.length}`;
    };
    elContent.querySelector('.hero-nav.prev')?.addEventListener('click', () => step(-1));
    elContent.querySelector('.hero-nav.next')?.addEventListener('click', () => step(1));
    heroImg.addEventListener('click', () => openImages(p.name, gallery, galleryIdx));
    elContent.querySelectorAll('.thumb').forEach((t) => t.addEventListener('click', () => openImages(p.name, gallery, Number(t.dataset.img))));
    elContent.querySelectorAll('.plan-row').forEach((b) => b.addEventListener('click', () => openPdf(`${p.name} · Floor plans · page ${b.dataset.page}`, fp[0].src, Number(b.dataset.page))));
    elContent.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
      const a = b.dataset.act;
      if (a === 'fly') app.flyToProject(p.id);
      if (a === 'brochure') openPdf(`${p.name} · Brochure`, br[0].src);
      if (a === 'floorplans') openPdf(`${p.name} · Floor plans${fp[0].inBrochure ? ' (in the brochure)' : ''}`, fp[0].src, fp[0].startPage);
      if (a === 'homes') app.openNaraHomes();
      if (a === 'showhome') app.setCameraMode('showhome');
    }));
    elContent.scrollTop = 0;
    shownId = id;
    document.getElementById('reopen-details-kind').textContent = 'Project';
    document.getElementById('reopen-unit-label').textContent = p.name;
  }

  // ---- the home clicked on the map: shown first, above its project --------------------------
  function showHome(h, d) {
    const el = elContent.querySelector('#pj-home');
    if (!el) return;
    if (!h) { el.classList.add('hidden'); el.innerHTML = ''; return; }
    const p = byId.get(h.project);
    const fp = app.floorplans?.[p.id];
    const file = p.floorplans?.[0];
    if (h.unitPlan && h.unitPlan.design) { showUnit(el, h, d, p, file); return; }
    if (h.unitPlan) { showMapUnit(el, h, d, p, file); return; }
    const plans = (fp?.plans || []).map((pl) => ({ pl, area: planArea(pl) })).filter((x) => x.area && !h.apartment && x.pl.beds === h.beds);
    const facts = h.apartment
      ? [['Bedrooms', `${esc(p.bedsLabel || '—')} BR`, 'per project'], ['Height', `G+P+${h.row?.storeys ?? 8}`, h.row?.storeysPrinted ? 'as printed' : 'representative']]
      : [['Bedrooms', `${h.beds}`, 'estimated'], ['Frontage', h.width ? `≈ ${h.width.toFixed(1)} m` : '—', 'from imagery'], ['Price from', p.priceFrom ? formatAED(p.priceFrom) : 'On request', 'project']];
    el.innerHTML = `
      <div class="ph-head">
        <span class="ph-eyebrow"><i style="background:${d.color || '#999'}"></i>Selected home</span>
        <button type="button" class="btn-text ph-clear" title="Clear the selection (Esc)">Clear</button>
      </div>
      <h3 class="ph-title">${esc(d.line.charAt(0).toUpperCase() + d.line.slice(1))}</h3>
      <p class="ph-sub">in <b>${esc(p.name)}</b> · ${esc(communities.find((c) => c.id === p.communityId)?.name || '')}</p>
      <div class="ph-facts">${facts.map(([l, v, sub]) => `<div><span>${l}</span><b>${v}</b><small>${sub}</small></div>`).join('')}</div>
      ${plans.length ? `<div class="ph-plans">
          <div class="ph-plans-head">${h.beds}-bedroom floor plans in ${esc(p.name)}</div>
          ${plans.slice(0, 4).map(({ pl, area }) => `<button type="button" class="ph-plan" data-page="${pl.page}" title="Open the developer sheet, page ${pl.page}">
            <span><b>${esc(pl.title || 'Plan')}</b><small>${esc([pl.kind, pl.style].filter(Boolean).join(' · '))}</small></span>
            <span class="ph-area">${rangeText(area.ftMin, area.ftMax, 0)} <small>sq ft</small></span>
            <svg class="icon"><use href="#i-chevron-right" /></svg></button>`).join('')}
        </div>`
        : file ? `<button type="button" class="btn btn-primary btn-block ph-open-plans"><svg class="icon"><use href="#i-plan" /></svg>Open the floor plans</button>` : ''}
      <p class="ph-note">${h.apartment ? 'Building placed from satellite imagery.' : "Placed from satellite imagery. Bedrooms are estimated (end of row 4 BR, mid row 3 BR, within the project's range) until the cluster map is traced."}</p>`;
    el.classList.remove('hidden');
    el.querySelector('.ph-clear').onclick = () => app.clearHome?.();
    el.querySelectorAll('.ph-plan').forEach((b) => (b.onclick = () => openPdf(`${p.name} · Floor plans · page ${b.dataset.page}`, file.src, Number(b.dataset.page))));
    const op = el.querySelector('.ph-open-plans');
    if (op) op.onclick = () => openPdf(`${p.name} · Floor plans`, file.src, file.startPage);
    elContent.scrollTop = 0;
  }

  // a home placed from the developer's cluster map: its unit number; floor plans of the project
  function showMapUnit(el, h, d, p, file) {
    const no = h.unitPlan.no;
    const total = p.unitCount?.total;
    el.innerHTML = `
      <div class="ph-head">
        <span class="ph-eyebrow"><i style="background:${d.color || '#999'}"></i>Selected home</span>
        <button type="button" class="btn-text ph-clear" title="Clear the selection (Esc)">Clear</button>
      </div>
      <h3 class="ph-title">Unit ${esc(String(no))}</h3>
      <p class="ph-sub">in <b>${esc(p.name)}</b> · ${esc(communities.find((c) => c.id === p.communityId)?.name || '')}</p>
      <div class="ph-facts">
        <div><span>Unit</span><b>${esc(String(no))}</b><small>${total ? `of ${total}` : 'cluster map'}</small></div>
        <div><span>Home</span><b>${h.kind === 'villa' ? 'Villa' : 'Townhouse'}</b><small>${esc((p.bedsLabel || '') + ' BR in project')}</small></div>
        <div><span>Price from</span><b>${p.priceFrom ? formatAED(p.priceFrom) : 'On request'}</b><small>project</small></div>
      </div>
      ${file ? `<button type="button" class="btn btn-primary btn-block ph-open-plans"><svg class="icon"><use href="#i-plan" /></svg>Open the ${esc(p.name)} floor plans</button>` : ''}
      <p class="ph-note">Placed and numbered from Emaar's ${esc(p.name)} cluster map. The floor plan of each unit number will be linked when Emaar's unit list is available.</p>`;
    el.classList.remove('hidden');
    el.querySelector('.ph-clear').onclick = () => app.clearHome?.();
    const op = el.querySelector('.ph-open-plans');
    if (op) op.onclick = () => openPdf(`${p.name} · Floor plans`, file.src, file.startPage);
    elContent.scrollTop = 0;
  }

  // a home with its official unit number and floor plan (traced from the developer's cluster map)
  function showUnit(el, h, d, p, file) {
    const up = h.unitPlan;
    const facts = [
      ['Unit', `${up.no}`, `TH${String(up.th).padStart(2, '0')} of ${up.plex}`],
      ['Bedrooms', `${up.beds}`, 'floor plan'],
      ['Built-up area', up.sqft ? `${Math.round(up.sqft).toLocaleString('en-US')} sq ft` : '—', up.sqm ? `${up.sqm.toFixed(1)} m²` : ''],
    ];
    el.innerHTML = `
      <div class="ph-head">
        <span class="ph-eyebrow"><i style="background:${d.color || '#999'}"></i>Selected home</span>
        <button type="button" class="btn-text ph-clear" title="Clear the selection (Esc)">Clear</button>
      </div>
      <h3 class="ph-title">Unit ${esc(String(up.no))} · ${esc(up.design)} ${up.beds} BR ${esc(up.plan)}</h3>
      <p class="ph-sub">in <b>${esc(p.name)}</b> · ${esc(communities.find((c) => c.id === p.communityId)?.name || '')} · ${esc(up.position)} unit</p>
      <div class="ph-facts">${facts.map(([l, v, sub]) => `<div><span>${l}</span><b>${v}</b><small>${esc(sub)}</small></div>`).join('')}</div>
      ${file ? `<div class="ph-plans"><div class="ph-plans-head">Floor plan of this home</div>
        <button type="button" class="ph-plan" data-page="${up.page}" title="Open the developer sheet, page ${up.page}">
          <span><b>${esc(up.design)} · ${up.beds} bedroom ${esc(up.plan)}</b><small>${up.plex} PLEX - TH ${String(up.th).padStart(2, '0')} · page ${up.page}</small></span>
          <span class="ph-area">${up.sqft ? Math.round(up.sqft).toLocaleString('en-US') : '—'} <small>sq ft</small></span>
          <svg class="icon"><use href="#i-chevron-right" /></svg></button></div>` : ''}
      <p class="ph-note">Placed from Emaar's ${esc(p.name)} cluster map: unit number, house type and floor plan as published by the developer.</p>`;
    el.classList.remove('hidden');
    el.querySelector('.ph-clear').onclick = () => app.clearHome?.();
    el.querySelectorAll('.ph-plan').forEach((b) => (b.onclick = () => openPdf(`${p.name} · Unit ${up.no} · floor plan`, file.src, Number(b.dataset.page))));
    elContent.scrollTop = 0;
  }

  // ---- community guide modal (reuses Nara's community modal) -------------------------------
  function openCommunityGuide(c) {
    const body = document.getElementById('community-modal-body');
    document.querySelector('#community-modal .modal-header h3').textContent = `${c.name} · community guide`;
    body.innerHTML = `
      <div class="guide">
        ${c.mapImage ? `<figure class="guide-map"><img src="${encodeURI(c.mapImage)}" alt="Locator map of ${esc(c.name)}" /><figcaption>Locator map published by Emaar</figcaption></figure>` : ''}
        ${c.overview.map((t) => `<p class="prose">${esc(t)}</p>`).join('')}
        ${c.figures.length ? `<div class="cm-figs wide">${c.figures.map((f) => `<div><strong>${esc(f.value)}</strong><span>${esc(f.label)}</span></div>`).join('')}</div>` : ''}
        ${c.gallery.length ? `<div class="thumb-grid wide">${c.gallery.map((g, i) => `<button class="thumb" data-img="${i}" style="background-image:url('${encodeURI(thumb(g))}')"></button>`).join('')}</div>` : ''}
        ${c.faq.length ? `<h4 class="section-label">Questions</h4>${c.faq.map((q) => `<details class="faq"><summary>${esc(q.q)}</summary><p class="prose">${esc(q.a)}</p></details>`).join('')}` : ''}
        <p class="source-note">From <a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.url)}</a></p>
      </div>`;
    body.querySelectorAll('.thumb').forEach((t) => t.addEventListener('click', () => openImages(c.name, c.gallery.map((src) => ({ src })), Number(t.dataset.img))));
    document.getElementById('community-modal').classList.remove('hidden');
  }

  // ---- media modal --------------------------------------------------------------------
  const elMedia = document.getElementById('media-modal');
  const elMediaBody = document.getElementById('media-body');
  const elMediaTitle = document.getElementById('media-title');
  const elMediaOpen = document.getElementById('media-open');
  function closeMedia() {
    elMedia.classList.add('hidden');
    elMediaBody.innerHTML = '';
  }
  document.getElementById('btn-close-media').addEventListener('click', closeMedia);
  elMedia.addEventListener('click', (e) => { if (e.target === elMedia) closeMedia(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !elMedia.classList.contains('hidden')) closeMedia(); });

  // Brochures and floor plans as page images (data/doc_pages.json, made by scripts/render_docs.py):
  // they open on every host and device, whereas emaar.com refuses to be shown inside other sites.
  let docPages = null;
  const docPagesReady = fetch('data/doc_pages.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}))
    .then((d) => { docPages = d || {}; });
  let docKey = null; // arrow-key paging while a document is open
  window.addEventListener('keydown', (e) => {
    if (!docKey || elMedia.classList.contains('hidden')) return;
    if (e.key === 'ArrowLeft') docKey(-1);
    if (e.key === 'ArrowRight') docKey(1);
  });

  function openPdf(title, src, page) {
    if (!docPages) { // list of page images still loading: wait for it rather than show a blocked frame
      elMediaTitle.textContent = title;
      elMediaBody.innerHTML = '<div class="lightbox doc-viewer"><div class="doc-loading">Loading…</div></div>';
      elMedia.classList.remove('hidden');
      docPagesReady.then(() => openPdf(title, src, page));
      return;
    }
    const doc = docPages[src];
    if (doc) return openDoc(title, src, doc, page || 1);
    docKey = null;
    elMediaTitle.textContent = title;
    const hash = page ? `#page=${page}&view=Fit` : '#view=FitH';
    elMediaOpen.href = encodeURI(src) + hash;
    elMediaBody.innerHTML = `<iframe class="pdf-frame" src="${encodeURI(src)}${hash}" title="${esc(title)}"></iframe>`;
    elMedia.classList.remove('hidden');
  }

  function openDoc(title, src, doc, page) {
    const n = doc.pages;
    let i = Math.min(Math.max(1, page), n);
    const base = title.replace(/ · page \d+$/, '');
    const url = (k) => `${encodeURI(doc.dir)}/${k}.jpg`;
    elMediaOpen.href = doc.url || encodeURI(src);
    elMediaBody.innerHTML = `<div class="lightbox doc-viewer"><img alt="" fetchpriority="high" decoding="async" />
      <div class="doc-loading">Loading page…</div>
      ${n > 1 ? `<button class="hero-nav prev" aria-label="Previous page"><svg class="icon"><use href="#i-chevron-left" /></svg></button><button class="hero-nav next" aria-label="Next page"><svg class="icon"><use href="#i-chevron-right" /></svg></button>` : ''}
      <span class="lb-count"></span></div>`;
    const box = elMediaBody.querySelector('.doc-viewer');
    const img = box.querySelector('img'), count = box.querySelector('.lb-count'), loading = box.querySelector('.doc-loading');
    img.onload = () => { loading.style.display = 'none'; };
    let retried = false, slow = 0;
    img.onerror = () => {
      if (!retried) { retried = true; img.src = url(i) + '?r=' + Date.now(); return; }
      loading.textContent = 'This page could not be loaded. Check the connection and try again.';
      loading.style.display = '';
    };
    const draw = () => {
      retried = false;
      clearTimeout(slow);
      slow = setTimeout(() => { if (!img.complete || !img.naturalWidth) loading.textContent = 'Loading page… (slow connection)'; }, 6000);
      loading.textContent = 'Loading page…';
      loading.style.display = img.complete && img.src.endsWith(`/${i}.jpg`) ? 'none' : '';
      img.src = url(i);
      img.alt = `${base}, page ${i}`;
      count.textContent = `Page ${i} / ${n}`;
      elMediaTitle.textContent = `${base} · page ${i}`;
      for (const k of [i + 1, i - 1]) if (k >= 1 && k <= n) new Image().src = url(k); // preload neighbours
    };
    const go = (d) => { i = ((i - 1 + d + n) % n) + 1; draw(); };
    docKey = go;
    box.querySelector('.prev')?.addEventListener('click', () => go(-1));
    box.querySelector('.next')?.addEventListener('click', () => go(1));
    let sx = null; // swipe on touch screens
    box.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; }, { passive: true });
    box.addEventListener('touchend', (e) => {
      if (sx == null) return;
      const dx = e.changedTouches[0].clientX - sx;
      sx = null;
      if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
    });
    draw();
    elMedia.classList.remove('hidden');
  }

  function openImages(title, imgs, start = 0) {
    docKey = null;
    let i = start;
    elMediaTitle.textContent = title;
    const draw = () => {
      elMediaOpen.href = encodeURI(imgs[i].src);
      elMediaBody.innerHTML = `<div class="lightbox"><img src="${encodeURI(imgs[i].src)}" alt="" />
        ${imgs.length > 1 ? `<button class="hero-nav prev"><svg class="icon"><use href="#i-chevron-left" /></svg></button><button class="hero-nav next"><svg class="icon"><use href="#i-chevron-right" /></svg></button>` : ''}
        <span class="lb-count">${i + 1} / ${imgs.length}</span></div>`;
      elMediaBody.querySelector('.prev')?.addEventListener('click', () => { i = (i - 1 + imgs.length) % imgs.length; draw(); });
      elMediaBody.querySelector('.next')?.addEventListener('click', () => { i = (i + 1) % imgs.length; draw(); });
    };
    draw();
    elMedia.classList.remove('hidden');
  }

  // ---- search options -------------------------------------------------------------------
  document.getElementById('search-options').innerHTML = allProjects.map((p) => `<option value="${esc(p.name)}">${esc(communities.find((c) => c.id === p.communityId).name)}</option>`).join('');
  function search(q) {
    q = q.trim().toLowerCase();
    if (!q) return false;
    const exact = allProjects.find((p) => p.name.toLowerCase() === q) || allProjects.find((p) => p.name.toLowerCase().startsWith(q)) || allProjects.find((p) => p.name.toLowerCase().includes(q));
    if (exact) { app.selectProject(exact.id); return true; }
    const c = communities.find((x) => x.name.toLowerCase().includes(q));
    if (c) { app.selectCommunity(c.id); return true; }
    return false;
  }

  renderLegend();
  // colour dots on the bedroom buttons, same colours as the homes
  document.querySelectorAll('#pp-beds button[data-beds]').forEach((b) => {
    const c = BED_COLORS[b.dataset.beds];
    if (c) b.insertAdjacentHTML('afterbegin', `<i class="bed-dot" style="background:${c}"></i>`);
  });
  return {
    homeFilter,
    filters,
    apply,
    renderLegend,
    renderCommunityHeader,
    showProject,
    showHome,
    shownId: () => shownId,
    markSelected,
    search,
    openPdf,
    openImages,
    byId,
  };
}

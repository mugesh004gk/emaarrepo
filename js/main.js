/**
 * Emaar Communities 3D — The Valley, Arabian Ranches III and Emaar South on one Dubai map.
 *
 * World: one shared projection (js/geo.js). The ground is the real Dubai map surface streamed as
 * satellite / street-map tiles (js/ground.js); nothing else is modelled except the homes.
 * Nara at The Valley (372 homes) runs on the reference Nara modules (js/nara/*), re-expressed in
 * the world frame (js/nara-frame.js). All 67 projects are selectable with their Emaar data.
 *
 * Rendering: two passes per frame (map surface + sky, then the 3D scene), frames are only drawn
 * when something changes, the sun's shadow map only updates when close enough to see shadows,
 * and every model is frustum-culled (see js/culling.js).
 */
import * as THREE from 'three';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

import { toWorld, toLatLng, localScale } from './geo.js';
import { createGround } from './ground.js';
import { createLabelLayer } from './labels.js';
import { createDistrictLayer, escapeHtml } from './districts.js';
import { createProjectsLayer, BED_COLORS as BED_COLORS_JS } from './projects-layer.js';
import { placeNaraInWorld } from './nara-frame.js';
import { createCommunityPicker, startCommunityRouting } from './ui/community-picker.js';
import { createScopeMask } from './scope-mask.js';
import { initProjectsUI } from './ui/projects-ui.js';
import { optimiseNaraWorld, createOcclusionCuller } from './culling.js';
import { createDetectedHomes } from './detected-homes.js';
import { createValleyDetail } from './valley-detail.js';
import { createHomeOverlay } from './home-overlay.js';
import { applySkyEnvironment, applyWallRelief } from './realism.js';
import { createHomeSelection, createPickIndex, apartmentBoxMatrix, naraBoxMatrix } from './home-select.js';

import { createMaterialLibrary } from './nara/materials.js';
import { createSolarSystem, bearingToCompass8 } from './nara/sun.js';
import { buildCommunityWorld } from './nara/community.js';
import { buildUnitInterior } from './nara/interior.js';
import { initFiltersModule } from './nara/filters.js';
import { initDetailsModule } from './nara/details.js';
import { initMinimapAndLabels } from './nara/minimap.js';
import { initNavigationModule } from './nara/navigation.js';
import { initShowHome } from './nara/showhome.js';

const COMPASS_ABBR = { North: 'N', 'North-East': 'NE', East: 'E', 'South-East': 'SE', South: 'S', 'South-West': 'SW', West: 'W', 'North-West': 'NW' };
const PERF = new URLSearchParams(location.search).has('perf');
const t0 = performance.now();
const tlog = (m) => PERF && console.log(`[t] ${m} ${Math.round(performance.now() - t0)}ms`);

async function boot() {
  window.APP_BOOTING = true;
  const elLoaderBar = document.getElementById('loader-bar');
  const elLoadingStatus = document.getElementById('loading-status');
  const elLoaderPct = document.getElementById('loader-pct');
  const setProgress = (pct, label) => {
    if (elLoaderBar) elLoaderBar.style.transform = `scaleX(${pct / 100})`;
    if (label && elLoadingStatus) elLoadingStatus.textContent = label;
    if (elLoaderPct) elLoaderPct.textContent = `${Math.round(pct)}%`;
  };
  const nextFrame = () => new Promise((r) => { let d = false; const go = () => { if (!d) { d = true; setTimeout(r, 0); } }; requestAnimationFrame(go); setTimeout(go, 80); });

  setProgress(6, 'Loading the communities');
  const [projectsData, districts, naraData, floorplans] = await Promise.all([
    fetch('data/projects.json', { cache: 'no-store' }).then((r) => r.json()),
    fetch('data/districts.json', { cache: 'no-store' }).then((r) => r.json()),
    fetch('data/nara_data.json', { cache: 'no-store' }).then((r) => r.json()),
    fetch('data/floorplans.json', { cache: 'no-store' }).then((r) => r.json()),
  ]);
  const homesDetected = await fetch('data/homes_detected.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const siteData = await fetch('data/site.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const greensData = await fetch('data/greens.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const projectStatus = await fetch('data/project_status.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  for (const c of projectsData.communities) for (const p of c.projects) p.buildStatus = projectStatus[p.id] || null;
  // official number of homes per project (only where a developer document states it)
  const unitCounts = await fetch('data/unit_counts.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  for (const c of projectsData.communities) for (const p of c.projects) p.unitCount = unitCounts?.projects?.[p.id] || null;
  if (homesDetected) {
    const byId = new Map(projectsData.communities.flatMap((c) => c.projects.map((p) => [p.id, p])));
    for (const rows of Object.values(homesDetected.communities)) for (const r of rows) {
      const p = byId.get(r.project);
      if (!p) continue;
      if (r.kind === 'apartment') p.detectedBuildings = (p.detectedBuildings || 0) + 1;
      else p.detectedHomes = (p.detectedHomes || 0) + r.units;
    }
  }
  const communities = projectsData.communities;
  const fit = placeNaraInWorld(naraData);
  tlog(`data loaded; Nara fit ${JSON.stringify(fit)}`);
  setProgress(20, 'Preparing the map of Dubai');
  await nextFrame();

  // ---- renderer, scenes, camera ----------------------------------------------------------
  // Create the 3D context with fallbacks: laptops with integrated / blocklisted GPUs often refuse the
  // high-performance + antialias + reversed-depth request but accept a plainer one. Each attempt uses a
  // fresh canvas (a canvas keeps the first context it was given).
  const ATTEMPTS = [
    { antialias: true, powerPreference: 'high-performance', reversedDepthBuffer: true },
    { antialias: true, powerPreference: 'default' },
    { antialias: false, powerPreference: 'low-power', failIfMajorPerformanceCaveat: false },
  ];
  let canvas = document.getElementById('webgl-canvas');
  let renderer = null, lowPower = false, lastErr = null;
  const FORCE_LITE = new URLSearchParams(location.search).has('lite');
  for (let i = 0; i < ATTEMPTS.length && !renderer && !FORCE_LITE; i++) {
    if (i > 0) { const c2 = canvas.cloneNode(false); canvas.replaceWith(c2); canvas = c2; }
    try { renderer = new THREE.WebGLRenderer({ canvas, ...ATTEMPTS[i] }); lowPower = i > 0; }
    catch (e) { lastErr = e; console.warn('WebGL attempt', i + 1, 'failed:', e.message); }
  }
  if (!renderer || FORCE_LITE) { const e = new Error('WEBGL_UNAVAILABLE'); e.cause = lastErr; throw e; }
  // weaker GPUs: smaller drawing buffer and shadow map
  const gpuInfo = (() => { try { const gl = renderer.getContext(); const ext = gl.getExtension('WEBGL_debug_renderer_info'); return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : ''; } catch { return ''; } })();
  if (/swiftshader|llvmpipe|software|microsoft basic/i.test(gpuInfo) || renderer.capabilities.maxTextureSize < 8192) lowPower = true;
  window.APP_GPU = { gpuInfo, lowPower };
  canvas.addEventListener('webglcontextlost', (ev) => {
    ev.preventDefault();
    // the GPU dropped the 3D view (out of graphics memory / driver reset): reopen as the map version
    location.replace(location.pathname + '?lite');
  });
  const isPhone = () => window.innerWidth <= 860;
  const pixelRatio = () => Math.min(window.devicePixelRatio || 1, lowPower ? 1 : 2);
  renderer.setPixelRatio(pixelRatio());
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.autoClear = false;

  const groundScene = new THREE.Scene();
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.5; // softer fill on shaded facades
  applySkyEnvironment(renderer, scene, 0.55); // real sky light replaces the studio room once loaded

  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1, 200000);
  const controls = new MapControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.09;
  controls.zoomToCursor = true;
  controls.screenSpacePanning = false;
  controls.maxPolarAngle = THREE.MathUtils.degToRad(84);
  controls.minDistance = 6;
  controls.maxDistance = 120000;
  controls.zoomSpeed = 1.15;

  // ---- materials, sun, sky, fog ----------------------------------------------------------
  const mats = createMaterialLibrary(renderer);
  applyWallRelief([mats.wallWhite, mats.wallOffWhite, mats.wallCharmWhite, mats.wallAstonGrey]);
  const solar = createSolarSystem(scene, mats);
  solar.sunLight.shadow.mapSize.set(lowPower ? 2048 : 4096, lowPower ? 2048 : 4096); // crisp shadows close up (smaller on weak GPUs)
  solar.sunLight.shadow.radius = 2.5;
  groundScene.add(solar.skyMesh);
  solar.skyMesh.renderOrder = -1000;
  solar.skyMesh.frustumCulled = false;
  solar.skyMesh.material.depthTest = false;
  scene.fog = new THREE.Fog(0xe6dfd3, 4000, 30000);
  groundScene.fog = scene.fog;

  // ---- ground (Dubai map surface) ----------------------------------------------------------
  let activeUntil = 0;
  const invalidate = (ms = 120) => { activeUntil = Math.max(activeUntil, performance.now() + ms); };
  // a texture / sky map that finishes downloading while the camera is still gets drawn straight away
  const prevProgress = THREE.DefaultLoadingManager.onProgress;
  THREE.DefaultLoadingManager.onProgress = (...a) => { prevProgress?.(...a); invalidate(300); };
  const ground = createGround(renderer, groundScene, scene, () => invalidate(300));

  // ---- labels, district map, projects --------------------------------------------------------
  const labels = createLabelLayer(document.getElementById('viewport-container'));
  const districtLayer = createDistrictLayer(groundScene, districts, communities, labels);

  const state = {
    data: naraData, scene, camera, renderer, orbitControls: controls, mats, solar,
    buildUnitInterior,
    cameraMode: 'aerial', colorMode: 'realistic',
    selectedUnitNo: null, matchingUnitSet: new Set(naraData.units.map((u) => u.unit)), filterActive: false,
    activeInteriorUnitNo: null, activeInteriorCtrl: null, cutawayFloor: 'both',
    sunHour: 16.0, sunDayOfYear: 294, flyAnim: null,
    communityId: null, projectId: null,
    left: 'projects', right: 'project', leftOpen: !isPhone(), rightOpen: false,
  };

  const app = { communities, floorplans, notes: projectsData.notes, state, invalidate };
  const projectsLayer = createProjectsLayer(scene, communities, labels, (pid, cid) => (pid ? selectProject(pid) : selectCommunity(cid)));
  app.projectsLayer = projectsLayer;

  setProgress(34, 'Building Nara: 372 homes on their plots');
  await nextFrame();

  // ---- Nara at The Valley ---------------------------------------------------------------------
  const community = buildCommunityWorld(scene, naraData, mats);
  state.community = community;
  // Nara's own roads, trees, parks and amenities are shown (toggle under Map)
  tlog('nara built');
  setProgress(62, 'Optimising draw calls and culling');
  await nextFrame();
  // ?nobatch renders Nara's original meshes (used to prove batching changes no pixel)
  const NOBATCH = new URLSearchParams(location.search).has('nobatch');
  const naraOpt = NOBATCH ? { stats: { meshesBefore: 0, batches: 0 } } : optimiseNaraWorld(community, camera);
  const occlusion = NOBATCH
    ? { beforeRender() {}, afterRender() {}, stats: { total: 0, culled: 0 }, setForceOff() {} }
    : createOcclusionCuller(renderer, camera, naraOpt);
  if (NOBATCH) {
    const orig = community.updateUnitVisualStates;
    community.updateUnitVisualStates = (o) => { orig(o); for (const r of community.unitRecords.values()) r.highlightMesh.visible = r.highlightMesh.material.opacity > 0.001; };
    for (const r of community.unitRecords.values()) r.highlightMesh.visible = false;
  }
  tlog(`nara optimised ${JSON.stringify(naraOpt.stats)}`);
  // ---- homes detected from satellite imagery (other projects), built in Nara's townhouse style ----
  const projectsById = new Map(communities.flatMap((c) => c.projects.map((p) => [p.id, p])));
  const detected = homesDetected ? createDetectedHomes(scene, homesDetected, projectsById, mats) : null;
  if (detected) tlog(`detected homes ${JSON.stringify(detected.stats)}`);
  // Every community at Nara detail near the camera: homes and plots, streets, street trees, parks
  const detailRoot = new THREE.Group();
  detailRoot.name = 'CommunityDetail';
  scene.add(detailRoot);
  // Eden's roads as traced on Nara's site plan (outside Nara itself), where no street is mapped yet
  function siteRoadsAroundNara(existing) {
    const segs = [];
    for (const st of existing) {
      if (st.cls === 'path') continue;
      for (let i = 0; i + 1 < st.pts.length; i++) { const a = toWorld(st.pts[i][1], st.pts[i][0]), b = toWorld(st.pts[i + 1][1], st.pts[i + 1][0]); segs.push([a.x, a.z, b.x, b.z]); }
    }
    const near = (x, z) => segs.some(([ax, az, bx, bz]) => { const vx = bx - ax, vz = bz - az, l2 = vx * vx + vz * vz || 1; const t = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / l2)); return Math.hypot(x - ax - vx * t, z - az - vz * t) < 8; });
    const out = [];
    for (const c of naraData.meta.outsideRoads || []) {
      let run = [];
      const flush = () => { if (run.length >= 2) out.push({ cls: 'minor', width: c.width || 7.3, source: 'siteplan', pts: run.map(([x, z]) => { const ll = toLatLng(x, z); return [ll.lng, ll.lat]; }) }); run = []; };
      for (let i = 0; i < c.pts.length; i++) {
        const [x, z] = c.pts[i];
        if (near(x, z)) flush(); else run.push([x, z]);
      }
      flush();
    }
    return out;
  }
  let valleyStreets = null;
  const details = detected && siteData
    ? Object.keys(homesDetected.communities).filter((cid) => siteData.communities[cid]).map((cid) => createValleyDetail(detailRoot, {
        naraData, mats, projectsById, massing: detected, communityId: cid,
        rows: homesDetected.communities[cid].filter((r) => r.kind !== 'apartment'),
        streets: cid === 'the-valley' ? (valleyStreets = [...siteData.communities[cid].streets, ...siteRoadsAroundNara(siteData.communities[cid].streets)]) : siteData.communities[cid].streets,
        // only lawns verified in the imagery (OpenStreetMap 'grass' areas include open desert scrub)
        greens: greensData?.communities?.[cid] || [],
      }))
    : [];
  const valleyDetail = details.length ? {
    group: detailRoot,
    units: details.flatMap((d) => d.units),
    update: (cam) => details.map((d) => d.update(cam)).some(Boolean),
    pickables: () => details.filter((d) => d.group.visible).flatMap((d) => d.pickables()),
    unitFromHit: (hit) => { for (const d of details) { const u = d.unitFromHit(hit); if (u) return u; } return null; },
    get stats() { return details.map((d) => d.stats); },
  } : null;
  if (valleyDetail) tlog(`community detail ${JSON.stringify(valleyDetail.stats)}`);
  // homes actually standing in 3D per project (after the road / overlap checks), for the project panel
  if (valleyDetail) {
    const placed = new Map();
    for (const u of valleyDetail.units) placed.set(u.project, (placed.get(u.project) || 0) + 1);
    for (const c of communities) for (const p of c.projects) if (!p.modelled && placed.has(p.id)) p.homesPlaced = placed.get(p.id);
  }
  // official unit numbers (from the developer's cluster map) on the houses when close
  if (valleyDetail) {
    const ov = new THREE.Vector3();
    for (const u of valleyDetail.units) {
      if (u.unitNo == null) continue;
      ov.set(0, 0.5, 0).applyMatrix4(u.overlayMatrix);
      labels.add({ x: ov.x, y: 9.5, z: ov.z, className: 'lbl-unit', html: `<span>${u.unitNo}</span>`, priority: 4, minDist: 0, maxDist: 150 });
    }
  }
  // street names (OpenStreetMap) as labels near the ground
  for (const [cid, v] of Object.entries(siteData?.communities || {})) {
    const seen = new Set();
    for (const n of v.names) {
      const key = `${n.name}|${n.at[0].toFixed(3)},${n.at[1].toFixed(3)}`;
      if (seen.has(key) || /access/i.test(n.name)) continue;
      seen.add(key);
      const w = toWorld(n.at[1], n.at[0]);
      labels.add({ x: w.x, y: 1, z: w.z, className: 'lbl-street', html: `<span>${n.name}</span>`, priority: 30, minDist: 0, maxDist: 1800 });
    }
  }
  // bedroom / status colours and filter highlight for every non-Nara home
  const overlayHomes = [
    ...(valleyDetail ? valleyDetail.units : []),
    ...(detected ? detected.homes.filter((h) => h.overlayMatrix && !details.some((d) => d.units.length && d.units[0].row && h.community === d.communityId)) : []),
  ];
  const homeOverlay = createHomeOverlay(scene, overlayHomes, projectsById);
  app.homesDetected = homesDetected;
  const naraCenter = new THREE.Vector3(naraData.meta.worldCenter.x, 0, naraData.meta.worldCenter.z);
  const unitsByNo = new Map(naraData.units.map((u) => [u.unit, u]));

  // ---- home hover / selection: one box per home for picking, amber outline for the chosen one ----------
  const selection = createHomeSelection(scene);
  const naraEntries = new Map();
  for (const [uno, rec] of community.unitRecords) {
    const u = rec.unit;
    naraEntries.set(uno, { nara: true, unitNo: uno, project: 'nara', beds: u.bedrooms, kind: 'townhouse', design: u.design, plan: u.planType, matrix: naraBoxMatrix(rec.highlightMesh) });
  }
  const pickEntries = [
    ...homeOverlay.homes.map((h) => ({ home: h, project: h.project, matrix: h.overlayMatrix })),
    ...(detected ? detected.apartments.map((a) => ({ home: { project: a.project, apartment: true, row: a, community: a.community }, project: a.project, matrix: apartmentBoxMatrix(a) })) : []),
    ...naraEntries.values(),
  ];
  const pickIndex = createPickIndex(pickEntries);
  state.home = null;

  // ---- camera poses & flights -------------------------------------------------------------------
  const tmpV = new THREE.Vector3();
  function currentPose() {
    const off = tmpV.copy(camera.position).sub(controls.target);
    const dist = off.length();
    return { target: controls.target.clone(), dist, polar: Math.acos(THREE.MathUtils.clamp(off.y / dist, -1, 1)), azimuth: Math.atan2(off.x, off.z) };
  }
  function poseToPosition(p, out = new THREE.Vector3()) {
    return out.set(p.target.x + p.dist * Math.sin(p.polar) * Math.sin(p.azimuth), p.target.y + p.dist * Math.cos(p.polar), p.target.z + p.dist * Math.sin(p.polar) * Math.cos(p.azimuth));
  }
  /** Earth-style flight: rises for long hops, eases in and out, keeps the heading unless told. */
  function flyTo({ target, dist, polar, azimuth, duration }) {
    if (state.cameraMode !== 'aerial' && state.cameraMode !== 'cutaway') setCameraMode('aerial', { noFly: true });
    const from = currentPose();
    const to = { target: target.clone(), dist, polar: polar ?? Math.min(from.polar, THREE.MathUtils.degToRad(58)), azimuth: azimuth ?? from.azimuth };
    let dAz = to.azimuth - from.azimuth;
    dAz = ((dAz + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    to.azimuth = from.azimuth + dAz;
    const travel = from.target.distanceTo(to.target);
    const peak = Math.max(from.dist, to.dist, travel * 0.75);
    const lf = Math.log(from.dist), lt = Math.log(to.dist), lm = (lf + lt) / 2;
    state.flyAnim = { t: 0, duration: duration ?? THREE.MathUtils.clamp(0.9 + 0.42 * Math.log2(1 + travel / 800), 0.9, 3.4), from, to, hump: Math.max(0, Math.log(peak) - lm), lf, lt };
    invalidate(4000);
  }
  function stepFlight(dt) {
    const fa = state.flyAnim;
    fa.t = Math.min(1, fa.t + dt / fa.duration);
    const t = fa.t;
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const p = {
      target: fa.from.target.clone().lerp(fa.to.target, e),
      dist: Math.exp(fa.lf + (fa.lt - fa.lf) * e + fa.hump * Math.sin(Math.PI * t)),
      polar: fa.from.polar + (fa.to.polar - fa.from.polar) * e,
      azimuth: fa.from.azimuth + (fa.to.azimuth - fa.from.azimuth) * e,
    };
    // long hops look down more in mid-flight, then reach the requested tilt on arrival
    if (fa.hump > 0) { const sn = Math.sin(Math.PI * t); p.polar = Math.min(p.polar, p.polar * (1 - sn) + 0.35 * sn); }
    controls.target.copy(p.target);
    poseToPosition(p, camera.position);
    camera.lookAt(controls.target);
    if (fa.t >= 1) { state.flyAnim = null; controls.update(); updateGuide(); }
  }
  function flyToWorldPoint(wx, wz, dist = 120) { flyTo({ target: new THREE.Vector3(wx, 2.5, wz), dist: dist * 1.2, polar: 0.92 }); }
  function flyToUnit(unitNo) {
    const u = unitsByNo.get(Number(unitNo));
    if (!u) return;
    const fb = THREE.MathUtils.degToRad(u.frontBearing);
    flyTo({ target: new THREE.Vector3(u.wx, 3.2, u.wz), dist: 46, polar: 0.98, azimuth: Math.atan2(Math.sin(fb) * 34 + 10, -Math.cos(fb) * 34 + 10) });
  }
  function boundsOf(projects) {
    const b = new THREE.Box3();
    for (const p of projects) if (p.world) b.expandByPoint(tmpV.set(p.world.x, 0, p.world.z));
    return b;
  }
  function fitDistance(box, pad = 1.25) {
    const size = box.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.z * camera.aspect * 0.8, 600) * pad;
    return span / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / Math.max(1, camera.aspect * 0.75);
  }

  // ---- panels (left: projects | Nara homes, right: project | home) ------------------------------
  const elProjectsPanel = document.getElementById('projects-panel');
  const elFiltersPanel = document.getElementById('filters-panel');
  const elProjectPanel = document.getElementById('project-panel');
  const elDetailsPanel = document.getElementById('details-panel');
  const btnReopenFilters = document.getElementById('btn-reopen-filters');
  const btnReopenDetails = document.getElementById('btn-reopen-details');
  function applyPanels() {
    const sh = state.cameraMode === 'showhome';
    elProjectsPanel.classList.toggle('slot-hidden', state.left !== 'projects');
    elFiltersPanel.classList.toggle('slot-hidden', state.left !== 'homes');
    elProjectPanel.classList.toggle('slot-hidden', state.right !== 'project');
    elDetailsPanel.classList.toggle('slot-hidden', state.right !== 'unit');
    for (const el of [elProjectsPanel, elFiltersPanel]) el.classList.toggle('panel-collapsed', !state.leftOpen || sh);
    for (const el of [elProjectPanel, elDetailsPanel]) el.classList.toggle('panel-collapsed', !state.rightOpen || sh);
    document.body.classList.toggle('filters-collapsed', !state.leftOpen);
    document.body.classList.toggle('details-collapsed', !state.rightOpen);
    const hasRight = (state.right === 'project' && state.projectId) || (state.right === 'unit' && state.selectedUnitNo);
    btnReopenFilters.classList.toggle('hidden', state.leftOpen || sh);
    btnReopenDetails.classList.toggle('hidden', state.rightOpen || sh || !hasRight);
  }
  function setPanelsState({ filtersOpen, detailsOpen }) {
    if (filtersOpen !== undefined) state.leftOpen = filtersOpen;
    if (detailsOpen !== undefined) state.rightOpen = detailsOpen;
    if (isPhone() && filtersOpen && detailsOpen) state.rightOpen = false;
    applyPanels();
  }
  const toggleLeft = (v) => { const open = v ?? !state.leftOpen; if (isPhone() && open) state.rightOpen = false; state.leftOpen = open; applyPanels(); };
  const toggleRight = (v) => { const open = v ?? !state.rightOpen; if (isPhone() && open) state.leftOpen = false; state.rightOpen = open; applyPanels(); };
  const collapseBothPanels = () => setPanelsState({ filtersOpen: false, detailsOpen: false });
  Object.assign(state, {
    setPanelsState, collapseBothPanels,
    toggleFiltersPanel: (v) => { if (v) state.left = 'homes'; toggleLeft(v); },
    toggleDetailsPanel: (v) => toggleRight(v),
  });
  app.toggleRightPanel = toggleRight;

  // ---- modes --------------------------------------------------------------------------------
  let navModule, showHome, detailsModule, filtersModule, minimapModule;
  function setCameraMode(mode, opts = {}) {
    const leavingShowHome = state.cameraMode === 'showhome' && mode !== 'showhome';
    if (leavingShowHome) showHome.exit();
    if (mode !== 'aerial' && mode !== 'showhome') {
      // street / inside / cut-away are available for the modelled homes (Nara)
      if (!state.selectedUnitNo) selectUnit(233, { flyTo: false, openDetails: false });
    }
    if (mode === 'showhome') {
      const u = unitsByNo.get(state.selectedUnitNo || 233);
      collapseBothPanels();
      state.flyAnim = null;
      controls.enabled = false;
      state.cameraMode = 'showhome';
      navModule.syncModeUI();
      showHome.enter(u ? u.planType : null);
    } else if (mode === 'aerial') {
      const wasAway = state.cameraMode !== 'aerial';
      const fromExplore = wasAway && state.exploring;
      state.exploring = false;
      state.cameraMode = 'aerial';
      controls.enabled = true;
      navModule.syncModeUI();
      if (fromExplore) {
        // rise up over the spot where the walk / drive ended
        const fwd = new THREE.Vector3(); camera.getWorldDirection(fwd); fwd.y = 0; fwd.normalize();
        controls.target.set(camera.position.x + fwd.x * 30, 0, camera.position.z + fwd.z * 30);
        flyTo({ target: controls.target.clone(), dist: 240, polar: THREE.MathUtils.degToRad(55), duration: 1.6 });
        opts = { ...opts, noFly: true };
      }
      if (wasAway && !isPhone()) setPanelsState({ filtersOpen: true, detailsOpen: !!(state.projectId || state.selectedUnitNo) && !fromExplore });
      if (wasAway && !opts.noFly && state.selectedUnitNo) flyToUnit(state.selectedUnitNo);
      else if (!opts.noFly) {
        if (state.selectedUnitNo && state.left === 'homes') flyToUnit(state.selectedUnitNo);
        else if (state.projectId) flyToProject(state.projectId);
      }
    } else if (mode === 'street') {
      collapseBothPanels();
      navModule.enterStreetMode(state.selectedUnitNo || 233, false);
    } else if (mode === 'interior' || mode === 'cutaway') {
      collapseBothPanels();
      navModule.enterHomeInterior(state.selectedUnitNo || 233, mode);
    }
    document.body.dataset.mode = state.cameraMode;
    updateExploreBar();
    if (state.cameraMode !== 'aerial') { setHover(null); }
    applyPanels();
    updateGuide();
    invalidate(600);
  }

  function selectUnit(unitNo, { flyTo: doFly = true, openDetails } = {}) {
    const uno = Number(unitNo);
    const u = unitsByNo.get(uno);
    if (!u) return null;
    if (doFly && state.cameraMode === 'showhome') setCameraMode('aerial', { noFly: true });
    state.selectedUnitNo = uno;
    if (state.communityId !== 'the-valley') selectCommunity('the-valley', { fly: false });
    state.right = 'unit';
    state.projectId = 'nara';
    projectsLayer.setSelected('nara');
    detailsModule.showUnitDetails(uno);
    filtersModule.refreshVisuals();
    filtersModule.renderUnitsList(state.matchingUnits || naraData.units);
    document.getElementById('reopen-details-kind').textContent = 'Unit';
    document.getElementById('reopen-unit-label').textContent = `#${uno}`;
    const open = openDetails !== undefined ? openDetails : doFly && state.cameraMode === 'aerial' && !isPhone();
    if (open) toggleRight(true);
    else applyPanels();
    if (doFly) {
      if (state.cameraMode === 'street') navModule.enterStreetMode(uno, false);
      else if (state.cameraMode === 'interior' || state.cameraMode === 'cutaway') navModule.enterHomeInterior(uno, state.cameraMode);
      else flyToUnit(uno);
    }
    // the same amber outline and roof tag as every other home
    state.home = naraEntries.get(uno) || null;
    selection.setSelected(state.home ? state.home.matrix : null);
    updateGuide();
    invalidate(300);
    return u;
  }

  // ---- community / project selection ------------------------------------------------------------
  function selectCommunity(id, opts = {}) {
    if (!id) { showPicker(opts); return; } // "all communities" = the start screen
    const fly = opts.fly ?? true;
    if (scope?.id !== id) setScope(id);
    picker?.hide();
    updateExploreBar();
    if (opts.push !== false) routing?.go(id);
    state.communityId = id;
    districtLayer.highlight(id);
    projectsUI.renderCommunityHeader();
    projectsUI.apply();
    document.getElementById('brand-sub').textContent = id ? communities.find((c) => c.id === id).name : 'Communities · Dubai';
    if (state.left !== 'projects') { state.left = 'projects'; }
    if (!isPhone()) state.leftOpen = true;
    applyPanels();
    updateGuide();
    if (fly) {
      if (id && !opts.noIntro) playCommunityIntro(id);
      else { stopIntro(); flyToCommunity(id); }
    }
  }

  /** Shift a target so it lands in the middle of the screen area not covered by the side panels. */
  function panelOffsetTarget(target, dist, azimuth, polar = currentPose().polar) {
    if (isPhone()) {
      // a bottom sheet covers the lower part of the screen: put the target in the upper part
      if (!state.rightOpen && !state.leftOpen) return target;
      const worldPerPx = (2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / window.innerHeight;
      const shift = (0.24 * window.innerHeight * worldPerPx) / Math.max(0.35, Math.cos(polar));
      return target.clone().add(new THREE.Vector3(Math.sin(azimuth), 0, Math.cos(azimuth)).multiplyScalar(shift));
    }
    const css = getComputedStyle(document.documentElement);
    const lw = state.leftOpen ? parseFloat(css.getPropertyValue('--left-w')) + 12 : 0;
    const rw = state.rightOpen ? parseFloat(css.getPropertyValue('--right-w')) + 12 : 0;
    const px = (lw - rw) / 2;
    const worldPerPx = (2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / window.innerHeight;
    return target.clone().add(new THREE.Vector3(-Math.cos(azimuth), 0, Math.sin(azimuth)).multiplyScalar(px * worldPerPx));
  }

  function flyToCommunity(id) {
    const list = id ? communities.find((c) => c.id === id).projects : communities.flatMap((c) => c.projects);
    const box = boundsOf(list);
    const dist = fitDistance(box, id ? 1.45 : 1.2);
    flyTo({ target: panelOffsetTarget(box.getCenter(new THREE.Vector3()), dist, 0), dist, polar: THREE.MathUtils.degToRad(id ? 50 : 38), azimuth: 0 });
  }

  // ---- community intro: the map first, then the 3D homes rise as the camera tilts down -------------
  // 1. top-down over the community (just the Dubai map, homes lowered into the ground)
  // 2. hold, then tilt and descend while the homes grow up out of the ground
  // 3. settle on a close oblique view of the showcase project, with a slow orbit
  // Any drag, scroll or click stops the intro and shows everything at once.
  const revealGroups = () => [valleyDetail?.group, detected?.group, naraOpt.batchGroup, community.homesGroup, ...Object.values(community.landscape)].filter(Boolean);
  const intro = { steps: [], holdUntil: 0, reveal: 1, revealFrom: 1, revealTo: 1, revealT0: 0, revealDur: 1, orbitUntil: 0 };
  function setReveal(v) {
    intro.reveal = v;
    const k = Math.max(0.001, v);
    for (const g of revealGroups()) {
      g.scale.y = k;
      g.visible = v > 0.002;
    }
    homeOverlay.mesh.scale.y = k; // colours rise with the homes (visibility stays with the colour mode)
    for (const g of Object.values(community.landscape)) g.visible = g.visible && document.getElementById('chk-landscape').checked;
    renderer.shadowMap.needsUpdate = true;
  }
  function animateReveal(to, dur) {
    intro.revealFrom = intro.reveal;
    intro.revealTo = to;
    intro.revealT0 = performance.now();
    intro.revealDur = dur * 1000;
  }
  function stopIntro() {
    if (!intro.steps.length && intro.reveal === 1 && !intro.orbitUntil) return;
    intro.steps = [];
    intro.orbitUntil = 0;
    if (intro.revealTo !== 1 || intro.reveal < 1) animateReveal(1, 0.5);
  }
  function playCommunityIntro(id) {
    const c = communities.find((x) => x.id === id);
    const box = boundsOf(c.projects.filter((p) => p.world));
    const centre = box.getCenter(new THREE.Vector3());
    const dist = fitDistance(box, 1.35);
    const show = id === 'the-valley' ? naraCenter.clone() : centre.clone();
    stopIntro();
    if (!isPhone()) { state.leftOpen = false; state.rightOpen = false; applyPanels(); intro.panelsHidden = true; } // full screen for the intro
    animateReveal(0, 0.6); // lower the homes while we fly to the map view
    intro.steps = [
      { fly: { target: panelOffsetTarget(centre, dist, 0), dist, polar: 0.03, azimuth: 0, duration: 2.0 }, hold: 900 },
      { fly: { target: centre.clone().lerp(show, 0.5), dist: dist * 0.55, polar: THREE.MathUtils.degToRad(48), azimuth: 0.45, duration: 2.6 }, reveal: 2.4, hold: 300 },
      { fly: { target: show, dist: 560, polar: THREE.MathUtils.degToRad(62), azimuth: 0.85, duration: 2.6 }, hold: 0, orbit: 9000 },
    ];
    intro.holdUntil = 0;
    nextIntroStep();
  }
  function restorePanelsAfterIntro() {
    if (intro.panelsHidden) {
      intro.panelsHidden = false;
      if (!isPhone()) { state.leftOpen = true; applyPanels(); }
      updateGuide();
    }
  }
  function nextIntroStep() {
    const st = intro.steps.shift();
    if (!st) { restorePanelsAfterIntro(); return; }
    flyTo(st.fly);
    if (st.reveal) animateReveal(1, st.reveal);
    intro.current = st;
  }
  function stepIntro(now, dt) {
    if (intro.reveal !== intro.revealTo) {
      const t = Math.min(1, (now - intro.revealT0) / intro.revealDur);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      setReveal(intro.revealFrom + (intro.revealTo - intro.revealFrom) * e);
      if (t >= 1) setReveal(intro.revealTo);
      invalidate(100);
    }
    if (!state.flyAnim && intro.current) {
      const st = intro.current;
      if (!intro.holdUntil) intro.holdUntil = now + (st.hold || 0);
      if (now >= intro.holdUntil) {
        intro.holdUntil = 0;
        intro.current = null;
        if (st.orbit) intro.orbitUntil = now + st.orbit;
        nextIntroStep();
      }
    }
    if (intro.orbitUntil && !state.flyAnim) {
      if (now > intro.orbitUntil) intro.orbitUntil = 0;
      else {
        const off = camera.position.clone().sub(controls.target);
        off.applyAxisAngle(new THREE.Vector3(0, 1, 0), dt * 0.06);
        camera.position.copy(controls.target).add(off);
        camera.lookAt(controls.target);
        invalidate(100);
      }
    }
  }
  const cancelIntro = () => { if (intro.steps.length || intro.current || intro.orbitUntil || intro.reveal < 1) { intro.current = null; stopIntro(); } restorePanelsAfterIntro(); };

  function flyToProject(id) {
    const p = projectsUI.byId.get(id);
    if (!p) return;
    if (!p.world && !p.buildStatus?.centroid) { flyToCommunity(p.communityId); return; } // pin flagged as unreliable
    const az = currentPose().azimuth;
    // built projects: fly to the middle of their homes (Emaar's pins sit ~300 m off their homes)
    const cen = p.buildStatus?.centroid;
    if (!p.modelled && cen) {
      const w = toWorld(cen[0], cen[1]);
      flyTo({ target: panelOffsetTarget(new THREE.Vector3(w.x, 0, w.z), 520, az, THREE.MathUtils.degToRad(55)), dist: 520, polar: THREE.MathUtils.degToRad(55) });
      return;
    }
    if (p.modelled) flyTo({ target: panelOffsetTarget(naraCenter.clone().setY(2), 820, az, THREE.MathUtils.degToRad(52)), dist: 820, polar: THREE.MathUtils.degToRad(52) });
    else flyTo({ target: panelOffsetTarget(new THREE.Vector3(p.world.x, 0, p.world.z), 720, az, THREE.MathUtils.degToRad(55)), dist: 720, polar: THREE.MathUtils.degToRad(55) });
  }

  function selectProject(id, { fly = true, keepHome = false } = {}) {
    const p = projectsUI.byId.get(id);
    if (!p) return;
    if (fly) cancelIntro();
    if (!keepHome) clearHome({ silent: true });
    if (state.cameraMode === 'showhome') setCameraMode('aerial', { noFly: true });
    if (state.communityId !== p.communityId) selectCommunity(p.communityId, { fly: false });
    const same = state.projectId === id && state.right === 'project' && projectsUI.shownId() === id;
    state.projectId = id;
    state.right = 'project';
    if (!same) {
      // only rebuild the panel when the project changes (clicking homes of one project stays instant)
      projectsLayer.setSelected(id);
      projectsUI.showProject(id);
      projectsUI.markSelected(id);
    }
    if (!isPhone()) state.rightOpen = true;
    else { state.rightOpen = true; state.leftOpen = false; }
    applyPanels();
    updateGuide();
    if (fly) flyToProject(id);
  }

  function openNaraHomes() {
    state.left = 'homes';
    state.leftOpen = true;
    if (isPhone()) state.rightOpen = false;
    applyPanels();
    if (camera.position.distanceTo(naraCenter) > 2500) flyToProject('nara');
  }

  // ---- one community at a time: start screen -> that community's own map -------------------------
  // Inside a community the camera stays over it (pan fenced to its area, zoom-out capped), and the
  // other communities' pins, names and outlines are hidden: no all-of-Dubai view.
  let scope = null;
  let picker = null;
  let routing = null;
  const scopeMask = createScopeMask(groundScene);
  const pointInRing = (x, z, r) => {
    let ins = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) if (r[i][1] > z !== r[j][1] > z && x < ((r[j][0] - r[i][0]) * (z - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) ins = !ins;
    return ins;
  };
  function communityPoints(id) {
    const c = communities.find((x) => x.id === id);
    const pts = [];
    for (const h of detected?.homes || []) {
      if (h.community !== id) continue;
      if (Number.isFinite(h.wx)) pts.push([h.wx, h.wz]);
      else if (h.row?.lat) { const w = toWorld(h.row.lat, h.row.lng); pts.push([w.x, w.z]); }
    }
    if (id === 'the-valley') for (const u of naraData.units) if (Number.isFinite(u.wx)) pts.push([u.wx, u.wz]);
    // its streets (every ~80 m) and its parks, lawns and golf course (outline + inside), so open green
    // areas of the community are not covered
    for (const st of siteData?.communities?.[id]?.streets || []) {
      for (let i = 0; i + 1 < st.pts.length; i++) {
        const a = toWorld(st.pts[i][1], st.pts[i][0]), b2 = toWorld(st.pts[i + 1][1], st.pts[i + 1][0]);
        const n = Math.max(1, Math.ceil(Math.hypot(b2.x - a.x, b2.z - a.z) / 80));
        for (let k = 0; k <= n; k++) pts.push([a.x + ((b2.x - a.x) * k) / n, a.z + ((b2.z - a.z) * k) / n]);
      }
    }
    for (const g of greensData?.communities?.[id] || []) {
      const ring = g.ring.map(([lng, lat]) => { const w = toWorld(lat, lng); return [w.x, w.z]; });
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const [x, z] of ring) { pts.push([x, z]); x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
      for (let x = x0; x <= x1; x += 120) for (let z = z0; z <= z1; z += 120) if (pointInRing(x, z, ring)) pts.push([x, z]);
    }
    for (const p of c.projects) {
      if (p.world && !p.pinFlag) pts.push([p.world.x, p.world.z]);
      if (p.buildStatus?.centroid) { const w = toWorld(p.buildStatus.centroid[0], p.buildStatus.centroid[1]); pts.push([w.x, w.z]); }
    }
    return pts;
  }
  function setScope(id) {
    if (!id) {
      scope = null;
      controls.maxDistance = 120000;
      controls.maxPolarAngle = THREE.MathUtils.degToRad(84);
    } else {
      const c = communities.find((x) => x.id === id);
      const core = boundsOf(c.projects);
      // the area people can look at: the community's projects and homes (+700 m), not the open desert
      // inside its official boundary
      const box = core.clone();
      for (const p of c.projects) if (p.buildStatus?.centroid) { const w = toWorld(p.buildStatus.centroid[0], p.buildStatus.centroid[1]); box.expandByPoint(tmpV.set(w.x, 0, w.z)); }
      box.expandByVector(new THREE.Vector3(700, 0, 700));
      scope = { id, box };
      controls.maxDistance = Math.max(3500, fitDistance(core, 1.35) * 1.3);
      controls.maxPolarAngle = THREE.MathUtils.degToRad(70); // no low views across the rest of Dubai
    }
    projectsLayer.setScope(id);
    districtLayer.setScope(id);
    state.street = id ? buildStreetWorld(id) : null;
    updateExploreBar();
    // only this community on screen: the rest of the map is covered, its satellite tiles not loaded
    scopeMask.set(id ? communityPoints(id) : null);
    ground.setClip(id ? scopeMask.shows : null);
    // the other communities' 3D content is not drawn or tested against the view at all (most of the
    // per-frame work was culling ~470,000 trees/shrubs/lamps and homes of all three communities)
    for (const d of details) d.group.visible = !id || d.communityId === id;
    detected?.setScope(id);
    const naraOn = !id || id === 'the-valley';
    const naraWorld = scene.getObjectByName('NaraCommunityWorld');
    if (naraWorld) naraWorld.visible = naraOn;
    occlusion.setForceOff?.(!naraOn);
    invalidate(300);
  }
  function clampToScope() {
    if (!scope || state.flyAnim || state.cameraMode !== 'aerial') return;
    const t = controls.target, b = scope.box;
    const dx = THREE.MathUtils.clamp(t.x, b.min.x, b.max.x) - t.x;
    const dz = THREE.MathUtils.clamp(t.z, b.min.z, b.max.z) - t.z;
    if (dx || dz) { t.x += dx; t.z += dz; camera.position.x += dx; camera.position.z += dz; }
  }
  controls.addEventListener('change', clampToScope);
  // ---- walking and driving in any community ------------------------------------------------------------
  // Roads: the community's streets (mapped + access streets), in The Valley also Nara's own roads and
  // Eden's site-plan roads. Homes and apartment blocks are solid. Cars stay on the carriageway.
  function buildStreetWorld(id) {
    const segs = [];
    const add = (pts, width, name) => {
      for (let i = 0; i + 1 < pts.length; i++) {
        const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
        if (Math.hypot(bx - ax, bz - az) < 0.3) continue;
        segs.push({ ax, az, bx, bz, hw: Math.max(2.6, (width || 7.3) / 2), name });
      }
    };
    const streets = id === 'the-valley' && valleyStreets ? valleyStreets : siteData?.communities?.[id]?.streets || [];
    for (const st of streets) {
      if (st.cls === 'path') continue;
      add(st.pts.map(([lng, lat]) => { const w = toWorld(lat, lng); return [w.x, w.z]; }), st.width, st.name);
    }
    if (id === 'the-valley') for (const rc of naraData.site.roadCentrelines || []) add(rc.pts, Math.min(rc.width || 7.3, 7.3), rc.name); // carriageway only
    const grid = new Map();
    const G = 50;
    for (const sg of segs) {
      for (let gx = Math.floor(Math.min(sg.ax, sg.bx) / G) - 1; gx <= Math.floor(Math.max(sg.ax, sg.bx) / G) + 1; gx++) {
        for (let gz = Math.floor(Math.min(sg.az, sg.bz) / G) - 1; gz <= Math.floor(Math.max(sg.az, sg.bz) / G) + 1; gz++) {
          const k = `${gx},${gz}`;
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k).push(sg);
        }
      }
    }
    function nearest(x, z, reach = 1) {
      let best = null;
      const gx = Math.floor(x / G), gz = Math.floor(z / G);
      for (let a = -reach; a <= reach; a++) for (let b = -reach; b <= reach; b++) {
        for (const sg of grid.get(`${gx + a},${gz + b}`) || []) {
          const vx = sg.bx - sg.ax, vz = sg.bz - sg.az, l2 = vx * vx + vz * vz;
          const t = Math.max(0, Math.min(1, ((x - sg.ax) * vx + (z - sg.az) * vz) / l2));
          const qx = sg.ax + vx * t, qz = sg.az + vz * t;
          const d = Math.hypot(x - qx, z - qz);
          if (!best || d < best.d) best = { d, qx, qz, sg };
        }
      }
      return best;
    }
    const yawAlong = (sg, nearYaw) => {
      const y1 = Math.atan2(-(sg.bx - sg.ax), -(sg.bz - sg.az));
      const y2 = y1 + Math.PI;
      const dd = (a) => Math.abs(Math.atan2(Math.sin(a - nearYaw), Math.cos(a - nearYaw)));
      return dd(y1) <= dd(y2) ? y1 : y2;
    };
    const det = details.find((d) => d.communityId === id);
    const apts = (detected?.apartments || []).filter((a) => a.community === id).map((a) => {
      const w = toWorld(a.lat, a.lng), t = THREE.MathUtils.degToRad(a.frontBearing), ls = localScale(a.lat);
      return { x: w.x, z: w.z, c: Math.cos(t), s: Math.sin(t), hl: (a.L / 2) * ls, hd: (a.D / 2) * ls };
    });
    const names = (siteData?.communities?.[id]?.names || []).map((n) => { const w = toWorld(n.at[1], n.at[0]); return { x: w.x, z: w.z, name: n.name }; }).filter((n) => !/access/i.test(n.name));
    const rowSet = new Set(homesDetected.communities[id] || []);
    const unitsHere = (valleyDetail?.units || []).filter((u) => rowSet.has(u.row));
    const c = communities.find((x) => x.id === id);
    return {
      segs,
      nearest,
      nearNara: (x, z) => id === 'the-valley' && Math.hypot(x - naraCenter.x, z - naraCenter.z) < 300,
      collide(x, z, r) {
        if (det?.collide(x, z, r)) return true;
        for (const a of apts) {
          const dx = x - a.x, dz = z - a.z;
          const lx = dx * a.c + dz * a.s, lz = -dx * a.s + dz * a.c;
          if (Math.abs(lx) < a.hl + r && Math.abs(lz) < a.hd + r) return true;
        }
        return false;
      },
      // a car stays on the carriageway (sliding along the kerb); snap = put it in the lane, along the road
      keepOnRoad(nx, nz, px, pz, snap) {
        const n = nearest(nx, nz, snap ? 6 : 1);
        if (!n) return { x: px, z: pz };
        const lim = Math.max(0.5, n.sg.hw - 1.1);
        let x = nx, z = nz;
        if (n.d > lim) { x = n.qx + ((nx - n.qx) * lim) / n.d; z = n.qz + ((nz - n.qz) * lim) / n.d; }
        if (!snap) return { x, z };
        const yaw = yawAlong(n.sg, navModule.player.yaw);
        // drive on the right-hand lane
        const off = n.sg.hw / 2;
        return { x: n.qx + Math.cos(yaw) * off, z: n.qz - Math.sin(yaw) * off, yaw };
      },
      label(x, z) {
        let nm = null, bd = 70;
        for (const n of names) { const d = Math.hypot(n.x - x, n.z - z); if (d < bd) { bd = d; nm = n.name; } }
        const r = nearest(x, z, 1);
        if (!nm && r && r.d < 15 && r.sg.name) nm = r.sg.name;
        let pj = null, pd = 160;
        for (const u of unitsHere) { const d = Math.hypot(u.pos.x - x, u.pos.z - z); if (d < pd) { pd = d; pj = u.project; } }
        const pname = pj ? projectsById.get(pj)?.name : null;
        return [nm || (pname ? `${pname} streets` : `${c.name} streets`), pname ? `${pname} · ${c.name}` : c.name];
      },
      yawAlong,
      /** the road's heading at a point, on the side nearest the given heading (lane assist) */
      roadYaw(x, z, yaw) { const n = nearest(x, z, 1); return n && n.d < n.sg.hw + 2 ? { yaw: yawAlong(n.sg, yaw), d: n.d, hw: n.sg.hw, qx: n.qx, qz: n.qz } : null; },
      // a straight stretch near a point (start of a walk / drive): long road pieces score better than bends
      straightNear(x, z) {
        let best = null;
        const gx = Math.floor(x / G), gz = Math.floor(z / G);
        for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
          for (const sg of grid.get(`${gx + a},${gz + b}`) || []) {
            const len = Math.hypot(sg.bx - sg.ax, sg.bz - sg.az);
            if (len < 20) continue;
            const mx = (sg.ax + sg.bx) / 2, mz = (sg.az + sg.bz) / 2;
            const d = Math.hypot(mx - x, mz - z);
            if (d > 70) continue;
            const score = d - Math.min(len, 80) * 0.6;
            if (!best || score < best.score) best = { score, d: 0, qx: sg.ax + (sg.bx - sg.ax) * 0.3, qz: sg.az + (sg.bz - sg.az) * 0.3, sg };
          }
        }
        return best;
      },
      // the home nearest a point (to start walks on a residential street, not on a golf course road)
      nearestHome(x, z) {
        let best = null, bd = Infinity;
        for (const u of unitsHere) { const d = Math.hypot(u.pos.x - x, u.pos.z - z); if (d < bd) { bd = d; best = u; } }
        if (id === 'the-valley' && Math.hypot(naraCenter.x - x, naraCenter.z - z) < bd) return { x: naraCenter.x, z: naraCenter.z };
        return best ? { x: best.pos.x, z: best.pos.z } : null;
      },
    };
  }
  state.onPlayerMoved = () => invalidate(120);

  function startExplore(drive) {
    const st = state.street;
    if (!st) return;
    cancelIntro();
    clearHome({ silent: true });
    // start on the street nearest the middle of the current view, heading the way the camera looks
    const t = controls.target;
    const h = st.nearestHome(t.x, t.z) || t;
    let n = st.straightNear(h.x, h.z) || st.nearest(h.x, h.z, 1) || st.nearest(t.x, t.z, 2) || st.nearest(t.x, t.z, 10) || st.nearest(t.x, t.z, 40);
    if (!n) return;
    const camYaw = Math.atan2(-(t.x - camera.position.x), -(t.z - camera.position.z));
    // face the way with the most open road ahead (not a dead end or a house), else the camera's way
    const open = (yw) => {
      let free = 0;
      for (let k = 2; k <= 80; k += 2) {
        const x = n.qx - Math.sin(yw) * k, z = n.qz - Math.cos(yw) * k;
        const r = st.nearest(x, z, 1);
        if (!r || r.d > r.sg.hw + 1 || st.collide(x, z, 1.2)) break;
        free = k;
      }
      return free;
    };
    const y1 = st.yawAlong(n.sg, camYaw), y2 = y1 + Math.PI;
    const o1 = open(y1), o2 = open(y2);
    const yaw = o2 > o1 + 10 ? y2 : y1;
    // driving: right-hand lane; walking: on the footpath beside the road
    // driving: centre of the right-hand lane; walking: at the kerb, looking along the street
    const side = drive ? n.sg.hw / 2 : Math.max(1.5, n.sg.hw - 0.7);
    const x = n.qx + Math.cos(yaw) * side, z = n.qz - Math.sin(yaw) * side;
    state.exploring = true;
    state.flyAnim = null;
    navModule.enterStreetAt(x, z, yaw, drive);
    document.body.dataset.mode = state.cameraMode;
    setHover(null);
    applyPanels();
    updateGuide();
    updateExploreBar();
    invalidate(800);
  }
  const elExplore = document.createElement('div');
  elExplore.id = 'explore-bar';
  elExplore.className = 'explore-bar hidden';
  elExplore.innerHTML = `
    <span class="ex-label">Explore at street level</span>
    <button type="button" data-ex="walk" title="Walk the streets at eye level (W A S D or arrow keys, Shift to walk faster)"><svg class="icon"><use href="#i-footprints" /></svg>Walk</button>
    <button type="button" data-ex="drive" title="Drive through the community (W / S to drive and brake, A / D to steer)"><svg class="icon"><use href="#i-car" /></svg>Drive</button>`;
  document.body.appendChild(elExplore);
  elExplore.addEventListener('click', (e) => { const b = e.target.closest('[data-ex]'); if (b) startExplore(b.dataset.ex === 'drive'); });
  function updateExploreBar() {
    elExplore.classList.toggle('hidden', !state.street || state.cameraMode !== 'aerial' || !!picker?.visible);
  }
  app.startExplore = startExplore;

  function showPicker(opts = {}) {
    if (intro.steps.length || intro.current || intro.orbitUntil) { intro.current = null; stopIntro(); }
    intro.panelsHidden = false;
    clearHome({ silent: true });
    if (state.cameraMode !== 'aerial') setCameraMode('aerial', { noFly: true });
    state.communityId = null;
    state.projectId = null;
    state.leftOpen = false;
    state.rightOpen = false;
    projectsLayer.setSelected(null);
    projectsUI.markSelected(null);
    setScope(null);
    projectsUI.renderCommunityHeader();
    projectsUI.apply();
    applyPanels();
    picker?.show();
    updateExploreBar();
    if (opts.push !== false) routing?.go(null);
  }

  /** Up the breadcrumb: back to all of Dubai (null) or to one community, with nothing selected */
  function goToLevel(communityId, opts = {}) {
    clearHome({ silent: true });
    state.projectId = null;
    state.right = 'project';
    state.rightOpen = false;
    projectsLayer.setSelected(null);
    projectsUI.markSelected(null);
    if (state.cameraMode !== 'aerial') setCameraMode('aerial', { noFly: true });
    selectCommunity(communityId, { noIntro: true, ...opts });
  }

  Object.assign(state, { flyToWorldPoint, flyToUnit, setCameraMode, selectUnit });
  Object.assign(app, { selectCommunity, selectProject, flyToProject, openNaraHomes, setCameraMode, goToLevel, showPicker });

  // ---- Nara modules ------------------------------------------------------------------------------
  minimapModule = initMinimapAndLabels(state);
  state.minimapModule = minimapModule;
  navModule = initNavigationModule(state);
  state.enterStreetMode = navModule.enterStreetMode;
  state.enterHomeInterior = navModule.enterHomeInterior;
  state.jumpToRoomInUnit = navModule.jumpToRoomInUnit;
  detailsModule = initDetailsModule(state);
  state.openCommunityModal = detailsModule.openCommunityModal;
  filtersModule = initFiltersModule(state);
  showHome = initShowHome(state);
  state.showHome = showHome;

  const projectsUI = initProjectsUI(app);
  app.projectsUI = projectsUI;

  // ---- explorer filters + colour mode on the 3D homes (detected homes and Nara) -----------------------
  const naraProject = projectsById.get('nara');
  const baseNaraUpdate = community.updateUnitVisualStates;
  community.updateUnitVisualStates = (o) => {
    const f = projectsUI.homeFilter();
    if (f) {
      const ex = new Set(naraData.units.filter((u) => f({ project: 'nara', beds: u.bedrooms, kind: 'townhouse' })).map((u) => u.unit));
      o = { ...o, filterActive: true, matchingUnitSet: o.filterActive && o.matchingUnitSet ? new Set([...o.matchingUnitSet].filter((x) => ex.has(x))) : ex };
    }
    baseNaraUpdate(o);
    for (const r of community.unitRecords.values()) r.selectionWire.visible = false; // the shared amber outline replaces it
  };
  function refreshHomeHighlight() {
    homeOverlay.update(state.colorMode, projectsUI.homeFilter());
    filtersModule.refreshVisuals();
    invalidate(200);
  }
  app.onFiltersChanged = refreshHomeHighlight;
  app.setColorMode = (m) => {
    const sel = document.getElementById('color-mode-select');
    if (sel.value !== m) { sel.value = m; sel.dispatchEvent(new Event('change')); }
  };
  setProgress(80, 'Setting up search, filters and documents');
  await nextFrame();

  // ---- header controls ---------------------------------------------------------------------------
  document.getElementById('unit-search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('unit-search-input');
    const v = input.value.trim();
    const n = Number(v);
    if (Number.isInteger(n) && n >= 1 && n <= 372) { openNaraHomes(); selectUnit(n, { flyTo: true }); input.value = ''; input.blur(); }
    else if (projectsUI.search(v)) input.blur();
  });
  // a project picked from the suggestions goes straight there (no extra Enter / Go)
  document.getElementById('unit-search-input').addEventListener('change', (e) => {
    const v = e.target.value.trim();
    if (v && projectsUI.byId && [...projectsUI.byId.values()].some((p) => p.name.toLowerCase() === v.toLowerCase())) { projectsUI.search(v); e.target.blur(); }
  });
  const COLOR_NAMES = { realistic: 'Natural', bedrooms: 'Bedrooms', status: 'Availability', design: 'Design', facing: 'Front faces', market: 'Sales' };
  const elViewSummary = document.getElementById('view-summary');
  const syncViewSummary = () => { elViewSummary.textContent = state.colorMode === 'realistic' ? '' : COLOR_NAMES[state.colorMode]; };
  document.getElementById('color-mode-select').addEventListener('change', (e) => {
    state.colorMode = e.target.value;
    projectsLayer.setColorMode(state.colorMode);
    projectsUI.renderLegend();
    refreshHomeHighlight();
    document.querySelectorAll('.vp-opt[data-color]').forEach((b) => b.classList.toggle('active', b.dataset.color === state.colorMode));
    // Nara's key (with Nara's counts) only for the Nara-only colourings; the left panel keys the rest
    document.getElementById('color-legend').style.display = ['design', 'facing', 'market'].includes(state.colorMode) ? '' : 'none';
    syncViewSummary();
    updateGuide();
  });
  document.querySelectorAll('.vp-opt[data-color]').forEach((b) => {
    b.classList.toggle('active', b.dataset.color === state.colorMode);
    b.addEventListener('click', () => app.setColorMode(b.dataset.color));
  });
  document.getElementById('btn-back-projects').addEventListener('click', () => { state.left = 'projects'; applyPanels(); });
  document.querySelectorAll('[data-back-project]').forEach((b) => b.addEventListener('click', () => selectProject('nara', { fly: false })));
  document.getElementById('btn-collapse-projects').addEventListener('click', () => toggleLeft(false));
  document.getElementById('btn-collapse-filters').addEventListener('click', () => toggleLeft(false));
  btnReopenFilters.addEventListener('click', () => toggleLeft(true));
  btnReopenDetails.addEventListener('click', () => toggleRight(true));
  document.getElementById('btn-close-project').addEventListener('click', () => toggleRight(false));
  document.getElementById('btn-exit-mode').addEventListener('click', () => setCameraMode('aerial'));
  const elExtras = document.getElementById('top-bar-extras');
  const btnMenu = document.getElementById('btn-mobile-menu');
  btnMenu.addEventListener('click', () => {
    const open = elExtras.classList.toggle('mobile-menu-open');
    btnMenu.classList.toggle('active', open);
    if (open) { state.leftOpen = false; state.rightOpen = false; applyPanels(); } // one sheet at a time
  });
  // picking a project or a unit from the phone menu closes it
  document.getElementById('unit-search-form').addEventListener('submit', () => { elExtras.classList.remove('mobile-menu-open'); btnMenu.classList.remove('active'); });

  // View menu: home colours, time of day, map style and layers in one place
  const elViewBlock = document.getElementById('view-block');
  const btnView = document.getElementById('btn-view');
  const setViewOpen = (open) => { elViewBlock.classList.toggle('open', open); btnView.setAttribute('aria-expanded', String(open)); };
  btnView.addEventListener('click', (e) => { e.stopPropagation(); setViewOpen(!elViewBlock.classList.contains('open')); });
  document.addEventListener('pointerdown', (e) => { if (elViewBlock.classList.contains('open') && !elViewBlock.contains(e.target)) setViewOpen(false); });
  const elCredit = document.getElementById('map-credit');
  const elMapAttr = document.getElementById('map-attribution');
  const syncCredit = () => { const a = ground.attribution() + ' · Boundaries © OpenStreetMap contributors'; elCredit.textContent = a; elMapAttr.textContent = a; };
  document.getElementById('map-base-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    document.querySelectorAll('#map-base-seg button').forEach((x) => x.classList.toggle('active', x === b));
    ground.setBase(b.dataset.base);
    document.getElementById('chk-labels').disabled = b.dataset.base !== 'satellite';
    syncCredit();
  });
  document.getElementById('chk-labels').addEventListener('change', (e) => { ground.setLabels(e.target.checked); syncCredit(); });
  document.getElementById('chk-districts').addEventListener('change', (e) => {
    districtLayer.setVisible(e.target.checked);
    labels.items.filter((i) => i.el.classList.contains('lbl-district')).forEach((i) => { i.enabled = e.target.checked; });
    invalidate();
  });
  document.getElementById('chk-pins').addEventListener('change', (e) => { projectsLayer.setVisible(e.target.checked); invalidate(); });
  document.getElementById('chk-landscape').addEventListener('change', (e) => {
    for (const g of Object.values(community.landscape)) g.visible = e.target.checked;
    renderer.shadowMap.needsUpdate = true;
    invalidate();
  });
  syncCredit();

  // sun
  const elSunSlider = document.getElementById('sun-time-slider');
  const elSunMonth = document.getElementById('sun-month-select');
  let sunDir = new THREE.Vector3(0.5, 0.6, 0.4);
  function updateSunUI() {
    state.sunHour = Number(elSunSlider.value);
    state.sunDayOfYear = Number(elSunMonth.value);
    const info = solar.update(state.sunHour, state.sunDayOfYear, null);
    sunDir = solar.sunLight.position.clone().sub(solar.sunLight.target.position).normalize();
    const hrs = Math.floor(state.sunHour), mins = Math.round((state.sunHour - hrs) * 60);
    document.getElementById('sun-time-label').textContent = `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
    document.getElementById('sun-azimuth-label').textContent = info.isNight ? 'Night · street and home lights on' : `Sun ${info.sunCompass.toLowerCase()} (${Math.round(info.azimuthDeg)}°) · shadows ${info.shadowCompass.toLowerCase()}`;
    state.lastSunInfo = info;
    renderer.shadowMap.needsUpdate = true;
    invalidate(200);
    return info;
  }
  elSunSlider.addEventListener('input', updateSunUI);
  elSunMonth.addEventListener('change', updateSunUI);
  updateSunUI();

  // compass
  const elDial = document.getElementById('compass-dial');
  const elReadout = document.getElementById('compass-readout');
  document.getElementById('compass-widget').addEventListener('click', () => {
    if (state.cameraMode !== 'aerial' && state.cameraMode !== 'cutaway') return;
    const p = currentPose();
    flyTo({ target: p.target, dist: p.dist, polar: p.polar, azimuth: 0, duration: 0.7 });
  });
  const dirV = new THREE.Vector3();
  function updateCompass() {
    camera.getWorldDirection(dirV);
    const b = (THREE.MathUtils.radToDeg(Math.atan2(dirV.x, -dirV.z)) + 360) % 360;
    elDial.style.transform = `rotate(${-b.toFixed(1)}deg)`;
    elReadout.textContent = `${COMPASS_ABBR[bearingToCompass8(b)]} ${Math.round(b)}°`;
  }

  // ---- picking: hover shows which home you are on, click selects it ----------------------------------
  const raycaster = new THREE.Raycaster();
  const downAt = new THREE.Vector2();
  const ndc = new THREE.Vector2();
  const elTip = document.getElementById('hover-tip');
  const elTag = document.getElementById('sel-tag');
  let hoverEntry = null;
  let hoverPending = null;
  let pointerDown = false;

  /** What a home is, in words: { title, line, color } */
  function describeHome(e) {
    const p = projectsById.get(e.project);
    const name = p ? p.name : '';
    if (e.nara) {
      return { title: `Nara · Unit ${e.unitNo}`, line: `${e.beds} bedroom townhouse · ${e.design} ${e.plan}`, short: `Unit ${e.unitNo}`, color: BED_COLORS_JS[e.beds] };
    }
    const h = e.home;
    if (h.unitPlan) {
      const up = h.unitPlan;
      return { title: `${name} · Unit ${up.no}`, line: `${up.beds} bedroom ${up.design} ${up.plan} · ${up.position} unit`, short: `Unit ${up.no}`, color: BED_COLORS_JS[Math.min(6, up.beds)] };
    }
    if (h.apartment) return { title: name, line: `Apartment building · ${p?.bedsLabel || ''} BR`, short: 'Apartment building', color: '#94a3b8' };
    const n = h.row?.unitWidths?.length || h.row?.units || 1;
    const end = h.endUnit ?? (h.index === 0 || h.index === n - 1);
    const kind = h.kind === 'villa' ? 'villa' : n === 1 ? 'detached home' : end ? 'townhouse, end of row' : 'townhouse, mid row';
    return { title: name, line: `${h.beds} bedroom ${kind}`, short: `${h.beds} BR ${h.kind === 'villa' ? 'villa' : 'home'}`, color: BED_COLORS_JS[Math.min(6, h.beds)] };
  }

  function pickAt(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    if (intro.reveal < 0.98) return null; // homes are still rising out of the ground
    const hit = pickIndex.pick(raycaster.ray, 30000);
    const pins = raycaster.intersectObjects(projectsLayer.pickables(), false);
    if (pins.length && (!hit || pins[0].distance < hit.distance)) return { projectId: pins[0].object.userData.projectId };
    return hit ? hit.entry : null;
  }

  function setHover(e, x, y) {
    if (e !== hoverEntry) {
      hoverEntry = e;
      selection.setHover(e && e.matrix && e !== state.home ? e.matrix : null);
      canvas.style.cursor = e ? 'pointer' : '';
      if (e && e.matrix) {
        const d = describeHome(e);
        elTip.innerHTML = `<i style="background:${d.color || '#999'}"></i><span><b>${escapeHtml(d.title)}</b><small>${escapeHtml(d.line)}</small></span><em>${e === state.home ? 'Selected' : 'Click for details'}</em>`;
      } else if (e && e.projectId) {
        elTip.innerHTML = `<span><b>${escapeHtml(projectsById.get(e.projectId)?.name || '')}</b><small>Project</small></span><em>Click to open</em>`;
      }
      elTip.classList.toggle('hidden', !e);
      invalidate(80);
    }
    if (e) elTip.style.transform = `translate(${Math.round(x + 16)}px, ${Math.round(y + 18)}px)`;
  }
  canvas.addEventListener('pointermove', (e) => {
    if (pointerDown || state.cameraMode !== 'aerial' || e.pointerType === 'touch') { if (hoverEntry) setHover(null); return; }
    hoverPending = [e.clientX, e.clientY];
  });
  canvas.addEventListener('pointerleave', () => { hoverPending = null; setHover(null); });
  function stepHover() {
    if (!hoverPending) return;
    const [x, y] = hoverPending;
    hoverPending = null;
    if (state.flyAnim) { setHover(null); return; }
    setHover(pickAt(x, y), x, y);
  }

  canvas.addEventListener('pointerdown', (e) => { pointerDown = true; downAt.set(e.clientX, e.clientY); cancelIntro(); setHover(null); invalidate(400); });
  window.addEventListener('pointerup', () => { pointerDown = false; });
  canvas.addEventListener('pointerup', (e) => {
    pointerDown = false;
    if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 6) return;
    if (state.cameraMode !== 'aerial' && state.cameraMode !== 'street') return;
    const hit = pickAt(e.clientX, e.clientY);
    if (!hit) { if (state.cameraMode === 'aerial') clearHome(); return; }
    if (hit.projectId) { selectProject(hit.projectId); return; }
    selectHome(hit);
  });
  controls.addEventListener('change', () => invalidate(160));
  canvas.addEventListener('wheel', () => { cancelIntro(); invalidate(400); }, { passive: true });
  window.addEventListener('wheel', () => invalidate(400), { passive: true });
  window.addEventListener('keydown', () => invalidate(400));

  // ---- selecting a home: outline + tag in 3D, its details at the top of the right panel ----------------
  function selectHome(e) {
    cancelIntro();
    setHover(null);
    if (e.nara) {
      if (state.left !== 'homes' && !isPhone()) state.leftOpen = state.leftOpen; // keep the left panel as it is
      selectUnit(e.unitNo, { flyTo: state.cameraMode !== 'aerial', openDetails: true });
    } else {
      state.home = e;
      selectProject(e.project, { fly: false, keepHome: true });
      selection.setSelected(e.matrix);
      projectsUI.showHome(e.home, describeHome(e));
      toggleRight(true);
    }
    keepInView(e.matrix);
    updateGuide();
    invalidate(400);
  }
  function clearHome({ silent = false } = {}) {
    if (!state.home) return;
    const wasNara = state.home.nara;
    state.home = null;
    selection.setSelected(null);
    elTag.classList.add('hidden');
    if (wasNara) {
      state.selectedUnitNo = null;
      filtersModule.refreshVisuals();
      if (!silent) selectProject('nara', { fly: false });
    } else projectsUI.showHome(null);
    if (!silent) updateGuide();
    invalidate(200);
  }
  app.clearHome = clearHome;

  /** Glide the camera only if the chosen home sits under a panel or at the screen edge. */
  const tmpP = new THREE.Vector3();
  function keepInView(m) {
    if (!m || state.cameraMode !== 'aerial') return;
    tmpP.set(0, 0.5, 0).applyMatrix4(m);
    const s = tmpP.clone().project(camera);
    const x = (s.x + 1) / 2 * window.innerWidth, y = (1 - s.y) / 2 * window.innerHeight;
    const css = getComputedStyle(document.documentElement);
    const left = isPhone() ? 0 : (state.leftOpen ? parseFloat(css.getPropertyValue('--left-w')) + 24 : 0);
    const right = isPhone() ? window.innerWidth : window.innerWidth - (state.rightOpen ? parseFloat(css.getPropertyValue('--right-w')) + 24 : 0);
    const bottom = isPhone() ? window.innerHeight * 0.26 : window.innerHeight - 90;
    if (s.z < 1 && x > left + 60 && x < right - 60 && y > (isPhone() ? 70 : 110) && y < bottom - (isPhone() ? 0 : 40)) return;
    const p = currentPose();
    const dist = Math.min(p.dist, 320);
    flyTo({ target: panelOffsetTarget(tmpP.clone().setY(2), dist, p.azimuth), dist, polar: p.polar, azimuth: p.azimuth, duration: 0.8 });
  }

  /** The tag above the selected home's roof follows it on screen */
  const tagV = new THREE.Vector3();
  function updateSelectionTag() {
    if (!state.home || state.cameraMode !== 'aerial') { elTag.classList.add('hidden'); return; }
    tagV.copy(selection.tagPoint()).project(camera);
    const vis = tagV.z < 1 && Math.abs(tagV.x) < 1.05 && Math.abs(tagV.y) < 1.05;
    elTag.classList.toggle('hidden', !vis);
    if (!vis) return;
    if (elTag.dataset.for !== String(state.home.unitNo ?? state.home.home?.id ?? '')) {
      const d = describeHome(state.home);
      elTag.dataset.for = String(state.home.unitNo ?? state.home.home?.id ?? '');
      elTag.innerHTML = `<b>${escapeHtml(d.short)}</b><span>${escapeHtml(d.title)}</span>`;
    }
    elTag.style.transform = `translate(${Math.round((tagV.x + 1) / 2 * window.innerWidth)}px, ${Math.round((1 - tagV.y) / 2 * window.innerHeight)}px) translate(-50%, -100%)`;
  }

  // ---- where you are: Dubai › community › project › home (each step goes back up) --------------------
  const elGuide = document.getElementById('guide');
  const elCrumbs = document.getElementById('crumbs');
  function updateGuide() {
    const c = communities.find((x) => x.id === state.communityId);
    const p = state.projectId ? projectsById.get(state.projectId) : null;
    const close = camera.position.distanceTo(controls.target) < 1500;
    const crumbs = [{ label: 'Communities', go: () => goToLevel(null) }];
    if (c) crumbs.push({ label: c.name, go: () => goToLevel(c.id) });
    if (p && (!c || p.communityId === c.id)) crumbs.push({ label: p.name, go: () => { clearHome({ silent: true }); selectProject(p.id); } });
    if (state.home) crumbs.push({ label: describeHome(state.home).short, go: () => keepInView(state.home.matrix), home: true });
    elCrumbs.innerHTML = crumbs.map((x, i) => `<li><button type="button" data-i="${i}" class="${i === crumbs.length - 1 ? 'current' : ''}${x.home ? ' home' : ''}">${escapeHtml(x.label)}</button></li>`).join('');
    elCrumbs.querySelectorAll('button').forEach((b) => { b.onclick = () => crumbs[Number(b.dataset.i)].go(); });
    let hint;
    if (state.home?.nara) hint = 'Go inside, walk the street or open the show home from the panel on the right.';
    else if (state.home) hint = 'Click another home to compare · Esc to clear';
    else if (p && p.pinFlag && !p.buildStatus?.centroid) hint = `Emaar has not published a reliable location for ${p.name} yet - see the note in the panel.`;
    else if (p) hint = close ?'Point at a home to see what it is, then click it.' : 'Scroll to zoom in to the homes, then click one.';
    else if (c) hint = 'Click a project on the map, or pick one from the list.';
    else hint = 'Choose a community at the top, or click one on the map.';
    elGuide.querySelector('.gd-hint').textContent = hint;
  }
  app.updateGuide = updateGuide;
  controls.addEventListener('end', () => updateGuide());

  state.onModeChanged = (mode) => {
    const aerial = mode === 'aerial';
    selection.setVisible(aerial);
    if (!aerial) setHover(null);
    invalidate(200);
  };

  // Esc steps back: close menus, leave street / inside / show home, then clear the selected home
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (document.querySelector('.modal-backdrop:not(.hidden)')) return; // the open document closes first
    if (elViewBlock.classList.contains('open')) { setViewOpen(false); return; }
    if (state.cameraMode === 'showhome' && !document.getElementById('sh-room-card').classList.contains('hidden')) return;
    if (state.cameraMode !== 'aerial') { setCameraMode('aerial'); return; }
    clearHome();
  });

  // ---- resize -------------------------------------------------------------------------------------
  function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(pixelRatio());
    renderer.setSize(window.innerWidth, window.innerHeight);
    districtLayer.setResolution(window.innerWidth, window.innerHeight);
    showHome.onResize();
    labels.measure();
    applyPanels();
    invalidate(300);
  }
  window.addEventListener('resize', onResize);
  districtLayer.setResolution(window.innerWidth, window.innerHeight);

  // ---- per-frame helpers ----------------------------------------------------------------------------
  function updateClipAndFog() {
    const h = Math.max(1.2, camera.position.y);
    const d = state.cameraMode === 'aerial' || state.cameraMode === 'cutaway' ? camera.position.distanceTo(controls.target) : h;
    const near = THREE.MathUtils.clamp(Math.min(h, d) * 0.02, 0.08, 40);
    const far = THREE.MathUtils.clamp(h * 60 + d * 6, 4000, 400000);
    if (Math.abs(camera.near - near) / near > 0.05 || Math.abs(camera.far - far) / far > 0.05) {
      camera.near = near;
      camera.far = far;
      camera.updateProjectionMatrix();
    }
    scene.fog.near = Math.max(1500, h * 5 + d * 1.2);
    scene.fog.far = Math.max(9000, scene.fog.near * 5);
    solar.skyMesh.position.copy(camera.position);
    solar.skyMesh.scale.setScalar((camera.far * 0.85) / 2200);
  }

  const SHADOW_MAX_DIST = 3200;
  let shadowsPrimed = false;
  let lastShadowKey = '';
  function updateShadows() {
    const aerial = state.cameraMode === 'aerial' || state.cameraMode === 'cutaway';
    const focus = aerial ? controls.target : camera.position;
    const d = aerial ? camera.position.distanceTo(controls.target) : 40;
    if (d > SHADOW_MAX_DIST && shadowsPrimed) { ground.shadowCatcher.visible = false; return; }
    shadowsPrimed = true; // the shadow map is always rendered at least once (materials sample it)
    ground.shadowCatcher.visible = true;
    const sun = solar.sunLight;
    // Shadows are fixed in the world (the sun only moves with its slider), so the 4096 px shadow map is
    // redrawn only when its area has to follow the camera: the area grows/shrinks in 18 % steps and
    // moves in quarter-size steps. Redrawing it every frame of a drag was half of the frame time.
    const size = Math.min(1500, 45 * Math.pow(1.18, Math.ceil(Math.log(Math.max(45, d * 0.95) / 45) / Math.log(1.18))));
    const step = size / 4; // a whole number of shadow-map texels
    const cx = Math.round(focus.x / step) * step;
    const cz = Math.round(focus.z / step) * step;
    const key = `${size}|${cx}|${cz}|${state.cameraMode}|${sunDir.x.toFixed(5)}|${sunDir.y.toFixed(5)}|${sunDir.z.toFixed(5)}`;
    if (key === lastShadowKey) return;
    lastShadowKey = key;
    sun.target.position.set(cx, 0, cz);
    sun.target.updateMatrixWorld();
    sun.position.set(cx + sunDir.x * 2400, Math.max(60, sunDir.y * 2400), cz + sunDir.z * 2400);
    const sc = sun.shadow.camera;
    if (sc.right !== size) {
      sc.left = -size; sc.right = size; sc.top = size; sc.bottom = -size;
      sc.near = 10; sc.far = 5200;
      sc.updateProjectionMatrix();
    }
    ground.setShadowArea(cx, cz, size);
    renderer.shadowMap.needsUpdate = true;
  }

  const elNaraLabels = document.getElementById('labels-overlay');
  const perfHud = document.getElementById('perf-hud');
  if (PERF) perfHud.classList.remove('hidden');
  let frames = 0, lastFpsT = performance.now(), fps = 0, drawCalls = 0, tris = 0;

  // Flat ground layers (lawns, pads, verges, footpaths, kerbs, asphalt, road lines, plot paving) lie
  // stacked a few cm apart. Drawn top layer first, the GPU skips shading the hidden layers underneath
  // (early depth test) - same picture, far less work at Retina resolution. renderOrder follows height.
  let flatScan = 0;
  function orderFlatLayers() {
    scene.traverse((o) => {
      if (!o.isMesh || o.userData.flatChecked) return;
      o.userData.flatChecked = true;
      if (o.renderOrder !== 0) return;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      if (!m || m.transparent || m.alphaTest > 0 || m.depthWrite === false || m.depthTest === false) return;
      const g = o.geometry;
      if (!g?.attributes?.position) return;
      if (!g.boundingBox) g.computeBoundingBox();
      const bb = tmpBox.copy(g.boundingBox).applyMatrix4(o.matrixWorld);
      if (bb.isEmpty() || bb.max.y - bb.min.y > 0.35 || bb.max.y > 0.6) return; // flat ground layers only
      o.renderOrder = 1 + Math.round((0.6 - bb.max.y) * 1000); // higher layer = drawn earlier
    });
  }
  const tmpBox = new THREE.Box3();

  function render() {
    if (++flatScan % 30 === 1) orderFlatLayers();
    updateClipAndFog();
    const eyeLevel = state.cameraMode === 'street' || state.cameraMode === 'interior';
    const busy = ground.update(camera, window.innerHeight * renderer.getPixelRatio(), eyeLevel ? 0.7 : 1);
    if (busy) invalidate(120);
    if (valleyDetail && valleyDetail.update(camera)) renderer.shadowMap.needsUpdate = true;
    updateShadows();
    projectsLayer.update(camera, window.innerHeight);
    occlusion.beforeRender(state.cameraMode);
    renderer.info.autoReset = false;
    renderer.info.reset();
    renderer.clear();
    renderer.render(groundScene, camera);
    renderer.render(scene, camera);
    occlusion.afterRender(scene);
    drawCalls = renderer.info.render.calls;
    tris = renderer.info.render.triangles;
    labels.update(camera, window.innerWidth, window.innerHeight);
    // Nara's numbered amenity labels only make sense near Nara
    const nearNara = state.cameraMode !== 'aerial' || camera.position.distanceTo(naraCenter) < 2200;
    if (nearNara !== state.naraLabelsOn) { state.naraLabelsOn = nearNara; elNaraLabels.style.display = nearNara ? '' : 'none'; }
    if (nearNara) minimapModule.updateProjectedLabels();
    updateSelectionTag();
    updateCompass();
    frames++;
  }

  // ---- first frame, then reveal ------------------------------------------------------------------
  const start = communities.flatMap((c) => c.projects);
  const box = boundsOf(start);
  const startDist = fitDistance(box, 1.2);
  controls.target.copy(panelOffsetTarget(box.getCenter(new THREE.Vector3()), startDist, 0));
  poseToPosition({ target: controls.target, dist: startDist, polar: THREE.MathUtils.degToRad(38), azimuth: 0 }, camera.position);
  camera.lookAt(controls.target);
  controls.update();
  onResize();
  projectsUI.renderCommunityHeader();
  projectsUI.apply();
  picker = createCommunityPicker(communities, {
    onPick: (id) => selectCommunity(id),
    homesIn3D: (c) => c.projects.reduce((n, p) => n + (p.modelled ? 372 : p.homesPlaced ?? p.detectedHomes ?? 0), 0),
  });
  routing = startCommunityRouting(communities, { enter: (id, o) => selectCommunity(id, o), home: (o) => goToLevel(null, o) });
  const startCommunity = routing.initial;
  showPicker({ push: false });
  setCameraMode('aerial', { noFly: true });
  refreshHomeHighlight();
  updateGuide();
  document.getElementById('color-legend').style.display = 'none';
  setProgress(92, 'Compiling materials');
  await nextFrame();
  renderer.compile(scene, camera);
  render();
  tlog('first frame');
  setProgress(100, 'Ready');
  setTimeout(() => document.getElementById('loading-overlay')?.classList.add('fade-out'), 450);
  labels.measure();
  window.APP_READY = true;
  if (startCommunity) setTimeout(() => selectCommunity(startCommunity, { push: false }), 500); // shared link: '#the-valley'

  // Public API for checks and automation
  // what lies on the ground at a point (checks and automation)
  const groundProbe = (x, z) => { const rc = new THREE.Raycaster(new THREE.Vector3(x, 50, z), new THREE.Vector3(0, -1, 0), 0, 60); return rc.intersectObjects(scene.children, true).slice(0, 4).map((h) => `${h.object.name || h.object.parent?.name || h.object.type}@${h.point.y.toFixed(2)}`); };
  window.EMAAR_APP = { groundProbe, valleyDetail, intro, app, state, pickAt, selectHome, selectProject, selectCommunity, selectUnit, setCameraMode, flyTo, ground, labels, naraOpt, occlusion, renderer, camera, controls, stats: () => ({ fps, drawCalls, tris, ground: ground.stats, occlusion: occlusion.stats, valley: valleyDetail?.stats }) };
  window.NARA_APP = { state, selectUnit, setCameraMode, updateSunUI, filtersModule, detailsModule, navModule, minimapModule, showHome };

  // ---- loop ------------------------------------------------------------------------------------------
  let last = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (state.cameraMode === 'showhome') {
      // the show-home studio has its own lights and shadows, updated every frame
      renderer.shadowMap.autoUpdate = true;
      showHome.update(dt);
      renderer.setRenderTarget(null);
      renderer.clear();
      renderer.render(showHome.scene, showHome.camera);
      return;
    }
    if (renderer.shadowMap.autoUpdate) { renderer.shadowMap.autoUpdate = false; renderer.shadowMap.needsUpdate = true; invalidate(300); }
    stepIntro(now, dt);
    stepHover();
    if (selection.tick(now)) invalidate(50);
    let active = now < activeUntil;
    if (state.flyAnim) { stepFlight(dt); active = true; }
    else if (state.cameraMode === 'aerial' || state.cameraMode === 'cutaway') { if (controls.update()) active = true; }
    if (state.cameraMode === 'street' || state.cameraMode === 'interior' || state.cameraMode === 'cutaway') {
      navModule.update(dt);
      active = true;
    }
    if (active) render();
    if (PERF && now - lastFpsT > 500) {
      fps = Math.round((frames * 1000) / (now - lastFpsT));
      frames = 0;
      lastFpsT = now;
      const s = ground.stats;
      perfHud.textContent = `${fps} fps · ${drawCalls} draws · ${(tris / 1000).toFixed(0)}k tris · tiles ${s.drawn} (z${s.maxZ}, ${s.inflight} loading) · culled ${occlusion.stats.culled}/${occlusion.stats.total}`;
    }
  }
  requestAnimationFrame(frame);
}

/** Plain-language fix steps when the browser cannot give us 3D graphics (not an app/link problem). */
function showGraphicsHelp(reason) {
  const ov = document.getElementById('loading-overlay');
  if (ov) ov.classList.remove('fade-out');
  const st = document.getElementById('loading-status');
  if (st) {
    st.innerHTML = `<b>This browser could not start 3D graphics.</b> ${reason || ''}<br>
      Fix (Chrome / Edge): open <code>chrome://settings/system</code> → turn on <b>“Use graphics acceleration when available”</b> → <b>Relaunch</b>.
      If it is already on, open <code>chrome://flags/#ignore-gpu-blocklist</code> → <b>Enabled</b> → Relaunch.
      Also update the graphics driver, close other heavy 3D tabs, or try another browser.`;
    st.style.whiteSpace = 'normal';
    st.style.lineHeight = '1.5';
  }
  document.getElementById('loader-retry')?.classList.remove('hidden');
}

boot().catch((err) => {
  console.error('Initialisation error:', err);
  if (err.message === 'WEBGL_UNAVAILABLE' || /WebGL/i.test(err.message)) {
    // no 3D on this device: open the map version (same projects, panels, brochures and filters)
    import('./lite.js').then((m) => m.startLite(''))
      .catch((e2) => { console.error(e2); showGraphicsHelp(''); });
    return;
  }
  const st = document.getElementById('loading-status');
  if (st) st.textContent = `The model could not be built: ${err.message}`;
  document.getElementById('loader-retry')?.classList.remove('hidden');
});

/**
 * Show Home: one floor-plan type presented on its own as a furnished model home.
 * Exterior turntable, ground- and first-floor cut-aways with clickable rooms, and a walk-through.
 * Uses the same plan data and builders as the community (exterior shell, plot & garden, 1:1 interior),
 * placed in a separate studio scene so the house can be studied without neighbours in the way.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  createPlanExteriorTemplate,
  buildUnitPlotAndGarden,
  createCarTemplates,
  buildAll1231Trees,
} from './community.js';

const FLOOR_Y = { ground: 0.0, first: 3.6 };
const DESIGN_ORDER = ['Aston', 'Palma', 'Charm'];
const DESIGN_RENDER = {
  Aston: 'assets/renders/aston.jpg',
  Palma: 'assets/renders/palma.jpg',
  Charm: 'assets/renders/charm.jpg',
};
const OUTDOOR_NAMES = { parking: 'Carport', sideYard: 'Side Yard' };

export function initShowHome(state) {
  const { data, renderer, mats, buildUnitInterior } = state;
  const canvas = renderer.domElement;

  // ==========================================================================
  // 1. STUDIO SCENE, CAMERA, LIGHTS & GROUND
  // ==========================================================================
  const scene = new THREE.Scene();
  scene.background = makeVerticalGradient('#f2f0ec', '#dedad3');

  const camera = new THREE.PerspectiveCamera(36, window.innerWidth / window.innerHeight, 0.1, 400);
  camera.position.set(14, 8, 26);

  const controls = new OrbitControls(camera, canvas);
  controls.enabled = false;
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.485;
  controls.minDistance = 4;
  controls.maxDistance = 75;
  controls.autoRotateSpeed = 0.6;
  controls.addEventListener('start', () => {
    tween = null;
    if (controls.autoRotate) setAutoRotate(false);
  });

  scene.add(new THREE.HemisphereLight(0xf5f7ff, 0xd6cab6, 0.85));
  const sun = new THREE.DirectionalLight(0xfff0da, 3.1);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -22;
  sun.shadow.camera.right = 22;
  sun.shadow.camera.top = 22;
  sun.shadow.camera.bottom = -22;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 110;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);
  const fill = new THREE.DirectionalLight(0xe4ecff, 0.5);
  scene.add(fill, fill.target);

  // Studio floor: soft disc fading into the backdrop, plus a shadow catcher
  const floorDisc = new THREE.Mesh(
    new THREE.CircleGeometry(90, 72),
    new THREE.MeshBasicMaterial({
      color: 0xd9d4cb,
      alphaMap: makeRadialAlpha(),
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    })
  );
  floorDisc.rotation.x = -Math.PI / 2;
  floorDisc.position.y = -0.02;
  floorDisc.renderOrder = -2;
  scene.add(floorDisc);

  const shadowCatcher = new THREE.Mesh(new THREE.PlaneGeometry(160, 160), new THREE.ShadowMaterial({ opacity: 0.16 }));
  shadowCatcher.rotation.x = -Math.PI / 2;
  shadowCatcher.position.y = -0.01;
  shadowCatcher.receiveShadow = true;
  scene.add(shadowCatcher);

  const carTemplates = createCarTemplates(mats);
  const keepGeometries = new Set();
  const keepMaterials = new Set(Object.values(mats).filter((m) => m && m.isMaterial));
  for (const car of carTemplates) {
    car.traverse((o) => {
      if (o.geometry) keepGeometries.add(o.geometry);
      if (o.material) keepMaterials.add(o.material);
    });
  }

  const overlayMat = new THREE.MeshBasicMaterial({
    color: 0x3d7bd9,
    transparent: true,
    opacity: 0.34,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const hoverMat = overlayMat.clone();
  hoverMat.opacity = 0.16;
  const ghostMat = new THREE.MeshStandardMaterial({
    color: 0xf4f2ee,
    roughness: 0.95,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
  });
  const ghostEdgeMat = new THREE.LineBasicMaterial({ color: 0xa39d93, transparent: true, opacity: 0.7 });
  keepMaterials.add(overlayMat).add(hoverMat).add(ghostMat).add(ghostEdgeMat);

  // ==========================================================================
  // 2. CATALOGUE OF THE 16 PLAN TYPES
  // ==========================================================================
  const counts = {};
  for (const u of data.units) counts[u.planType] = (counts[u.planType] || 0) + 1;

  const catalog = Object.keys(data.plans)
    .map((key) => {
      const p = data.plans[key];
      const rep = data.units.find((u) => u.planType === key);
      const sqft = p.areas.map((a) => a.sqft);
      return {
        key,
        pdata: p,
        rep,
        design: rep.design,
        beds: p.beds,
        variant: key.slice(-1),
        count: counts[key] || 0,
        sqftMin: Math.min(...sqft),
        sqftMax: Math.max(...sqft),
        isEnd: p.party.left === null || p.party.right === null,
      };
    })
    .sort(
      (a, b) =>
        DESIGN_ORDER.indexOf(a.design) - DESIGN_ORDER.indexOf(b.design) ||
        a.beds - b.beds ||
        a.variant.localeCompare(b.variant)
    );
  const catalogByKey = new Map(catalog.map((c) => [c.key, c]));

  // ==========================================================================
  // 3. DOM
  // ==========================================================================
  const el = (id) => document.getElementById(id);
  const elPlanList = el('sh-plan-list');
  const elHero = el('sh-plan-hero');
  const elTitle = el('sh-plan-title');
  const elSub = el('sh-plan-sub');
  const elStats = el('sh-stats');
  const elRooms = el('sh-rooms');
  const elSheetImg = el('sh-sheet-img');
  const elLabels = el('sh-labels');
  const elRoomCard = el('sh-room-card');
  const elRoomFloor = el('sh-room-floor');
  const elRoomName = el('sh-room-name');
  const elRoomSize = el('sh-room-size');
  const elRoomArea = el('sh-room-area');
  const elWalkHud = el('sh-walk-hud');
  const elWalkRoom = el('sh-walk-room');
  const elViewHint = el('sh-view-hint');
  const btnRotate = el('sh-btn-rotate');
  const viewBtns = document.querySelectorAll('[data-sh-view]');
  const bedBtns = document.querySelectorAll('[data-sh-beds]');

  // ==========================================================================
  // 4. STATE
  // ==========================================================================
  let active = false;
  let current = null;
  let view = 'exterior';
  let lastOrbitView = 'ground';
  let bedFilter = 'all';
  let selected = null; // room item
  let hovered = null;
  let tween = null;
  const player = { x: 0, z: 0, floorY: 0, yaw: 0, pitch: 0 };
  const keys = { forward: false, backward: false, left: false, right: false };
  const padMove = { forward: false, backward: false, left: false, right: false };

  // ==========================================================================
  // 5. BUILD / DISPOSE ONE HOUSE
  // ==========================================================================
  function loadPlan(key) {
    const entry = catalogByKey.get(key) || catalog[0];
    if (current && current.key === entry.key) return;
    disposeCurrent();

    const pdata = entry.pdata;
    // Studio frame: house at the origin, street side towards +Z (bearing 180 gives a zero rotation)
    const unit = { ...entry.rep, wx: 0, wz: 0, frontBearing: 180, gardenBearing: 0 };
    const ax = unit.anchorX;
    const az = unit.anchorZ;

    const root = new THREE.Group();
    root.name = `ShowHome_${entry.key}`;

    const plot = buildUnitPlotAndGarden(unit, pdata, mats, carTemplates);
    plot.traverse((o) => {
      if (o.isMesh) o.receiveShadow = true;
    });
    const shell = createPlanExteriorTemplate(pdata, mats);
    shell.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    const interiorGroup = new THREE.Group();
    root.add(plot, shell, interiorGroup);

    const rec = { unit, pdata, interiorGroup, hasBuiltInterior: false, interiorController: null };
    const ctrl = buildUnitInterior(rec, mats);

    const ghosts = buildNeighbourGhosts(pdata, unit);
    root.add(ghosts);

    const street = buildStreetFront(unit);
    root.add(street);

    // Studio dressing: a small olive in the back garden (kept out of the street-side camera line)
    const trees = buildAll1231Trees([{ species: 'olive', wx: unit.xLeft - ax + 1.6, wz: 1.7 - az, radius: 1.6 }], mats);
    trees.traverse((o) => {
      if (o.isMesh) o.castShadow = true;
    });
    root.add(trees);

    scene.add(root);

    const cx = 0.5 * (pdata.houseX[0] + pdata.houseX[1]) - ax;
    const cz = 11.4 - az;
    const center = new THREE.Vector3(cx, 0, cz);
    sun.target.position.copy(center);
    sun.position.set(cx - 15, 28, cz + 19);
    fill.target.position.copy(center);
    fill.position.set(cx + 20, 12, cz - 14);

    current = {
      key: entry.key,
      entry,
      pdata,
      unit,
      root,
      shell,
      ghosts,
      ctrl,
      interiorGroup,
      center,
      rooms: buildRoomIndex(pdata, ax, az, root),
    };

    buildRoomLabels();
    renderPlanList();
    renderPlanDetails();
    selectRoom(null);
    setView(view === 'walk' ? 'exterior' : view, { instant: true });
  }

  function disposeCurrent() {
    if (!current) return;
    scene.remove(current.root);
    current.root.traverse((o) => {
      if (o.geometry && !keepGeometries.has(o.geometry)) o.geometry.dispose();
      const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of ms) if (!keepMaterials.has(m)) m.dispose();
    });
    elLabels.innerHTML = '';
    current = null;
    selected = null;
    hovered = null;
  }

  // Pale massing of the attached neighbours, so the party walls read as shared walls
  function buildNeighbourGhosts(pdata, unit) {
    const g = new THREE.Group();
    const ax = unit.anchorX;
    const az = unit.anchorZ;
    const neighbourW = 7.6;
    for (const side of ['left', 'right']) {
      const pw = pdata.party[side];
      if (!pw) continue;
      const z0 = Math.min(pw.z[0], 5.6);
      const z1 = Math.max(pw.z[1], 17.2);
      const depth = z1 - z0;
      const x = side === 'left' ? pw.x - neighbourW / 2 : pw.x + neighbourW / 2;
      const box = new THREE.BoxGeometry(neighbourW - 0.06, 7.9, depth);
      const mesh = new THREE.Mesh(box, ghostMat);
      mesh.position.set(x - ax, 3.95, 0.5 * (z0 + z1) - az);
      mesh.renderOrder = 2;
      g.add(mesh);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box), ghostEdgeMat);
      edges.position.copy(mesh.position);
      g.add(edges);
    }
    return g;
  }

  // Short stretch of street in front of the plot for scale
  function buildStreetFront(unit) {
    const g = new THREE.Group();
    const az = unit.anchorZ;
    const cx = 0.5 * (unit.xLeft + unit.xRight) - unit.anchorX;
    const road = new THREE.Mesh(new THREE.PlaneGeometry(44, 7.4), mats.roadAsphalt);
    road.rotation.x = -Math.PI / 2;
    road.position.set(cx, 0.005, 31.5 - az);
    road.receiveShadow = true;
    g.add(road);
    const kerb = new THREE.Mesh(new THREE.BoxGeometry(44, 0.14, 0.3), mats.kerbStone);
    kerb.position.set(cx, 0.07, 27.65 - az);
    kerb.receiveShadow = true;
    g.add(kerb);
    const verge = new THREE.Mesh(new THREE.PlaneGeometry(44, 2.2), mats.footpathPaver);
    verge.rotation.x = -Math.PI / 2;
    verge.position.set(cx, 0.012, 26.4 - az);
    verge.receiveShadow = true;
    g.add(verge);
    return g;
  }

  // Rooms + outdoor zones per floor, each with a local polygon, label point and highlight overlay
  function buildRoomIndex(pdata, ax, az, root) {
    const index = { ground: [], first: [] };
    for (const fk of ['ground', 'first']) {
      const fl = pdata.floors[fk];
      const items = fl.rooms
        .filter((rm) => !rm.overlayOnly)
        .map((rm) => ({ src: rm, name: rm.name, type: rm.type, dims: rm.dims || '', areaM2: rm.areaM2, outdoor: false }));
      if (fk === 'ground') {
        for (const out of fl.outdoor || []) {
          items.push({
            src: out,
            name: OUTDOOR_NAMES[out.type] || out.name || 'Garden',
            type: out.type,
            dims: '',
            areaM2: out.areaM2,
            outdoor: true,
          });
        }
      }
      items.forEach((it, idx) => {
        it.fk = fk;
        it.idx = idx;
        it.poly = it.src.poly.map((p) => [p[0] - ax, p[1] - az]);
        const lp = it.src.label ? [it.src.label[0] - ax, it.src.label[1] - az] : interiorPoint(it.poly);
        it.lx = lp[0];
        it.lz = lp[1];

        const shape = new THREE.Shape();
        it.poly.forEach((p, i) => (i === 0 ? shape.moveTo(p[0], -p[1]) : shape.lineTo(p[0], -p[1])));
        shape.closePath();
        const geom = new THREE.ShapeGeometry(shape);
        geom.rotateX(-Math.PI / 2);
        const overlay = new THREE.Mesh(geom, overlayMat);
        overlay.position.y = FLOOR_Y[fk] + (it.outdoor ? 0.1 : 0.06);
        overlay.visible = false;
        overlay.renderOrder = 3;
        root.add(overlay);
        it.overlay = overlay;
      });
      index[fk] = items;
    }
    return index;
  }

  // ==========================================================================
  // 6. VIEWS
  // ==========================================================================
  function setView(next, { instant = false } = {}) {
    if (!current) return;
    view = next;
    if (next === 'ground' || next === 'first') lastOrbitView = next;
    document.body.dataset.shView = next;
    viewBtns.forEach((b) => b.classList.toggle('active', b.dataset.shView === next));

    const { shell, ghosts, ctrl, interiorGroup, center } = current;
    const isFloor = next === 'ground' || next === 'first';

    shell.visible = next === 'exterior';
    ghosts.visible = next === 'exterior';
    interiorGroup.visible = next !== 'exterior';
    if (isFloor) ctrl.setViewMode(true, next);
    else ctrl.setViewMode(false, 'both');

    if (selected && (!isFloor || selected.fk !== next)) selectRoom(null);
    setHover(null);
    elWalkHud.classList.toggle('hidden', next !== 'walk');
    elRoomCard.classList.toggle('hidden', !selected);

    const hints = {
      exterior: 'Drag to rotate · Click the house to look inside',
      ground: 'Tap a room to see its size',
      first: 'Tap a room to see its size',
      walk: '',
    };
    elViewHint.textContent = hints[next];

    if (next === 'walk') {
      controls.enabled = false;
      setAutoRotate(false);
      tween = null;
      camera.fov = 64;
      camera.updateProjectionMatrix();
      const start = findRoom('ground', (r) => r.type === 'entrance') || findRoom('ground', (r) => r.type === 'living');
      placePlayer(start ? start.lx : center.x, start ? start.lz : center.z, 0, 0);
      return;
    }

    controls.enabled = true;
    camera.fov = 36;
    camera.updateProjectionMatrix();
    if (next !== 'exterior') setAutoRotate(false);

    const portrait = camera.aspect < 1;
    let pos;
    let target;
    if (next === 'exterior') {
      const k = portrait ? 1.3 : 1;
      target = new THREE.Vector3(center.x, 3.2, center.z + 2.5);
      pos = new THREE.Vector3(center.x + 21 * k, 11.5 * k, center.z + 36 * k);
    } else {
      const k = portrait ? 1.35 : 1.12;
      const y = FLOOR_Y[next];
      target = new THREE.Vector3(center.x, y + 0.6, center.z + 0.6);
      pos = new THREE.Vector3(center.x + 6.5 * k, y + 18.5 * k, center.z + 13.5 * k);
    }
    moveCamera(pos, target, instant);
  }

  function moveCamera(pos, target, instant = false) {
    if (instant) {
      tween = null;
      camera.position.copy(pos);
      controls.target.copy(target);
      controls.update();
      return;
    }
    tween = {
      t: 0,
      dur: 0.9,
      fromPos: camera.position.clone(),
      fromTarget: controls.target.clone(),
      toPos: pos,
      toTarget: target,
    };
  }

  function resetView() {
    setView(view === 'walk' ? lastOrbitView : view);
  }

  function setAutoRotate(on) {
    controls.autoRotate = on;
    btnRotate.classList.toggle('active', on);
    btnRotate.setAttribute('aria-pressed', String(on));
  }

  // ==========================================================================
  // 7. ROOMS: LABELS, HOVER, SELECTION
  // ==========================================================================
  function findRoom(fk, pred) {
    return current ? current.rooms[fk].find(pred) : null;
  }

  function pickRoomAt(fk, lx, lz) {
    const items = current.rooms[fk];
    // Rooms win over the outdoor zones that wrap around them
    return (
      items.find((it) => !it.outdoor && pointInPoly(lx, lz, it.poly)) ||
      items.find((it) => it.outdoor && pointInPoly(lx, lz, it.poly)) ||
      null
    );
  }

  function buildRoomLabels() {
    elLabels.innerHTML = '';
    for (const fk of ['ground', 'first']) {
      for (const it of current.rooms[fk]) {
        if (it.type === 'stair' && fk === 'first') continue;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `sh-label${it.outdoor ? ' is-outdoor' : ''}`;
        b.innerHTML = `<span class="sh-label-name">${escapeHtml(it.name)}</span>${
          it.dims ? `<span class="sh-label-dims">${formatDims(it.dims)}</span>` : ''
        }`;
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          selectRoom(it, { focus: true });
        });
        elLabels.appendChild(b);
        it.labelEl = b;
      }
    }
  }

  function setHover(it) {
    if (hovered === it) return;
    if (hovered && hovered !== selected) hovered.overlay.visible = false;
    hovered = it;
    if (it && it !== selected) {
      it.overlay.material = hoverMat;
      it.overlay.visible = true;
    }
    canvas.style.cursor = it ? 'pointer' : '';
  }

  function selectRoom(it, { focus = false } = {}) {
    if (selected) {
      selected.overlay.visible = false;
      if (selected.labelEl) selected.labelEl.classList.remove('active');
    }
    selected = it;
    elRooms.querySelectorAll('.sh-room-row').forEach((r) => {
      r.classList.toggle('active', !!it && r.dataset.shFloor === it.fk && Number(r.dataset.shIdx) === it.idx);
    });
    if (!it) {
      elRoomCard.classList.add('hidden');
      return;
    }
    it.overlay.material = overlayMat;
    it.overlay.visible = true;
    if (it.labelEl) it.labelEl.classList.add('active');

    elRoomFloor.textContent = it.outdoor ? 'Outdoor · Ground floor' : it.fk === 'first' ? 'First floor' : 'Ground floor';
    elRoomName.textContent = it.name;
    elRoomSize.textContent = it.dims ? formatDims(it.dims) : '—';
    elRoomArea.textContent = it.areaM2 ? `${it.areaM2.toFixed(1)} m²` : '—';
    el('sh-btn-walk-room').classList.toggle('hidden', it.type === 'parking' || it.type === 'sideYard');
    elRoomCard.classList.remove('hidden');

    if (focus) {
      if (view !== it.fk) setView(it.fk);
      const xs = it.poly.map((p) => p[0]);
      const zs = it.poly.map((p) => p[1]);
      const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs), 2.5);
      const d = (6 + span * 1.25) * (camera.aspect < 1 ? 1.6 : 1);
      const y = FLOOR_Y[it.fk];
      const target = new THREE.Vector3(it.lx, y + 0.5, it.lz);
      const pos = new THREE.Vector3(it.lx + d * 0.32, y + d * 0.92, it.lz + d * 0.62);
      setAutoRotate(false);
      moveCamera(pos, target);
    }
  }

  const tmpV = new THREE.Vector3();
  function updateLabels() {
    const isFloor = view === 'ground' || view === 'first';
    const w = window.innerWidth;
    const h = window.innerHeight;
    const shown = [];
    for (const fk of ['ground', 'first']) {
      for (const it of current.rooms[fk]) {
        if (!it.labelEl) continue;
        if (!isFloor || fk !== view) {
          it.labelEl.style.display = 'none';
          continue;
        }
        tmpV.set(it.lx, FLOOR_Y[fk] + 1.0, it.lz).project(camera);
        if (tmpV.z > 1 || tmpV.z < -1) {
          it.labelEl.style.display = 'none';
          continue;
        }
        shown.push({ it, x: (tmpV.x * 0.5 + 0.5) * w, y: (-tmpV.y * 0.5 + 0.5) * h });
      }
    }
    // Light screen-space separation so neighbouring labels do not overlap
    const minW = 84;
    const minH = 24;
    for (let iter = 0; iter < 5; iter++) {
      for (let i = 0; i < shown.length; i++) {
        for (let j = i + 1; j < shown.length; j++) {
          const a = shown[i];
          const b = shown[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          if (Math.abs(dx) < minW && Math.abs(dy) < minH) {
            const s = dy >= 0 ? 1 : -1;
            const push = (minH - Math.abs(dy)) * 0.5;
            a.y -= s * push;
            b.y += s * push;
          }
        }
      }
    }
    for (const s of shown) {
      s.it.labelEl.style.display = '';
      s.it.labelEl.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px) translate(-50%, -50%)`;
    }
  }

  // ==========================================================================
  // 8. WALK-THROUGH
  // ==========================================================================
  function placePlayer(x, z, floorY, yaw) {
    player.x = x;
    player.z = z;
    player.floorY = floorY;
    player.yaw = yaw;
    player.pitch = -0.04;
    current.ctrl.updateDoors(x, z, floorY, 1.0);
    applyPlayerCamera();
    updateWalkRoom();
  }

  function applyPlayerCamera() {
    camera.position.set(player.x, player.floorY + 1.6, player.z);
    camera.quaternion.setFromEuler(new THREE.Euler(player.pitch, player.yaw, 0, 'YXZ'));
  }

  function updateWalkRoom() {
    const fk = player.floorY >= 1.8 ? 'first' : 'ground';
    const it = pickRoomAt(fk, player.x, player.z);
    const floorName = fk === 'first' ? 'First floor' : 'Ground floor';
    elWalkRoom.innerHTML = it
      ? `<strong>${escapeHtml(it.name)}</strong><span>${floorName}${it.dims ? ` · ${formatDims(it.dims)}` : ''}</span>`
      : `<strong>${floorName}</strong><span>${current.key}</span>`;
  }

  function updateWalk(dt) {
    const { ctrl } = current;
    const fwd = (keys.forward || padMove.forward ? 1 : 0) - (keys.backward || padMove.backward ? 1 : 0);
    const turn = (keys.left || padMove.left ? 1 : 0) - (keys.right || padMove.right ? 1 : 0);
    if (turn) player.yaw += turn * 1.7 * dt;
    if (fwd) {
      const step = fwd * 3.2 * dt;
      const nx = player.x - Math.sin(player.yaw) * step;
      const nz = player.z - Math.cos(player.yaw) * step;
      if (!ctrl.checkLocalWallCollision(nx, nz, player.floorY)) {
        player.x = nx;
        player.z = nz;
        player.floorY = ctrl.sampleFloorElevation(nx, nz, player.floorY);
      }
      updateWalkRoom();
    }
    ctrl.updateDoors(player.x, player.z, player.floorY, dt);
    applyPlayerCamera();
  }

  // ==========================================================================
  // 9. PANELS
  // ==========================================================================
  function renderPlanList() {
    const groups = DESIGN_ORDER.map((design) => ({
      design,
      items: catalog.filter((c) => c.design === design && (bedFilter === 'all' || String(c.beds) === bedFilter)),
    })).filter((g) => g.items.length);

    elPlanList.innerHTML = groups
      .map(
        (g) => `
        <div class="sh-plan-group">
          <div class="sh-plan-group-label">${g.design}</div>
          ${g.items
            .map(
              (c) => `
            <button type="button" class="sh-plan-item${current && current.key === c.key ? ' active' : ''}" data-sh-plan="${c.key}">
              <span class="sh-plan-code">${c.key}</span>
              <span class="sh-plan-text">
                <strong>${c.beds} bed · Type ${c.variant}</strong>
                <span>${fmtSqft(c)} sq ft · ${c.isEnd ? 'End unit' : 'Middle unit'}</span>
              </span>
              <span class="sh-plan-count">${c.count}</span>
            </button>`
            )
            .join('')}
        </div>`
      )
      .join('');
    const activeItem = elPlanList.querySelector('.sh-plan-item.active');
    if (activeItem) activeItem.scrollIntoView({ block: 'nearest', inline: 'center' });
  }

  function renderPlanDetails() {
    const c = current.entry;
    const p = c.pdata;
    elHero.src = DESIGN_RENDER[c.design];
    elHero.alt = `${c.design} design render`;
    elTitle.textContent = `${c.design} ${c.beds} Bedroom · Type ${c.variant}`;
    elSub.textContent = `Plan ${c.key} · ${c.count} homes in Nara · ${c.isEnd ? 'End of row' : 'Middle of row'}`;
    elStats.innerHTML = `
      <div class="stat"><span class="stat-label">Bedrooms</span><span class="stat-value">${c.beds} <small>+ maid</small></span></div>
      <div class="stat"><span class="stat-label">Built-up area</span><span class="stat-value">${fmtSqft(c)} <small>sq ft</small></span></div>
      <div class="stat"><span class="stat-label">Plot</span><span class="stat-value">${p.plot.w.toFixed(1)} × ${p.plot.d.toFixed(1)} <small>m</small></span></div>
      <div class="stat"><span class="stat-label">In Nara</span><span class="stat-value">${c.count} <small>homes</small></span></div>
    `;
    elRooms.innerHTML = ['ground', 'first']
      .map(
        (fk) => `
        <div class="sh-room-group">
          <div class="sh-room-group-label">${fk === 'first' ? 'First floor' : 'Ground floor'}</div>
          ${current.rooms[fk]
            .filter((it) => !(fk === 'first' && it.type === 'stair'))
            .map(
              (it) => `
            <button type="button" class="sh-room-row" data-sh-floor="${fk}" data-sh-idx="${it.idx}">
              <span>${escapeHtml(it.name)}</span>
              <span class="sh-room-dims">${it.dims ? formatDims(it.dims) : it.areaM2 ? `${it.areaM2.toFixed(1)} m²` : ''}</span>
            </button>`
            )
            .join('')}
        </div>`
      )
      .join('');
    elSheetImg.src = p.sheetImage;
    elSheetImg.alt = `Developer floor-plan sheet ${c.key}`;
  }

  // ==========================================================================
  // 10. EVENTS
  // ==========================================================================
  elPlanList.addEventListener('click', (e) => {
    const b = e.target.closest('[data-sh-plan]');
    if (b) loadPlan(b.dataset.shPlan);
  });

  bedBtns.forEach((b) =>
    b.addEventListener('click', () => {
      bedFilter = b.dataset.shBeds;
      bedBtns.forEach((x) => x.classList.toggle('active', x === b));
      renderPlanList();
    })
  );

  viewBtns.forEach((b) => b.addEventListener('click', () => setView(b.dataset.shView)));

  elRooms.addEventListener('click', (e) => {
    const r = e.target.closest('.sh-room-row');
    if (!r || !current) return;
    const it = current.rooms[r.dataset.shFloor][Number(r.dataset.shIdx)];
    if (it) selectRoom(it, { focus: true });
  });

  btnRotate.addEventListener('click', () => {
    if (view === 'walk') setView('exterior');
    setAutoRotate(!controls.autoRotate);
  });
  el('sh-btn-reset').addEventListener('click', resetView);
  el('sh-btn-close-room').addEventListener('click', () => selectRoom(null));
  el('sh-btn-walk-room').addEventListener('click', () => {
    if (!selected) return;
    const it = selected;
    setView('walk');
    placePlayer(it.lx, it.lz, FLOOR_Y[it.fk], 0);
  });
  el('sh-btn-info').addEventListener('click', () => document.body.classList.toggle('sh-info-open'));
  el('sh-btn-close-info').addEventListener('click', () => document.body.classList.remove('sh-info-open'));

  el('sh-sheet-open').addEventListener('click', () => {
    const modal = document.getElementById('sheet-modal');
    document.getElementById('modal-sheet-title').textContent = `${current.entry.design} ${current.entry.beds} Bedroom · Type ${current.entry.variant} (${current.key})`;
    document.getElementById('modal-sheet-img').src = current.pdata.sheetImage;
    modal.classList.remove('hidden');
  });

  el('sh-btn-find').addEventListener('click', () => {
    const key = current.key;
    state.setCameraMode('aerial');
    const sel = document.getElementById('filter-plan');
    if (sel) {
      sel.value = key;
      sel.dispatchEvent(new Event('change'));
    }
    if (state.toggleFiltersPanel) state.toggleFiltersPanel(true);
  });

  // Room picking on the canvas (floor views) and drag-to-look (walk view)
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const hitPoint = new THREE.Vector3();
  const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  let downX = 0;
  let downY = 0;
  let lookDrag = false;

  function roomUnderPointer(e) {
    if (view !== 'ground' && view !== 'first') return null;
    const rect = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    floorPlane.constant = -FLOOR_Y[view];
    if (!ray.ray.intersectPlane(floorPlane, hitPoint)) return null;
    return pickRoomAt(view, hitPoint.x, hitPoint.z);
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!active) return;
    downX = e.clientX;
    downY = e.clientY;
    if (view === 'walk') {
      lookDrag = true;
    }
  });
  window.addEventListener('pointermove', (e) => {
    if (!active) return;
    if (lookDrag) {
      player.yaw -= e.movementX * 0.0045;
      player.pitch = Math.max(-1.1, Math.min(1.1, player.pitch - e.movementY * 0.0045));
      applyPlayerCamera();
      return;
    }
    if (e.target === canvas && e.buttons === 0 && e.pointerType === 'mouse') setHover(roomUnderPointer(e));
  });
  window.addEventListener('pointerup', (e) => {
    if (!active) return;
    lookDrag = false;
    if (e.target !== canvas || Math.hypot(e.clientX - downX, e.clientY - downY) > 6) return;
    if (view === 'ground' || view === 'first') {
      const it = roomUnderPointer(e);
      selectRoom(it, { focus: !!it });
    } else if (view === 'exterior' && pointerHitsHouse(e)) {
      setView('ground');
    }
  });

  function pointerHitsHouse(e) {
    const rect = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    return ray.intersectObject(current.shell, true).length > 0;
  }

  const KEYMAP = { KeyW: 'forward', ArrowUp: 'forward', KeyS: 'backward', ArrowDown: 'backward', KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right' };
  window.addEventListener('keydown', (e) => {
    if (!active || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (KEYMAP[e.code]) keys[KEYMAP[e.code]] = true;
    if (e.code === 'Escape' && selected) selectRoom(null);
  });
  window.addEventListener('keyup', (e) => {
    if (KEYMAP[e.code]) keys[KEYMAP[e.code]] = false;
  });

  document.querySelectorAll('[data-sh-move]').forEach((b) => {
    const dir = b.dataset.shMove;
    const on = (e) => {
      e.preventDefault();
      padMove[dir] = true;
    };
    const off = (e) => {
      e.preventDefault();
      padMove[dir] = false;
    };
    b.addEventListener('pointerdown', on);
    b.addEventListener('pointerup', off);
    b.addEventListener('pointerleave', off);
    b.addEventListener('pointercancel', off);
  });

  // ==========================================================================
  // 11. PUBLIC API
  // ==========================================================================
  function enter(planKey) {
    active = true;
    document.body.classList.add('mode-showhome');
    loadPlan(planKey || (current && current.key) || catalog[0].key);
    if (!current) return;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    setView('exterior', { instant: true });
    // Begin slightly off the hero angle and ease in, with a slow turntable
    camera.position.applyAxisAngle(new THREE.Vector3(0, 1, 0), -0.35);
    camera.position.y += 3;
    setView('exterior');
    setAutoRotate(true);
  }

  function exit() {
    active = false;
    controls.enabled = false;
    setAutoRotate(false);
    setHover(null);
    lookDrag = false;
    Object.keys(padMove).forEach((k) => (padMove[k] = false));
    document.body.classList.remove('mode-showhome', 'sh-info-open');
    delete document.body.dataset.shView;
  }

  function update(dt) {
    if (!active || !current) return;
    if (view === 'walk') {
      updateWalk(dt);
    } else {
      if (tween) {
        tween.t = Math.min(1, tween.t + dt / tween.dur);
        const k = tween.t < 0.5 ? 4 * tween.t ** 3 : 1 - (-2 * tween.t + 2) ** 3 / 2;
        camera.position.lerpVectors(tween.fromPos, tween.toPos, k);
        controls.target.lerpVectors(tween.fromTarget, tween.toTarget, k);
        if (tween.t >= 1) tween = null;
      }
      controls.update();
    }
    updateLabels();
  }

  function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  }

  return {
    scene,
    camera,
    catalog,
    enter,
    exit,
    update,
    onResize,
    loadPlan,
    setView,
    selectRoom: (fk, name) => {
      const it = current && current.rooms[fk].find((r) => r.name === name);
      selectRoom(it || null, { focus: !!it });
    },
    get isActive() {
      return active;
    },
    get currentKey() {
      return current ? current.key : null;
    },
    get view() {
      return view;
    },
  };
}

// ============================================================================
// HELPERS
// ============================================================================
function pointInPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0];
    const zi = poly[i][1];
    const xj = poly[j][0];
    const zj = poly[j][1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi + 1e-9) + xi) inside = !inside;
  }
  return inside;
}

// Point well inside a polygon (grid search for the spot farthest from its edges) for label placement
function interiorPoint(poly) {
  const xs = poly.map((p) => p[0]);
  const zs = poly.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const z0 = Math.min(...zs);
  const z1 = Math.max(...zs);
  let best = [(x0 + x1) / 2, (z0 + z1) / 2];
  let bestD = -1;
  const n = 24;
  for (let i = 1; i < n; i++) {
    for (let j = 1; j < n; j++) {
      const x = x0 + ((x1 - x0) * i) / n;
      const z = z0 + ((z1 - z0) * j) / n;
      if (!pointInPoly(x, z, poly)) continue;
      let d = Infinity;
      for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
        d = Math.min(d, distToSeg(x, z, poly[b][0], poly[b][1], poly[a][0], poly[a][1]));
      }
      if (d > bestD) {
        bestD = d;
        best = [x, z];
      }
    }
  }
  return best;
}

function distToSeg(px, pz, ax, az, bx, bz) {
  const abx = bx - ax;
  const abz = bz - az;
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (pz - az) * abz) / (abx * abx + abz * abz || 1e-9)));
  return Math.hypot(px - (ax + abx * t), pz - (az + abz * t));
}

function formatDims(dims) {
  return `${dims.replace(/\s*x\s*/i, ' × ')} m`;
}

function fmtSqft(c) {
  const lo = Math.round(c.sqftMin).toLocaleString();
  const hi = Math.round(c.sqftMax).toLocaleString();
  return lo === hi ? lo : `${lo}–${hi}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function makeVerticalGradient(top, bottom) {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeRadialAlpha() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.35, '#ffffff');
  g.addColorStop(1, '#000000');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}

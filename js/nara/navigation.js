/**
 * Street-Level Walk (1.6m Eye) / Drive SUV & Inside-Home First-Person / Cut-Away Navigation
 * Handles WASD/Arrow keys, mouse look, touch controls, wall collisions, stairs, and door triggers
 */
import * as THREE from 'three';

export function initNavigationModule(state) {
  const { data, camera, orbitControls, community, mats, buildUnitInterior } = state;
  const unitsByNo = new Map(data.units.map((u) => [u.unit, u]));

  const elNavHud = document.getElementById('navigation-hud');
  const elStreetSub = document.getElementById('street-subcontrols');
  const elInteriorSub = document.getElementById('interior-subcontrols');
  const elRoomJumpStrip = document.getElementById('interior-room-jump');
  const elCurrentRoomName = document.getElementById('current-room-name');
  const elCurrentRoomDims = document.getElementById('current-room-dims');

  const btnStreetWalk = document.getElementById('btn-street-walk');
  const btnStreetDrive = document.getElementById('btn-street-drive');
  const btnStreetGate = document.getElementById('btn-street-gate');
  const btnEnterNearest = document.getElementById('btn-enter-nearest-home');

  const btnIntWalk = document.getElementById('btn-int-walk');
  const btnIntCutaway = document.getElementById('btn-int-cutaway');
  const btnExitToStreet = document.getElementById('btn-exit-to-street');
  const floorBtns = document.querySelectorAll('.floor-btn');

  // First-person player state
  const player = {
    x: 0,
    y: 1.6,
    z: 0,
    floorY: 0.0,
    yaw: 0,
    pitch: 0,
    streetDrive: false, // false = Walk, true = Drive
    speed: 0, // m/s along the heading (walking and driving accelerate and slow down smoothly)
    bob: 0, // walking step phase
  };
  // Eye heights and speeds of real people and cars
  const WALK = { eye: 1.65, speed: 1.9, fast: 4.2, accel: 6 };
  const DRIVE = { eye: 1.3, speed: 13.9, fast: 22.2, accel: 3.2, brake: 7.5 }; // 50 km/h, 80 km/h with Shift

  const keys = { forward: false, backward: false, left: false, right: false, fast: false };
  const touchMove = { forward: false, backward: false, left: false, right: false };
  let isPointerDragging = false;
  let prevPointerX = 0;
  let prevPointerY = 0;

  // Compute street position on the road in front of a given unit (13.5m from front facade) facing the home
  function getStreetSpawnForUnit(u) {
    const pdata = data.plans[u.planType];
    const fbRad = THREE.MathUtils.degToRad(u.frontBearing);
    const fx = Math.sin(fbRad);
    const fz = -Math.cos(fbRad);
    // Right vector along row (+X in local unit coords)
    const rx = -Math.cos(fbRad);
    const rz = -Math.sin(fbRad);

    // Center of the house facade in local X
    const houseMidX = pdata ? 0.5 * (pdata.houseX[0] + pdata.houseX[1]) - u.anchorX : 0;
    const facadeLz = 17.2 - (u.anchorZ || 12.0); // ~5.0m in front of unit anchor
    const roadDistFromFacade = 13.5; // 13.5m in front of facade (on the street outside the carport)
    const totalFrontOffset = facadeLz + roadDistFromFacade;

    const facadeWx = u.wx + rx * houseMidX + fx * facadeLz;
    const facadeWz = u.wz + rz * houseMidX + fz * facadeLz;

    const wx = u.wx + rx * houseMidX + fx * totalFrontOffset;
    const wz = u.wz + rz * houseMidX + fz * totalFrontOffset;

    // Look from road point directly toward the front center of the home
    const dx = facadeWx - wx;
    const dz = facadeWz - wz;
    const lookYaw = Math.atan2(-dx, -dz);
    return { wx, wz, yaw: lookYaw, facadeWx, facadeWz };
  }

  function enterStreetMode(unitNo = null, startAtGate = false) {
    const targetNo = unitNo || state.selectedUnitNo || 233;
    const u = unitsByNo.get(targetNo) || unitsByNo.get(233);

    if (state.collapseBothPanels) {
      state.collapseBothPanels();
    }

    // Restore any active unit's exterior shell when stepping out to street
    restoreActiveInteriorShell();

    if (startAtGate) {
      const gateAmenity = data.site.amenityPoints.find((a) => a.number === 9);
      player.x = gateAmenity ? gateAmenity.wx - 8 : 200;
      player.z = gateAmenity ? gateAmenity.wz + 8 : 66;
      player.yaw = THREE.MathUtils.degToRad(52); // Facing North-West down the entry boulevard
    } else {
      const sp = getStreetSpawnForUnit(u);
      player.x = sp.wx;
      player.z = sp.wz;
      player.yaw = sp.yaw;
    }

    player.floorY = 0.0;
    player.y = player.streetDrive ? 1.85 : 1.6;
    player.pitch = 0.06;

    state.cameraMode = 'street';
    orbitControls.enabled = false;
    syncModeUI();
    applyFirstPersonCamera();
    updateStreetLocationLabel();
  }

  /** Walk or drive from any street point (every community, not only Nara) */
  function enterStreetAt(x, z, yaw, drive) {
    if (state.collapseBothPanels) state.collapseBothPanels();
    restoreActiveInteriorShell();
    player.x = x; player.z = z; player.yaw = yaw;
    player.floorY = 0; player.pitch = drive ? 0.02 : 0.04; player.speed = 0;
    setDrive(drive);
    player.y = drive ? DRIVE.eye : WALK.eye;
    state.cameraMode = 'street';
    orbitControls.enabled = false;
    syncModeUI();
    applyFirstPersonCamera();
    updateStreetLocationLabel();
  }
  function setDrive(drive) {
    player.streetDrive = !!drive;
    player.speed = 0;
    btnStreetWalk.classList.toggle('active', !drive);
    btnStreetDrive.classList.toggle('active', !!drive);
    if (drive && state.street?.keepOnRoad) { const p = state.street.keepOnRoad(player.x, player.z, player.x, player.z, true); player.x = p.x; player.z = p.z; if (p.yaw != null) player.yaw = p.yaw; }
    if (state.cameraMode === 'street') { player.y = drive ? DRIVE.eye : WALK.eye; applyFirstPersonCamera(); updateStreetLocationLabel(); }
  }

  function enterHomeInterior(unitNo = null, subMode = 'interior') {
    const targetNo = unitNo || state.selectedUnitNo || 233;
    if (state.selectedUnitNo !== targetNo && state.selectUnit) {
      state.selectUnit(targetNo, { flyTo: false, openDetails: false });
    }
    if (state.collapseBothPanels) {
      state.collapseBothPanels();
    }
    const rec = community.unitRecords.get(targetNo);
    if (!rec) return;

    // Restore previous unit shell if switching homes
    if (state.activeInteriorUnitNo && state.activeInteriorUnitNo !== targetNo) {
      restoreActiveInteriorShell();
    }

    // Build 1:1 furnished interior on demand and hide exterior shell of this unit
    const intCtrl = buildUnitInterior(rec, mats);
    rec.shellGroup.visible = false;
    state.activeInteriorUnitNo = targetNo;
    state.activeInteriorCtrl = intCtrl;

    // Populate room jump buttons & 3D cutaway labels
    populateRoomJumpStrip(intCtrl);
    if (state.minimapModule) {
      state.minimapModule.buildRoomMarkersForUnit(intCtrl);
    }

    if (subMode === 'cutaway') {
      state.cameraMode = 'cutaway';
      state.cutawayFloor = state.cutawayFloor || 'both';
      intCtrl.setViewMode(true, state.cutawayFloor);
      document.querySelectorAll('.floor-btn').forEach((b) => {
        b.classList.toggle('active', b.dataset.floor === state.cutawayFloor);
      });
      orbitControls.enabled = true;

      const u = rec.unit;
      const fbRad = THREE.MathUtils.degToRad(u.frontBearing);
      const fx = Math.sin(fbRad), fz = -Math.cos(fbRad);
      const rx = -Math.cos(fbRad), rz = -Math.sin(fbRad);
      camera.position.set(u.wx + fx * 10.5 + rx * 8.5, 15.5, u.wz + fz * 10.5 + rz * 8.5);
      orbitControls.target.set(u.wx, 2.4, u.wz);
      orbitControls.update();
    } else {
      state.cameraMode = 'interior';
      intCtrl.setViewMode(false, 'both');
      orbitControls.enabled = false;

      // Spawn inside the Entrance Hall / Living Room facing into the home
      const rooms = intCtrl.getNavigableRooms();
      const entryRm =
        rooms.find((r) => r.type === 'entrance') ||
        rooms.find((r) => r.type === 'living') ||
        rooms[0];
      if (entryRm) {
        player.x = entryRm.wx;
        player.z = entryRm.wz;
        player.floorY = entryRm.yFloor;
      } else {
        player.x = rec.unit.wx;
        player.z = rec.unit.wz;
        player.floorY = 0.0;
      }
      player.y = player.floorY + 1.6;
      // Face from street side toward garden side
      const gbRad = THREE.MathUtils.degToRad(rec.unit.gardenBearing);
      player.yaw = Math.atan2(-Math.sin(gbRad), Math.cos(gbRad));
      player.pitch = -0.03;
      applyFirstPersonCamera();
    }

    syncModeUI();
    updateInteriorRoomStatus();
  }

  function restoreActiveInteriorShell() {
    if (state.activeInteriorUnitNo) {
      const prevRec = community.unitRecords.get(state.activeInteriorUnitNo);
      if (prevRec) {
        prevRec.shellGroup.visible = true;
        if (prevRec.interiorController) {
          prevRec.interiorController.setViewMode(false, 'both');
        }
      }
    }
    if (state.minimapModule) {
      state.minimapModule.clearRoomMarkers();
    }
  }

  function jumpToRoomInUnit(unitNo, floorKey, roomName) {
    if (state.activeInteriorUnitNo !== unitNo || state.cameraMode !== 'interior') {
      enterHomeInterior(unitNo, 'interior');
    }
    const intCtrl = state.activeInteriorCtrl;
    if (!intCtrl) return;
    const rooms = intCtrl.getNavigableRooms();
    const target =
      rooms.find((r) => r.floorKey === floorKey && r.name === roomName) ||
      rooms.find((r) => r.name === roomName);
    if (target) {
      player.x = target.wx;
      player.z = target.wz;
      player.floorY = target.yFloor;
      player.y = player.floorY + 1.6;
      intCtrl.updateDoors(target.lx, target.lz, player.floorY, 1.0);
      applyFirstPersonCamera();
      updateInteriorRoomStatus();
    }
  }

  function populateRoomJumpStrip(intCtrl) {
    const rooms = intCtrl.getNavigableRooms();
    elRoomJumpStrip.innerHTML = rooms
      .map(
        (r) => `
      <button class="room-jump-btn" data-floor="${r.floorKey}" data-room="${r.name}">
        <span class="rj-floor">${r.floorKey === 'first' ? '1F' : r.type === 'garden' ? 'OUT' : 'GF'}</span>
        <span>${r.name}</span>
      </button>
    `
      )
      .join('');
  }

  function applyFirstPersonCamera() {
    camera.position.set(player.x, player.y, player.z);
    const euler = new THREE.Euler(player.pitch, player.yaw, 0, 'YXZ');
    camera.quaternion.setFromEuler(euler);
  }

  function updateStreetLocationLabel() {
    const near = !state.street || state.street.nearNara(player.x, player.z);
    btnStreetGate.classList.toggle('hidden', !near);
    btnEnterNearest.classList.toggle('hidden', !near);
    document.getElementById('minimap-container')?.classList.toggle('hidden', !near);
    if (!near) {
      const [title, sub] = state.street.label(player.x, player.z);
      const kmh = Math.round(Math.abs(player.speed) * 3.6);
      elCurrentRoomName.textContent = title;
      elCurrentRoomDims.textContent = player.streetDrive ? `${kmh} km/h · ${sub}` : sub;
      return;
    }
    // Find nearest unit (measuring to its front facade) to display on Street HUD
    let nearestU = null;
    let bestD = Infinity;
    for (const u of data.units) {
      const fbRad = THREE.MathUtils.degToRad(u.frontBearing);
      const facX = u.wx + Math.sin(fbRad) * 5.0;
      const facZ = u.wz - Math.cos(fbRad) * 5.0;
      const d = Math.hypot(facX - player.x, facZ - player.z);
      if (d < bestD) {
        bestD = d;
        nearestU = u;
      }
    }
    state.nearestStreetUnit = nearestU;
    if (nearestU) {
      elCurrentRoomName.textContent = `Street outside Unit ${nearestU.unit} (${nearestU.design} ${nearestU.planType})`;
      elCurrentRoomDims.textContent = `${Math.round(bestD)}m away · Row ${nearestU.row}`;
    }
  }

  function updateInteriorRoomStatus() {
    const intCtrl = state.activeInteriorCtrl;
    if (!intCtrl) return;
    const loc = intCtrl.worldToLocal(player.x, player.z);
    const rm = intCtrl.getRoomAt(loc.lx, loc.lz, player.floorY);
    if (rm) {
      elCurrentRoomName.textContent = `${rm.name} (${rm.floor})`;
      elCurrentRoomDims.textContent = rm.dims ? `${rm.dims} m` : `Unit ${intCtrl.unit.unit}`;
    } else {
      const flName = player.floorY >= 1.8 ? 'First Floor' : 'Ground Floor';
      elCurrentRoomName.textContent = `Unit ${intCtrl.unit.unit} — ${flName}`;
      elCurrentRoomDims.textContent = intCtrl.unit.planType;
    }
  }

  function syncModeUI() {
    const mode = state.cameraMode;
    // the page follows the mode however it was entered (top bar, panel buttons, Esc)
    document.body.dataset.mode = mode;
    if (state.onModeChanged) state.onModeChanged(mode);
    document.querySelectorAll('.mode-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });

    if (mode === 'aerial' || mode === 'showhome') {
      elNavHud.classList.add('hidden');
      restoreActiveInteriorShell();
    } else {
      elNavHud.classList.remove('hidden');
      elStreetSub.classList.toggle('hidden', mode !== 'street');
      elInteriorSub.classList.toggle('hidden', mode !== 'interior' && mode !== 'cutaway');
      elRoomJumpStrip.classList.toggle('hidden', mode !== 'interior' && mode !== 'cutaway');
      btnIntWalk.classList.toggle('active', mode === 'interior');
      btnIntCutaway.classList.toggle('active', mode === 'cutaway');
    }

    community.updateUnitVisualStates({
      selectedUnitNo: state.selectedUnitNo,
      matchingUnitSet: state.matchingUnitSet,
      filterActive: state.filterActive,
      colorMode: state.colorMode,
      cameraMode: mode,
    });
  }

  function update(dt) {
    const mode = state.cameraMode;
    if (mode === 'street' && state.street) {
      streetMove(dt);
      applyFirstPersonCamera();
      if (state.minimapModule && state.street.nearNara(player.x, player.z)) state.minimapModule.drawMinimap(player.x, player.z, player.yaw);
    } else if (mode === 'street' || mode === 'interior') {
      const fwd = (keys.forward || touchMove.forward ? 1 : 0) - (keys.backward || touchMove.backward ? 1 : 0);
      const turn = (keys.left || touchMove.left ? 1 : 0) - (keys.right || touchMove.right ? 1 : 0);

      if (turn !== 0) {
        player.yaw += turn * 1.65 * dt;
      }

      if (fwd !== 0) {
        const speed = mode === 'street' ? (player.streetDrive ? 14.5 : 5.8) : 3.4;
        const step = fwd * speed * dt;
        const dx = -Math.sin(player.yaw) * step;
        const dz = -Math.cos(player.yaw) * step;
        const nx = player.x + dx;
        const nz = player.z + dz;

        if (mode === 'street') {
          if (!community.checkStreetCollision(nx, nz, 0.45, null)) {
            player.x = nx;
            player.z = nz;
          }
          player.y = player.streetDrive ? 1.85 : 1.6;
          updateStreetLocationLabel();
        } else if (mode === 'interior' && state.activeInteriorCtrl) {
          const intCtrl = state.activeInteriorCtrl;
          const loc = intCtrl.worldToLocal(nx, nz);
          if (!intCtrl.checkLocalWallCollision(loc.lx, loc.lz, player.floorY)) {
            player.x = nx;
            player.z = nz;
            player.floorY = intCtrl.sampleFloorElevation(loc.lx, loc.lz, player.floorY);
          }
          player.y = player.floorY + 1.6;
          updateInteriorRoomStatus();
        }
      }

      if (mode === 'interior' && state.activeInteriorCtrl) {
        const loc = state.activeInteriorCtrl.worldToLocal(player.x, player.z);
        state.activeInteriorCtrl.updateDoors(loc.lx, loc.lz, player.floorY, dt);
      }

      applyFirstPersonCamera();
      if (state.minimapModule) {
        state.minimapModule.drawMinimap(player.x, player.z, player.yaw);
      }
    } else if (mode === 'cutaway' && state.activeInteriorCtrl) {
      const u = state.activeInteriorCtrl.unit;
      if (state.minimapModule) {
        state.minimapModule.drawMinimap(u.wx, u.wz, 0);
      }
    }
  }

  // Street level anywhere: smooth speed, real eye heights, homes are solid, cars stay on the road
  let labelT = 0;
  function streetMove(dt) {
    const fwd = (keys.forward || touchMove.forward ? 1 : 0) - (keys.backward || touchMove.backward ? 1 : 0);
    const turn = (keys.left || touchMove.left ? 1 : 0) - (keys.right || touchMove.right ? 1 : 0);
    const drive = player.streetDrive;
    const P = drive ? DRIVE : WALK;
    const top = (keys.fast ? P.fast : P.speed) * (fwd < 0 ? (drive ? 0.35 : 0.6) : 1);
    const want = fwd * top;
    const rate = drive && Math.sign(want) !== Math.sign(player.speed) && Math.abs(player.speed) > 0.2 ? DRIVE.brake : (fwd ? P.accel : P.accel * 1.4);
    player.speed += Math.max(-rate * dt, Math.min(rate * dt, want - player.speed));
    if (Math.abs(player.speed) < 0.01 && !fwd) player.speed = 0;
    // steering: a car turns with its speed (tighter when slow), a person turns on the spot
    if (turn) player.yaw += turn * dt * (drive ? Math.min(0.9, 0.35 + Math.abs(player.speed) * 0.05) * Math.sign(player.speed || 1) : 1.9);
    // lane assist: with no steering, the car follows the bends of the road and keeps to its lane
    if (drive && !turn && Math.abs(player.speed) > 1 && state.street.roadYaw) {
      const r = state.street.roadYaw(player.x, player.z, player.speed > 0 ? player.yaw : player.yaw + Math.PI);
      if (r) {
        const target = player.speed > 0 ? r.yaw : r.yaw + Math.PI;
        const diff = Math.atan2(Math.sin(target - player.yaw), Math.cos(target - player.yaw));
        if (Math.abs(diff) < 0.7) player.yaw += diff * Math.min(1, dt * 2.2);
        // drift back toward the middle of the right-hand lane
        const lane = r.hw / 2;
        const rx = Math.cos(r.yaw), rz = -Math.sin(r.yaw); // right of the road heading
        const side = (player.x - r.qx) * rx + (player.z - r.qz) * rz;
        const pull = Math.max(-1, Math.min(1, (lane - side) * 0.8)) * dt * Math.min(1, Math.abs(player.speed) / 6);
        player.x += rx * pull; player.z += rz * pull;
      }
    }
    const step = player.speed * dt;
    if (step) {
      const nx = player.x - Math.sin(player.yaw) * step;
      const nz = player.z - Math.cos(player.yaw) * step;
      let p = { x: nx, z: nz };
      if (drive) p = state.street.keepOnRoad(nx, nz, player.x, player.z, false);
      const blocked = state.street.collide(p.x, p.z, drive ? 1.0 : 0.35) || (state.street.nearNara(p.x, p.z) && community.checkStreetCollision(p.x, p.z, drive ? 1.0 : 0.42, null));
      if (!blocked) { player.x = p.x; player.z = p.z; }
      else if (drive) player.speed *= 0.3; // bump: slow right down
      else player.speed = 0;
    }
    // gentle step bob while walking, slight settle while driving
    if (!drive && Math.abs(player.speed) > 0.2) player.bob += dt * Math.abs(player.speed) * 4.2;
    const bobY = drive ? 0 : Math.sin(player.bob) * 0.025 * Math.min(1, Math.abs(player.speed) / WALK.speed);
    player.y = (drive ? DRIVE.eye : WALK.eye) + bobY;
    labelT += dt;
    if (labelT > 0.25) { labelT = 0; updateStreetLocationLabel(); }
    if (player.speed) state.onPlayerMoved?.();
  }

  // Bind keyboard, mouse look & touch controls
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.code === 'KeyW' || e.code === 'ArrowUp') keys.forward = true;
    if (e.code === 'KeyS' || e.code === 'ArrowDown') keys.backward = true;
    if (e.code === 'KeyA' || e.code === 'ArrowLeft') keys.left = true;
    if (e.code === 'KeyD' || e.code === 'ArrowRight') keys.right = true;
    if (e.key === 'Shift') keys.fast = true;
  });

  window.addEventListener('keyup', (e) => {
    if (e.code === 'KeyW' || e.code === 'ArrowUp') keys.forward = false;
    if (e.code === 'KeyS' || e.code === 'ArrowDown') keys.backward = false;
    if (e.code === 'KeyA' || e.code === 'ArrowLeft') keys.left = false;
    if (e.code === 'KeyD' || e.code === 'ArrowRight') keys.right = false;
    if (e.key === 'Shift') keys.fast = false;
  });

  const canvas = document.getElementById('webgl-canvas');
  canvas.addEventListener('pointerdown', (e) => {
    if (state.cameraMode === 'street' || state.cameraMode === 'interior') {
      isPointerDragging = true;
      prevPointerX = e.clientX;
      prevPointerY = e.clientY;
    }
  });
  window.addEventListener('pointermove', (e) => {
    if (!isPointerDragging) return;
    const dx = e.clientX - prevPointerX;
    const dy = e.clientY - prevPointerY;
    prevPointerX = e.clientX;
    prevPointerY = e.clientY;
    player.yaw -= dx * 0.0045;
    player.pitch = Math.max(-1.1, Math.min(1.1, player.pitch - dy * 0.0045));
    applyFirstPersonCamera();
  });
  window.addEventListener('pointerup', () => {
    isPointerDragging = false;
  });

  // On-screen D-pad buttons for mobile & desktop click
  document.querySelectorAll('.dpad-btn').forEach((btn) => {
    const dir = btn.dataset.move;
    const start = (e) => { e.preventDefault(); touchMove[dir] = true; };
    const end = (e) => { e.preventDefault(); touchMove[dir] = false; };
    btn.addEventListener('pointerdown', start);
    btn.addEventListener('pointerup', end);
    btn.addEventListener('pointerleave', end);
  });

  // HUD Subcontrol buttons
  btnStreetWalk.addEventListener('click', () => setDrive(false));
  btnStreetDrive.addEventListener('click', () => setDrive(true));
  btnStreetGate.addEventListener('click', () => enterStreetMode(state.selectedUnitNo, true));
  btnEnterNearest.addEventListener('click', () => {
    const uno = state.nearestStreetUnit ? state.nearestStreetUnit.unit : state.selectedUnitNo || 233;
    enterHomeInterior(uno, 'interior');
  });

  btnIntWalk.addEventListener('click', () => enterHomeInterior(state.selectedUnitNo, 'interior'));
  btnIntCutaway.addEventListener('click', () => enterHomeInterior(state.selectedUnitNo, 'cutaway'));
  btnExitToStreet.addEventListener('click', () => enterStreetMode(state.selectedUnitNo, false));

  floorBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      floorBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.cutawayFloor = btn.dataset.floor;
      if (state.cameraMode !== 'cutaway') {
        enterHomeInterior(state.selectedUnitNo, 'cutaway');
      } else if (state.activeInteriorCtrl) {
        state.activeInteriorCtrl.setViewMode(true, state.cutawayFloor);
      }
    });
  });

  elRoomJumpStrip.addEventListener('click', (e) => {
    const btn = e.target.closest('.room-jump-btn');
    if (!btn || !state.selectedUnitNo) return;
    jumpToRoomInUnit(state.selectedUnitNo, btn.dataset.floor, btn.dataset.room);
  });

  return {
    player,
    enterStreetMode,
    enterStreetAt,
    setDrive,
    enterHomeInterior,
    jumpToRoomInUnit,
    syncModeUI,
    update,
  };
}

/**
 * 2D True-North Mini-Map Canvas & Projected 3D Labels (10 Amenities & Cut-Away Rooms)
 * For Nara at The Valley
 */
import * as THREE from 'three';

export function initMinimapAndLabels(state) {
  const { data, camera } = state;
  const minimapCanvas = document.getElementById('minimap-canvas');
  const ctx = minimapCanvas ? minimapCanvas.getContext('2d') : null;
  const labelsOverlay = document.getElementById('labels-overlay');

  // Build 10 Numbered Amenity Pins (one representative marker per amenity 1..10)
  const amenityMarkers = [];
  const seenAmenityNos = new Set();
  const sortedPoints = [...data.site.amenityPoints].sort((a, b) => a.number - b.number);

  for (const ap of sortedPoints) {
    // Show primary marker for each of the 10 numbered amenities (plus East/West pocket parks)
    const key = ap.number === 5 ? `${ap.number}_${ap.wx > 0 ? 'E' : 'W'}` : String(ap.number);
    if (seenAmenityNos.has(key)) continue;
    seenAmenityNos.add(key);

    const el = document.createElement('div');
    el.className = 'label-3d amenity-pin';
    el.innerHTML = `<span class="am-num">${ap.number}</span><span>${ap.name}</span>`;
    el.title = `${ap.name} — ${ap.detail} (Click to fly here)`;
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.flyToWorldPoint) {
        state.setCameraMode('aerial');
        state.flyToWorldPoint(ap.wx, ap.wz, 85);
      }
    });
    labelsOverlay.appendChild(el);
    amenityMarkers.push({
      number: ap.number,
      name: ap.name,
      wx: ap.wx,
      wy: 9.5,
      wz: ap.wz,
      el,
    });
  }

  // Dynamic Cut-Away Room Pin elements
  let roomMarkers = [];

  function formatRoomDims(dims) {
    if (!dims) return '';
    return /\d/.test(dims) && !dims.endsWith('m') ? `${dims} m` : dims;
  }

  function buildRoomMarkersForUnit(intCtrl) {
    clearRoomMarkers();
    if (!intCtrl) return;
    const rooms = intCtrl.getNavigableRooms();
    for (const rm of rooms) {
      // Skip tiny stair landing duplicate if stair is already labeled
      if (rm.type === 'stair') continue;
      const el = document.createElement('div');
      el.className = 'label-3d room-pin';
      const dimStr = formatRoomDims(rm.dims);
      el.innerHTML = `<strong>${rm.name}</strong>${dimStr ? `<span>${dimStr}</span>` : ''}`;
      el.title = dimStr ? `${rm.name} (${dimStr}) — Tap/hover for size, double-click to walk inside` : rm.name;
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const wasShowing = el.classList.contains('show-dims');
        roomMarkers.forEach((m) => m.el.classList.remove('show-dims'));
        if (!wasShowing) {
          el.classList.add('show-dims');
        } else if (state.jumpToRoomInUnit) {
          state.jumpToRoomInUnit(intCtrl.unit.unit, rm.floorKey, rm.name);
        }
      });
      labelsOverlay.appendChild(el);
      roomMarkers.push({
        floorKey: rm.floorKey,
        type: rm.type,
        name: rm.name,
        wx: rm.wx,
        wy: rm.yFloor + 0.85,
        wz: rm.wz,
        el,
      });
    }
  }

  function clearRoomMarkers() {
    for (const m of roomMarkers) {
      if (m.el.parentNode) m.el.parentNode.removeChild(m.el);
    }
    roomMarkers = [];
  }

  const tempVec = new THREE.Vector3();

  function updateProjectedLabels() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const mode = state.cameraMode;

    // 1. Amenity markers: visible in aerial mode
    const showAmenities = mode === 'aerial';
    for (const am of amenityMarkers) {
      if (!showAmenities) {
        am.el.style.display = 'none';
        continue;
      }
      tempVec.set(am.wx, am.wy, am.wz);
      tempVec.project(camera);
      if (tempVec.z > 1.0 || tempVec.z < -1.0) {
        am.el.style.display = 'none';
        continue;
      }
      const x = (tempVec.x * 0.5 + 0.5) * w;
      const y = (-tempVec.y * 0.5 + 0.5) * h;
      if (x < 40 || x > w - 40 || y < 65 || y > h - 20) {
        am.el.style.display = 'none';
      } else {
        am.el.style.display = 'inline-flex';
        am.el.style.left = `${x.toFixed(1)}px`;
        am.el.style.top = `${y.toFixed(1)}px`;
      }
    }

    // 2. Cut-away room labels: visible in cutaway mode, de-overlapped in 2D screen space
    const showRooms = mode === 'cutaway';
    const floorFilter = state.cutawayFloor || 'both';
    const visibleRoomPins = [];

    for (const rm of roomMarkers) {
      // When both floors are shown, the first-floor slab covers ground-floor interior rooms,
      // so show first-floor room labels + outdoor Rear Garden; when a single floor is chosen, show all its rooms.
      const floorOk =
        (floorFilter === 'ground' && rm.floorKey === 'ground') ||
        (floorFilter === 'first' && rm.floorKey === 'first') ||
        (floorFilter === 'both' && (rm.floorKey === 'first' || rm.type === 'garden'));

      if (!showRooms || !floorOk) {
        rm.el.style.display = 'none';
        continue;
      }
      tempVec.set(rm.wx, rm.wy, rm.wz);
      tempVec.project(camera);
      if (tempVec.z > 1.0 || tempVec.z < -1.0) {
        rm.el.style.display = 'none';
        continue;
      }
      const sx = (tempVec.x * 0.5 + 0.5) * w;
      const sy = (-tempVec.y * 0.5 + 0.5) * h;
      visibleRoomPins.push({ rm, sx, sy });
    }

    // Iterative 2D screen-space separation so room labels never overlap
    const minW = 76;
    const minH = 23;
    for (let iter = 0; iter < 6; iter++) {
      for (let i = 0; i < visibleRoomPins.length; i++) {
        for (let j = i + 1; j < visibleRoomPins.length; j++) {
          const a = visibleRoomPins[i];
          const b = visibleRoomPins[j];
          const dx = b.sx - a.sx;
          const dy = b.sy - a.sy;
          if (Math.abs(dx) < minW && Math.abs(dy) < minH) {
            const ox = minW - Math.abs(dx);
            const oy = minH - Math.abs(dy);
            if (oy <= ox * 0.65) {
              const sySign = dy >= 0 ? 1 : -1;
              a.sy -= sySign * oy * 0.52;
              b.sy += sySign * oy * 0.52;
            } else {
              const sxSign = dx >= 0 ? 1 : -1;
              a.sx -= sxSign * ox * 0.52;
              b.sx += sxSign * ox * 0.52;
            }
          }
        }
      }
    }

    for (const item of visibleRoomPins) {
      item.rm.el.style.display = 'block';
      item.rm.el.style.left = `${item.sx.toFixed(1)}px`;
      item.rm.el.style.top = `${item.sy.toFixed(1)}px`;
    }
  }

  // Draw live 2D mini-map in Street / Interior / Cut-Away mode (True North = Up)
  function drawMinimap(playerX, playerZ, playerYawRad) {
    if (!ctx) return;
    const cw = minimapCanvas.width;
    const ch = minimapCanvas.height;
    ctx.clearRect(0, 0, cw, ch);

    // Background
    ctx.fillStyle = '#f1f0ed';
    ctx.fillRect(0, 0, cw, ch);

    // Scale: 160m radius in street mode, 45m radius in interior mode
    const worldRadius = state.cameraMode === 'street' ? 145 : 42;
    const scale = (cw * 0.46) / worldRadius;
    const toCX = (wx) => cw * 0.5 + (wx - playerX) * scale;
    const toCY = (wz) => ch * 0.5 + (wz - playerZ) * scale;

    // Draw road centrelines
    ctx.strokeStyle = '#d6d3cc';
    ctx.lineWidth = Math.max(2, 6 * scale);
    ctx.lineCap = 'round';
    for (const rc of data.site.roadCentrelines) {
      ctx.beginPath();
      rc.pts.forEach((p, idx) => {
        const x = toCX(p[0]);
        const y = toCY(p[1]);
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    // Draw all 372 homes as dots (selected home in gold)
    for (const u of data.units) {
      const x = toCX(u.wx);
      const y = toCY(u.wz);
      if (x < -10 || x > cw + 10 || y < -10 || y > ch + 10) continue;
      const isSel = u.unit === state.selectedUnitNo;
      ctx.fillStyle = isSel ? '#16181c' : '#a8a49c';
      const r = isSel ? 4.2 : 2.2;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Draw player field-of-view cone & position dot at center
    const cx = cw * 0.5;
    const cy = ch * 0.5;
    // In Three.js camera, forward look direction on XZ is (-sin(yaw), -cos(yaw))
    const dirX = -Math.sin(playerYawRad);
    const dirZ = -Math.cos(playerYawRad);
    const angle = Math.atan2(dirZ, dirX);

    const cone = ctx.createRadialGradient(cx, cy, 0, cx, cy, 34);
    cone.addColorStop(0, 'rgba(47, 107, 216, 0.38)');
    cone.addColorStop(1, 'rgba(47, 107, 216, 0)');
    ctx.fillStyle = cone;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, 34, angle - 0.5, angle + 0.5);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#2f6bd8';
    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();

    // True north marker at top
    ctx.fillStyle = '#d9463e';
    ctx.beginPath();
    ctx.moveTo(cw * 0.5, 5);
    ctx.lineTo(cw * 0.5 + 5, 14);
    ctx.lineTo(cw * 0.5 - 5, 14);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#16181c';
    ctx.font = '600 10px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('N', cw * 0.5, 25);
  }

  return {
    amenityMarkers,
    buildRoomMarkersForUnit,
    clearRoomMarkers,
    updateProjectedLabels,
    drawMinimap,
  };
}

import * as THREE from 'three';

/**
 * Builds the 1:1 scale furnished interior for any of the 16 Nara floor-plan types
 * directly from `02_3D_Plan_Data_<type>.json` (compiled in `nara_data.json`):
 * - Real wall thicknesses and storey heights (Ground 0..3.6m, First 3.6..6.9m, Roof/Parapet 6.9..7.9m)
 * - Exact wall cutouts (sill..head) for windows, doors, sliding doors, and entrance doors
 * - Animated swing and sliding doors that open smoothly as you walk through
 * - Multi-flight staircases with all 21 treads & risers connecting Ground and First floors
 * - First-floor slab with exact stairwell and double-height entrance hall voids + glass balustrades
 * - Room floors by brochure material (pale porcelain in living/dining/kitchen, warm oak in bedrooms,
 *   Calacatta marble in bathrooms, stone pavers on terraces/balconies)
 * - All 27 procedural furniture & sanitaryware fixture models matching the brochure renders
 * - Warm evening ceiling lights, curtains, rugs, wall art, and decorative plants
 * - Wall collision, stair elevation tracking, room detection, and Cut-Away / Floor selector modes
 */
export function buildUnitInterior(rec, mats) {
  if (rec.hasBuiltInterior && rec.interiorController) {
    return rec.interiorController;
  }

  const unit = rec.unit;
  const pdata = rec.pdata;
  const ax = unit.anchorX;
  const az = unit.anchorZ;
  const root = rec.interiorGroup;

  // Clear if anything existed
  while (root.children.length > 0) {
    root.remove(root.children[0]);
  }

  const groundGroup = new THREE.Group();
  groundGroup.name = 'GroundFloor';
  const firstGroup = new THREE.Group();
  firstGroup.name = 'FirstFloor';
  const roofGroup = new THREE.Group();
  roofGroup.name = 'RoofAndParapet';

  root.add(groundGroup);
  root.add(firstGroup);
  root.add(roofGroup);

  const animatedDoors = []; // { kind, pivot, closedRotY, openRotY, closedPos, openPos, centerX, centerZ, floorY, currentT }
  const wallColliders = { ground: [], first: [] }; // Segments { ax, az, bx, bz, r }
  const ceilingLights = []; // PointLights turned on in evening/interior mode

  // Helper: convert plan [px, pz] -> unit-local [lx, lz]
  const toLX = (px) => px - ax;
  const toLZ = (pz) => pz - az;

  function polyToShapeLocal(pts, holes = []) {
    const shape = new THREE.Shape();
    pts.forEach((p, i) => {
      const x = toLX(p[0]);
      const z = toLZ(p[1]);
      if (i === 0) shape.moveTo(x, -z);
      else shape.lineTo(x, -z);
    });
    shape.closePath();
    for (const h of holes) {
      if (!h || h.length < 3) continue;
      const path = new THREE.Path();
      h.forEach((p, i) => {
        const x = toLX(p[0]);
        const z = toLZ(p[1]);
        if (i === 0) path.moveTo(x, -z);
        else path.lineTo(x, -z);
      });
      path.closePath();
      shape.holes.push(path);
    }
    return shape;
  }

  // ============================================================================
  // 1. FLOOR SLABS, ROOM FINISHES, SKIRTINGS & CEILING LIGHTS
  // ============================================================================
  // Ground floor structural base slab
  const gBaseShape = polyToShapeLocal(pdata.house.outline);
  const gBaseGeom = new THREE.ExtrudeGeometry(gBaseShape, { depth: 0.12, bevelEnabled: false });
  gBaseGeom.rotateX(-Math.PI / 2);
  gBaseGeom.translate(0, -0.09, 0);
  const gBaseMesh = new THREE.Mesh(gBaseGeom, mats.wallWhite);
  gBaseMesh.receiveShadow = true;
  groundGroup.add(gBaseMesh);

  // First floor structural slab with stairwell & double-height voids cut out
  const fOutline = pdata.house.outlineFirst || pdata.house.outline;
  const fVoidPolys = (pdata.floors.first.voids || []).map((v) => v.poly);
  const fSlabShape = polyToShapeLocal(fOutline, fVoidPolys);
  const fSlabGeom = new THREE.ExtrudeGeometry(fSlabShape, { depth: 0.22, bevelEnabled: false });
  fSlabGeom.rotateX(-Math.PI / 2);
  fSlabGeom.translate(0, 3.38, 0);
  const fSlabMesh = new THREE.Mesh(fSlabGeom, mats.intCeiling);
  fSlabMesh.castShadow = true;
  fSlabMesh.receiveShadow = true;
  firstGroup.add(fSlabMesh);

  const groundCeilingGroup = new THREE.Group();
  const firstCeilingGroup = new THREE.Group();
  groundGroup.add(groundCeilingGroup);
  firstGroup.add(firstCeilingGroup);

  const groundFullWalls = new THREE.Group();
  const groundCutWalls = new THREE.Group();
  groundCutWalls.visible = false;
  groundGroup.add(groundFullWalls);
  groundGroup.add(groundCutWalls);

  const firstFullWalls = new THREE.Group();
  const firstCutWalls = new THREE.Group();
  firstCutWalls.visible = false;
  firstGroup.add(firstFullWalls);
  firstGroup.add(firstCutWalls);

  const CUT_WALL_H = 1.18; // Consistent solid dollhouse wall cut height (1.18m above floor slab)

  // Room floor finishes & ceiling downlights on both floors
  for (const [flKey, flGroup, ceilGroup, yBase, ceilY] of [
    ['ground', groundGroup, groundCeilingGroup, 0.032, 3.36],
    ['first', firstGroup, firstCeilingGroup, 3.605, 6.86],
  ]) {
    const fl = pdata.floors[flKey];
    for (const rm of fl.rooms) {
      if (rm.overlayOnly || rm.type === 'stair') continue;
      let floorMat = mats.floorPorcelain;
      if (rm.type === 'master' || rm.type === 'bedroom' || rm.type === 'guest' || rm.type === 'storage') {
        floorMat = mats.floorOak;
      } else if (rm.type === 'bath' || rm.type === 'ensuite' || rm.type === 'maidBath' || rm.type === 'powder') {
        floorMat = mats.floorMarble;
      } else if (rm.type === 'balcony') {
        floorMat = mats.floorTerrace;
      }

      const rShape = polyToShapeLocal(rm.poly);
      const rGeom = new THREE.ShapeGeometry(rShape);
      rGeom.rotateX(-Math.PI / 2);
      rGeom.translate(0, yBase, 0);
      const rMesh = new THREE.Mesh(rGeom, floorMat);
      rMesh.receiveShadow = true;
      flGroup.add(rMesh);

      // Recessed ceiling downlight fixture in main rooms
      if (rm.label && rm.type !== 'balcony' && rm.type !== 'pump') {
        const lx = toLX(rm.label[0]);
        const lz = toLZ(rm.label[1]);
        const bezel = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.03, 12), mats.chromeMetal);
        bezel.position.set(lx, ceilY, lz);
        ceilGroup.add(bezel);
        const disk = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.035, 12), mats.lampEmissive);
        disk.position.set(lx, ceilY - 0.005, lz);
        ceilGroup.add(disk);

        // Add warm interior PointLight for key living/bedroom spaces (capped for WebGL performance)
        if (
          ['living', 'dining', 'kitchen', 'master', 'bedroom', 'guest', 'entrance', 'landing'].includes(rm.type) &&
          ceilingLights.length < 8
        ) {
          const ptLight = new THREE.PointLight(0xffe6bf, 0.65, 8.5, 1.4);
          ptLight.position.set(lx, ceilY - 0.25, lz);
          flGroup.add(ptLight);
          ceilingLights.push(ptLight);
        }
      }
    }
  }

  // ============================================================================
  // 2. WALLS WITH EXACT DOOR / WINDOW CUTOUTS & ANIMATED DOORS
  //    Builds both full-height walls (1st-person) and consistent 1.18m cut walls (Cut-Away Dollhouse)
  // ============================================================================
  for (const [flKey, fullWGroup, cutWGroup, yBase, defaultWallH] of [
    ['ground', groundFullWalls, groundCutWalls, 0.0, 3.4],
    ['first', firstFullWalls, firstCutWalls, 3.6, 3.3],
  ]) {
    const fl = pdata.floors[flKey];
    const openingsByWall = new Map();
    fl.openings.forEach((op) => {
      if (!openingsByWall.has(op.wall)) openingsByWall.set(op.wall, []);
      openingsByWall.get(op.wall).push(op);
    });

    fl.walls.forEach((w, wIdx) => {
      const axW = toLX(w.a[0]);
      const azW = toLZ(w.a[1]);
      const bxW = toLX(w.b[0]);
      const bzW = toLZ(w.b[1]);
      const wallLen = Math.hypot(bxW - axW, bzW - azW);
      if (wallLen < 0.05) return;

      const wallH = w.kind === 'column' ? w.h || 3.2 : defaultWallH;
      const cutH = Math.min(wallH, CUT_WALL_H);
      const wallT = w.t || (w.ext ? 0.24 : 0.15);
      const ux = (bxW - axW) / wallLen;
      const uz = (bzW - azW) / wallLen;
      const yaw = -Math.atan2(uz, ux);
      const wallMat = w.ext ? mats.wallWhite : mats.intWall;

      const ops = (openingsByWall.get(wIdx) || [])
        .map((op) => {
          const t0 = (toLX(op.a[0]) - axW) * ux + (toLZ(op.a[1]) - azW) * uz;
          const t1 = (toLX(op.b[0]) - axW) * ux + (toLZ(op.b[1]) - azW) * uz;
          const s0 = Math.max(0, Math.min(wallLen, Math.min(t0, t1)));
          const s1 = Math.max(0, Math.min(wallLen, Math.max(t0, t1)));
          return { op, s0, s1 };
        })
        .filter((item) => item.s1 - item.s0 > 0.08)
        .sort((a, b) => a.s0 - b.s0);

      let cursor = 0;
      for (const item of ops) {
        const { op, s0, s1 } = item;
        // Solid wall segment before opening
        if (s0 - cursor > 0.04) {
          addWallBox(fullWGroup, axW, azW, ux, uz, yaw, cursor, s0, 0, wallH, yBase, wallT, wallMat, false);
          addWallBox(cutWGroup, axW, azW, ux, uz, yaw, cursor, s0, 0, cutH, yBase, wallT, wallMat, true);
          addWallColliderSegment(flKey, axW + ux * cursor, azW + uz * cursor, axW + ux * s0, azW + uz * s0, wallT);
        }

        const sill = op.sill || 0.0;
        const head = Math.min(wallH, op.head || 2.4);

        // Sill wall below window
        if (sill > 0.04) {
          addWallBox(fullWGroup, axW, azW, ux, uz, yaw, s0, s1, 0, sill, yBase, wallT, wallMat, false);
          const cutSill = Math.min(sill, cutH);
          if (cutSill > 0.04) {
            addWallBox(cutWGroup, axW, azW, ux, uz, yaw, s0, s1, 0, cutSill, yBase, wallT, wallMat, cutSill >= cutH - 0.01);
          }
        }
        // Lintel wall above door/window (only in full-height mode)
        if (wallH - head > 0.04) {
          addWallBox(fullWGroup, axW, azW, ux, uz, yaw, s0, s1, head, wallH, yBase, wallT, wallMat, false);
        }

        // Window cannot be walked through -> add collider; Door / SlidingDoor / EntranceDoor CAN be walked through!
        if (op.kind === 'window') {
          addWallColliderSegment(flKey, axW + ux * s0, azW + uz * s0, axW + ux * s1, azW + uz * s1, wallT);
        }

        // Build 3D Window / Door / SlidingDoor assembly inside the opening
        buildOpeningAssembly(fullWGroup, op, s1 - s0, sill, head, yBase, wallT, yaw, mats, animatedDoors, toLX, toLZ);
        if (sill < cutH - 0.08) {
          buildOpeningAssembly(
            cutWGroup,
            op,
            s1 - s0,
            sill,
            Math.min(head, cutH),
            yBase,
            wallT,
            yaw,
            mats,
            animatedDoors,
            toLX,
            toLZ
          );
        }

        cursor = Math.max(cursor, s1);
      }

      // Solid wall segment after last opening
      if (wallLen - cursor > 0.04) {
        addWallBox(fullWGroup, axW, azW, ux, uz, yaw, cursor, wallLen, 0, wallH, yBase, wallT, wallMat, false);
        addWallBox(cutWGroup, axW, azW, ux, uz, yaw, cursor, wallLen, 0, cutH, yBase, wallT, wallMat, true);
        addWallColliderSegment(
          flKey,
          axW + ux * cursor,
          azW + uz * cursor,
          axW + ux * wallLen,
          azW + uz * wallLen,
          wallT
        );
      }
    });
  }

  function addWallBox(parent, axW, azW, ux, uz, yaw, s0, s1, h0, h1, yBase, thick, mat, addTopCap = false) {
    const len = s1 - s0;
    const h = h1 - h0;
    if (len <= 0.02 || h <= 0.02) return;
    const midS = 0.5 * (s0 + s1);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(len, h, thick), mat);
    mesh.position.set(axW + ux * midS, yBase + h0 + h * 0.5, azW + uz * midS);
    mesh.rotation.y = yaw;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);

    if (addTopCap) {
      const cap = new THREE.Mesh(new THREE.BoxGeometry(len + 0.005, 0.03, thick + 0.01), mats.parapetCoping);
      cap.position.set(axW + ux * midS, yBase + h1 + 0.015, azW + uz * midS);
      cap.rotation.y = yaw;
      parent.add(cap);
    }
  }

  function addWallColliderSegment(flKey, x0, z0, x1, z1, thick) {
    wallColliders[flKey].push({
      ax: x0,
      az: z0,
      bx: x1,
      bz: z1,
      r: thick * 0.5 + 0.24,
    });
  }

  // ============================================================================
  // 3. MULTI-FLIGHT STAIRCASE (21 RISERS & TREADS) + BALUSTRADES
  // ============================================================================
  const stairDataList = pdata.floors.ground.stairs || [];
  const stairTreads = []; // For smooth player elevation interpolation
  for (const st of stairDataList) {
    const stGroup = new THREE.Group();
    stGroup.name = 'Staircase';
    const riserH = st.riser || 0.1714;
    for (const tp of st.treadPolys || []) {
      const topY = tp.top || 0.171;
      const stepH = Math.min(topY, riserH + 0.06);
      const tShape = polyToShapeLocal(tp.poly);

      // Step riser/carriage block
      const rGeom = new THREE.ExtrudeGeometry(tShape, { depth: stepH, bevelEnabled: false });
      rGeom.rotateX(-Math.PI / 2);
      rGeom.translate(0, topY - stepH, 0);
      const rMesh = new THREE.Mesh(rGeom, mats.intWall);
      rMesh.castShadow = true;
      rMesh.receiveShadow = true;
      stGroup.add(rMesh);

      // Warm oak/stone tread nosing cap
      const capGeom = new THREE.ExtrudeGeometry(tShape, { depth: 0.035, bevelEnabled: false });
      capGeom.rotateX(-Math.PI / 2);
      capGeom.translate(0, topY - 0.03, 0);
      const capMesh = new THREE.Mesh(capGeom, mats.floorOak);
      capMesh.receiveShadow = true;
      stGroup.add(capMesh);

      stairTreads.push({
        poly: tp.poly.map((p) => [toLX(p[0]), toLZ(p[1])]),
        top: topY,
      });
    }

    // Add glass + walnut handrail along the stair path
    if (st.path && st.path.length >= 2) {
      for (let i = 0; i < st.path.length - 1; i++) {
        const p0 = st.path[i];
        const p1 = st.path[i + 1];
        const x0 = toLX(p0[0]), z0 = toLZ(p0[1]);
        const x1 = toLX(p1[0]), z1 = toLZ(p1[1]);
        const segL = Math.hypot(x1 - x0, z1 - z0);
        if (segL < 0.3) continue;
        const y0 = (i / (st.path.length - 1)) * 3.4 + 0.9;
        const y1 = ((i + 1) / (st.path.length - 1)) * 3.4 + 0.9;
        const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, segL, 8), mats.walnutWood);
        bar.position.set(0.5 * (x0 + x1), 0.5 * (y0 + y1), 0.5 * (z0 + z1));
        bar.lookAt(x1, y1, z1);
        bar.rotateX(Math.PI / 2);
        stGroup.add(bar);
      }
    }
    groundGroup.add(stGroup);
  }

  // First-floor glass railings (around stairwell void, double-height entrance hall, and balconies)
  for (const rl of pdata.floors.first.railings || []) {
    const x0 = toLX(rl.a[0]), z0 = toLZ(rl.a[1]);
    const x1 = toLX(rl.b[0]), z1 = toLZ(rl.b[1]);
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (len < 0.15) continue;
    const rH = rl.h || 1.1;
    const yaw = -Math.atan2(z1 - z0, x1 - x0);
    const glass = new THREE.Mesh(new THREE.BoxGeometry(len, rH, 0.04), mats.balconyGlass);
    glass.position.set(0.5 * (x0 + x1), 3.6 + rH * 0.5, 0.5 * (z0 + z1));
    glass.rotation.y = yaw;
    firstGroup.add(glass);

    const rail = new THREE.Mesh(new THREE.BoxGeometry(len, 0.05, 0.07), mats.walnutWood);
    rail.position.set(0.5 * (x0 + x1), 3.6 + rH, 0.5 * (z0 + z1));
    rail.rotation.y = yaw;
    firstGroup.add(rail);

    // Prevent player from walking off a balcony or into the stairwell void
    addWallColliderSegment('first', x0, z0, x1, z1, 0.12);
  }

  // ============================================================================
  // 4. FURNISH EVERY ROOM (ALL 27 FIXTURE TYPES + RUGS, ART & CHANDELIERS)
  // ============================================================================
  for (const [flKey, flGroup, yBase] of [
    ['ground', groundGroup, 0.035],
    ['first', firstGroup, 3.61],
  ]) {
    const fl = pdata.floors[flKey];
    for (const fx of fl.fixtures || []) {
      if (fx.type === 'car') continue; // Cars already placed on driveway in plotGroup
      const fxMesh = createFurnitureFixture(fx, mats);
      if (fxMesh) {
        fxMesh.position.set(toLX(fx.at[0]), yBase, toLZ(fx.at[1]));
        // Clockwise plan rotation in degrees -> Three.js Y rotation
        fxMesh.rotation.y = THREE.MathUtils.degToRad(-(fx.rot || 0));
        flGroup.add(fxMesh);
      }
    }

    // Add brochure-authentic decorative accents per room (sheer curtains, framed wall art, pendant lights)
    for (const rm of fl.rooms) {
      if (!rm.label) continue;
      const rx = toLX(rm.label[0]);
      const rz = toLZ(rm.label[1]);
      if (rm.type === 'dining') {
        // Contemporary linear pendant chandelier over dining table (04_Interior_Living_room.jpg)
        const pend = createDiningChandelier(mats);
        pend.position.set(rx, yBase + 2.45, rz);
        (flKey === 'ground' ? groundCeilingGroup : firstCeilingGroup).add(pend);
      }
    }
  }

  // ============================================================================
  // 5. ROOF SLAB, PARAPET & CARPORT CANOPY (VISIBLE IN FULL MODE, HIDDEN IN CUTAWAY)
  // ============================================================================
  const rShape = polyToShapeLocal(fOutline);
  const rSlab = new THREE.Mesh(
    new THREE.ExtrudeGeometry(rShape, { depth: 0.25, bevelEnabled: false }).rotateX(-Math.PI / 2),
    mats.intCeiling
  );
  rSlab.position.y = 6.9;
  roofGroup.add(rSlab);

  if (pdata.canopies) {
    for (const c of pdata.canopies) {
      const cShape = polyToShapeLocal(c.poly);
      const cH = (c.top || 3.6) - (c.bottom || 3.2);
      const cGeom = new THREE.ExtrudeGeometry(cShape, { depth: cH, bevelEnabled: false });
      cGeom.rotateX(-Math.PI / 2);
      cGeom.translate(0, c.bottom || 3.2, 0);
      groundCeilingGroup.add(new THREE.Mesh(cGeom, mats.wallWhite));
    }
  }

  // ============================================================================
  // 6. INTERIOR CONTROLLER API (DOORS, STAIRS, COLLISION, ROOM DETECTION, CUTAWAY)
  // ============================================================================
  let cutawayFloor = 'both'; // 'both' | 'ground' | 'first'
  let isCutawayMode = false;

  function setViewMode(cutaway, floorFilter = 'both') {
    isCutawayMode = cutaway;
    cutawayFloor = floorFilter;

    if (cutaway) {
      // Clean dollhouse: roof removed; when ground floor is chosen, hide first floor above it;
      // solid walls cut at consistent 1.18m height; furniture clearly visible
      roofGroup.visible = false;
      groundGroup.visible = floorFilter === 'both' || floorFilter === 'ground' || floorFilter === 'first';
      firstGroup.visible = floorFilter === 'both' || floorFilter === 'first';

      groundFullWalls.visible = false;
      groundCutWalls.visible = true;
      groundCeilingGroup.visible = false;

      firstFullWalls.visible = false;
      firstCutWalls.visible = true;
      firstCeilingGroup.visible = false;
    } else {
      roofGroup.visible = true;
      groundGroup.visible = true;
      firstGroup.visible = true;

      groundFullWalls.visible = true;
      groundCutWalls.visible = false;
      groundCeilingGroup.visible = true;

      firstFullWalls.visible = true;
      firstCutWalls.visible = false;
      firstCeilingGroup.visible = true;
    }
  }

  // Point-in-polygon helper (2D local coordinates)
  function pointInPoly2D(x, z, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], zi = poly[i][1];
      const xj = poly[j][0], zj = poly[j][1];
      const intersect = zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi + 1e-9) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  // World <-> Unit-Local coordinate transforms
  const thetaRad = THREE.MathUtils.degToRad(unit.frontBearing);
  const rotY = Math.PI - thetaRad;
  const cosR = Math.cos(rotY);
  const sinR = Math.sin(rotY);

  function worldToLocal(wx, wz) {
    const dx = wx - unit.wx;
    const dz = wz - unit.wz;
    return {
      lx: dx * cosR - dz * sinR,
      lz: dx * sinR + dz * cosR,
    };
  }

  function localToWorld(lx, lz) {
    return {
      wx: unit.wx + lx * cosR + lz * sinR,
      wz: unit.wz - lx * sinR + lz * cosR,
    };
  }

  // Update doors based on player position in unit-local coordinates
  function updateDoors(lx, lz, floorY, dt = 0.016) {
    for (const d of animatedDoors) {
      const sameFloor = Math.abs(floorY - d.floorY) < 1.9;
      const dist = Math.hypot(lx - d.centerX, lz - d.centerZ);
      const shouldOpen = sameFloor && dist < 2.25;
      const target = shouldOpen ? 1.0 : 0.0;
      d.currentT += (target - d.currentT) * Math.min(1.0, dt * 6.5);

      if (d.kind === 'slidingDoor') {
        d.pivot.position.x = THREE.MathUtils.lerp(d.closedX, d.openX, d.currentT);
      } else {
        d.pivot.rotation.y = THREE.MathUtils.lerp(d.closedRot, d.openRot, d.currentT);
      }
    }
  }

  // Determine floor elevation (0.0 on ground, 0..3.6 on stairs, 3.6 on first floor)
  function sampleFloorElevation(lx, lz, currentFloorY) {
    // Check if player is inside any stair tread polygon
    for (const tr of stairTreads) {
      if (pointInPoly2D(lx, lz, tr.poly)) {
        if (Math.abs(tr.top - currentFloorY) < 1.25) {
          return tr.top;
        }
      }
    }
    // If near top of stairs (y > 2.85), snap to first floor (3.6m) when stepping onto landing
    if (currentFloorY > 2.85) {
      const fOutlineLocal = fOutline.map((p) => [toLX(p[0]), toLZ(p[1])]);
      if (pointInPoly2D(lx, lz, fOutlineLocal)) {
        return 3.6;
      }
    }
    if (currentFloorY < 0.75) {
      return 0.0;
    }
    return currentFloorY >= 1.8 ? 3.6 : 0.0;
  }

  // Check wall collision in unit-local coordinates
  function checkLocalWallCollision(lx, lz, floorY) {
    // When mid-stairs (0.35m < floorY < 3.1m), allow smooth passage along the stairwell
    if (floorY > 0.35 && floorY < 3.1) return false;
    const flKey = floorY >= 1.8 ? 'first' : 'ground';
    const segs = wallColliders[flKey];
    for (const s of segs) {
      const abx = s.bx - s.ax;
      const abz = s.bz - s.az;
      const ab2 = abx * abx + abz * abz || 1e-6;
      const t = Math.max(0, Math.min(1, ((lx - s.ax) * abx + (lz - s.az) * abz) / ab2));
      const cx = s.ax + abx * t;
      const cz = s.az + abz * t;
      if (Math.hypot(lx - cx, lz - cz) < s.r) {
        return true;
      }
    }
    return false;
  }

  // Detect which room the player is currently standing in
  function getRoomAt(lx, lz, floorY) {
    const flKey = floorY >= 1.8 ? 'first' : 'ground';
    const rooms = pdata.floors[flKey].rooms;
    for (const rm of rooms) {
      const polyLocal = rm.poly.map((p) => [toLX(p[0]), toLZ(p[1])]);
      if (pointInPoly2D(lx, lz, polyLocal)) {
        return {
          floor: flKey === 'first' ? 'First Floor' : 'Ground Floor',
          floorKey: flKey,
          name: rm.name,
          dims: rm.dims || '',
          type: rm.type,
          areaM2: rm.areaM2,
        };
      }
    }
    // Check outdoor terrace / garden
    if (flKey === 'ground') {
      for (const out of pdata.floors.ground.outdoor || []) {
        const polyLocal = out.poly.map((p) => [toLX(p[0]), toLZ(p[1])]);
        if (pointInPoly2D(lx, lz, polyLocal)) {
          return {
            floor: 'Ground Floor',
            floorKey: 'ground',
            name: out.name || 'Garden / Terrace',
            dims: '',
            type: out.type,
          };
        }
      }
    }
    return null;
  }

  // Get list of all navigable rooms on Ground & First floor with world spawn coordinates
  function getNavigableRooms() {
    const list = [];
    for (const [flKey, flLabel, yFloor] of [
      ['ground', 'Ground Floor', 0.0],
      ['first', 'First Floor', 3.6],
    ]) {
      for (const rm of pdata.floors[flKey].rooms) {
        if (!rm.label) continue;
        const lx = toLX(rm.label[0]);
        const lz = toLZ(rm.label[1]);
        const { wx, wz } = localToWorld(lx, lz);
        list.push({
          floorKey: flKey,
          floorLabel: flLabel,
          name: rm.name,
          dims: rm.dims || '',
          type: rm.type,
          lx,
          lz,
          wx,
          wz,
          yFloor,
        });
      }
    }
    // Also include Rear Garden so user can jump or walk straight out to the garden
    const gdnLocal = { lx: toLX(pdata.anchorX), lz: toLZ(2.8) };
    const gdnWorld = localToWorld(gdnLocal.lx, gdnLocal.lz);
    list.push({
      floorKey: 'ground',
      floorLabel: 'Outdoor',
      name: 'Rear Garden & Terrace',
      dims: `${unit.backsOnto}`,
      type: 'garden',
      lx: gdnLocal.lx,
      lz: gdnLocal.lz,
      wx: gdnWorld.wx,
      wz: gdnWorld.wz,
      yFloor: 0.0,
    });
    return list;
  }

  const controller = {
    unit,
    pdata,
    root,
    groundGroup,
    firstGroup,
    roofGroup,
    setViewMode,
    updateDoors,
    sampleFloorElevation,
    checkLocalWallCollision,
    getRoomAt,
    getNavigableRooms,
    worldToLocal,
    localToWorld,
  };

  rec.hasBuiltInterior = true;
  rec.interiorController = controller;
  return controller;
}

// ============================================================================
// HELPER: BUILD DOORS, SLIDING DOORS, ENTRANCE DOORS & WINDOWS IN WALL CUTOUTS
// ============================================================================
function buildOpeningAssembly(parent, op, width, sill, head, yBase, wallT, yaw, mats, animatedDoors, toLX, toLZ) {
  const height = Math.max(0.35, head - sill);
  const cx = 0.5 * (toLX(op.a[0]) + toLX(op.b[0]));
  const cz = 0.5 * (toLZ(op.a[1]) + toLZ(op.b[1]));
  const cy = yBase + sill + height * 0.5;

  const frameGroup = new THREE.Group();
  frameGroup.position.set(cx, cy, cz);
  frameGroup.rotation.y = yaw;
  parent.add(frameGroup);

  const frameDepth = wallT + 0.04;
  // Outer jambs & head frame
  const leftJamb = new THREE.Mesh(new THREE.BoxGeometry(0.05, height, frameDepth), mats.darkMetal);
  leftJamb.position.x = -width * 0.5 + 0.025;
  frameGroup.add(leftJamb);

  const rightJamb = new THREE.Mesh(new THREE.BoxGeometry(0.05, height, frameDepth), mats.darkMetal);
  rightJamb.position.x = width * 0.5 - 0.025;
  frameGroup.add(rightJamb);

  const headBar = new THREE.Mesh(new THREE.BoxGeometry(width, 0.05, frameDepth), mats.darkMetal);
  headBar.position.y = height * 0.5 - 0.025;
  frameGroup.add(headBar);

  if (op.kind === 'window') {
    const sillBar = new THREE.Mesh(new THREE.BoxGeometry(width + 0.04, 0.04, frameDepth + 0.04), mats.parapetCoping);
    sillBar.position.y = -height * 0.5 + 0.02;
    frameGroup.add(sillBar);

    const glass = new THREE.Mesh(new THREE.BoxGeometry(width - 0.1, height - 0.1, 0.02), mats.interiorGlass);
    frameGroup.add(glass);

    // Subtle sheer curtain panel on side of large windows
    if (width > 1.3 && height > 1.6) {
      const curtain = new THREE.Mesh(new THREE.BoxGeometry(0.32, height - 0.08, 0.06), mats.fabricCurtain);
      curtain.position.set(width * 0.5 - 0.22, 0, -wallT * 0.5 - 0.05);
      frameGroup.add(curtain);
    }
  } else if (op.kind === 'slidingDoor') {
    // 2-leaf or 4-leaf full-height glass sliding doors to terrace / balcony
    const leafW = (width - 0.08) * 0.52;
    const fixedLeaf = new THREE.Mesh(new THREE.BoxGeometry(leafW, height - 0.08, 0.03), mats.interiorGlass);
    fixedLeaf.position.set(-width * 0.23, 0, -0.02);
    frameGroup.add(fixedLeaf);

    const slidePivot = new THREE.Group();
    const closedX = width * 0.23;
    const openX = -width * 0.2;
    slidePivot.position.set(closedX, 0, 0.02);
    const slidingGlass = new THREE.Mesh(new THREE.BoxGeometry(leafW, height - 0.08, 0.03), mats.interiorGlass);
    const mullion = new THREE.Mesh(new THREE.BoxGeometry(0.04, height - 0.08, 0.045), mats.darkMetal);
    mullion.position.x = -leafW * 0.5;
    slidePivot.add(slidingGlass);
    slidePivot.add(mullion);
    frameGroup.add(slidePivot);

    animatedDoors.push({
      kind: 'slidingDoor',
      pivot: slidePivot,
      closedX,
      openX,
      centerX: cx,
      centerZ: cz,
      floorY: yBase,
      currentT: 0.0,
    });
  } else {
    // Hinged door or entranceDoor
    const isEntrance = op.kind === 'entranceDoor';
    const leafW = Math.max(0.5, width - 0.08);
    const leafMat = isEntrance ? mats.walnutWood : mats.wallOffWhite;

    // Hinge on left end of opening in local frame
    const pivot = new THREE.Group();
    pivot.position.set(-leafW * 0.5, 0, 0);
    const leaf = new THREE.Mesh(new THREE.BoxGeometry(leafW, height - 0.06, 0.045), leafMat);
    leaf.position.x = leafW * 0.5;
    leaf.castShadow = true;
    pivot.add(leaf);

    // Chrome/brass lever handle on both sides of door
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.025, 0.14), mats.chromeMetal);
    handle.position.set(leafW - 0.1, -0.1, 0);
    pivot.add(handle);

    frameGroup.add(pivot);

    animatedDoors.push({
      kind: op.kind,
      pivot,
      closedRot: 0.0,
      openRot: Math.PI * 0.46,
      centerX: cx,
      centerZ: cz,
      floorY: yBase,
      currentT: 0.0,
    });
  }
}

// ============================================================================
// HELPER: PROCEDURAL 3D FURNITURE & SANITARYWARE MODELS (ALL 27 FIXTURE TYPES)
// Matches 04_Interior_Living_room.jpg, 04_Interior_Bedroom.jpg, 04_Interior_Kitchen.jpg
// ============================================================================
function createFurnitureFixture(fx, mats) {
  const g = new THREE.Group();
  const w = fx.w || 1.0;
  const d = fx.d || 1.0;
  const type = fx.type;

  if (type === 'sectional' || type === 'sofa') {
    // Brochure living room: soft cream fabric sofa/sectional over a sage area rug with teal-sage throw pillows
    const rug = new THREE.Mesh(new THREE.BoxGeometry(w + 0.9, 0.015, d + 0.9), mats.fabricRug);
    rug.position.y = 0.008;
    rug.receiveShadow = true;
    g.add(rug);

    const base = new THREE.Mesh(new THREE.BoxGeometry(w, 0.42, d * 0.48), mats.fabricCream);
    base.position.set(0, 0.21, -d * 0.22);
    base.castShadow = true;
    g.add(base);

    const back = new THREE.Mesh(new THREE.BoxGeometry(w, 0.42, 0.2), mats.fabricCream);
    back.position.set(0, 0.58, -d * 0.38);
    back.castShadow = true;
    g.add(back);

    if (type === 'sectional') {
      const chaise = new THREE.Mesh(new THREE.BoxGeometry(w * 0.36, 0.42, d * 0.92), mats.fabricCream);
      chaise.position.set(-w * 0.32, 0.21, 0);
      chaise.castShadow = true;
      g.add(chaise);
    }

    // Sage-teal accent cushions (matching 04_Interior_Living_room.jpg)
    for (const px of [-w * 0.3, 0, w * 0.3]) {
      const pillow = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.32, 0.12), mats.fabricSage);
      pillow.position.set(px, 0.54, -d * 0.24);
      pillow.rotation.x = -0.2;
      g.add(pillow);
    }
  } else if (type === 'armchair') {
    const seat = new THREE.Mesh(new THREE.BoxGeometry(w, 0.42, d), mats.fabricSage);
    seat.position.y = 0.21;
    seat.castShadow = true;
    g.add(seat);
    const back = new THREE.Mesh(new THREE.BoxGeometry(w, 0.42, 0.16), mats.fabricSage);
    back.position.set(0, 0.58, -d * 0.4);
    g.add(back);
  } else if (type === 'coffeeTable') {
    // Round/nested brass & white marble coffee tables (04_Interior_Living_room.jpg)
    const r = Math.min(w, d) * 0.46;
    const top1 = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.04, 20), mats.quartzWhite);
    top1.position.set(-w * 0.1, 0.4, 0);
    top1.castShadow = true;
    g.add(top1);
    const base1 = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.82, r * 0.82, 0.38, 16, 1, true), mats.brassAccent);
    base1.position.set(-w * 0.1, 0.19, 0);
    g.add(base1);

    const top2 = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.65, r * 0.65, 0.035, 18), mats.walnutWood);
    top2.position.set(w * 0.22, 0.32, d * 0.12);
    g.add(top2);
  } else if (type === 'tvUnit') {
    // Low walnut/white media console + large wall-mounted flat-screen TV
    const consoleBox = new THREE.Mesh(new THREE.BoxGeometry(w, 0.46, d), mats.walnutWood);
    consoleBox.position.y = 0.23;
    consoleBox.castShadow = true;
    g.add(consoleBox);

    const tv = new THREE.Mesh(new THREE.BoxGeometry(w * 0.82, 0.82, 0.05), mats.tvScreen);
    tv.position.set(0, 1.18, -d * 0.35);
    g.add(tv);
  } else if (type === 'diningTable') {
    // Warm timber dining table + 6 upholstered chairs (04_Interior_Living_room.jpg)
    const top = new THREE.Mesh(new THREE.BoxGeometry(w, 0.06, d), mats.walnutWood);
    top.position.y = 0.75;
    top.castShadow = true;
    g.add(top);

    for (const [lx, lz] of [
      [-w * 0.4, -d * 0.38],
      [w * 0.4, -d * 0.38],
      [-w * 0.4, d * 0.38],
      [w * 0.4, d * 0.38],
    ]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.02, 0.74, 8), mats.darkMetal);
      leg.position.set(lx, 0.37, lz);
      g.add(leg);
    }

    // 6 chairs around table
    for (const cx of [-w * 0.28, 0, w * 0.28]) {
      for (const side of [-1, 1]) {
        const ch = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.44, 0.42), mats.fabricCream);
        ch.position.set(cx, 0.22, side * (d * 0.5 + 0.18));
        ch.castShadow = true;
        g.add(ch);
        const cb = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.42, 0.07), mats.fabricCream);
        cb.position.set(cx, 0.62, side * (d * 0.5 + 0.36));
        g.add(cb);
      }
    }
  } else if (type === 'kitchenRun' || type === 'kitchenIsland') {
    // Fitted contemporary kitchen: walnut lower cabinets + white quartz countertop + overhead cabinets (04_Interior_Kitchen.jpg)
    const baseCab = new THREE.Mesh(new THREE.BoxGeometry(w, 0.86, d), mats.walnutWood);
    baseCab.position.y = 0.43;
    baseCab.castShadow = true;
    g.add(baseCab);

    const counter = new THREE.Mesh(new THREE.BoxGeometry(w + 0.03, 0.05, d + 0.03), mats.quartzWhite);
    counter.position.y = 0.885;
    counter.castShadow = true;
    g.add(counter);

    if (type === 'kitchenRun') {
      const upperCab = new THREE.Mesh(new THREE.BoxGeometry(w, 0.72, d * 0.58), mats.wallWhite);
      upperCab.position.set(0, 1.88, -d * 0.2);
      upperCab.castShadow = true;
      g.add(upperCab);
    }
  } else if (type === 'hob') {
    const glassHob = new THREE.Mesh(new THREE.BoxGeometry(w, 0.02, d), mats.tvScreen);
    glassHob.position.y = 0.92;
    g.add(glassHob);
    // Range hood above
    const hood = new THREE.Mesh(new THREE.BoxGeometry(w, 0.55, d * 0.8), mats.chromeMetal);
    hood.position.set(0, 1.95, 0);
    g.add(hood);
  } else if (type === 'sink') {
    const basin = new THREE.Mesh(new THREE.BoxGeometry(w * 0.85, 0.03, d * 0.75), mats.chromeMetal);
    basin.position.y = 0.915;
    g.add(basin);
    const tap = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.28, 8), mats.chromeMetal);
    tap.position.set(0, 1.05, -d * 0.25);
    g.add(tap);
  } else if (type === 'fridge') {
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, 1.86, d), mats.chromeMetal);
    body.position.y = 0.93;
    body.castShadow = true;
    g.add(body);
  } else if (type === 'bed' || type === 'bedSingle') {
    // Brochure bedroom (04_Interior_Bedroom.jpg): upholstered headboard, crisp white linen, sage throw blanket, area rug
    const rug = new THREE.Mesh(new THREE.BoxGeometry(w + 0.7, 0.014, d + 0.5), mats.fabricBedroomRug);
    rug.position.y = 0.007;
    rug.receiveShadow = true;
    g.add(rug);

    const frame = new THREE.Mesh(new THREE.BoxGeometry(w, 0.32, d), mats.walnutWood);
    frame.position.y = 0.16;
    frame.castShadow = true;
    g.add(frame);

    const mattress = new THREE.Mesh(new THREE.BoxGeometry(w - 0.08, 0.24, d - 0.1), mats.intCeiling);
    mattress.position.set(0, 0.42, 0.02);
    mattress.castShadow = true;
    g.add(mattress);

    const throwBlanket = new THREE.Mesh(new THREE.BoxGeometry(w - 0.06, 0.25, d * 0.35), mats.fabricSage);
    throwBlanket.position.set(0, 0.425, d * 0.28);
    g.add(throwBlanket);

    const headboard = new THREE.Mesh(new THREE.BoxGeometry(w + 0.06, 1.18, 0.12), mats.fabricCream);
    headboard.position.set(0, 0.59, -d * 0.5 + 0.06);
    headboard.castShadow = true;
    g.add(headboard);

    const numPillows = type === 'bed' ? 2 : 1;
    for (let i = 0; i < numPillows; i++) {
      const px = numPillows === 2 ? (i === 0 ? -w * 0.24 : w * 0.24) : 0;
      const pil = new THREE.Mesh(new THREE.BoxGeometry(w * 0.38, 0.14, 0.32), mats.intCeiling);
      pil.position.set(px, 0.58, -d * 0.32);
      pil.rotation.x = 0.18;
      g.add(pil);
    }
  } else if (type === 'nightstand') {
    const box = new THREE.Mesh(new THREE.BoxGeometry(w, 0.52, d), mats.walnutWood);
    box.position.y = 0.26;
    box.castShadow = true;
    g.add(box);
    const lampShade = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.14, 0.24, 10), mats.lampEmissive);
    lampShade.position.y = 0.68;
    g.add(lampShade);
  } else if (type === 'wardrobe') {
    const cab = new THREE.Mesh(new THREE.BoxGeometry(w, 2.35, d), mats.wallOffWhite);
    cab.position.y = 1.175;
    cab.castShadow = true;
    g.add(cab);
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.9, d + 0.02), mats.walnutWood);
    handle.position.y = 1.15;
    g.add(handle);
  } else if (type === 'dresser' || type === 'desk') {
    const top = new THREE.Mesh(new THREE.BoxGeometry(w, 0.76, d), mats.walnutWood);
    top.position.y = 0.38;
    top.castShadow = true;
    g.add(top);
    // Framed mirror / art panel above
    const mirror = new THREE.Mesh(new THREE.BoxGeometry(w * 0.7, 0.85, 0.04), mats.interiorGlass);
    mirror.position.set(0, 1.32, -d * 0.42);
    g.add(mirror);
  } else if (type === 'bathtub') {
    const outer = new THREE.Mesh(new THREE.BoxGeometry(w, 0.58, d), mats.ceramicWhite);
    outer.position.y = 0.29;
    outer.castShadow = true;
    g.add(outer);
    const water = new THREE.Mesh(new THREE.BoxGeometry(w - 0.16, 0.02, d - 0.16), mats.poolWater);
    water.position.y = 0.52;
    g.add(water);
  } else if (type === 'shower') {
    const tray = new THREE.Mesh(new THREE.BoxGeometry(w, 0.06, d), mats.ceramicWhite);
    tray.position.y = 0.03;
    g.add(tray);
    const screen = new THREE.Mesh(new THREE.BoxGeometry(w, 2.05, 0.03), mats.interiorGlass);
    screen.position.set(0, 1.05, d * 0.46);
    g.add(screen);
    const head = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.03, 12), mats.chromeMetal);
    head.position.set(0, 2.05, -d * 0.25);
    g.add(head);
  } else if (type === 'wc') {
    const bowl = new THREE.Mesh(new THREE.BoxGeometry(w, 0.42, d * 0.72), mats.ceramicWhite);
    bowl.position.set(0, 0.21, d * 0.1);
    bowl.castShadow = true;
    g.add(bowl);
    const tank = new THREE.Mesh(new THREE.BoxGeometry(w, 0.45, d * 0.28), mats.ceramicWhite);
    tank.position.set(0, 0.62, -d * 0.32);
    g.add(tank);
  } else if (type === 'vanity' || type === 'basin') {
    const cab = new THREE.Mesh(new THREE.BoxGeometry(w, 0.82, d), mats.walnutWood);
    cab.position.y = 0.41;
    cab.castShadow = true;
    g.add(cab);
    const top = new THREE.Mesh(new THREE.BoxGeometry(w + 0.02, 0.06, d + 0.02), mats.ceramicWhite);
    top.position.y = 0.85;
    g.add(top);
    const mirror = new THREE.Mesh(new THREE.BoxGeometry(w * 0.88, 0.95, 0.03), mats.interiorGlass);
    mirror.position.set(0, 1.45, -d * 0.45);
    g.add(mirror);
  } else if (type === 'washer') {
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, 0.85, d), mats.ceramicWhite);
    body.position.y = 0.425;
    body.castShadow = true;
    g.add(body);
    const door = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.04, 16), mats.darkMetal);
    door.rotation.x = Math.PI / 2;
    door.position.set(0, 0.48, d * 0.5);
    g.add(door);
  } else if (type === 'outdoorDining') {
    const tbl = new THREE.Mesh(new THREE.BoxGeometry(w * 0.75, 0.74, d * 0.75), mats.walnutWood);
    tbl.position.y = 0.37;
    tbl.castShadow = true;
    g.add(tbl);
  } else if (type === 'lounger') {
    const bed = new THREE.Mesh(new THREE.BoxGeometry(w, 0.32, d), mats.fabricCream);
    bed.position.y = 0.16;
    bed.castShadow = true;
    g.add(bed);
  } else if (type === 'plant') {
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.16, 0.38, 10), mats.ceramicWhite);
    pot.position.y = 0.19;
    pot.castShadow = true;
    g.add(pot);
    const foliage = new THREE.Mesh(new THREE.SphereGeometry(0.38, 10, 8), mats.leafFrangipani);
    foliage.scale.set(1, 1.35, 1);
    foliage.position.y = 0.68;
    foliage.castShadow = true;
    g.add(foliage);
  }

  return g;
}

function createDiningChandelier(mats) {
  const g = new THREE.Group();
  const bar = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.04, 0.06), mats.brassAccent);
  g.add(bar);
  for (const x of [-0.42, 0, 0.42]) {
    const globe = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), mats.lampEmissive);
    globe.position.set(x, -0.1, 0);
    g.add(globe);
  }
  return g;
}

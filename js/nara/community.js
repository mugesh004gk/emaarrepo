import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { buildTrees } from '../vegetation.js';

/**
 * Builds the entire exterior 3D community of Nara at The Valley:
 * - All 372 townhouses in 57 rows (Aston, Palma, Charm) at exact lat/lon and true bearing
 * - Roads, kerbs, footpaths, crossings, sikkas, street lamps
 * - All 1,231 trees across 7 species
 * - All 10 numbered amenities (Community Centre & Pools, Green Sikkas, Community Gardens,
 *   Outdoor Fitness, Pocket Parks, Picnic Area, Lawn Area, Mosque, Entrance Gatehouse, Wadi Drive)
 * - Dry landscaped wadi with blue running/cycling track & arched timber footbridges
 * - Parked cars and surrounding Valley clusters (Eden, etc.) + desert horizon
 */
export function buildCommunityWorld(scene, data, mats) {
  const worldGroup = new THREE.Group();
  worldGroup.name = 'NaraCommunityWorld';
  scene.add(worldGroup);

  const unitRecords = new Map(); // unitNo -> { unit, group, shellGroup, interiorGroup, highlightMesh, roofBadgePos, ... }
  const pickableMeshes = [];     // Meshes for raycasting unit selection
  const buildingColliders = [];  // 2D OBBs for street-level collision detection

  // Helper: create a 2D THREE.Shape from an array of [x, z] points
  // Note: shape is in (x, -z) so when rotated by rotateX(-Math.PI/2), (x, y_shape) -> (x, 0, -y_shape) = (x, 0, z)!
  function polyToShape(pts, holes = []) {
    const shape = new THREE.Shape();
    pts.forEach((p, idx) => {
      if (idx === 0) shape.moveTo(p[0], -p[1]);
      else shape.lineTo(p[0], -p[1]);
    });
    shape.closePath();
    for (const h of holes) {
      if (h.length < 3) continue;
      const path = new THREE.Path();
      h.forEach((p, idx) => {
        if (idx === 0) path.moveTo(p[0], -p[1]);
        else path.lineTo(p[0], -p[1]);
      });
      path.closePath();
      shape.holes.push(path);
    }
    return shape;
  }

  function makeFlatPolyGeometry(pts, y = 0.01, holes = []) {
    const shape = polyToShape(pts, holes);
    const geom = new THREE.ShapeGeometry(shape);
    geom.rotateX(-Math.PI / 2);
    geom.translate(0, y, 0);
    return geom;
  }

  function makeExtrudedPolyGeometry(pts, height, yBottom = 0, holes = []) {
    const shape = polyToShape(pts, holes);
    const geom = new THREE.ExtrudeGeometry(shape, {
      depth: height,
      bevelEnabled: false,
    });
    geom.rotateX(-Math.PI / 2);
    geom.translate(0, yBottom, 0);
    return geom;
  }

  function makeRibbonGeometry(pts, width, y = 0.02) {
    if (!pts || pts.length < 2) return null;
    const positions = [];
    const uvs = [];
    const indices = [];
    const halfW = width * 0.5;
    let dist = 0;

    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (i > 0) {
        dist += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]);
      }
      let tx = 0, tz = 0;
      if (i < pts.length - 1) {
        const dx = pts[i + 1][0] - p[0];
        const dz = pts[i + 1][1] - p[1];
        const l = Math.hypot(dx, dz) || 1;
        tx += dx / l;
        tz += dz / l;
      }
      if (i > 0) {
        const dx = p[0] - pts[i - 1][0];
        const dz = p[1] - pts[i - 1][1];
        const l = Math.hypot(dx, dz) || 1;
        tx += dx / l;
        tz += dz / l;
      }
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl;
      tz /= tl;
      const nx = -tz;
      const nz = tx;

      positions.push(p[0] - nx * halfW, y, p[1] - nz * halfW);
      positions.push(p[0] + nx * halfW, y, p[1] + nz * halfW);
      uvs.push(0, dist * 0.2, 1, dist * 0.2);

      if (i < pts.length - 1) {
        const b = i * 2;
        indices.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
      }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geom.setIndex(indices);
    geom.computeVertexNormals();
    return geom;
  }

  // ============================================================================
  // 1. BASE DESERT TERRAIN & SURROUNDING VALLEY CONTEXT
  // ============================================================================
  // Ground planes removed: the real Dubai map surface (js/ground.js) is the ground.

  // ============================================================================
  // 2. ROADS, FOOTPATHS, SIKKAS, CROSSINGS, CYCLE TRACK & STREET LAMPS
  // ============================================================================
  const site = data.site;
  const roadGroup = new THREE.Group();
  roadGroup.name = 'RoadsAndPaths';
  worldGroup.add(roadGroup);

  // 2a. Multi-ring road surfaces + continuous paved roadside footpaths & green planting verges
  for (const rs of site.roadSurfaces) {
    // Wide paved sidewalk & pale gravel shoulder under the road network
    const footpathShoulder = makeFlatPolyGeometry(rs.outer, 0.015, []);
    const shoulderMesh = new THREE.Mesh(footpathShoulder, mats.paleGravel);
    shoulderMesh.receiveShadow = true;
    roadGroup.add(shoulderMesh);

    const rGeom = makeFlatPolyGeometry(rs.outer, 0.022, rs.holes);
    const rMesh = new THREE.Mesh(rGeom, mats.roadAsphalt);
    rMesh.receiveShadow = true;
    roadGroup.add(rMesh);

    // Subtle kerb / road base thickness
    const kGeom = makeExtrudedPolyGeometry(rs.outer, 0.08, -0.05, rs.holes);
    const kMesh = new THREE.Mesh(kGeom, mats.kerbStone);
    kMesh.receiveShadow = true;
    roadGroup.add(kMesh);
  }

  // 2b. Dashed white lane markings, continuous roadside footpaths, green verges & street lamps
  const dashGeoms = [];
  const vergeSidewalkGeoms = [];
  const vergeGreenGeoms = [];
  const streetLampPositions = [];
  for (const rc of site.roadCentrelines) {
    const pts = rc.pts;
    const roadW = rc.width || 7.2;
    // Continuous paved footpath corridor + green tree verge along every street
    const swGeom = makeRibbonGeometry(pts, roadW + 4.6, 0.019);
    if (swGeom) vergeSidewalkGeoms.push(swGeom);
    const vgGeom = makeRibbonGeometry(pts, roadW + 1.8, 0.0205);
    if (vgGeom) vergeGreenGeoms.push(vgGeom);

    let accum = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const ax = pts[i][0], az = pts[i][1];
      const bx = pts[i + 1][0], bz = pts[i + 1][1];
      const segLen = Math.hypot(bx - ax, bz - az);
      if (segLen < 1) continue;
      const dx = (bx - ax) / segLen;
      const dz = (bz - az) / segLen;
      const nx = -dz, nz = dx;

      // Dashed centreline every 6m
      for (let d = 1.5; d + 2.2 < segLen; d += 6.0) {
        const cx = ax + dx * (d + 1.0);
        const cz = az + dz * (d + 1.0);
        const g = new THREE.PlaneGeometry(0.14, 2.0);
        g.rotateX(-Math.PI / 2);
        const yaw = Math.atan2(dx, dz);
        g.rotateY(yaw);
        g.translate(cx, 0.032, cz);
        dashGeoms.push(g);
      }

      // Street lamps along roads every ~34m
      const wHalf = roadW * 0.5 + 0.85;
      while (accum + 34 < segLen) {
        accum += 34;
        const lx = ax + dx * accum + nx * wHalf;
        const lz = az + dz * accum + nz * wHalf;
        // Avoid placing street lamps too close to existing lamps
        if (!streetLampPositions.some((p) => Math.hypot(p.x - lx, p.z - lz) < 18)) {
          streetLampPositions.push({ x: lx, z: lz, yaw: Math.atan2(-nx, -nz) });
        }
      }
      accum = (accum + segLen) % 34;
    }
  }
  if (vergeSidewalkGeoms.length > 0) {
    const swMesh = new THREE.Mesh(mergeGeometries(vergeSidewalkGeoms, false), mats.footpathPaver);
    swMesh.receiveShadow = true;
    roadGroup.add(swMesh);
  }
  if (vergeGreenGeoms.length > 0) {
    const vgMesh = new THREE.Mesh(mergeGeometries(vergeGreenGeoms, false), mats.plantingBed);
    vgMesh.receiveShadow = true;
    roadGroup.add(vgMesh);
  }
  if (dashGeoms.length > 0) {
    const mergedDashes = mergeGeometries(dashGeoms, false);
    roadGroup.add(new THREE.Mesh(mergedDashes, mats.roadLine));
  }

  // 2c. Paths: footpaths, sikkaWalks, laneWalks, crossings, and the blue cycleTrack
  const footpathGeoms = [];
  const sikkaWalkGeoms = [];
  const crossingGeoms = [];

  for (const p of site.paths) {
    if (p.kind === 'cycleTrack') {
      // Wide landscaped wadi linear park & pale gravel bed under the blue cycle track (04_Cycle_and_jogging_path.jpg)
      const wadiParkGeom = makeRibbonGeometry(p.pts, 28.0, 0.012);
      if (wadiParkGeom) {
        const wpm = new THREE.Mesh(wadiParkGeom, mats.parkGrass);
        wpm.receiveShadow = true;
        roadGroup.add(wpm);
      }
      const wadiGravelGeom = makeRibbonGeometry(p.pts, 12.5, 0.016);
      if (wadiGravelGeom) {
        const wgm = new THREE.Mesh(wadiGravelGeom, mats.paleGravel);
        wgm.receiveShadow = true;
        roadGroup.add(wgm);
      }

      // Blue running & cycling track along the dry landscaped wadi valley (04_Cycle_and_jogging_path.jpg)
      const trackGeom = makeRibbonGeometry(p.pts, p.width || 3.5, 0.04);
      if (trackGeom) {
        const trackMesh = new THREE.Mesh(trackGeom, mats.cycleTrackBlue);
        trackMesh.receiveShadow = true;
        roadGroup.add(trackMesh);
      }
      // White edge lines & walking side path alongside the blue track
      const borderGeom = makeRibbonGeometry(p.pts, (p.width || 3.5) + 0.35, 0.035);
      if (borderGeom) {
        roadGroup.add(new THREE.Mesh(borderGeom, mats.roadLine));
      }
      const walkBesideGeom = makeRibbonGeometry(p.pts, (p.width || 3.5) + 2.6, 0.026);
      if (walkBesideGeom) {
        const wm = new THREE.Mesh(walkBesideGeom, mats.footpathPaver);
        wm.receiveShadow = true;
        roadGroup.add(wm);
      }

      // Add 2 arched timber footbridges over the dry wadi valley (matching 04_Cycle_and_jogging_path.jpg)
      for (const idxFrac of [0.32, 0.68]) {
        const idx = Math.floor(p.pts.length * idxFrac);
        const pt = p.pts[idx];
        const nextPt = p.pts[Math.min(p.pts.length - 1, idx + 1)];
        if (pt && nextPt) {
          const bridge = createArchedTimberBridge(mats);
          bridge.position.set(pt[0], 0, pt[1]);
          bridge.rotation.y = Math.atan2(nextPt[0] - pt[0], nextPt[1] - pt[1]) + Math.PI / 2;
          roadGroup.add(bridge);
        }
      }
    } else if (p.kind === 'crossing') {
      // Pedestrian zebra stripes
      const pts = p.pts;
      if (pts.length >= 2) {
        const ax = pts[0][0], az = pts[0][1];
        const bx = pts[pts.length - 1][0], bz = pts[pts.length - 1][1];
        const len = Math.hypot(bx - ax, bz - az) || 1;
        const yaw = Math.atan2(bx - ax, bz - az);
        const stripes = Math.max(3, Math.floor(len / 0.9));
        for (let s = 0; s < stripes; s++) {
          const t = (s + 0.5) / stripes;
          const sx = ax + (bx - ax) * t;
          const sz = az + (bz - az) * t;
          const sg = new THREE.PlaneGeometry(2.4, 0.42);
          sg.rotateX(-Math.PI / 2);
          sg.rotateY(yaw);
          sg.translate(sx, 0.036, sz);
          crossingGeoms.push(sg);
        }
      }
    } else if (p.kind === 'sikkaWalk' || p.kind === 'laneWalk') {
      const g = makeRibbonGeometry(p.pts, (p.width || 1.8) + 0.6, 0.03);
      if (g) sikkaWalkGeoms.push(g);
    } else {
      const g = makeRibbonGeometry(p.pts, (p.width || 1.8) + 0.5, 0.028);
      if (g) footpathGeoms.push(g);
    }
  }

  if (footpathGeoms.length > 0) {
    const m = new THREE.Mesh(mergeGeometries(footpathGeoms, false), mats.footpathPaver);
    m.receiveShadow = true;
    roadGroup.add(m);
  }
  if (sikkaWalkGeoms.length > 0) {
    const m = new THREE.Mesh(mergeGeometries(sikkaWalkGeoms, false), mats.sikkaPaver);
    m.receiveShadow = true;
    roadGroup.add(m);
  }
  if (crossingGeoms.length > 0) {
    roadGroup.add(new THREE.Mesh(mergeGeometries(crossingGeoms, false), mats.roadLine));
  }

  // 2d. Instanced Street Lamps
  if (streetLampPositions.length > 0) {
    const poleGeo = new THREE.CylinderGeometry(0.06, 0.09, 5.2, 8);
    poleGeo.translate(0, 2.6, 0);
    const armGeo = new THREE.BoxGeometry(0.08, 0.08, 1.1);
    armGeo.translate(0, 5.15, 0.45);
    const poleMerged = mergeGeometries([poleGeo, armGeo], false);
    const bulbGeo = new THREE.BoxGeometry(0.28, 0.08, 0.45);
    bulbGeo.translate(0, 5.1, 0.85);

    const poleInst = new THREE.InstancedMesh(poleMerged, mats.darkMetal, streetLampPositions.length);
    const bulbInst = new THREE.InstancedMesh(bulbGeo, mats.lampEmissive, streetLampPositions.length);
    poleInst.castShadow = true;

    const dummy = new THREE.Object3D();
    streetLampPositions.forEach((lp, i) => {
      dummy.position.set(lp.x, 0, lp.z);
      dummy.rotation.set(0, lp.yaw, 0);
      dummy.updateMatrix();
      poleInst.setMatrixAt(i, dummy.matrix);
      bulbInst.setMatrixAt(i, dummy.matrix);
    });
    roadGroup.add(poleInst);
    roadGroup.add(bulbInst);
  }

  // ============================================================================
  // 3. AMENITIES (1–10), PARKS, POOLS, CLUBHOUSE, MOSQUE & GATEHOUSE
  // ============================================================================
  const amenityGroup = new THREE.Group();
  amenityGroup.name = 'AmenitiesAndLandscape';
  worldGroup.add(amenityGroup);

  // 3a. Amenity Ground Polygons (lush lawns, planting beds, pale gravel sikkas, and paved plazas)
  for (const aa of site.amenityAreas) {
    let mat = mats.lawnGrass;
    let y = 0.014;
    if (aa.kind === 'poolDeck') {
      mat = mats.poolDeck;
      y = 0.035;
    } else if (
      aa.kind === 'compound' ||
      aa.kind === 'forecourt' ||
      aa.kind === 'plaza' ||
      aa.kind === 'picnicHardscape' ||
      aa.kind === 'brochureFootprint'
    ) {
      mat = mats.sikkaPaver;
      y = 0.021;
    } else if (aa.kind === 'sikka') {
      mat = mats.paleGravel;
      y = 0.011;
    } else if (aa.kind === 'lawn' || aa.kind === 'park' || aa.kind === 'gardenBeds' || aa.kind === 'plot' || aa.kind === 'zone') {
      mat = aa.kind === 'park' || aa.kind === 'plot' ? mats.parkGrass : aa.kind === 'gardenBeds' ? mats.plantingBed : mats.lawnGrass;
      y = 0.017;
    } else if (aa.kind === 'activityZone' || aa.kind === 'sportsCourt') {
      mat = mats.cycleTrackBlue;
      y = 0.028;
    } else if (aa.kind === 'parking') {
      mat = mats.roadAsphalt;
      y = 0.022;
    } else if (aa.kind === 'island') {
      mat = mats.lawnGrass;
      y = 0.06;
    } else {
      mat = mats.paleGravel;
      y = 0.012;
    }
    const geom = makeFlatPolyGeometry(aa.outer, y, aa.holes);
    const mesh = new THREE.Mesh(geom, mat);
    mesh.receiveShadow = true;
    amenityGroup.add(mesh);
  }

  // 3b. Water Features (Main Pool 9.45x27.9m, Kids' Pool 10x7m, Context Lagoon)
  const waterMeshes = [];
  for (const w of site.water) {
    // Pool basin rim
    const rimGeom = makeExtrudedPolyGeometry(w.outer, 0.16, 0.0, w.holes);
    const rimMesh = new THREE.Mesh(rimGeom, mats.parapetCoping);
    rimMesh.receiveShadow = true;
    amenityGroup.add(rimMesh);

    // Turquoise pool floor & water surface
    const floorGeom = makeFlatPolyGeometry(w.outer, 0.03, w.holes);
    amenityGroup.add(new THREE.Mesh(floorGeom, mats.poolTile));

    const waterGeom = makeFlatPolyGeometry(w.outer, 0.13, w.holes);
    const waterMesh = new THREE.Mesh(waterGeom, mats.poolWater);
    amenityGroup.add(waterMesh);
    waterMeshes.push(waterMesh);

    // If Main Pool (Amenity 1), add sun loungers & pink resort umbrellas around the pool deck (04_Community_Centre_pool.jpg)
    if (w.kind === 'pool') {
      let cx = 0, cz = 0;
      w.outer.forEach((p) => { cx += p[0]; cz += p[1]; });
      cx /= w.outer.length;
      cz /= w.outer.length;
      const poolProps = createPoolDeckFurniture(mats);
      poolProps.position.set(cx, 0.04, cz);
      poolProps.rotation.y = THREE.MathUtils.degToRad(37.49);
      amenityGroup.add(poolProps);
    }
    if (w.kind === 'kidsPool') {
      let cx = 0, cz = 0;
      w.outer.forEach((p) => { cx += p[0]; cz += p[1]; });
      cx /= w.outer.length;
      cz /= w.outer.length;
      // Tensile shade canopy over kids' pool
      const canopyGroup = new THREE.Group();
      canopyGroup.position.set(cx, 0, cz);
      canopyGroup.rotation.y = THREE.MathUtils.degToRad(37.49);
      const sail = new THREE.Mesh(new THREE.ConeGeometry(6.2, 1.4, 4), mats.wallWhite);
      sail.position.y = 4.2;
      sail.rotation.y = Math.PI / 4;
      sail.castShadow = true;
      canopyGroup.add(sail);
      for (const [px, pz] of [[-4.2, -3.2], [4.2, -3.2], [-4.2, 3.2], [4.2, 3.2]]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 4.0, 8), mats.darkMetal);
        post.position.set(px, 2.0, pz);
        canopyGroup.add(post);
      }
      amenityGroup.add(canopyGroup);
    }
  }

  // 3c. Amenity Buildings (Community Centre Pavilions, Mosque with Dome & Minaret, Entrance Gatehouse, Substations)
  for (const b of site.buildings) {
    const h = b.height || 4.5;
    if (b.kind === 'pavilion') {
      // Community Centre Pavilions (matching 04_Community_Centre_pool.jpg: warm travertine/stone frame + full-height glazing)
      const shell = new THREE.Mesh(makeExtrudedPolyGeometry(b.outer, h, 0, b.holes), mats.wallAstonTaupe);
      shell.castShadow = true;
      shell.receiveShadow = true;
      amenityGroup.add(shell);

      const roofCap = new THREE.Mesh(makeExtrudedPolyGeometry(b.outer, 0.45, h - 0.3, b.holes), mats.parapetCoping);
      roofCap.castShadow = true;
      amenityGroup.add(roofCap);

      // Glazing band on pavilions
      for (let i = 0; i < b.outer.length; i++) {
        const p1 = b.outer[i];
        const p2 = b.outer[(i + 1) % b.outer.length];
        const segLen = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
        if (segLen > 5.0) {
          const glassPane = new THREE.Mesh(new THREE.BoxGeometry(segLen * 0.78, h - 0.9, 0.12), mats.exteriorGlass);
          glassPane.position.set((p1[0] + p2[0]) * 0.5, (h - 0.9) * 0.5 + 0.1, (p1[1] + p2[1]) * 0.5);
          glassPane.rotation.y = -Math.atan2(p2[1] - p1[1], p2[0] - p1[0]);
          amenityGroup.add(glassPane);
        }
      }
      addPolyCollider(b.outer);
    } else if (b.kind === 'mosqueHall') {
      // Amenity 8: Mosque Prayer Hall + Central Dome + Minaret
      const hallMesh = new THREE.Mesh(makeExtrudedPolyGeometry(b.outer, h, 0, b.holes), mats.wallWhite);
      hallMesh.castShadow = true;
      hallMesh.receiveShadow = true;
      amenityGroup.add(hallMesh);

      const parapetMesh = new THREE.Mesh(makeExtrudedPolyGeometry(b.outer, 0.8, h, b.holes), mats.parapetCoping);
      amenityGroup.add(parapetMesh);

      let cx = 0, cz = 0;
      b.outer.forEach((p) => { cx += p[0]; cz += p[1]; });
      cx /= b.outer.length;
      cz /= b.outer.length;

      // Drum + Dome + Crescent Finial
      const drum = new THREE.Mesh(new THREE.CylinderGeometry(5.2, 5.4, 1.8, 24), mats.parapetCoping);
      drum.position.set(cx, h + 0.9, cz);
      drum.castShadow = true;
      amenityGroup.add(drum);

      const dome = new THREE.Mesh(
        new THREE.SphereGeometry(5.1, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.55),
        mats.mosqueDomeGold
      );
      dome.position.set(cx, h + 1.6, cz);
      dome.castShadow = true;
      amenityGroup.add(dome);

      const spire = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.12, 2.2, 8), mats.brassAccent);
      spire.position.set(cx, h + 7.2, cz);
      amenityGroup.add(spire);

      // Minaret tower at corner of mosque
      const minX = cx + 11.5, minZ = cz - 8.5;
      const minBase = new THREE.Mesh(new THREE.BoxGeometry(2.8, 14, 2.8), mats.wallWhite);
      minBase.position.set(minX, 7.0, minZ);
      minBase.castShadow = true;
      amenityGroup.add(minBase);

      const minBalcony = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 1.7, 0.9, 12), mats.parapetCoping);
      minBalcony.position.set(minX, 14.4, minZ);
      amenityGroup.add(minBalcony);

      const minUpper = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.25, 5.5, 12), mats.wallWhite);
      minUpper.position.set(minX, 17.5, minZ);
      minUpper.castShadow = true;
      amenityGroup.add(minUpper);

      const minCap = new THREE.Mesh(new THREE.ConeGeometry(1.15, 2.8, 12), mats.mosqueDomeGold);
      minCap.position.set(minX, 21.6, minZ);
      amenityGroup.add(minCap);

      addPolyCollider(b.outer);
    } else if (b.kind === 'mihrab' || b.kind === 'courtyard' || b.kind === 'service') {
      const m = new THREE.Mesh(makeExtrudedPolyGeometry(b.outer, h, 0, b.holes), mats.wallOffWhite);
      m.castShadow = true;
      m.receiveShadow = true;
      amenityGroup.add(m);
      addPolyCollider(b.outer);
    } else if (b.kind === 'gatehouse') {
      // Amenity 9: Main Entrance Gatehouse, Canopy, Boom Barriers & NARA Feature Wall
      const gh = new THREE.Mesh(makeExtrudedPolyGeometry(b.outer, h, 0, b.holes), mats.wallAstonTaupe);
      gh.castShadow = true;
      gh.receiveShadow = true;
      amenityGroup.add(gh);

      let cx = 0, cz = 0;
      b.outer.forEach((p) => { cx += p[0]; cz += p[1]; });
      cx /= b.outer.length;
      cz /= b.outer.length;

      const gatePortal = createEntranceGatePortal(mats);
      gatePortal.position.set(cx, 0, cz);
      gatePortal.rotation.y = THREE.MathUtils.degToRad(37.49);
      amenityGroup.add(gatePortal);
      addPolyCollider(b.outer);
    }
  }

  // Substations
  for (const u of site.utilities) {
    const sub = new THREE.Mesh(makeExtrudedPolyGeometry(u.outer, 2.8, 0), mats.wallOffWhite);
    sub.castShadow = true;
    sub.receiveShadow = true;
    amenityGroup.add(sub);
    addPolyCollider(u.outer);
  }

  // Park Furnishings (Playgrounds in Pocket Parks #5, Fitness Stations #4, Picnic Pergolas #6, Hammocks #3)
  for (const ap of site.amenityPoints) {
    if (ap.number === 5) {
      const play = createPocketParkPlayArea(mats);
      play.position.set(ap.wx, 0.02, ap.wz);
      play.rotation.y = THREE.MathUtils.degToRad(37.49);
      amenityGroup.add(play);
    } else if (ap.number === 4) {
      const fit = createFitnessStation(mats);
      fit.position.set(ap.wx, 0.03, ap.wz);
      amenityGroup.add(fit);
    } else if (ap.number === 6) {
      const pic = createPicnicPergola(mats);
      pic.position.set(ap.wx, 0.02, ap.wz);
      pic.rotation.y = THREE.MathUtils.degToRad(37.49);
      amenityGroup.add(pic);
    } else if (ap.number === 3) {
      const gdn = createCommunityGardenFeatures(mats);
      gdn.position.set(ap.wx, 0.02, ap.wz);
      amenityGroup.add(gdn);
    }
  }

  function addPolyCollider(pts) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of pts) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minZ) minZ = p[1];
      if (p[1] > maxZ) maxZ = p[1];
    }
    buildingColliders.push({
      type: 'aabb',
      minX: minX + 0.2,
      maxX: maxX - 0.2,
      minZ: minZ + 0.2,
      maxZ: maxZ - 0.2,
    });
  }

  // ============================================================================
  // 4. ALL 1,231 TREES BY SPECIES (7 SPECIES FROM SITE MAP)
  // ============================================================================
  const treeGroup = buildAll1231Trees(site.trees, mats, 0.55);
  worldGroup.add(treeGroup);

  // ============================================================================
  // 5. ALL 372 TOWNHOUSES IN 57 ROWS (ASTON, PALMA, CHARM)
  // ============================================================================
  const homesGroup = new THREE.Group();
  homesGroup.name = 'All372Townhouses';
  worldGroup.add(homesGroup);

  // Pre-build reusable exterior shell geometry templates for each of the 16 plan types
  const planTemplates = {};
  for (const [pkey, pdata] of Object.entries(data.plans)) {
    planTemplates[pkey] = createPlanExteriorTemplate(pdata, mats);
  }

  // Car templates for driveways
  const carMeshesByColor = createCarTemplates(mats);

  for (const unit of data.units) {
    const pdata = data.plans[unit.planType];
    const tpl = planTemplates[unit.planType];

    const uGroup = new THREE.Group();
    uGroup.name = `Unit_${unit.unit}`;
    uGroup.position.set(unit.wx, 0, unit.wz);
    // Exact true bearing rotation: plan +Z faces frontBearing, plan +X runs along row (TH1 -> THN)
    const thetaRad = THREE.MathUtils.degToRad(unit.frontBearing);
    uGroup.rotation.y = Math.PI - thetaRad;
    uGroup.userData = { unitNo: unit.unit, unit };
    homesGroup.add(uGroup);

    // 5a. Plot & Garden (always visible both from outside and when inside looking out the windows!)
    const plotGroup = buildUnitPlotAndGarden(unit, pdata, mats, carMeshesByColor);
    uGroup.add(plotGroup);

    // 5b. Exterior Building Shell (visible from outside; hidden when user enters this specific unit's full interior)
    const shellGroup = tpl.clone();
    shellGroup.traverse((child) => {
      if (child.isMesh) {
        child.userData.unitNo = unit.unit;
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    uGroup.add(shellGroup);

    // 5c. Pickable / Highlight / Color-Coding Roof & Facade Overlay
    const houseW = pdata.houseX[1] - pdata.houseX[0];
    const houseMidX = 0.5 * (pdata.houseX[0] + pdata.houseX[1]) - unit.anchorX;
    const houseMidZ = 11.8 - unit.anchorZ;

    const pickGeo = new THREE.BoxGeometry(houseW - 0.15, 7.85, 11.6);
    const pickMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.4,
      metalness: 0.1,
      transparent: true,
      opacity: 0.0,
      depthWrite: false,
    });
    const highlightMesh = new THREE.Mesh(pickGeo, pickMat);
    highlightMesh.position.set(houseMidX, 3.95, houseMidZ);
    highlightMesh.userData = { unitNo: unit.unit, isPicker: true };
    uGroup.add(highlightMesh);
    pickableMeshes.push(highlightMesh);

    // Selection outline frame above roof
    const ringGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(houseW + 0.3, 8.2, 12.1));
    const ringMat = new THREE.LineBasicMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.0 });
    const selectionWire = new THREE.LineSegments(ringGeo, ringMat);
    selectionWire.position.set(houseMidX, 4.1, houseMidZ);
    uGroup.add(selectionWire);

    // Container for on-demand 1:1 Furnished Interior
    const interiorGroup = new THREE.Group();
    interiorGroup.name = `Interior_${unit.unit}`;
    uGroup.add(interiorGroup);

    // Street-level OBB collider for this house (so player cannot walk through closed exterior houses)
    buildingColliders.push({
      type: 'unit',
      unitNo: unit.unit,
      wx: unit.wx,
      wz: unit.wz,
      cosR: Math.cos(uGroup.rotation.y),
      sinR: Math.sin(uGroup.rotation.y),
      minX: pdata.houseX[0] - unit.anchorX,
      maxX: pdata.houseX[1] - unit.anchorX,
      minZ: 5.6 - unit.anchorZ,
      maxZ: 17.2 - unit.anchorZ,
    });

    unitRecords.set(unit.unit, {
      unit,
      pdata,
      group: uGroup,
      plotGroup,
      shellGroup,
      interiorGroup,
      highlightMesh,
      selectionWire,
      hasBuiltInterior: false,
      interiorController: null,
    });
  }

  // ============================================================================
  // 6. SURROUNDING VALLEY CONTEXT (EDEN & NEIGHBOURING CLUSTERS)
  // ============================================================================
  // Stand-in context clusters removed: neighbouring projects come from their own data.

  // ============================================================================
  // 7. COLLISION DETECTION & COLOR-CODING API
  // ============================================================================
  function checkStreetCollision(wx, wz, radius = 0.42, activeInteriorUnitNo = null) {
    for (const c of buildingColliders) {
      if (c.type === 'unit') {
        if (c.unitNo === activeInteriorUnitNo) continue; // Interior handles its own wall collisions
        const dx = wx - c.wx;
        const dz = wz - c.wz;
        // Inverse rotate into unit local frame
        const lx = dx * c.cosR - dz * c.sinR;
        const lz = dx * c.sinR + dz * c.cosR;
        if (
          lx > c.minX - radius &&
          lx < c.maxX + radius &&
          lz > c.minZ - radius &&
          lz < c.maxZ + radius
        ) {
          return true;
        }
      } else if (c.type === 'aabb') {
        if (
          wx > c.minX - radius &&
          wx < c.maxX + radius &&
          wz > c.minZ - radius &&
          wz < c.maxZ + radius
        ) {
          return true;
        }
      }
    }
    return false;
  }

  function updateUnitVisualStates({
    selectedUnitNo = null,
    matchingUnitSet = null,
    filterActive = false,
    colorMode = 'realistic',
    cameraMode = 'aerial',
  }) {
    const isAerial = cameraMode === 'aerial';
    for (const [uno, rec] of unitRecords.entries()) {
      const u = rec.unit;
      const isSelected = uno === selectedUnitNo;
      const isMatch = !filterActive || (matchingUnitSet && matchingUnitSet.has(uno));
      const shellHidden = !rec.shellGroup.visible;

      // Never show selection box or tint when in cutaway, interior, or street view
      if (!isAerial || shellHidden) {
        rec.selectionWire.visible = false;
        rec.selectionWire.material.opacity = 0.0;
        rec.highlightMesh.material.opacity = 0.0;
        rec.highlightMesh.material.emissiveIntensity = 0.0;
        continue;
      }

      // Selection wireframe in aerial view only
      rec.selectionWire.visible = isSelected;
      rec.selectionWire.material.opacity = isSelected ? 0.9 : 0.0;
      rec.selectionWire.material.color.setHex(isSelected ? 0xffb703 : 0x10b981);

      // Determine color overlay (only when colorMode !== 'realistic' or filterActive)
      let overlayColor = null;
      let overlayOpacity = 0.0;

      if (colorMode === 'design') {
        overlayColor =
          u.design === 'Aston' ? 0x52b788 : u.design === 'Palma' ? 0xf4a261 : 0xe76f51;
        overlayOpacity = 0.52;
      } else if (colorMode === 'bedrooms') {
        overlayColor = u.bedrooms === 4 ? 0x3b82f6 : 0x10b981;
        overlayOpacity = 0.52;
      } else if (colorMode === 'facing') {
        const f = u.frontFaces;
        overlayColor =
          f === 'North-West'
            ? 0x38bdf8
            : f === 'South-East'
            ? 0xf59e0b
            : f === 'North-East'
            ? 0xa855f7
            : 0xec4899;
        overlayOpacity = 0.52;
      } else if (colorMode === 'market') {
        if (u.salesCount > 0 && u.leasesCount > 0) {
          overlayColor = 0x8b5cf6;
          overlayOpacity = 0.52;
        } else if (u.salesCount > 0) {
          overlayColor = 0x10b981;
          overlayOpacity = 0.52;
        } else if (u.leasesCount > 0) {
          overlayColor = 0x0ea5e9;
          overlayOpacity = 0.52;
        } else {
          overlayColor = 0x64748b;
          overlayOpacity = 0.18;
        }
      }

      if (filterActive) {
        if (isMatch) {
          if (!overlayColor) overlayColor = 0x10b981;
          overlayOpacity = Math.max(overlayOpacity, 0.45);
        } else {
          overlayColor = 0x1e293b;
          overlayOpacity = 0.35;
        }
      }

      if (isSelected && (filterActive || colorMode !== 'realistic')) {
        overlayColor = 0xf59e0b;
        overlayOpacity = 0.45;
      }

      const mat = rec.highlightMesh.material;
      if (overlayOpacity > 0 && overlayColor !== null) {
        mat.color.setHex(overlayColor);
        mat.emissive.setHex(overlayColor);
        mat.emissiveIntensity = isSelected ? 0.35 : filterActive && isMatch ? 0.25 : 0.15;
        mat.opacity = overlayOpacity;
      } else {
        mat.opacity = 0.0;
        mat.emissiveIntensity = 0.0;
      }
    }
  }

  function animateWater(timeSec) {
    const wave = Math.sin(timeSec * 2.2) * 0.008;
    for (const wm of waterMeshes) {
      wm.position.y = wave;
    }
  }

  return {
    worldGroup,
    homesGroup,
    landscape: { roads: roadGroup, amenities: amenityGroup, trees: treeGroup },
    unitRecords,
    pickableMeshes,
    checkStreetCollision,
    updateUnitVisualStates,
    animateWater,
  };
}

// ============================================================================
// HELPER: CREATE EXTERIOR BUILDING TEMPLATE FOR EACH OF THE 16 PLAN TYPES
// ============================================================================
export function createPlanExteriorTemplate(pdata, mats) {
  const group = new THREE.Group();
  const ax = pdata.anchorX;
  const az = pdata.anchorZ;
  const style = pdata.style; // 'aston' | 'palma' | 'charm'

  const mainWallMat =
    style === 'aston'
      ? mats.wallAstonGrey
      : style === 'palma'
      ? mats.wallOffWhite
      : mats.wallCharmWhite;

  function toShape(pts) {
    const s = new THREE.Shape();
    pts.forEach((p, idx) => {
      const x = p[0] - ax;
      const z = p[1] - az;
      if (idx === 0) s.moveTo(x, -z);
      else s.lineTo(x, -z);
    });
    s.closePath();
    return s;
  }

  // 1. Ground Floor Massing (0.0 -> 3.6m)
  const gShape = toShape(pdata.house.outline);
  const gGeom = new THREE.ExtrudeGeometry(gShape, { depth: 3.6, bevelEnabled: false });
  gGeom.rotateX(-Math.PI / 2);
  group.add(new THREE.Mesh(gGeom, mats.wallWhite));

  // 2. First Floor Massing (3.6 -> 6.9m)
  const fOutline = pdata.house.outlineFirst || pdata.house.outline;
  const fShape = toShape(fOutline);
  const fGeom = new THREE.ExtrudeGeometry(fShape, { depth: 3.3, bevelEnabled: false });
  fGeom.rotateX(-Math.PI / 2);
  fGeom.translate(0, 3.6, 0);
  group.add(new THREE.Mesh(fGeom, mainWallMat));

  // 3. Roof Slab & Parapet Walls (6.9 -> 7.9m) + Roof Equipment
  const rGeom = new THREE.ExtrudeGeometry(fShape, { depth: 0.95, bevelEnabled: false });
  rGeom.rotateX(-Math.PI / 2);
  rGeom.translate(0, 6.9, 0);
  group.add(new THREE.Mesh(rGeom, mainWallMat));

  const copingGeom = new THREE.ExtrudeGeometry(fShape, { depth: 0.1, bevelEnabled: false });
  copingGeom.rotateX(-Math.PI / 2);
  copingGeom.translate(0, 7.85, 0);
  group.add(new THREE.Mesh(copingGeom, mats.parapetCoping));

  // Roof AC Condensers & Solar Water Heater (inset on roof at y = 7.85m)
  const midX = 0.5 * (pdata.houseX[0] + pdata.houseX[1]) - ax;
  const ac1 = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.75, 0.42), mats.wallAstonGrey);
  ac1.position.set(midX - 1.1, 8.22, 10.5 - az);
  group.add(ac1);
  const ac2 = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.75, 0.42), mats.wallAstonGrey);
  ac2.position.set(midX + 0.2, 8.22, 10.5 - az);
  group.add(ac2);
  const waterHeater = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 1.35, 10), mats.chromeMetal);
  waterHeater.rotation.z = Math.PI / 2;
  waterHeater.position.set(midX + 1.5, 8.2, 12.2 - az);
  group.add(waterHeater);

  // 4. Carport Canopy (3.2 -> 3.6m), Front Portal Beam, Recessed Soffit Lights & Columns (0 -> 3.2m)
  const hLeft = pdata.houseX[0] - ax;
  const hRight = pdata.houseX[1] - ax;
  const hW = hRight - hLeft;
  const frontZ = 17.15 - az;
  const backZ = 5.85 - az;
  const carportFrontZ = 22.85 - az;

  if (pdata.canopies && pdata.canopies.length > 0) {
    for (const c of pdata.canopies) {
      const cShape = toShape(c.poly);
      const cH = (c.top || 3.6) - (c.bottom || 3.2);
      const cGeom = new THREE.ExtrudeGeometry(cShape, { depth: cH, bevelEnabled: false });
      cGeom.rotateX(-Math.PI / 2);
      cGeom.translate(0, c.bottom || 3.2, 0);
      group.add(new THREE.Mesh(cGeom, mats.wallWhite));
    }
  } else {
    // Ensure every plan has a projecting carport roof slab & front beam
    const cpSlab = new THREE.Mesh(new THREE.BoxGeometry(hW, 0.36, 5.7), mats.wallWhite);
    cpSlab.position.set(midX, 3.38, frontZ + 2.85);
    group.add(cpSlab);
  }

  // Crisp dark fascia trim & front carport beam + two outer structural columns + recessed LED soffit downlights
  const fasciaBeam = new THREE.Mesh(new THREE.BoxGeometry(hW + 0.04, 0.08, 0.12), mats.darkMetal);
  fasciaBeam.position.set(midX, 3.54, carportFrontZ);
  group.add(fasciaBeam);

  for (const colX of [hLeft + 0.22, hRight - 0.22]) {
    const fCol = new THREE.Mesh(new THREE.BoxGeometry(0.32, 3.25, 0.32), mats.wallWhite);
    fCol.position.set(colX, 1.625, carportFrontZ - 0.2);
    group.add(fCol);
  }

  for (const lxOff of [-1.25, 1.25]) {
    const downlight = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.03, 0.14), mats.lampEmissive);
    downlight.position.set(midX + lxOff, 3.19, frontZ + 2.4);
    group.add(downlight);
  }

  for (const w of pdata.floors.ground.walls) {
    if (w.kind === 'column') {
      const cx = 0.5 * (w.a[0] + w.b[0]) - ax;
      const cz = 0.5 * (w.a[1] + w.b[1]) - az;
      const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]) || 0.45;
      const col = new THREE.Mesh(new THREE.BoxGeometry(w.t || 0.26, w.h || 3.2, len), mats.wallWhite);
      col.position.set(cx, (w.h || 3.2) * 0.5, cz);
      group.add(col);
    }
  }

  // 5. Exterior Windows (with Recessed Casements, Mullions, Warm Interior Backing & Reflective Glass) & Entrance Doors
  for (const [flKey, baseH] of [['ground', 0.0], ['first', 3.6]]) {
    const fl = pdata.floors[flKey];
    for (const op of fl.openings) {
      const hostWall = fl.walls[op.wall];
      if (!hostWall || !hostWall.ext) continue;
      const ox = 0.5 * (op.a[0] + op.b[0]) - ax;
      const oz = 0.5 * (op.a[1] + op.b[1]) - az;
      const wLen = Math.hypot(op.b[0] - op.a[0], op.b[1] - op.a[1]);
      if (wLen < 0.2) continue;
      const sill = op.sill || 0.0;
      const head = op.head || 2.6;
      const oH = Math.max(0.4, head - sill);
      const yaw = -Math.atan2(op.b[1] - op.a[1], op.b[0] - op.a[0]);
      const thick = (hostWall.t || 0.22) + 0.06;

      const winGroup = new THREE.Group();
      winGroup.position.set(ox, baseH + sill + oH * 0.5, oz);
      winGroup.rotation.y = yaw;
      group.add(winGroup);

      if (op.kind === 'entranceDoor') {
        // Dark outer portal frame + warm walnut door + vertical brushed-steel pull bar
        const dFrame = new THREE.Mesh(new THREE.BoxGeometry(wLen + 0.1, oH + 0.06, thick), mats.darkMetal);
        winGroup.add(dFrame);
        const doorMesh = new THREE.Mesh(new THREE.BoxGeometry(wLen - 0.04, oH - 0.04, thick + 0.02), mats.walnutWood);
        winGroup.add(doorMesh);
        const pullBar = new THREE.Mesh(new THREE.BoxGeometry(0.03, oH * 0.55, thick + 0.06), mats.chromeMetal);
        pullBar.position.set(wLen * 0.28, 0, 0);
        winGroup.add(pullBar);
      } else {
        // Dark anodized aluminum outer box frame + stone sill
        const frameMesh = new THREE.Mesh(new THREE.BoxGeometry(wLen + 0.08, oH + 0.08, thick), mats.darkMetal);
        winGroup.add(frameMesh);

        const sillLedge = new THREE.Mesh(new THREE.BoxGeometry(wLen + 0.14, 0.06, thick + 0.08), mats.parapetCoping);
        sillLedge.position.y = -oH * 0.5 - 0.01;
        winGroup.add(sillLedge);

        // Warm lit interior backing plane inside the window
        const backingMesh = new THREE.Mesh(
          new THREE.BoxGeometry(wLen - 0.06, oH - 0.06, thick + 0.01),
          mats.windowInteriorBacking
        );
        winGroup.add(backingMesh);

        // Reflective exterior glass pane
        const glassMesh = new THREE.Mesh(
          new THREE.BoxGeometry(wLen - 0.06, oH - 0.06, thick + 0.035),
          mats.exteriorGlass
        );
        winGroup.add(glassMesh);

        // Vertical aluminum mullions (1, 2 or 3 panes depending on window width)
        const numPanes = Math.max(1, Math.round(wLen / 1.05));
        for (let p = 1; p < numPanes; p++) {
          const mx = -wLen * 0.5 + (p / numPanes) * wLen;
          const mullion = new THREE.Mesh(new THREE.BoxGeometry(0.045, oH, thick + 0.05), mats.darkMetal);
          mullion.position.x = mx;
          winGroup.add(mullion);
        }
        // Horizontal transom bar on tall windows
        if (oH > 1.9) {
          const transom = new THREE.Mesh(new THREE.BoxGeometry(wLen, 0.04, thick + 0.05), mats.darkMetal);
          transom.position.y = oH * 0.24;
          winGroup.add(transom);
        }
      }
    }
  }

  // 6. First-Floor Glass & Metal Balcony Railings
  if (pdata.floors.first.railings) {
    for (const rl of pdata.floors.first.railings) {
      const rx = 0.5 * (rl.a[0] + rl.b[0]) - ax;
      const rz = 0.5 * (rl.a[1] + rl.b[1]) - az;
      const rLen = Math.hypot(rl.b[0] - rl.a[0], rl.b[1] - rl.a[1]);
      if (rLen < 0.2) continue;
      const rH = rl.h || 1.1;
      const yaw = -Math.atan2(rl.b[1] - rl.a[1], rl.b[0] - rl.a[0]);
      const railGlass = new THREE.Mesh(new THREE.BoxGeometry(rLen, rH, 0.05), mats.balconyGlass);
      railGlass.position.set(rx, 3.6 + rH * 0.5, rz);
      railGlass.rotation.y = yaw;
      group.add(railGlass);

      const topBar = new THREE.Mesh(new THREE.BoxGeometry(rLen, 0.05, 0.08), mats.darkMetal);
      topBar.position.set(rx, 3.6 + rH, rz);
      topBar.rotation.y = yaw;
      group.add(topBar);
    }
  }

  // 7. Signature Facade Details by Style (Aston / Palma / Charm) matching 04_Design_*.jpg & 04_Streetscape.jpg
  if (style === 'aston') {
    // Aston (04_Design_Aston.jpg): Deep projecting stone-grey box frame + bronze-taupe spandrels + vertical metal slats + timber entry cladding
    const topBar = new THREE.Mesh(new THREE.BoxGeometry(hW, 0.28, 0.72), mats.wallAstonGrey);
    topBar.position.set(midX, 7.68, frontZ + 0.32);
    group.add(topBar);

    const botLedge = new THREE.Mesh(new THREE.BoxGeometry(hW, 0.22, 0.68), mats.wallAstonGrey);
    botLedge.position.set(midX, 3.68, frontZ + 0.3);
    group.add(botLedge);

    const leftWing = new THREE.Mesh(new THREE.BoxGeometry(0.24, 4.25, 0.72), mats.wallAstonGrey);
    leftWing.position.set(hLeft + 0.14, 5.7, frontZ + 0.32);
    group.add(leftWing);

    const rightWing = new THREE.Mesh(new THREE.BoxGeometry(0.24, 4.25, 0.72), mats.wallAstonGrey);
    rightWing.position.set(hRight - 0.14, 5.7, frontZ + 0.32);
    group.add(rightWing);

    // Bronze-taupe vertical spandrel panel + vertical bronze slats on upper street facade
    const spandrel = new THREE.Mesh(new THREE.BoxGeometry(hW * 0.36, 3.75, 0.2), mats.wallAstonTaupe);
    spandrel.position.set(midX - hW * 0.24, 5.65, frontZ + 0.1);
    group.add(spandrel);

    for (let s = 0; s < 6; s++) {
      const slat = new THREE.Mesh(new THREE.BoxGeometry(0.045, 3.75, 0.28), mats.darkMetal);
      slat.position.set(midX - hW * 0.42 + s * 0.11, 5.65, frontZ + 0.16);
      group.add(slat);
    }

    // Rear garden facade frame & bronze-taupe spandrel (04_Streetscape.jpg)
    const rearTopBar = new THREE.Mesh(new THREE.BoxGeometry(hW, 0.26, 0.55), mats.wallAstonGrey);
    rearTopBar.position.set(midX, 7.68, backZ - 0.24);
    group.add(rearTopBar);
    const rearSpandrel = new THREE.Mesh(new THREE.BoxGeometry(hW * 0.34, 3.6, 0.18), mats.wallAstonTaupe);
    rearSpandrel.position.set(midX + hW * 0.24, 5.6, backZ - 0.08);
    group.add(rearSpandrel);

    // Ground-floor carport timber slat accent wall
    const entryWood = new THREE.Mesh(new THREE.BoxGeometry(0.16, 3.18, 2.8), mats.walnutWood);
    entryWood.position.set(hLeft + 0.14, 1.6, frontZ + 1.6);
    group.add(entryWood);
  } else if (style === 'palma') {
    // Palma (04_Design_Palma.jpg): Bold projecting 4-sided picture-window box frame + bronze inner header + side louver shutters
    const boxW = hW * 0.64;
    const picTop = new THREE.Mesh(new THREE.BoxGeometry(boxW, 0.28, 0.76), mats.wallPalmaFrame);
    picTop.position.set(midX, 7.62, frontZ + 0.35);
    group.add(picTop);

    const picBot = new THREE.Mesh(new THREE.BoxGeometry(boxW, 0.26, 0.76), mats.wallPalmaFrame);
    picBot.position.set(midX, 3.72, frontZ + 0.35);
    group.add(picBot);

    const picLeft = new THREE.Mesh(new THREE.BoxGeometry(0.26, 4.18, 0.76), mats.wallPalmaFrame);
    picLeft.position.set(midX - boxW * 0.5 + 0.13, 5.67, frontZ + 0.35);
    group.add(picLeft);

    const picRight = new THREE.Mesh(new THREE.BoxGeometry(0.26, 4.18, 0.76), mats.wallPalmaFrame);
    picRight.position.set(midX + boxW * 0.5 - 0.13, 5.67, frontZ + 0.35);
    group.add(picRight);

    // Dark bronze recessed header band inside picture window box
    const innerHeader = new THREE.Mesh(new THREE.BoxGeometry(boxW - 0.52, 0.52, 0.28), mats.wallAstonTaupe);
    innerHeader.position.set(midX, 7.22, frontZ + 0.24);
    group.add(innerHeader);

    // Warm lit interior backing + reflective picture window glass + 3 vertical mullions
    const picBack = new THREE.Mesh(new THREE.BoxGeometry(boxW - 0.54, 3.12, 0.08), mats.windowInteriorBacking);
    picBack.position.set(midX, 5.4, frontZ + 0.24);
    group.add(picBack);

    const picGlass = new THREE.Mesh(new THREE.BoxGeometry(boxW - 0.54, 3.12, 0.12), mats.exteriorGlass);
    picGlass.position.set(midX, 5.4, frontZ + 0.28);
    group.add(picGlass);

    for (const mFrac of [-0.25, 0, 0.25]) {
      const mul = new THREE.Mesh(new THREE.BoxGeometry(0.045, 3.12, 0.16), mats.darkMetal);
      mul.position.set(midX + (boxW - 0.54) * mFrac, 5.4, frontZ + 0.3);
      group.add(mul);
    }

    // Side bay louvered shutter screen & ground-floor warm taupe accent wall
    const shutter = new THREE.Mesh(new THREE.BoxGeometry(hW * 0.16, 2.85, 0.14), mats.gateSlat);
    shutter.position.set(hLeft + hW * 0.1, 5.35, frontZ + 0.06);
    group.add(shutter);

    const gfFeature = new THREE.Mesh(new THREE.BoxGeometry(hW * 0.55, 3.18, 0.14), mats.wallPalmaFeature);
    gfFeature.position.set(midX, 1.6, frontZ + 0.05);
    group.add(gfFeature);
  } else if (style === 'charm') {
    // Charm (04_Design_Charm.jpg): Rhythmic vertical architectural louver screen + walnut timber panels + walnut carport cladding
    const numFins = 18;
    const span = hW * 0.56;
    for (let i = 0; i < numFins; i++) {
      const fx = midX - span * 0.5 + (i / (numFins - 1)) * span;
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.055, 3.25, 0.32), mats.charmLouver);
      fin.position.set(fx, 5.3, frontZ + 0.2);
      group.add(fin);

      // Matching vertical fins on garden facade (04_Interior_Living_room.jpg)
      const bFin = new THREE.Mesh(new THREE.BoxGeometry(0.055, 3.2, 0.26), mats.charmLouver);
      bFin.position.set(fx, 5.3, backZ - 0.16);
      group.add(bFin);
    }

    // Warm walnut vertical accent panels flanking the upper window band
    for (const wxSign of [-1, 1]) {
      const wPanel = new THREE.Mesh(new THREE.BoxGeometry(0.42, 2.65, 0.16), mats.walnutWood);
      wPanel.position.set(midX + wxSign * (span * 0.5 + 0.24), 5.05, frontZ + 0.1);
      group.add(wPanel);
    }

    // Full-height warm walnut timber slat carport walls on left and entrance portal
    const woodWallLeft = new THREE.Mesh(new THREE.BoxGeometry(0.18, 3.18, 4.4), mats.walnutWood);
    woodWallLeft.position.set(hLeft + 0.14, 1.6, frontZ + 2.3);
    group.add(woodWallLeft);

    const woodPortal = new THREE.Mesh(new THREE.BoxGeometry(1.35, 3.18, 0.22), mats.walnutWood);
    woodPortal.position.set(hRight - 0.72, 1.6, frontZ + 0.12);
    group.add(woodPortal);
  }

  return group;
}

// ============================================================================
// HELPER: BUILD PLOT, GARDEN, BOUNDARY WALLS, DRIVEWAY, FOOTPATH & PLANTERS PER UNIT
// ============================================================================
// Flat plot layers are stacked 1.5-3 cm apart (the reference used 1 mm, which z-fights and
// flickers when seen from the air): base pad < lawn < gravel bed < driveway < planter < footpath
// (the terrace is an 8 cm slab and keeps its reference height).
export function buildUnitPlotAndGarden(unit, pdata, mats, carMeshesByColor) {
  const g = new THREE.Group();
  const ax = unit.anchorX;
  const az = unit.anchorZ;
  const xL = unit.xLeft - ax;
  const xR = unit.xRight - ax;
  const w = xR - xL;
  const cx = 0.5 * (xL + xR);

  // 0. Full-plot pale gravel base pad (eliminates any bare desert sand inside or in front of plots)
  const plotBase = new THREE.Mesh(new THREE.PlaneGeometry(w + 0.08, 27.2), mats.paleGravel);
  plotBase.rotation.x = -Math.PI / 2;
  plotBase.position.set(cx, 0.01, 13.5 - az);
  plotBase.receiveShadow = true;
  g.add(plotBase);

  // 1. Rear Garden Lawn (z = 0.18 -> 6.5) + Pale Gravel Planting Strip & Garden Shrubs
  const rearD = 6.32;
  const rearLawn = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.2, rearD), mats.lawnGrass);
  rearLawn.rotation.x = -Math.PI / 2;
  rearLawn.position.set(cx, 0.035, 0.18 + rearD * 0.5 - az);
  rearLawn.receiveShadow = true;
  g.add(rearLawn);

  // Rear boundary planting bed strip + ornamental shrubs & stepping stones to rear gate
  const rearBed = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.24, 0.85), mats.paleGravel);
  rearBed.rotation.x = -Math.PI / 2;
  rearBed.position.set(cx, 0.055, 0.62 - az);
  g.add(rearBed);

  for (let s = 0; s < 3; s++) {
    const sx = xL + 0.9 + s * ((w - 1.8) / 2);
    const shrub = new THREE.Mesh(new THREE.SphereGeometry(0.42, 7, 6), s % 2 === 0 ? mats.shrubGreen : mats.ornamentalGrass);
    shrub.scale.set(1.25, 0.65, 0.95);
    shrub.position.set(sx, 0.22, 0.65 - az);
    shrub.castShadow = true;
    g.add(shrub);
  }

  for (let st = 0; st < 4; st++) {
    const paver = new THREE.Mesh(new THREE.BoxGeometry(0.65, 0.03, 0.42), mats.sikkaPaver);
    paver.position.set(xL + 0.85, 0.05, (1.1 + st * 0.95) - az);
    g.add(paver);
  }

  // 2. Side Yard Lawn & Stepping Stones for End Units (4BR)
  if (unit.endOrMiddle === 'End') {
    const isLeftOpen = pdata.party.left === null;
    const sideW = 2.85;
    const sideX = isLeftOpen ? xL + sideW * 0.5 + 0.12 : xR - sideW * 0.5 - 0.12;
    const sideLawn = new THREE.Mesh(new THREE.PlaneGeometry(sideW, 17.2), mats.lawnGrass);
    sideLawn.rotation.x = -Math.PI / 2;
    sideLawn.position.set(sideX, 0.035, 8.8 - az);
    sideLawn.receiveShadow = true;
    g.add(sideLawn);
  }

  // 3. Rear Terrace Pavers
  for (const out of pdata.floors.ground.outdoor || []) {
    if (out.type === 'terrace') {
      const xs = out.poly.map((p) => p[0] - ax);
      const zs = out.poly.map((p) => p[1] - az);
      const minX = Math.min(...xs), maxX = Math.max(...xs);
      const minZ = Math.min(...zs), maxZ = Math.max(...zs);
      const tMesh = new THREE.Mesh(
        new THREE.BoxGeometry(maxX - minX, 0.08, maxZ - minZ),
        mats.floorTerrace
      );
      tMesh.position.set(0.5 * (minX + maxX), 0.04, 0.5 * (minZ + maxZ));
      tMesh.receiveShadow = true;
      g.add(tMesh);
    }
  }

  // 4. Front Paved Driveway (z = 16.8 -> 27.0) + Continuous Street-Side Paved Footpath + Front Planter Beds
  const pMinX = (pdata.houseX[0] || 0) - ax;
  const pMaxX = (pdata.houseX[1] || unit.plotW) - ax;
  const driveW = Math.min(w - 0.7, pMaxX - pMinX - 0.3);
  const driveCx = 0.5 * (Math.max(xL, pMinX) + Math.min(xR, pMaxX));

  const driveMesh = new THREE.Mesh(new THREE.PlaneGeometry(driveW, 10.2), mats.drivewayPaver);
  driveMesh.rotation.x = -Math.PI / 2;
  driveMesh.position.set(driveCx, 0.06, 21.9 - az);
  driveMesh.receiveShadow = true;
  g.add(driveMesh);

  // Continuous paved footpath across the full front of every plot (z = 23.4 -> 25.4)
  const frontFootpath = new THREE.Mesh(new THREE.PlaneGeometry(w + 0.06, 2.1), mats.footpathPaver);
  frontFootpath.rotation.x = -Math.PI / 2;
  frontFootpath.position.set(cx, 0.09, 24.4 - az);
  frontFootpath.receiveShadow = true;
  g.add(frontFootpath);

  // Front planter strips flanking the driveway with shrubs, lavender & ornamental grass (04_Design_Aston/Palma/Charm.jpg)
  for (const sideX of [xL + 0.42, xR - 0.42]) {
    const planterTurf = new THREE.Mesh(new THREE.PlaneGeometry(0.78, 6.2), mats.plantingBed);
    planterTurf.rotation.x = -Math.PI / 2;
    planterTurf.position.set(sideX, 0.075, 20.3 - az);
    g.add(planterTurf);

    const bush1 = new THREE.Mesh(new THREE.SphereGeometry(0.36, 7, 6), mats.shrubGreen);
    bush1.scale.set(1.1, 0.65, 1.2);
    bush1.position.set(sideX, 0.22, 18.4 - az);
    g.add(bush1);

    const bush2 = new THREE.Mesh(new THREE.SphereGeometry(0.34, 7, 6), mats.lavenderBush);
    bush2.scale.set(1.0, 0.6, 1.3);
    bush2.position.set(sideX, 0.2, 22.4 - az);
    g.add(bush2);
  }

  // 5. Boundary Walls with Stone Coping Caps & Rear Garden Gate (floors.ground.boundary)
  for (const bw of pdata.floors.ground.boundary || []) {
    const bx1 = Math.max(xL, Math.min(xR, bw.a[0] - ax));
    const bx2 = Math.max(xL, Math.min(xR, bw.b[0] - ax));
    const bz1 = bw.a[1] - az;
    const bz2 = bw.b[1] - az;
    const len = Math.hypot(bx2 - bx1, bz2 - bz1);
    if (len < 0.15) continue;
    const bh = bw.h || 1.8;
    const bt = bw.t || 0.22;
    const yaw = -Math.atan2(bz2 - bz1, bx2 - bx1);
    const isGate = bw.type === 'gate';
    const mat = isGate ? mats.gateSlat : mats.boundaryWall;
    const wallMesh = new THREE.Mesh(new THREE.BoxGeometry(len, bh, bt), mat);
    wallMesh.position.set(0.5 * (bx1 + bx2), bh * 0.5, 0.5 * (bz1 + bz2));
    wallMesh.rotation.y = yaw;
    wallMesh.castShadow = true;
    wallMesh.receiveShadow = true;
    g.add(wallMesh);

    if (!isGate) {
      const coping = new THREE.Mesh(new THREE.BoxGeometry(len + 0.02, 0.06, bt + 0.05), mats.parapetCoping);
      coping.position.set(0.5 * (bx1 + bx2), bh + 0.03, 0.5 * (bz1 + bz2));
      coping.rotation.y = yaw;
      g.add(coping);
    }
  }

  // 6. Parked Car under Carport (deterministic ~68% occupancy)
  const hash = (unit.unit * 2654435761) >>> 0;
  if (hash % 10 < 7) {
    const carFixtures = (pdata.floors.ground.fixtures || []).filter((f) => f.type === 'car');
    if (carFixtures.length > 0) {
      const cf = carFixtures[hash % carFixtures.length];
      const carColorIdx = hash % carMeshesByColor.length;
      const carClone = carMeshesByColor[carColorIdx].clone();
      carClone.position.set(cf.at[0] - ax, 0.03, cf.at[1] - az);
      carClone.rotation.y = THREE.MathUtils.degToRad(-(cf.rot || 180));
      g.add(carClone);
    }
  }

  // 7. Street-Side Unit Number Pillar (matching brochure renders 04_Design_Aston/Palma/Charm)
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.75, 0.14), mats.wallAstonTaupe);
  post.position.set(xL + 0.35, 0.38, 23.3 - az);
  g.add(post);

  return g;
}

// ============================================================================
// HELPER: BUILD ALL 1,231 TREES USING SPECIES-SPECIFIC INSTANCED GEOMETRIES
// ============================================================================
export function buildAll1231Trees(trees, mats, sizeScale = 1) {
  // sizeScale shrinks every tree (walkthrough views stay open)
  return buildTrees(trees, sizeScale); // natural leaf-card trees and palms (js/vegetation.js)
  const group = new THREE.Group();
  group.name = 'All1231Trees';

  const bySpecies = {};
  for (const t of trees) {
    const sp = t.species || 'neem';
    if (!bySpecies[sp]) bySpecies[sp] = [];
    bySpecies[sp].push(t);
  }

  const dummy = new THREE.Object3D();

  // Helper: build a gracefully arching multi-segment pinnate palm frond
  function makeArchingFrondGeometries(length, riseAngle, droopRate, yTop) {
    const segs = 4;
    const segLen = length / segs;
    const parts = [];
    let curY = 0;
    let curZ = 0.18;
    let pitch = -riseAngle; // Negative X rotation tilts upward as +Z extends outward

    for (let s = 0; s < segs; s++) {
      const w = (1 - s * 0.18) * 0.72;
      // Left and right V-angled pinnate leaflet blades
      for (const side of [-1, 1]) {
        const blade = new THREE.BoxGeometry(w * 0.52, 0.025, segLen * 0.96);
        blade.rotateZ(side * 0.28);
        blade.translate(side * w * 0.22, 0, segLen * 0.48);
        blade.rotateX(pitch);
        blade.translate(0, yTop + curY, curZ);
        parts.push(blade);
      }
      curY += -Math.sin(pitch) * segLen;
      curZ += Math.cos(pitch) * segLen;
      pitch += droopRate;
    }
    return parts;
  }

  // Helper: build a forked trunk with angled upper limbs
  function makeBranchedTrunkGeometry(baseH, baseR, topR, branches) {
    const parts = [];
    const base = new THREE.CylinderGeometry(topR, baseR, baseH, 7);
    base.translate(0, baseH * 0.5, 0);
    parts.push(base);

    for (const [bx, by, bz, br, blen] of branches) {
      const limb = new THREE.CylinderGeometry(br * 0.65, br, blen, 6);
      limb.translate(0, blen * 0.5, 0);
      limb.rotateZ(-bx * 0.55);
      limb.rotateX(bz * 0.55);
      limb.translate(0, by, 0);
      parts.push(limb);
    }
    return mergeGeometries(parts, false);
  }

  for (const [species, list] of Object.entries(bySpecies)) {
    const count = list.length;
    if (species === 'datePalm' || species === 'washingtonia') {
      // Date Palm & Washingtonia: ringed tapering trunk + date clusters + 16 multi-segment arching fronds in 3 tiers
      const isWash = species === 'washingtonia';
      const trunkH = isWash ? 9.2 : 6.6;
      const tLower = new THREE.CylinderGeometry(0.21, 0.32, trunkH * 0.55, 8);
      tLower.translate(0, trunkH * 0.275, 0);
      const tUpper = new THREE.CylinderGeometry(0.16, 0.21, trunkH * 0.45, 8);
      tUpper.translate(0, trunkH * 0.775, 0);
      const collar = new THREE.CylinderGeometry(0.28, 0.18, 0.55, 8);
      collar.translate(0, trunkH - 0.15, 0);
      const trunkGeo = mergeGeometries([tLower, tUpper, collar], false);

      const frondParts = [];
      const fLen = isWash ? 2.5 : 3.35;
      // 3 tiers: lower drooping (6), middle wide-arching (6), upper rising (4)
      const tiers = [
        { n: 6, rise: 0.08, droop: 0.28, yOff: -0.15, rotOff: 0.0 },
        { n: 6, rise: 0.38, droop: 0.24, yOff: 0.02, rotOff: Math.PI / 6 },
        { n: 4, rise: 0.68, droop: 0.18, yOff: 0.16, rotOff: Math.PI / 4 },
      ];
      for (const tier of tiers) {
        for (let i = 0; i < tier.n; i++) {
          const angle = tier.rotOff + (i / tier.n) * Math.PI * 2;
          const segs = makeArchingFrondGeometries(fLen, tier.rise, tier.droop, trunkH + tier.yOff);
          for (const sg of segs) {
            sg.rotateY(angle);
            frondParts.push(sg);
          }
        }
      }
      const crownGeo = mergeGeometries(frondParts, false);

      const trunkInst = new THREE.InstancedMesh(trunkGeo, mats.palmTrunk, count);
      const crownInst = new THREE.InstancedMesh(crownGeo, mats.leafPalm, count);
      trunkInst.castShadow = true;
      crownInst.castShadow = true;

      list.forEach((t, i) => {
        const s = Math.max(0.78, Math.min(1.32, (t.radius || 2.8) / 2.8));
        dummy.position.set(t.wx, 0, t.wz);
        dummy.rotation.set(0, (i * 1.7) % (Math.PI * 2), 0);
        dummy.scale.set(s, s * (0.92 + (i % 5) * 0.04), s); dummy.scale.multiplyScalar(sizeScale);
        dummy.updateMatrix();
        trunkInst.setMatrixAt(i, dummy.matrix);
        crownInst.setMatrixAt(i, dummy.matrix);
      });
      group.add(trunkInst);
      group.add(crownInst);
    } else if (species === 'flameTree') {
      // Royal Poinciana (Flame Tree): Y-forked spreading limbs + wide flat layered umbrella canopy + bright red-orange blossom pads
      const trunkGeo = makeBranchedTrunkGeometry(2.1, 0.28, 0.2, [
        [0.85, 1.85, 0.55, 0.13, 2.1],
        [-0.85, 1.85, 0.45, 0.13, 2.0],
        [0.45, 1.9, -0.85, 0.12, 2.05],
        [-0.55, 1.9, -0.75, 0.12, 1.95],
      ]);

      // Wide flat layered umbrella foliage pads
      const greenPads = [];
      const padSpecs = [
        [0.0, 3.55, 0.0, 1.95, 0.28, 1.95],
        [1.05, 3.72, 0.65, 1.45, 0.25, 1.45],
        [-1.05, 3.68, 0.55, 1.45, 0.25, 1.45],
        [0.55, 3.78, -1.0, 1.4, 0.25, 1.4],
        [-0.65, 3.75, -0.9, 1.35, 0.25, 1.35],
        [0.0, 4.05, 0.0, 1.55, 0.24, 1.55],
      ];
      for (const [px, py, pz, sx, sy, sz] of padSpecs) {
        const g = new THREE.IcosahedronGeometry(1.0, 2);
        g.scale(sx, sy, sz);
        g.translate(px, py, pz);
        greenPads.push(g);
      }
      const greenGeo = mergeGeometries(greenPads, false);

      // Flat red-orange blossom clusters crowning the wide umbrella canopy
      const blossomPads = [];
      const bSpecs = [
        [0.0, 4.26, 0.0, 1.5, 0.2, 1.5],
        [1.1, 3.95, 0.65, 1.15, 0.18, 1.15],
        [-1.08, 3.92, 0.55, 1.15, 0.18, 1.15],
        [0.55, 4.0, -1.02, 1.1, 0.18, 1.1],
        [-0.68, 3.96, -0.92, 1.1, 0.18, 1.1],
        [0.35, 4.35, 0.35, 0.95, 0.18, 0.95],
      ];
      for (const [bx, by, bz, sx, sy, sz] of bSpecs) {
        const b = new THREE.IcosahedronGeometry(1.0, 2);
        b.scale(sx, sy, sz);
        b.translate(bx, by, bz);
        blossomPads.push(b);
      }
      const blossomGeo = mergeGeometries(blossomPads, false);

      const trunkInst = new THREE.InstancedMesh(trunkGeo, mats.trunkBark, count);
      const greenInst = new THREE.InstancedMesh(greenGeo, mats.leafFlameGreen, count);
      const blossomInst = new THREE.InstancedMesh(blossomGeo, mats.leafFlameBlossom, count);
      trunkInst.castShadow = true;
      greenInst.castShadow = true;
      blossomInst.castShadow = true;

      list.forEach((t, i) => {
        const r = Math.max(1.8, t.radius || 2.8);
        const s = r / 2.35;
        dummy.position.set(t.wx, 0, t.wz);
        dummy.rotation.set(0, (i * 2.3) % (Math.PI * 2), 0);
        dummy.scale.set(s, 0.88 + s * 0.22, s); dummy.scale.multiplyScalar(sizeScale);
        dummy.updateMatrix();
        trunkInst.setMatrixAt(i, dummy.matrix);
        greenInst.setMatrixAt(i, dummy.matrix);
        blossomInst.setMatrixAt(i, dummy.matrix);
      });
      group.add(trunkInst);
      group.add(greenInst);
      group.add(blossomInst);
    } else if (species === 'frangipani') {
      // Small Flowering Frangipani (Plumeria): low sculptural multi-branched tree with green leaf clusters & white-cream blossoms
      const trunkGeo = makeBranchedTrunkGeometry(1.35, 0.16, 0.12, [
        [0.65, 1.15, 0.4, 0.08, 1.15],
        [-0.6, 1.15, 0.35, 0.08, 1.1],
        [0.0, 1.2, -0.65, 0.08, 1.1],
      ]);

      const leafClusters = [];
      const flClusters = [];
      for (const [cx, cy, cz, r] of [
        [0.0, 2.35, 0.0, 0.85],
        [0.68, 2.15, 0.42, 0.72],
        [-0.65, 2.12, 0.38, 0.72],
        [0.05, 2.18, -0.68, 0.72],
      ]) {
        const lc = new THREE.IcosahedronGeometry(r, 2);
        lc.scale(1.15, 0.55, 1.15);
        lc.translate(cx, cy, cz);
        leafClusters.push(lc);

        const fc = new THREE.IcosahedronGeometry(r * 0.52, 1);
        fc.scale(1.1, 0.42, 1.1);
        fc.translate(cx * 1.05, cy + 0.24, cz * 1.05);
        flClusters.push(fc);
      }

      const trunkInst = new THREE.InstancedMesh(trunkGeo, mats.trunkBark, count);
      const leafInst = new THREE.InstancedMesh(mergeGeometries(leafClusters, false), mats.leafFrangipani, count);
      const flowerInst = new THREE.InstancedMesh(mergeGeometries(flClusters, false), mats.flowerFrangipani, count);
      trunkInst.castShadow = true;
      leafInst.castShadow = true;

      list.forEach((t, i) => {
        const s = Math.max(0.85, (t.radius || 1.8) / 1.8);
        dummy.position.set(t.wx, 0, t.wz);
        dummy.rotation.set(0, (i * 1.9) % (Math.PI * 2), 0);
        dummy.scale.set(s, s, s); dummy.scale.multiplyScalar(sizeScale);
        dummy.updateMatrix();
        trunkInst.setMatrixAt(i, dummy.matrix);
        leafInst.setMatrixAt(i, dummy.matrix);
        flowerInst.setMatrixAt(i, dummy.matrix);
      });
      group.add(trunkInst);
      group.add(leafInst);
      group.add(flowerInst);
    } else {
      // Rounded Neem, Desert Ghaf & Silvery Mediterranean Olive: multi-forked trunk + 7-lobed organic cloud crown
      const isOlive = species === 'olive';
      const leafMat = isOlive ? mats.leafOlive : species === 'ghaf' ? mats.leafGhaf : mats.leafNeem;
      const baseH = isOlive ? 1.75 : 2.35;

      const trunkGeo = makeBranchedTrunkGeometry(baseH, isOlive ? 0.22 : 0.25, 0.16, [
        [0.65, baseH - 0.2, 0.45, 0.11, 1.55],
        [-0.65, baseH - 0.2, 0.35, 0.11, 1.5],
        [0.1, baseH - 0.15, -0.68, 0.11, 1.5],
      ]);

      const crownY = baseH + 1.15;
      const lobes = [];
      const lobeSpecs = isOlive
        ? [
            [0.0, crownY + 0.2, 0.0, 1.15, 0.48, 1.15],
            [0.82, crownY - 0.05, 0.48, 0.88, 0.42, 0.88],
            [-0.82, crownY - 0.08, 0.42, 0.86, 0.42, 0.86],
            [0.25, crownY - 0.02, -0.82, 0.88, 0.42, 0.88],
            [-0.45, crownY + 0.15, -0.55, 0.78, 0.4, 0.78],
          ]
        : [
            [0.0, crownY + 0.45, 0.0, 1.18, 0.72, 1.18],
            [0.78, crownY + 0.05, 0.52, 0.92, 0.62, 0.92],
            [-0.78, crownY + 0.02, 0.45, 0.9, 0.62, 0.9],
            [0.45, crownY + 0.08, -0.75, 0.88, 0.6, 0.88],
            [-0.52, crownY + 0.04, -0.68, 0.85, 0.58, 0.85],
            [0.25, crownY + 0.72, 0.2, 0.82, 0.52, 0.82],
          ];

      for (const [lx, ly, lz, sx, sy, sz] of lobeSpecs) {
        const g = new THREE.IcosahedronGeometry(1.0, 2);
        g.scale(sx, sy, sz);
        g.translate(lx, ly, lz);
        lobes.push(g);
      }
      const canopyGeo = mergeGeometries(lobes, false);

      const trunkInst = new THREE.InstancedMesh(trunkGeo, mats.trunkBark, count);
      const canopyInst = new THREE.InstancedMesh(canopyGeo, leafMat, count);
      trunkInst.castShadow = true;
      canopyInst.castShadow = true;

      list.forEach((t, i) => {
        const r = Math.max(1.5, t.radius || 2.4);
        const s = r / 2.15;
        dummy.position.set(t.wx, 0, t.wz);
        dummy.rotation.set(0, (i * 1.9) % (Math.PI * 2), 0);
        dummy.scale.set(s, 0.88 + s * 0.22, s); dummy.scale.multiplyScalar(sizeScale);
        dummy.updateMatrix();
        trunkInst.setMatrixAt(i, dummy.matrix);
        canopyInst.setMatrixAt(i, dummy.matrix);
      });
      group.add(trunkInst);
      group.add(canopyInst);
    }
  }

  return group;
}

// ============================================================================
// HELPER: AMENITY PROPS, BRIDGES, CARS & SURROUNDING VALLEY CONTEXT
// ============================================================================
function createArchedTimberBridge(mats) {
  const g = new THREE.Group();
  const segments = 10;
  const span = 11.0;
  const width = 2.8;
  for (let i = 0; i < segments; i++) {
    const t = (i + 0.5) / segments - 0.5;
    const x = t * span;
    const y = Math.cos(t * Math.PI) * 1.15;
    const deck = new THREE.Mesh(new THREE.BoxGeometry(span / segments + 0.08, 0.16, width), mats.walnutWood);
    deck.position.set(x, y, 0);
    deck.rotation.z = -Math.sin(t * Math.PI) * 0.24;
    deck.castShadow = true;
    g.add(deck);

    // Timber slat railings on both sides (matching 04_Cycle_and_jogging_path.jpg)
    for (const side of [-width * 0.46, width * 0.46]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.1, 0.08), mats.walnutWood);
      post.position.set(x, y + 0.55, side);
      g.add(post);
    }
  }
  return g;
}

function createPoolDeckFurniture(mats) {
  const g = new THREE.Group();
  // 8 pairs of loungers + pink resort umbrellas along the east side of the pool (04_Community_Centre_pool.jpg)
  for (let i = -3; i <= 3; i++) {
    const z = i * 3.4;
    const x = 6.6;
    const l1 = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.32, 0.72), mats.fabricCream);
    l1.position.set(x, 0.18, z - 0.65);
    l1.castShadow = true;
    g.add(l1);

    const l2 = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.32, 0.72), mats.fabricCream);
    l2.position.set(x, 0.18, z + 0.65);
    l2.castShadow = true;
    g.add(l2);

    if (i % 2 === 0) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.5, 8), mats.darkMetal);
      pole.position.set(x + 0.2, 1.25, z);
      g.add(pole);
      const umb = new THREE.Mesh(new THREE.ConeGeometry(1.85, 0.55, 12, 1, true), mats.umbrellaPink);
      umb.position.set(x + 0.2, 2.45, z);
      umb.castShadow = true;
      g.add(umb);
    }
  }
  return g;
}

function createEntranceGatePortal(mats) {
  const g = new THREE.Group();
  // Overhanging modern gatehouse canopy spanning both entry and exit lanes
  const canopy = new THREE.Mesh(new THREE.BoxGeometry(18.5, 0.45, 4.8), mats.wallWhite);
  canopy.position.set(0, 4.2, 0);
  canopy.castShadow = true;
  g.add(canopy);

  // Dual Boom Barriers (red & white bars)
  for (const dir of [-1, 1]) {
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.45, 1.1, 0.45), mats.darkMetal);
    box.position.set(dir * 3.2, 0.55, 1.2);
    g.add(box);
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 4.2, 8), mats.leafFlameBlossom);
    bar.rotation.z = Math.PI / 2;
    bar.position.set(dir * 5.3, 0.95, 1.2);
    g.add(bar);
  }

  // Feature signage wall
  const signWall = new THREE.Mesh(new THREE.BoxGeometry(5.5, 1.6, 0.45), mats.wallAstonTaupe);
  signWall.position.set(0, 0.8, -5.5);
  signWall.castShadow = true;
  g.add(signWall);
  return g;
}

export function createPocketParkPlayArea(mats) {
  const g = new THREE.Group();
  // Shade sail + stepping logs (04_Nara_Hero_single-row_homes.jpg) + climbing frame
  const sail = new THREE.Mesh(new THREE.ConeGeometry(4.5, 1.1, 4), mats.wallOffWhite);
  sail.position.set(0, 3.6, 0);
  sail.rotation.y = Math.PI / 4;
  sail.castShadow = true;
  g.add(sail);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const stump = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.34, 0.25 + (i % 3) * 0.1, 10), mats.walnutWood);
    stump.position.set(Math.cos(a) * 2.2, 0.15, Math.sin(a) * 2.2);
    stump.castShadow = true;
    g.add(stump);
  }
  return g;
}

export function createFitnessStation(mats) {
  const g = new THREE.Group();
  for (let i = -1; i <= 1; i++) {
    const rack = new THREE.Mesh(new THREE.BoxGeometry(1.6, 2.2, 1.2), mats.darkMetal);
    rack.position.set(i * 3.2, 1.1, 0);
    rack.castShadow = true;
    g.add(rack);
  }
  return g;
}

export function createPicnicPergola(mats) {
  const g = new THREE.Group();
  const roof = new THREE.Mesh(new THREE.BoxGeometry(6.5, 0.22, 4.2), mats.walnutWood);
  roof.position.set(0, 3.1, 0);
  roof.castShadow = true;
  g.add(roof);
  for (const [px, pz] of [[-2.9, -1.8], [2.9, -1.8], [-2.9, 1.8], [2.9, 1.8]]) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.18, 3.1, 0.18), mats.darkMetal);
    p.position.set(px, 1.55, pz);
    g.add(p);
  }
  const table = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.76, 1.2), mats.walnutWood);
  table.position.set(0, 0.38, 0);
  g.add(table);
  return g;
}

export function createCommunityGardenFeatures(mats) {
  const g = new THREE.Group();
  // Raised wooden planter beds & hammocks (04_Landscape_hammocks.jpg)
  for (let i = -1; i <= 1; i++) {
    const bed = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.45, 1.6), mats.walnutWood);
    bed.position.set(i * 4.8, 0.22, 0);
    g.add(bed);
    const bush = new THREE.Mesh(new THREE.BoxGeometry(3.3, 0.35, 1.3), mats.shrubGreen);
    bush.position.set(i * 4.8, 0.55, 0);
    g.add(bush);
  }
  return g;
}

export function createCarTemplates(mats) {
  // Shaped car bodies (SUV and sedan side profiles, extruded with rounded edges), tinted glass
  // greenhouse, wheels with alloy rims, head and tail lights. Car is 4.6 m long along z, 1.85 m wide.
  const glassMat = new THREE.MeshPhysicalMaterial({ color: 0x1b232b, roughness: 0.08, metalness: 0.2, clearcoat: 1, transparent: true, opacity: 0.88 });
  const tyreMat = new THREE.MeshStandardMaterial({ color: 0x18181b, roughness: 0.9 });
  const rimMat = new THREE.MeshStandardMaterial({ color: 0xc7ccd1, roughness: 0.25, metalness: 0.9 });
  const headMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, emissive: 0xfff4d6, emissiveIntensity: 0.4, roughness: 0.2 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x991b1b, emissive: 0x7f1d1d, emissiveIntensity: 0.35, roughness: 0.3 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.6 });
  // side profiles in (z, y): front at +z
  const SUV = [[2.3, 0.42], [2.32, 0.78], [2.15, 0.98], [1.25, 1.06], [0.85, 1.68], [-1.55, 1.74], [-2.2, 1.62], [-2.3, 1.05], [-2.3, 0.42]];
  const SEDAN = [[2.3, 0.4], [2.33, 0.7], [2.05, 0.86], [1.05, 0.98], [0.5, 1.42], [-1.0, 1.46], [-1.75, 1.08], [-2.28, 1.0], [-2.3, 0.4]];
  const GLASS_SUV = [[1.2, 1.08], [0.82, 1.62], [-1.5, 1.68], [-2.12, 1.58], [-2.15, 1.1]];
  const GLASS_SEDAN = [[1.0, 1.0], [0.48, 1.38], [-0.98, 1.42], [-1.62, 1.08]];
  function extrude(profile, width, bevel, mat) {
    const sh = new THREE.Shape(profile.map(([z, y]) => new THREE.Vector2(z, y)));
    const g = new THREE.ExtrudeGeometry(sh, { depth: width - 2 * bevel, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 6 });
    g.translate(0, 0, -(width - 2 * bevel) / 2);
    g.rotateY(Math.PI / 2); // profile z -> world z, extrusion -> world x
    const m = new THREE.Mesh(g, mat);
    m.castShadow = true;
    return m;
  }
  const wheelGeo = new THREE.CylinderGeometry(0.36, 0.36, 0.26, 20).rotateZ(Math.PI / 2);
  const rimGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.28, 14).rotateZ(Math.PI / 2);
  const colors = [0xf8fafc, 0xcbd5e1, 0x111827, 0x334155, 0x7f1d1d, 0x1e3a5f, 0xd6cfc4];
  return colors.map((hex, ci) => {
    const suv = ci % 2 === 0;
    const car = new THREE.Group();
    const body = new THREE.MeshPhysicalMaterial({ color: hex, roughness: 0.28, metalness: 0.6, clearcoat: 1, clearcoatRoughness: 0.12 });
    car.add(extrude(suv ? SUV : SEDAN, 1.86, 0.12, body));
    car.add(extrude(suv ? GLASS_SUV : GLASS_SEDAN, 1.9, 0.06, glassMat));
    for (const [wx, wz] of [[-0.86, -1.42], [0.86, -1.42], [-0.86, 1.45], [0.86, 1.45]]) {
      const t = new THREE.Mesh(wheelGeo, tyreMat);
      t.position.set(wx, 0.36, wz);
      t.castShadow = true;
      car.add(t);
      const r = new THREE.Mesh(rimGeo, rimMat);
      r.position.set(wx, 0.36, wz);
      car.add(r);
    }
    for (const sx of [-0.62, 0.62]) {
      const hl = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.1, 0.06), headMat);
      hl.position.set(sx, suv ? 0.86 : 0.78, 2.33);
      car.add(hl);
      const tl = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.1, 0.06), tailMat);
      tl.position.set(sx, suv ? 1.0 : 0.92, -2.33);
      car.add(tl);
    }
    const grille = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.18, 0.05), trimMat);
    grille.position.set(0, suv ? 0.62 : 0.56, 2.34);
    car.add(grille);
    return car;
  });
}

function buildSurroundingValleyClusters(mats) {
  const g = new THREE.Group();
  g.name = 'SurroundingValleyContext';
  // Rotate a sub-group into Nara local map alignment (-37.49 deg) so Eden (north-west) and south/west clusters align with the satellite map
  const aligned = new THREE.Group();
  aligned.rotation.y = THREE.MathUtils.degToRad(37.49);
  g.add(aligned);

  const boxGeoms = [];
  // 1. Eden Community rows north of Nara (local z = -165 .. -320, local x = -260 .. +260)
  for (let rz = -175; rz >= -315; rz -= 38) {
    for (let rx = -240; rx <= 220; rx += 54) {
      const b = new THREE.BoxGeometry(42, 7.2, 11.5);
      b.translate(rx, 3.6, rz);
      boxGeoms.push(b);
    }
  }
  // 2. Southern neighbouring cluster rows (local z = +155 .. +295, local x = -220 .. +260)
  for (let rz = 160; rz <= 285; rz += 38) {
    for (let rx = -210; rx <= 240; rx += 54) {
      const b = new THREE.BoxGeometry(42, 7.2, 11.5);
      b.translate(rx, 3.6, rz);
      boxGeoms.push(b);
    }
  }
  // 3. Western cluster beyond the wadi park (local x = -375 .. -450, local z = -120 .. +110)
  for (let rx = -385; rx >= -445; rx -= 42) {
    for (let rz = -95; rz <= 95; rz += 48) {
      const b = new THREE.BoxGeometry(11.5, 7.2, 38);
      b.translate(rx, 3.6, rz);
      boxGeoms.push(b);
    }
  }

  if (boxGeoms.length > 0) {
    const merged = mergeGeometries(boxGeoms, false);
    const mesh = new THREE.Mesh(merged, mats.contextBuilding);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    aligned.add(mesh);
  }
  return g;
}

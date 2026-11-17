import * as THREE from 'three';

/**
 * Performance layer for the modelled homes. Nothing here changes how a home looks.
 *
 * 1. Batching + per-home frustum culling
 *    Every exterior mesh of every home (shell, facade details, plot, garden, walls, cars) is moved
 *    into one THREE.BatchedMesh per material. Each piece stays an instance with its own matrix and
 *    visibility, so the GPU gets a handful of multi-draw calls instead of thousands, and three.js
 *    frustum-culls every instance individually, for the camera and for the sun's shadow camera.
 *    Nara's code keeps working: `rec.shellGroup.visible = false` (entering a home) is mapped onto
 *    that home's batch instances.
 *
 * 2. Occlusion culling (street level and inside a home)
 *    Each row of homes has a GPU occlusion query (WebGL2 ANY_SAMPLES_PASSED_CONSERVATIVE) drawn
 *    with its bounding box, inflated by 2 m sideways and 0.3 m up, against the frame's depth buffer. A row is skipped only
 *    after 4 consecutive "fully hidden" answers and comes back on the first "visible" answer; the
 *    inflated box answers "visible" before the row itself reaches the screen, so rows never pop in.
 *    Hidden rows still cast shadows (the shadow pass ignores occlusion).
 */
export function optimiseNaraWorld(community) {
  const t0 = performance.now();
  const homes = community.homesGroup;
  homes.updateMatrixWorld(true);

  // ---- collect exterior meshes per home --------------------------------------------------------
  const buckets = new Map(); // key -> { material, cast, receive, items: [{geometry, matrix, unitNo, part}] }
  let meshesBefore = 0;
  const removals = [];
  for (const [unitNo, rec] of community.unitRecords) {
    for (const [part, grp] of [['shell', rec.shellGroup], ['plot', rec.plotGroup]]) {
      grp.traverse((o) => {
        if (!o.isMesh || o.isInstancedMesh || o.isBatchedMesh || Array.isArray(o.material)) return;
        if (o.material.transparent && o.material.opacity === 0) return;
        meshesBefore++;
        const key = `${o.material.uuid}|${o.castShadow ? 1 : 0}${o.receiveShadow ? 1 : 0}`;
        let b = buckets.get(key);
        if (!b) buckets.set(key, (b = { material: o.material, cast: o.castShadow, receive: o.receiveShadow, items: [] }));
        b.items.push({ geometry: o.geometry, matrix: o.matrixWorld.clone(), unitNo, part }); // made local below
        removals.push(o);
      });
    }
  }

  // ---- build one BatchedMesh per bucket --------------------------------------------------------
  // The batch is anchored at the community's centre and instance matrices are stored relative to
  // it: Nara lies ~16 km from the world origin, and 32-bit instance matrices that far out would
  // lose the millimetres that separate stacked paving layers (they would z-fight differently).
  const anchor = new THREE.Vector3();
  let nAnchor = 0;
  for (const rec of community.unitRecords.values()) { anchor.x += rec.unit.wx; anchor.z += rec.unit.wz; nAnchor++; }
  anchor.divideScalar(Math.max(1, nAnchor));
  anchor.set(Math.round(anchor.x), 0, Math.round(anchor.z));
  const toLocal = new THREE.Matrix4().makeTranslation(-anchor.x, 0, -anchor.z);
  const batchGroup = new THREE.Group();
  batchGroup.name = 'HomesBatched';
  batchGroup.position.copy(anchor);
  homes.parent.add(batchGroup);
  const unitInstances = new Map(); // unitNo -> { shell: [[batch, id]], plot: [[batch, id]] }
  const batches = [];
  const normCache = new Map();
  for (const b of buckets.values()) {
    // One batch item per home and part (shell / plot) instead of one per piece: each home's pieces of
    // this material are merged into one geometry, positions and normals transformed exactly as the
    // batching shader transformed them (same picture). Chrome on Mac (ANGLE/Metal) issues every batch
    // item as its own draw, so 51,121 pieces were 51,121 draws per pass; now it is ~1 per home.
    const groups = new Map(); // `${unitNo}|${part}` -> items
    for (const it of b.items) {
      const k = `${it.unitNo}|${it.part}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(it);
    }
    const merged = [];
    let verts = 0, idx = 0;
    for (const [k, items] of groups) {
      const g = mergeHomeParts(items.map((it) => ({ geo: normaliseGeometry(it.geometry, normCache), matrix: it.matrix.premultiply(toLocal) })));
      const [unitNo, part] = k.split('|');
      merged.push({ g, unitNo: items[0].unitNo, part });
      verts += g.attributes.position.count;
      idx += g.index.count;
    }
    const batch = new THREE.BatchedMesh(merged.length, verts, idx, b.material);
    batch.castShadow = b.cast;
    batch.receiveShadow = b.receive;
    batch.perObjectFrustumCulled = true;
    batch.sortObjects = !b.material.transparent;
    for (const m of merged) {
      const id = batch.addInstance(batch.addGeometry(m.g)); // identity matrix: geometry is already placed
      let u = unitInstances.get(m.unitNo);
      if (!u) unitInstances.set(m.unitNo, (u = { shell: [], plot: [] }));
      u[m.part].push([batch, id]);
    }
    batch.computeBoundingBox();
    batch.computeBoundingSphere();
    batchGroup.add(batch);
    batches.push(batch);
  }
  for (const o of removals) o.parent.remove(o);

  // ---- per-home visibility: shell toggles (Nara) + occlusion (rows) ------------------------------
  const shellVisible = new Map();
  const occluded = new Set(); // unitNo hidden by occlusion
  function applyUnit(unitNo, forShadow) {
    const u = unitInstances.get(unitNo);
    if (!u) return;
    const occ = !forShadow && occluded.has(unitNo);
    const shell = shellVisible.get(unitNo) !== false;
    for (const [batch, id] of u.shell) batch.setVisibleAt(id, shell && !occ);
    for (const [batch, id] of u.plot) batch.setVisibleAt(id, !occ);
  }
  for (const [unitNo, rec] of community.unitRecords) {
    shellVisible.set(unitNo, true);
    Object.defineProperty(rec.shellGroup, 'visible', {
      configurable: true,
      get: () => shellVisible.get(unitNo) !== false,
      set: (v) => { shellVisible.set(unitNo, !!v); applyUnit(unitNo, false); },
    });
  }

  // shadow pass sees every home; the main pass hides occluded rows
  let shadowState = false;
  for (const batch of batches) {
    const orig = batch.onBeforeRender.bind(batch);
    batch.onBeforeRender = function (renderer, scene, camera, geometry, material, group) {
      const forShadow = scene === null;
      if (occluded.size && forShadow !== shadowState) {
        shadowState = forShadow;
        for (const n of occluded) applyUnit(n, forShadow);
      }
      return orig(renderer, scene, camera, geometry, material, group);
    };
  }

  // the pick boxes / overlays only draw when they show something
  const origUpdate = community.updateUnitVisualStates;
  community.updateUnitVisualStates = (opts) => {
    origUpdate(opts);
    for (const rec of community.unitRecords.values()) {
      rec.highlightMesh.visible = rec.highlightMesh.material.opacity > 0.001;
    }
  };
  for (const rec of community.unitRecords.values()) rec.highlightMesh.visible = false;

  // ---- row chunks for occlusion --------------------------------------------------------------------
  const rows = new Map();
  for (const [unitNo, rec] of community.unitRecords) {
    const key = rec.unit.row;
    let r = rows.get(key);
    if (!r) rows.set(key, (r = { key, units: [], box: new THREE.Box3() }));
    r.units.push(unitNo);
  }
  const tmpBox = new THREE.Box3();
  const m4 = new THREE.Matrix4();
  for (const r of rows.values()) {
    for (const n of r.units) {
      const u = unitInstances.get(n);
      for (const [batch, id] of [...u.shell, ...u.plot]) {
        const gid = batch.getGeometryIdAt(id);
        batch.getBoundingBoxAt(gid, tmpBox);
        batch.getMatrixAt(id, m4);
        r.box.union(tmpBox.applyMatrix4(m4).translate(anchor));
      }
    }
    // 2 m around the row, only 0.3 m above the roofs so a row never 'peeks' over the row in front
    r.box.expandByVector(new THREE.Vector3(2.0, 0.3, 2.0));
  }

  let instances = 0;
  for (const b of batches) instances += b.instanceCount;
  const stats = { meshesBefore, batches: batches.length, instances, rows: rows.size, ms: Math.round(performance.now() - t0) };
  return { batches, batchGroup, rows: [...rows.values()], occluded, applyUnit, stats, shadowReset: () => { shadowState = false; } };
}

/**
 * Merge one home's pieces (normalised: indexed position / normal / uv) into one geometry in batch space.
 * Normals use the batching shader's own transform (matrix columns divided by their squared length), and
 * triangle order is kept, so the merged home renders exactly like its separate instances did.
 */
function mergeHomeParts(parts) {
  let nv = 0, ni = 0;
  for (const { geo } of parts) { nv += geo.attributes.position.count; ni += geo.index.count; }
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  const index = new Uint32Array(ni);
  let ov = 0, oi = 0;
  for (const { geo, matrix } of parts) {
    const e = matrix.elements;
    const s0 = e[0] * e[0] + e[1] * e[1] + e[2] * e[2], s1 = e[4] * e[4] + e[5] * e[5] + e[6] * e[6], s2 = e[8] * e[8] + e[9] * e[9] + e[10] * e[10];
    const P = geo.attributes.position, N = geo.attributes.normal, T = geo.attributes.uv, I = geo.index;
    for (let i = 0; i < P.count; i++) {
      const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
      const j = (ov + i) * 3;
      pos[j] = e[0] * x + e[4] * y + e[8] * z + e[12];
      pos[j + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      pos[j + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
      const nx = N.getX(i) / s0, ny = N.getY(i) / s1, nz = N.getZ(i) / s2;
      let a = e[0] * nx + e[4] * ny + e[8] * nz, b = e[1] * nx + e[5] * ny + e[9] * nz, c = e[2] * nx + e[6] * ny + e[10] * nz;
      const l = Math.hypot(a, b, c) || 1;
      nor[j] = a / l; nor[j + 1] = b / l; nor[j + 2] = c / l;
      uv[(ov + i) * 2] = T.getX(i);
      uv[(ov + i) * 2 + 1] = T.getY(i);
    }
    for (let i = 0; i < I.count; i++) index[oi + i] = I.getX(i) + ov;
    ov += P.count;
    oi += I.count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  return g;
}

/** Make a geometry batch-compatible: indexed, with exactly position / normal / uv. */
export function normaliseGeometry(src, cache) {
  if (cache.has(src)) return cache.get(src);
  const g = new THREE.BufferGeometry();
  const pos = src.getAttribute('position');
  g.setAttribute('position', pos);
  if (src.getAttribute('normal')) g.setAttribute('normal', src.getAttribute('normal'));
  else { g.computeVertexNormals(); }
  if (!g.getAttribute('normal')) { const t = src.clone(); t.computeVertexNormals(); g.setAttribute('normal', t.getAttribute('normal')); }
  const uv = src.getAttribute('uv');
  g.setAttribute('uv', uv && uv.itemSize === 2 && !uv.normalized ? uv : new THREE.Float32BufferAttribute(new Float32Array(pos.count * 2), 2));
  if (src.index) g.setIndex(src.index);
  else {
    const n = pos.count;
    const arr = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
    for (let i = 0; i < n; i++) arr[i] = i;
    g.setIndex(new THREE.BufferAttribute(arr, 1));
  }
  if (g.index.array instanceof Uint16Array) {
    // BatchedMesh concatenates indices; widen to 32-bit to be safe with large batches
    g.setIndex(new THREE.BufferAttribute(Uint32Array.from(g.index.array), 1));
  }
  cache.set(src, g);
  return g;
}

export function createOcclusionCuller(renderer, camera, opt) {
  const gl = renderer.getContext();
  const supported = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
  const scene = new THREE.Scene();
  const mat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: true, side: THREE.DoubleSide });
  const box = new THREE.BoxGeometry(1, 1, 1);
  const HIDE_AFTER = 4;
  const chunks = opt.rows.map((r) => {
    const m = new THREE.Mesh(box, mat);
    r.box.getCenter(m.position);
    r.box.getSize(m.scale);
    m.updateMatrixWorld();
    m.matrixAutoUpdate = false;
    const c = { row: r, mesh: m, query: null, pending: false, hiddenStreak: 0, hidden: false };
    m.onBeforeRender = () => {
      if (!c.query) c.query = gl.createQuery();
      gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE, c.query);
    };
    m.onAfterRender = () => {
      gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE);
      c.pending = true;
    };
    scene.add(m);
    return c;
  });
  let enabled = false;
  let forceOff = false;
  const stats = { total: chunks.length, culled: 0, enabled: false };
  const frustum = new THREE.Frustum();
  const projScreen = new THREE.Matrix4();

  function setHidden(c, hidden) {
    if (c.hidden === hidden) return;
    c.hidden = hidden;
    for (const n of c.row.units) {
      if (hidden) opt.occluded.add(n);
      else opt.occluded.delete(n);
      opt.applyUnit(n, false);
    }
  }

  function beforeRender(mode) {
    const want = supported && !forceOff && (mode === 'street' || mode === 'interior');
    if (want !== enabled) {
      enabled = want;
      stats.enabled = want;
      if (!want) for (const c of chunks) { setHidden(c, false); c.hiddenStreak = 0; }
    }
    opt.shadowReset();
    if (!enabled) return;
    // read finished queries (non-blocking)
    for (const c of chunks) {
      if (!c.pending) continue;
      if (!gl.getQueryParameter(c.query, gl.QUERY_RESULT_AVAILABLE)) continue;
      c.pending = false;
      const visible = gl.getQueryParameter(c.query, gl.QUERY_RESULT) > 0;
      if (visible) { c.hiddenStreak = 0; setHidden(c, false); }
      else if (++c.hiddenStreak >= HIDE_AFTER) setHidden(c, true);
    }
    // Off-screen rows are left to frustum culling and reset to visible, so a row turning into view
    // is never waiting on a stale "hidden" answer; a row around the camera is never hidden.
    camera.updateMatrixWorld();
    projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projScreen, camera.coordinateSystem, camera.reversedDepth);
    for (const c of chunks) {
      if (!frustum.intersectsBox(c.row.box) || c.row.box.containsPoint(camera.position)) { c.hiddenStreak = 0; setHidden(c, false); }
    }
    stats.culled = chunks.filter((c) => c.hidden).length;
  }

  function afterRender() {
    if (!enabled) return;
    // issue new queries only for rows without one in flight; off-screen boxes are frustum-culled
    for (const c of chunks) c.mesh.visible = !c.pending;
    renderer.render(scene, camera);
  }

  return { beforeRender, afterRender, stats, supported, setForceOff: (v) => { forceOff = v; } };
}

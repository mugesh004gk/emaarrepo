import * as THREE from 'three';

/**
 * "Only this community": everything outside the open community is covered with a calm, even ground
 * colour, so the satellite map of the rest of Dubai (other districts, roads, airfields, place names)
 * is not shown. The visible area follows where the community really is - a soft-edged region around
 * every home and project (homes within ~120 m fully clear, fading out by ~330 m) - drawn into a small
 * mask image, so separate clusters keep their own shape instead of one hard outline.
 *
 * The same mask tells the ground (js/ground.js) which satellite tiles it can skip entirely.
 */
// the surroundings: the base board of an architectural model - warm stone, a fine survey grid, faint
// contour lines and a thin teal line tracing the community's edge
const BASE = 0xe9e4d8, BASE_FAR = 0xd9d3c5, LINE = 0x9a9180, ACCENT = 0x16b8a6;
const CLEAR = 120; // m around a home/project that stay fully visible
const FADE = 330; // m where the cover is complete
const RES = 1024; // mask image size (long side)
const GRID = 64; // occupancy grid for skipping satellite tiles

export function createScopeMask(groundScene) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.flipY = false;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthTest: false, depthWrite: false, toneMapped: false, fog: false,
    uniforms: {
      mask: { value: tex },
      base: { value: new THREE.Color(BASE) },
      baseFar: { value: new THREE.Color(BASE_FAR) },
      line: { value: new THREE.Color(LINE) },
      accent: { value: new THREE.Color(ACCENT) },
      centre: { value: new THREE.Vector2() },
      radius: { value: 3000 },
    },
    vertexShader: `
      varying vec2 vUv; varying vec2 vWorld;
      void main() {
        vUv = uv;
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: `
      uniform sampler2D mask; uniform vec3 base, baseFar, line, accent; uniform vec2 centre; uniform float radius;
      varying vec2 vUv; varying vec2 vWorld;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
      float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int k = 0; k < 4; k++) { v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }
      // anti-aliased line every 'step' metres, fading out where lines get denser than the pixels
      float gridLine(vec2 p, float step, float width) {
        vec2 q = p / step; vec2 fw = fwidth(q);
        vec2 g = abs(fract(q - 0.5) - 0.5) / max(fw, 1e-5);
        float l = 1.0 - min(min(g.x, g.y) / width, 1.0);
        return l * (1.0 - smoothstep(0.08, 0.35, max(fw.x, fw.y)));
      }
      void main() {
        float m = texture2D(mask, vUv).g; // 1 = surroundings, 0 = the community itself
        if (m < 0.003) discard;
        float d = length(vWorld - centre) / radius;
        float n = fbm(vWorld * 0.0009);
        vec3 col = mix(base, baseFar, smoothstep(0.6, 3.5, d)) * (0.975 + 0.05 * n);
        float h = fbm(vWorld * 0.00055) * 14.0; // terrain contours
        float fh = fwidth(h);
        float dd = abs(fract(h + 0.5) - 0.5); // distance to the nearest contour level
        float contour = (1.0 - smoothstep(0.0, 1.5 * fh, dd)) * (1.0 - smoothstep(0.05, 0.4, fh));
        float grid = gridLine(vWorld, 50.0, 0.9) * 0.10 + gridLine(vWorld, 250.0, 1.2) * 0.20;
        col = mix(col, line, clamp(grid + contour * 0.10, 0.0, 0.45));
        float edge = smoothstep(0.28, 0.40, m) * (1.0 - smoothstep(0.40, 0.55, m)); // around the community
        col = mix(col, accent, edge * 0.55);
        gl_FragColor = vec4(col, m);
        #include <colorspace_fragment>
      }`,
  });
  const BIG = 400000;
  const geo = new THREE.PlaneGeometry(BIG, BIG).rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'CommunityMask';
  mesh.renderOrder = -20; // above the satellite tiles (-100..-60) and boundary lines, below nothing in the main scene
  mesh.frustumCulled = false;
  mesh.visible = false;
  groundScene.add(mesh);

  let area = null; // { minX, maxX, minZ, maxZ, grid: Uint8Array }

  /** points: [[x, z], ...] in world metres (homes and project positions). null = no mask. */
  function set(points) {
    if (!points || !points.length) { mesh.visible = false; area = null; return; }
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of points) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
    const pad = FADE + 80; // border pixels stay fully covered (the texture clamps to them)
    minX -= pad; maxX += pad; minZ -= pad; maxZ += pad;
    const span = Math.max(maxX - minX, maxZ - minZ);
    const W = Math.max(64, Math.round((RES * (maxX - minX)) / span)), H = Math.max(64, Math.round((RES * (maxZ - minZ)) / span));
    canvas.width = W; canvas.height = H;
    const sx = W / (maxX - minX), sz = H / (maxZ - minZ);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#fff'; // white = covered
    ctx.fillRect(0, 0, W, H);
    // clear (black) around every point, soft edge; thin out dense points (one per ~25 m cell)
    const seen = new Set();
    const r0 = CLEAR * sx, r1 = FADE * sx;
    for (const [x, z] of points) {
      const key = `${Math.round(x / 25)},${Math.round(z / 25)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const cx = (x - minX) * sx, cy = (z - minZ) * sz;
      const g = ctx.createRadialGradient(cx, cy, r0, cx, cy, r1);
      g.addColorStop(0, 'rgba(0,0,0,1)');
      g.addColorStop(0.55, 'rgba(0,0,0,0.55)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, r1, 0, Math.PI * 2);
      ctx.fill();
    }
    tex.needsUpdate = true;
    // plane UVs: the mask image spans [minX..maxX] x [minZ..maxZ]; beyond it the clamped white border covers
    const pos = geo.attributes.position, uv = geo.attributes.uv;
    for (let i = 0; i < pos.count; i++) uv.setXY(i, (pos.getX(i) - minX) / (maxX - minX), (pos.getZ(i) - minZ) / (maxZ - minZ));
    uv.needsUpdate = true;
    mesh.position.set(0, 0, 0);
    mat.uniforms.centre.value.set((minX + maxX) / 2, (minZ + maxZ) / 2);
    mat.uniforms.radius.value = Math.max(maxX - minX, maxZ - minZ) / 2;
    mesh.visible = true;
    // which parts of the area show any ground at all (for skipping satellite tiles)
    const data = ctx.getImageData(0, 0, W, H).data;
    const grid = new Uint8Array(GRID * GRID);
    for (let py = 0; py < H; py++) {
      const gy = Math.min(GRID - 1, Math.floor((py / H) * GRID));
      for (let px = 0; px < W; px++) {
        if (data[(py * W + px) * 4 + 1] < 250) grid[gy * GRID + Math.min(GRID - 1, Math.floor((px / W) * GRID))] = 1;
      }
    }
    area = { minX, maxX, minZ, maxZ, grid };
  }

  /** false when the box [x0..x1] x [z0..z1] lies entirely under the cover (its satellite tile is not needed) */
  function shows(x0, x1, z0, z1) {
    if (!area) return true;
    const { minX, maxX, minZ, maxZ, grid } = area;
    if (x1 < minX || x0 > maxX || z1 < minZ || z0 > maxZ) return false;
    const gx0 = Math.max(0, Math.floor(((x0 - minX) / (maxX - minX)) * GRID)), gx1 = Math.min(GRID - 1, Math.floor(((x1 - minX) / (maxX - minX)) * GRID));
    const gz0 = Math.max(0, Math.floor(((z0 - minZ) / (maxZ - minZ)) * GRID)), gz1 = Math.min(GRID - 1, Math.floor(((z1 - minZ) / (maxZ - minZ)) * GRID));
    for (let gz = gz0; gz <= gz1; gz++) for (let gx = gx0; gx <= gx1; gx++) if (grid[gz * GRID + gx]) return true;
    return false;
  }

  return { mesh, set, shows, get active() { return !!area; } };
}

/**
 * 3D buildings without WebGL: every home is drawn as an extruded block (walls + roof + parapet line)
 * on a plain 2D canvas over the Leaflet map, in perspective from a camera above the map centre
 * (the technique of the classic canvas 3D-building maps). Runs on the CPU, so it works on any device,
 * including laptops whose browser cannot start 3D graphics.
 *
 * Speed: only blocks inside the view are projected; blocks are sorted far-to-near once per frame;
 * redraws happen on map move/zoom, coalesced to one per animation frame.
 */
const SUN = [-0.55, -0.75]; // light from the south-east in screen terms (y down)

function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.round(((n >> 16) & 255) * k)), g = Math.min(255, Math.round(((n >> 8) & 255) * k)), b = Math.min(255, Math.round((n & 255) * k));
  return `rgb(${r},${g},${b})`;
}

export function createBlocks3D(L, map, blocks, { minZoom = 15, onClick } = {}) {
  // blocks: [{ ring: [[lat,lng]x4], height: m, color: '#rrggbb', ref }]
  const canvas = L.DomUtil.create('canvas', 'blocks3d-canvas');
  const pane = map.getPanes().overlayPane;
  pane.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  let queued = false;
  let drawn = []; // [{ roof: [[x,y]...], ref }] for hit tests, near-most last
  // precompute centres for culling
  for (const b of blocks) {
    b.cLat = b.ring.reduce((s, p) => s + p[0], 0) / b.ring.length;
    b.cLng = b.ring.reduce((s, p) => s + p[1], 0) / b.ring.length;
  }

  function draw() {
    queued = false;
    const size = map.getSize();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== size.x * dpr || canvas.height !== size.y * dpr) {
      canvas.width = size.x * dpr;
      canvas.height = size.y * dpr;
      canvas.style.width = size.x + 'px';
      canvas.style.height = size.y + 'px';
    }
    L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.x, size.y);
    drawn = [];
    const z = map.getZoom();
    if (z < minZoom) return;
    const bounds = map.getBounds().pad(0.15);
    const centre = map.getCenter();
    const mpp = (40075016.686 * Math.cos((centre.lat * Math.PI) / 180)) / (256 * Math.pow(2, z)); // metres per pixel
    const cx = size.x / 2, cy = size.y / 2;
    const camZ = Math.max(size.x, size.y) * 1.1; // camera height in pixels (perspective strength)
    const vis = [];
    for (const b of blocks) {
      if (!bounds.contains([b.cLat, b.cLng])) continue;
      const base = b.ring.map(([la, ln]) => { const p = map.latLngToContainerPoint([la, ln]); return [p.x, p.y]; });
      // bird's-eye view tilted toward the north: roofs rise up the screen (front walls show), with a
      // little perspective spread from the centre
      const h = Math.min((b.height * 1.35) / mpp, camZ * 0.5);
      const k = h / (camZ - h);
      const roof = base.map(([x, y]) => [x + (x - cx) * k * 0.35, y - h * 0.9 + (y - cy) * k * 0.15]);
      const by = base.reduce((s, p) => s + p[1], 0) / base.length;
      vis.push({ b, base, roof, d: by });
    }
    vis.sort((a, b) => a.d - b.d); // back (top of screen) first, front last
    ctx.lineJoin = 'round';
    for (const v of vis) {
      const { base, roof, b } = v;
      // walls: only the sides facing the viewer (outward normal pointing away from the centre)
      for (let i = 0; i < base.length; i++) {
        const j = (i + 1) % base.length;
        const ex = base[j][0] - base[i][0], ey = base[j][1] - base[i][1];
        const len = Math.hypot(ex, ey) || 1;
        // outward normal for a ring in either winding: test against the block centre
        let nx = ey / len, ny = -ex / len;
        const mx = (base[i][0] + base[j][0]) / 2, my = (base[i][1] + base[j][1]) / 2;
        const bcx = base.reduce((s, p) => s + p[0], 0) / base.length, bcy = base.reduce((s, p) => s + p[1], 0) / base.length;
        if ((mx - bcx) * nx + (my - bcy) * ny < 0) { nx = -nx; ny = -ny; }
        if (ny < -0.05) continue; // north-facing walls point away from the tilted camera
        const lit = 0.72 + 0.22 * Math.max(0, -(nx * SUN[0] + ny * SUN[1]));
        ctx.beginPath();
        ctx.moveTo(base[i][0], base[i][1]);
        ctx.lineTo(base[j][0], base[j][1]);
        ctx.lineTo(roof[j][0], roof[j][1]);
        ctx.lineTo(roof[i][0], roof[i][1]);
        ctx.closePath();
        ctx.fillStyle = shade(b.wall || b.color, lit);
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.12)';
        ctx.lineWidth = 0.6;
        ctx.stroke();
      }
      // roof with a parapet edge
      ctx.beginPath();
      roof.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.fillStyle = shade(b.color, 1.0);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1;
      ctx.stroke();
      drawn.push({ roof, base, ref: b.ref });
    }
  }
  const request = () => { if (!queued) { queued = true; requestAnimationFrame(draw); } };
  map.on('move zoom zoomend resize viewreset', request);
  request();

  function inside(x, y, poly) {
    let ins = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins;
    }
    return ins;
  }
  map.on('click', (e) => {
    const { x, y } = e.containerPoint;
    for (let i = drawn.length - 1; i >= 0; i--) {
      if (inside(x, y, drawn[i].roof) || inside(x, y, drawn[i].base)) { onClick?.(drawn[i].ref); return; }
    }
  });
  return { redraw: request, blocks };
}

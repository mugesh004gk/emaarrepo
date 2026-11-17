import * as THREE from 'three';

/**
 * Procedural PBR Texture & Material Library for Nara at The Valley
 * Matches the developer renders (04_Design_Aston/Palma/Charm, 04_Interior_*, 04_Community_Centre_pool, 04_Cycle_and_jogging_path)
 */
// Seeded generator (mulberry32): the procedural textures look the same on every load.
let seed = 0x2f6bd8;
function rand() {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function createMaterialLibrary(renderer) {
  seed = 0x2f6bd8;
  const maxAniso = renderer ? Math.min(8, renderer.capabilities.getMaxAnisotropy()) : 4;

  function makeCanvasTexture(w, h, drawFn, repeatX = 1, repeatY = 1) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    drawFn(ctx, w, h);
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeatX, repeatY);
    tex.anisotropy = maxAniso;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  // 1. Stucco / Fine architectural render texture
  const stuccoTex = makeCanvasTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#f5f3ee';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 6000; i++) {
      const x = rand() * w;
      const y = rand() * h;
      const v = 236 + Math.floor(rand() * 18);
      ctx.fillStyle = `rgb(${v},${v - 1},${v - 4})`;
      ctx.fillRect(x, y, 2, 2);
    }
  }, 2, 2);

  // 2. Road asphalt texture with subtle lane aggregate
  const asphaltTex = makeCanvasTexture(512, 512, (ctx, w, h) => {
    ctx.fillStyle = '#33363b';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 16000; i++) {
      const x = rand() * w;
      const y = rand() * h;
      const v = 42 + Math.floor(rand() * 24);
      ctx.fillStyle = `rgb(${v},${v + 1},${v + 3})`;
      ctx.fillRect(x, y, 2, 2);
    }
  }, 0.18, 0.18);

  // 3. Two-tone architectural block paving texture for driveways, sikkas, and footpaths (04_Design_Aston/Palma/Charm)
  const paverTex = makeCanvasTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#9e9b95';
    ctx.fillRect(0, 0, w, h);
    const rows = 12;
    const cols = 6;
    const bw = w / cols;
    const bh = h / rows;
    for (let r = 0; r < rows; r++) {
      const off = (r % 2) * (bw * 0.5);
      for (let c = -1; c <= cols; c++) {
        const x = c * bw + off;
        const y = r * bh;
        // Occasional lighter/darker accent blocks like in the brochure renders
        const pick = rand();
        const shade = pick < 0.15 ? 205 : pick < 0.35 ? 148 : 172 + Math.floor(rand() * 18);
        ctx.fillStyle = `rgb(${shade},${shade - 2},${shade - 5})`;
        ctx.fillRect(x + 1.5, y + 1.5, bw - 3, bh - 3);
      }
    }
  }, 0.75, 0.75);

  // 4. Lush irrigated lawn grass texture for gardens, parks, and sikkas
  const grassTex = makeCanvasTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#4a8536';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 11000; i++) {
      const x = rand() * w;
      const y = rand() * h;
      const g = 112 + Math.floor(rand() * 48);
      const r = Math.floor(g * 0.56);
      const b = Math.floor(g * 0.36);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(x, y, 2, 3);
    }
  }, 0.28, 0.28);

  // 4b. Pale crushed limestone gravel texture for sikkas and planting beds (04_Streetscape.jpg)
  const paleGravelTex = makeCanvasTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#e5e1d8';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 14000; i++) {
      const x = rand() * w;
      const y = rand() * h;
      const v = 195 + Math.floor(rand() * 52);
      ctx.fillStyle = `rgb(${v},${v - 2},${v - 6})`;
      ctx.fillRect(x, y, 2.2, 2.2);
    }
  }, 0.45, 0.45);

  // 4c. Ringed / diamond-patterned Date Palm trunk bark texture (04_Streetscape.jpg)
  const palmBarkTex = makeCanvasTexture(128, 256, (ctx, w, h) => {
    ctx.fillStyle = '#6e553e';
    ctx.fillRect(0, 0, w, h);
    const rings = 28;
    const rh = h / rings;
    for (let r = 0; r < rings; r++) {
      const y = r * rh;
      ctx.fillStyle = r % 2 === 0 ? '#58422f' : '#7d6249';
      ctx.fillRect(0, y, w, rh * 0.65);
      ctx.fillStyle = '#3e2d1e';
      ctx.fillRect(0, y + rh * 0.65, w, rh * 0.35);
    }
  }, 1, 2);

  // 4d. Warm lit interior window backing texture (curtains + warm chandelier glow seen through exterior windows)
  const windowBackingTex = makeCanvasTexture(256, 256, (ctx, w, h) => {
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#ead8b8');
    grad.addColorStop(0.45, '#d8c29d');
    grad.addColorStop(1, '#8c7a62');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    // Warm ceiling chandelier glow orbs
    ctx.fillStyle = 'rgba(255, 244, 214, 0.85)';
    for (const [cx, cy, r] of [[w * 0.45, h * 0.24, 9], [w * 0.55, h * 0.28, 7], [w * 0.38, h * 0.3, 6]]) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }
    // Sheer curtain panels on left and right edges
    ctx.fillStyle = 'rgba(244, 239, 228, 0.65)';
    ctx.fillRect(0, 0, w * 0.18, h);
    ctx.fillRect(w * 0.82, 0, w * 0.18, h);
  }, 1, 1);

  // 5. Desert sand texture (only for outer desert horizon outside the landscaped community)
  const sandTex = makeCanvasTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#dfd1ba';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 8000; i++) {
      const x = rand() * w;
      const y = rand() * h;
      const v = 205 + Math.floor(rand() * 30);
      ctx.fillStyle = `rgb(${v},${v - 14},${v - 32})`;
      ctx.fillRect(x, y, 2, 2);
    }
  }, 0.12, 0.12);

  // 6. Pool deck timber planks (04_Community_Centre_pool.jpg)
  const deckWoodTex = makeCanvasTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#6e5039';
    ctx.fillRect(0, 0, w, h);
    const planks = 12;
    const ph = h / planks;
    for (let i = 0; i < planks; i++) {
      const y = i * ph;
      const d = -8 + Math.floor(rand() * 16);
      ctx.fillStyle = `rgb(${110 + d},${80 + d},${57 + d})`;
      ctx.fillRect(0, y + 1, w, ph - 2);
      ctx.fillStyle = '#3d2a1d';
      ctx.fillRect(0, y, w, 1.5);
    }
  }, 0.4, 0.4);

  // 7. Interior large pale porcelain floor tile (04_Interior_Living_room.jpg)
  const porcelainTileTex = makeCanvasTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#ebe6dc';
    ctx.fillRect(0, 0, w, h);
    // Subtle stone clouding
    for (let i = 0; i < 1500; i++) {
      const x = rand() * w;
      const y = rand() * h;
      ctx.fillStyle = 'rgba(218, 211, 198, 0.18)';
      ctx.fillRect(x, y, 8, 8);
    }
    // Fine grout lines (2x2 tiles in texture)
    ctx.strokeStyle = '#d4cdc0';
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, w / 2, h / 2);
    ctx.strokeRect(w / 2, 0, w / 2, h / 2);
    ctx.strokeRect(0, h / 2, w / 2, h / 2);
    ctx.strokeRect(w / 2, h / 2, w / 2, h / 2);
  }, 0.8, 0.8);

  // 8. Interior warm oak bedroom floor (04_Interior_Bedroom.jpg)
  const oakWoodTex = makeCanvasTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#c8a982';
    ctx.fillRect(0, 0, w, h);
    const strips = 8;
    const sh = h / strips;
    for (let i = 0; i < strips; i++) {
      const d = -10 + Math.floor(rand() * 20);
      ctx.fillStyle = `rgb(${200 + d},${168 + d},${128 + d})`;
      ctx.fillRect(0, i * sh + 1, w, sh - 2);
      ctx.fillStyle = 'rgba(120, 88, 52, 0.25)';
      ctx.fillRect(0, i * sh, w, 1);
    }
  }, 1.0, 1.0);

  // 9. Interior bathroom Calacatta marble tile
  const marbleTex = makeCanvasTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#f2f0ec';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(165, 160, 152, 0.35)';
    ctx.lineWidth = 2;
    for (let i = 0; i < 10; i++) {
      ctx.beginPath();
      ctx.moveTo(rand() * w, rand() * h);
      ctx.bezierCurveTo(
        rand() * w, rand() * h,
        rand() * w, rand() * h,
        rand() * w, rand() * h
      );
      ctx.stroke();
    }
    ctx.strokeStyle = '#dad6ce';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(0, 0, w / 2, h / 2);
    ctx.strokeRect(w / 2, h / 2, w / 2, h / 2);
  }, 1.0, 1.0);

  // 10. Architectural walnut wood slats / doors (Charm & Kitchen)
  const walnutTex = makeCanvasTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#785032';
    ctx.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 8) {
      const d = -8 + Math.floor(rand() * 16);
      ctx.fillStyle = `rgb(${120 + d},${80 + d},${50 + d})`;
      ctx.fillRect(x, 0, 6, h);
      ctx.fillStyle = '#4a2e19';
      ctx.fillRect(x + 6, 0, 2, h);
    }
  }, 1, 1);

  // 11. Environment reflection cubemap (procedural sky + desert + greenery)
  const envMap = (() => {
    const size = 64;
    const faces = [];
    for (let f = 0; f < 6; f++) {
      const c = document.createElement('canvas');
      c.width = size;
      c.height = size;
      const ctx = c.getContext('2d');
      if (f === 2) {
        // +Y top sky
        ctx.fillStyle = '#7ab5e6';
        ctx.fillRect(0, 0, size, size);
      } else if (f === 3) {
        // -Y ground
        ctx.fillStyle = '#c8bca6';
        ctx.fillRect(0, 0, size, size);
      } else {
        const grad = ctx.createLinearGradient(0, 0, 0, size);
        grad.addColorStop(0, '#7ab5e6');
        grad.addColorStop(0.52, '#dfeaf2');
        grad.addColorStop(0.55, '#7a946e');
        grad.addColorStop(1, '#d2c5b0');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, size, size);
      }
      faces.push(c);
    }
    const cubeTex = new THREE.CubeTexture(faces);
    cubeTex.needsUpdate = true;
    return cubeTex;
  })();

  const mats = {
    envMap,
    // Exterior walls by style
    wallWhite: new THREE.MeshStandardMaterial({
      map: stuccoTex,
      color: 0xfbf9f5,
      roughness: 0.78,
      metalness: 0.02,
    }),
    wallOffWhite: new THREE.MeshStandardMaterial({
      map: stuccoTex,
      color: 0xf0ece3,
      roughness: 0.8,
      metalness: 0.02,
    }),
    wallAstonGrey: new THREE.MeshStandardMaterial({
      map: stuccoTex,
      color: 0xc2c6c4,
      roughness: 0.72,
      metalness: 0.05,
    }),
    wallAstonTaupe: new THREE.MeshStandardMaterial({
      color: 0x8a8275,
      roughness: 0.55,
      metalness: 0.15,
    }),
    wallPalmaFrame: new THREE.MeshStandardMaterial({
      map: stuccoTex,
      color: 0xeaeef0,
      roughness: 0.68,
      metalness: 0.04,
    }),
    wallPalmaFeature: new THREE.MeshStandardMaterial({
      color: 0x6f5b4b,
      roughness: 0.62,
      metalness: 0.08,
    }),
    wallCharmWhite: new THREE.MeshStandardMaterial({
      map: stuccoTex,
      color: 0xfdfcfa,
      roughness: 0.74,
      metalness: 0.02,
    }),
    charmLouver: new THREE.MeshStandardMaterial({
      color: 0xd8dcd8,
      roughness: 0.45,
      metalness: 0.25,
    }),
    walnutWood: new THREE.MeshStandardMaterial({
      map: walnutTex,
      color: 0xffffff,
      roughness: 0.55,
      metalness: 0.05,
    }),
    darkMetal: new THREE.MeshStandardMaterial({
      color: 0x26292e,
      roughness: 0.35,
      metalness: 0.7,
    }),
    parapetCoping: new THREE.MeshStandardMaterial({
      color: 0xdcd7cd,
      roughness: 0.7,
      metalness: 0.05,
    }),
    boundaryWall: new THREE.MeshStandardMaterial({
      map: stuccoTex,
      color: 0xeae5dc,
      roughness: 0.82,
      metalness: 0.02,
    }),
    gateSlat: new THREE.MeshStandardMaterial({
      color: 0x9a968e,
      roughness: 0.45,
      metalness: 0.4,
    }),

    // Glass (exterior & interior)
    windowInteriorBacking: new THREE.MeshStandardMaterial({
      map: windowBackingTex,
      color: 0xffffff,
      roughness: 0.5,
      metalness: 0.0,
      emissive: new THREE.Color(0xffdfa8),
      emissiveIntensity: 0.22,
    }),
    exteriorGlass: new THREE.MeshPhysicalMaterial({
      color: 0xaed4e6,
      envMap,
      envMapIntensity: 1.5,
      roughness: 0.06,
      metalness: 0.14,
      transparent: true,
      opacity: 0.58,
      emissive: new THREE.Color(0x000000),
      emissiveIntensity: 0.0,
    }),
    balconyGlass: new THREE.MeshPhysicalMaterial({
      color: 0xc8e0ea,
      envMap,
      envMapIntensity: 1.15,
      roughness: 0.08,
      metalness: 0.06,
      transparent: true,
      opacity: 0.42,
    }),
    interiorGlass: new THREE.MeshPhysicalMaterial({
      color: 0xdaf0f7,
      envMap,
      envMapIntensity: 0.9,
      roughness: 0.06,
      metalness: 0.05,
      transparent: true,
      opacity: 0.32,
      side: THREE.DoubleSide,
    }),

    // Ground & landscape materials
    desertGround: new THREE.MeshStandardMaterial({
      map: sandTex,
      color: 0xe6d8c3,
      roughness: 0.94,
      metalness: 0.0,
    }),
    gravelBed: new THREE.MeshStandardMaterial({
      map: paleGravelTex,
      color: 0xe2ded5,
      roughness: 0.86,
      metalness: 0.0,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }),
    paleGravel: new THREE.MeshStandardMaterial({
      map: paleGravelTex,
      color: 0xeae6de,
      roughness: 0.84,
      metalness: 0.0,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }),
    plantingBed: new THREE.MeshStandardMaterial({
      map: grassTex,
      color: 0x578c43,
      roughness: 0.9,
      metalness: 0.0,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }),
    roadAsphalt: new THREE.MeshStandardMaterial({
      map: asphaltTex,
      color: 0xffffff,
      roughness: 0.82,
      metalness: 0.04,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }),
    roadLine: new THREE.MeshBasicMaterial({
      color: 0xf4f1ea,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    }),
    kerbStone: new THREE.MeshStandardMaterial({
      color: 0xc7c2b8,
      roughness: 0.8,
      metalness: 0.02,
    }),
    drivewayPaver: new THREE.MeshStandardMaterial({
      map: paverTex,
      color: 0xc8c3ba,
      roughness: 0.76,
      metalness: 0.03,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
    footpathPaver: new THREE.MeshStandardMaterial({
      map: paverTex,
      color: 0xd8d3c8,
      roughness: 0.78,
      metalness: 0.02,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
    sikkaPaver: new THREE.MeshStandardMaterial({
      map: paverTex,
      color: 0xe3dfd6,
      roughness: 0.74,
      metalness: 0.02,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
    cycleTrackBlue: new THREE.MeshStandardMaterial({
      color: 0x3b78a8,
      roughness: 0.65,
      metalness: 0.05,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    }),
    lawnGrass: new THREE.MeshStandardMaterial({
      map: grassTex,
      color: 0x6cb04d,
      roughness: 0.86,
      metalness: 0.0,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }),
    parkGrass: new THREE.MeshStandardMaterial({
      map: grassTex,
      color: 0x61a344,
      roughness: 0.86,
      metalness: 0.0,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }),
    poolDeck: new THREE.MeshStandardMaterial({
      map: deckWoodTex,
      color: 0xffffff,
      roughness: 0.68,
      metalness: 0.04,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
    poolWater: new THREE.MeshPhysicalMaterial({
      color: 0x20b2d6,
      envMap,
      envMapIntensity: 1.6,
      roughness: 0.06,
      metalness: 0.08,
      transparent: true,
      opacity: 0.86,
      emissive: new THREE.Color(0x084c61),
      emissiveIntensity: 0.25,
    }),
    poolTile: new THREE.MeshStandardMaterial({
      color: 0x5fd3eb,
      roughness: 0.3,
      metalness: 0.05,
    }),

    // Tree & Foliage materials
    trunkBark: new THREE.MeshStandardMaterial({
      color: 0x5d4736,
      roughness: 0.92,
    }),
    palmTrunk: new THREE.MeshStandardMaterial({
      map: palmBarkTex,
      color: 0x9e8266,
      roughness: 0.88,
    }),
    leafFlameGreen: new THREE.MeshStandardMaterial({
      color: 0x457d32,
      roughness: 0.76,
    }),
    leafFlameBlossom: new THREE.MeshStandardMaterial({
      color: 0xe64522,
      roughness: 0.62,
      emissive: new THREE.Color(0x4a1204),
      emissiveIntensity: 0.16,
    }),
    leafNeem: new THREE.MeshStandardMaterial({
      color: 0x457c39,
      roughness: 0.8,
    }),
    leafOlive: new THREE.MeshStandardMaterial({
      color: 0x788f6c,
      roughness: 0.82,
    }),
    leafGhaf: new THREE.MeshStandardMaterial({
      color: 0x5c8248,
      roughness: 0.84,
    }),
    leafFrangipani: new THREE.MeshStandardMaterial({
      color: 0x528842,
      roughness: 0.75,
    }),
    flowerFrangipani: new THREE.MeshStandardMaterial({
      color: 0xfff5e4,
      roughness: 0.6,
    }),
    leafPalm: new THREE.MeshStandardMaterial({
      color: 0x4d7e3a,
      roughness: 0.72,
      side: THREE.DoubleSide,
    }),
    shrubGreen: new THREE.MeshStandardMaterial({
      color: 0x558441,
      roughness: 0.86,
    }),
    lavenderBush: new THREE.MeshStandardMaterial({
      color: 0x7b68a6,
      roughness: 0.82,
    }),
    ornamentalGrass: new THREE.MeshStandardMaterial({
      color: 0xc8ba96,
      roughness: 0.88,
    }),

    // Interior floors, walls & furniture
    intWall: new THREE.MeshStandardMaterial({
      color: 0xf7f4ee,
      roughness: 0.82,
      metalness: 0.01,
    }),
    intCeiling: new THREE.MeshStandardMaterial({
      color: 0xfcfbf9,
      roughness: 0.88,
    }),
    floorPorcelain: new THREE.MeshStandardMaterial({
      map: porcelainTileTex,
      color: 0xffffff,
      roughness: 0.32,
      metalness: 0.05,
    }),
    floorOak: new THREE.MeshStandardMaterial({
      map: oakWoodTex,
      color: 0xffffff,
      roughness: 0.46,
      metalness: 0.04,
    }),
    floorMarble: new THREE.MeshStandardMaterial({
      map: marbleTex,
      color: 0xffffff,
      roughness: 0.24,
      metalness: 0.06,
    }),
    floorTerrace: new THREE.MeshStandardMaterial({
      map: paverTex,
      color: 0xded8ce,
      roughness: 0.72,
      metalness: 0.03,
    }),
    fabricCream: new THREE.MeshStandardMaterial({
      color: 0xeae5dc,
      roughness: 0.88,
    }),
    fabricSage: new THREE.MeshStandardMaterial({
      color: 0x7ca19b,
      roughness: 0.82,
    }),
    fabricRug: new THREE.MeshStandardMaterial({
      color: 0x9eb2ad,
      roughness: 0.94,
    }),
    fabricBedroomRug: new THREE.MeshStandardMaterial({
      color: 0xb8a88f,
      roughness: 0.94,
    }),
    fabricCurtain: new THREE.MeshStandardMaterial({
      color: 0xdedad0,
      roughness: 0.86,
      transparent: true,
      opacity: 0.88,
      side: THREE.DoubleSide,
    }),
    quartzWhite: new THREE.MeshStandardMaterial({
      color: 0xf4f2ee,
      roughness: 0.2,
      metalness: 0.05,
    }),
    ceramicWhite: new THREE.MeshStandardMaterial({
      color: 0xfafafa,
      roughness: 0.14,
      metalness: 0.08,
    }),
    chromeMetal: new THREE.MeshStandardMaterial({
      color: 0xd8dde2,
      roughness: 0.18,
      metalness: 0.88,
    }),
    brassAccent: new THREE.MeshStandardMaterial({
      color: 0xc5a059,
      roughness: 0.28,
      metalness: 0.82,
    }),
    tvScreen: new THREE.MeshStandardMaterial({
      color: 0x111317,
      roughness: 0.12,
      metalness: 0.4,
    }),
    lampEmissive: new THREE.MeshStandardMaterial({
      color: 0xfff3d6,
      emissive: new THREE.Color(0xffd28a),
      emissiveIntensity: 0.8,
    }),
    mosqueDomeGold: new THREE.MeshStandardMaterial({
      color: 0xdcc082,
      roughness: 0.32,
      metalness: 0.65,
    }),
    umbrellaPink: new THREE.MeshStandardMaterial({
      color: 0xc895ab,
      roughness: 0.72,
      side: THREE.DoubleSide,
    }),
    contextBuilding: new THREE.MeshStandardMaterial({
      color: 0xebe6dc,
      roughness: 0.88,
      metalness: 0.02,
    }),
  };

  return mats;
}

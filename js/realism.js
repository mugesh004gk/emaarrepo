import * as THREE from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';

/**
 * Photo-scanned surfaces (Poly Haven, CC0 — media/textures/LICENSE.txt) and a real sky lighting map.
 * Textures are created synchronously (their images stream in), so materials built later share them.
 */
const T = 'media/textures/';
const loader = new THREE.TextureLoader();
const cache = new Map();
const clonesOf = new Map(); // base texture -> its texRepeat clones

/** A repeating texture; `colour` = sRGB albedo, otherwise linear data (normal maps). */
export function tex(name, colour = true) {
  const key = name + colour;
  if (cache.has(key)) return cache.get(key);
  // Until the photo arrives the texture shows a 1-pixel stand-in of its typical colour (grass green,
  // asphalt grey, flat normal...) instead of black - on a slow connection roads and lawns otherwise
  // render black for seconds. Clones (texRepeat) are refreshed when the photo has loaded.
  // (dispose() makes the renderer allocate the GPU texture again at the photo's size)
  const t = loader.load(T + name, () => { for (const x of [t, ...clonesOf.get(t)]) { x.dispose(); x.needsUpdate = true; } });
  clonesOf.set(t, []);
  t.image = placeholder(name);
  t.needsUpdate = true;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  if (colour) t.colorSpace = THREE.SRGBColorSpace;
  cache.set(key, t);
  return t;
}

/** Same texture with its own repeat (texture objects carry the repeat, so each use gets a clone). */
export function texRepeat(name, rx, ry, colour = true) {
  const base = tex(name, colour);
  const t = base.clone();
  clonesOf.get(base).push(t);
  t.repeat.set(rx, ry);
  return t;
}

const STAND_IN = [[/_nor/, '#8080ff'], [/asphalt/, '#5b5b5b'], [/grass/, '#6f8c4c'], [/paver|concrete/, '#b9b3a8'], [/stucco/, '#efede8']];
function placeholder(name) {
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  const g = c.getContext('2d');
  g.fillStyle = (STAND_IN.find(([rx]) => rx.test(name)) || [0, '#9a9a9a'])[1];
  g.fillRect(0, 0, 1, 1);
  return c;
}

/** Stucco relief on the white wall materials of every home (Nara and detected homes). */
export function applyWallRelief(materials) {
  for (const m of materials) {
    if (!m || m.userData.relief) continue;
    m.normalMap = texRepeat('white_stucco_nor_gl.jpg', 0.6, 0.6, false);
    m.normalScale = new THREE.Vector2(0.35, 0.35);
    m.userData.relief = true;
    m.needsUpdate = true;
  }
}

/** Natural sky light and reflections (replaces the studio room environment). */
export function applySkyEnvironment(renderer, scene, intensity = 0.55) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  new HDRLoader().load(T + 'sky_1k.hdr', (hdr) => {
    hdr.mapping = THREE.EquirectangularReflectionMapping;
    scene.environment = pmrem.fromEquirectangular(hdr).texture;
    scene.environmentIntensity = intensity;
    hdr.dispose();
    pmrem.dispose();
  });
}

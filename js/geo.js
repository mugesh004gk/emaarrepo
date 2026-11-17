/**
 * One shared projection for everything in the world: satellite tiles, district outlines,
 * project pins and every home. Web Mercator, scaled to true metres at the world origin.
 *
 *   world x = east  (metres)
 *   world z = south (metres)   -> north is -z (same convention as the Nara model)
 *   world y = up
 *
 * Because tiles and homes go through the same function, a home always lands on its own
 * roof in the imagery. Mercator is conformal, so local shapes keep their angles; the
 * small scale change with latitude is applied with localScale() (0.05% across the area).
 */
export const ORIGIN = { lat: 24.955, lng: 55.30 }; // between the three communities

const R = 6378137;
const D2R = Math.PI / 180;
const S0 = Math.cos(ORIGIN.lat * D2R);
const mx = (lng) => R * lng * D2R;
const my = (lat) => R * Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2));
const MX0 = mx(ORIGIN.lng);
const MY0 = my(ORIGIN.lat);

export function toWorld(lat, lng) {
  return { x: (mx(lng) - MX0) * S0, z: -(my(lat) - MY0) * S0 };
}

export function toLatLng(x, z) {
  const lng = (x / S0 + MX0) / (R * D2R);
  const lat = (2 * Math.atan(Math.exp((-z / S0 + MY0) / R)) - Math.PI / 2) / D2R;
  return { lat, lng };
}

/** World units per true metre at a latitude (apply to models built in metres). */
export function localScale(lat) {
  return S0 / Math.cos(lat * D2R);
}

// ---- slippy-map tiles -------------------------------------------------------
export function tileBounds(z, x, y) {
  const n = 2 ** z;
  const lngW = (x / n) * 360 - 180;
  const lngE = ((x + 1) / n) * 360 - 180;
  const latN = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) / D2R;
  const latS = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) / D2R;
  const a = toWorld(latN, lngW);
  const b = toWorld(latS, lngE);
  return { x0: a.x, z0: a.z, x1: b.x, z1: b.z, latN, latS, lngW, lngE };
}

export function tileAt(lat, lng, z) {
  const n = 2 ** z;
  const x = Math.floor(((lng + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(lat * D2R) + 1 / Math.cos(lat * D2R)) / Math.PI) / 2) * n);
  return { x, y };
}

/** Great-circle distance in metres. */
export function haversine(a, b) {
  const dLat = (b.lat - a.lat) * D2R;
  const dLng = (b.lng - a.lng) * D2R;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

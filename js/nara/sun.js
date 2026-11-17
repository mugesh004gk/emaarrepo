import * as THREE from 'three';

/**
 * True Astronomical Solar Position & Dynamic Sky/Lighting System for Nara at The Valley, Dubai
 * Coordinates: 25.0126° N, 55.4516° E, Timezone: UTC+4 (Gulf Standard Time)
 * World frame: +X = True East, +Y = Up, -Z = True North (+Z = True South)
 */
export const NARA_LAT = 25.012567;
export const NARA_LON = 55.451648;
export const DUBAI_TZ_OFFSET = 4.0; // UTC+4

const COMPASS_8 = [
  'North', 'North-East', 'East', 'South-East',
  'South', 'South-West', 'West', 'North-West'
];

export function bearingToCompass8(deg) {
  const b = ((deg % 360) + 360) % 360;
  return COMPASS_8[Math.round(b / 45) % 8];
}

/**
 * Computes true solar azimuth (deg clockwise from True North) and altitude (deg above horizon)
 * for Nara (25.01° N, 55.45° E) at a given day-of-year (1..365) and local Dubai hour (0..24).
 */
export function computeNaraSunPosition(hourDecimal = 16.0, dayOfYear = 294) {
  const latRad = THREE.MathUtils.degToRad(NARA_LAT);

  // Fractional year in radians
  const gamma = ((2 * Math.PI) / 365) * (dayOfYear - 1 + (hourDecimal - 12) / 24);

  // Equation of time (minutes) - NOAA Spencer formula
  const eqTime = 229.18 * (
    0.000075 +
    0.001868 * Math.cos(gamma) -
    0.032077 * Math.sin(gamma) -
    0.014615 * Math.cos(2 * gamma) -
    0.040849 * Math.sin(2 * gamma)
  );

  // Solar declination (radians)
  const decl =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma);

  // Time offset in minutes from standard meridian (60° E for UTC+4)
  const timeOffsetMin = eqTime + 4 * (NARA_LON - 15 * DUBAI_TZ_OFFSET);
  const trueSolarTimeMin = hourDecimal * 60 + timeOffsetMin;

  // Hour angle H (degrees and radians): negative in morning, 0 at solar noon, positive in afternoon
  const hourAngleDeg = trueSolarTimeMin / 4 - 180;
  const hourAngleRad = THREE.MathUtils.degToRad(hourAngleDeg);

  // Solar elevation / altitude
  const sinAlt = Math.max(
    -1,
    Math.min(1, Math.sin(latRad) * Math.sin(decl) + Math.cos(latRad) * Math.cos(decl) * Math.cos(hourAngleRad))
  );
  const altRad = Math.asin(sinAlt);
  const altDeg = THREE.MathUtils.radToDeg(altRad);

  // Solar azimuth clockwise from True North (0=N, 90=E, 180=S, 270=W)
  const cosAlt = Math.max(1e-6, Math.cos(altRad));
  const sinAz = (-Math.cos(decl) * Math.sin(hourAngleRad)) / cosAlt;
  const cosAz = (Math.sin(decl) - Math.sin(latRad) * sinAlt) / (Math.cos(latRad) * cosAlt);
  const azRad = Math.atan2(sinAz, cosAz);
  const azDeg = (THREE.MathUtils.radToDeg(azRad) + 360) % 360;

  // Direction vector toward the sun in world coordinates (+X East, +Y Up, -Z North / +Z South)
  const dirX = Math.sin(azRad) * Math.cos(altRad);
  const dirY = Math.sin(altRad);
  const dirZ = -Math.cos(azRad) * Math.cos(altRad);

  // Shadow bearing (direction shadows point away from the sun)
  const shadowBearingDeg = (azDeg + 180) % 360;

  return {
    azimuthDeg: azDeg,
    altitudeDeg: altDeg,
    shadowBearingDeg,
    sunCompass: bearingToCompass8(azDeg),
    shadowCompass: bearingToCompass8(shadowBearingDeg),
    direction: new THREE.Vector3(dirX, dirY, dirZ).normalize(),
    isNight: altDeg < -1.0,
    isTwilight: altDeg >= -6.0 && altDeg < 6.0,
  };
}

export function createSolarSystem(scene, mats) {
  // Directional Sun Light with large high-res shadow frustum
  const sunLight = new THREE.DirectionalLight(0xfff6e5, 2.6);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.width = 2048;
  sunLight.shadow.mapSize.height = 2048;
  sunLight.shadow.camera.near = 20;
  sunLight.shadow.camera.far = 950;
  const d = 340;
  sunLight.shadow.camera.left = -d;
  sunLight.shadow.camera.right = d;
  sunLight.shadow.camera.top = d;
  sunLight.shadow.camera.bottom = -d;
  sunLight.shadow.bias = -0.00035;
  sunLight.shadow.normalBias = 0.02;
  scene.add(sunLight);
  scene.add(sunLight.target);

  // Hemisphere Sky/Ground Fill Light
  const hemiLight = new THREE.HemisphereLight(0x9ed2ff, 0xd8c8b0, 1.05);
  scene.add(hemiLight);

  // Soft Ambient Light
  const ambientLight = new THREE.AmbientLight(0xfff8ee, 0.35);
  scene.add(ambientLight);

  // Sky Dome + Visible Solar Disc
  const skyGeo = new THREE.SphereGeometry(2200, 32, 20);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      topColor: { value: new THREE.Color(0x4b8fd1) },
      horizonColor: { value: new THREE.Color(0xe6eff5) },
      groundColor: { value: new THREE.Color(0xdccbb4) },
      sunDir: { value: new THREE.Vector3(-0.7, 0.4, 0.5) },
      sunColor: { value: new THREE.Color(0xffe9b8) },
    },
    vertexShader: `
      varying vec3 vWorldPos;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        // direction from the dome centre (the dome follows the camera across the map)
        vWorldPos = wp.xyz - (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      uniform vec3 topColor;
      uniform vec3 horizonColor;
      uniform vec3 groundColor;
      uniform vec3 sunDir;
      uniform vec3 sunColor;
      varying vec3 vWorldPos;
      void main() {
        vec3 d = normalize(vWorldPos);
        float h = clamp(d.y, 0.0, 1.0);
        vec3 col = mix(horizonColor, topColor, pow(h, 0.55));
        if (d.y < 0.0) {
          col = mix(horizonColor, groundColor, clamp(-d.y * 4.0, 0.0, 1.0));
        }
        float sunCos = max(dot(d, normalize(sunDir)), 0.0);
        col += sunColor * pow(sunCos, 24.0) * 0.35;
        col += sunColor * smoothstep(0.9992, 0.9998, sunCos) * 1.6;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const skyMesh = new THREE.Mesh(skyGeo, skyMat);
  scene.add(skyMesh);

  // Fog for natural desert horizon fade
  scene.fog = new THREE.FogExp2(0xe6dfd3, 0.00042);

  // Street lamp and night light callbacks
  const nightCallbacks = [];

  function update(hourDecimal = 16.0, dayOfYear = 294, focusTarget = null) {
    const info = computeNaraSunPosition(hourDecimal, dayOfYear);

    const cx = focusTarget ? focusTarget.x : 0;
    const cz = focusTarget ? focusTarget.z : 0;
    sunLight.target.position.set(cx, 0, cz);
    sunLight.target.updateMatrixWorld();

    // Clamp light height slightly when sun is near/below horizon so moonlight still gives subtle relief
    const effDir = info.direction.clone();
    if (effDir.y < 0.06) {
      effDir.y = 0.18;
      effDir.normalize();
    }
    sunLight.position.set(
      cx + effDir.x * 380,
      Math.max(25, effDir.y * 380),
      cz + effDir.z * 380
    );

    // Adjust shadow camera size when focused on a single unit vs whole community
    const frustum = focusTarget ? 85 : 340;
    if (sunLight.shadow.camera.right !== frustum) {
      sunLight.shadow.camera.left = -frustum;
      sunLight.shadow.camera.right = frustum;
      sunLight.shadow.camera.top = frustum;
      sunLight.shadow.camera.bottom = -frustum;
      sunLight.shadow.camera.updateProjectionMatrix();
    }

    // Color & intensity transitions for Morning / Midday / Golden Hour / Night
    const alt = info.altitudeDeg;
    if (alt > 25) {
      // Bright Dubai daylight
      sunLight.color.setHex(0xfff8eb);
      sunLight.intensity = 2.7;
      hemiLight.color.setHex(0x9bd0ff);
      hemiLight.groundColor.setHex(0xd8c8b0);
      hemiLight.intensity = 1.08;
      ambientLight.intensity = 0.36;
      skyMat.uniforms.topColor.value.setHex(0x4a8fd4);
      skyMat.uniforms.horizonColor.value.setHex(0xe5eef5);
      skyMat.uniforms.sunColor.value.setHex(0xfff2cf);
      scene.fog.color.setHex(0xe5dfd4);
    } else if (alt > 4) {
      // Morning / Late Afternoon (e.g. 4:00 PM late October!)
      const t = (alt - 4) / 21;
      sunLight.color.lerpColors(new THREE.Color(0xffb56b), new THREE.Color(0xfff6e0), t);
      sunLight.intensity = 1.9 + 0.8 * t;
      hemiLight.color.lerpColors(new THREE.Color(0xffcfa3), new THREE.Color(0x9bd0ff), t);
      hemiLight.groundColor.setHex(0xd1bfa6);
      hemiLight.intensity = 0.85 + 0.22 * t;
      ambientLight.intensity = 0.32;
      skyMat.uniforms.topColor.value.lerpColors(new THREE.Color(0x3a6ca8), new THREE.Color(0x4a8fd4), t);
      skyMat.uniforms.horizonColor.value.lerpColors(new THREE.Color(0xf4d3b0), new THREE.Color(0xe5eef5), t);
      skyMat.uniforms.sunColor.value.setHex(0xffc982);
      scene.fog.color.lerpColors(new THREE.Color(0xeed4b9), new THREE.Color(0xe5dfd4), t);
    } else if (alt > -4) {
      // Sunset / Twilight
      const t = (alt + 4) / 8;
      sunLight.color.setHex(0xff8e47);
      sunLight.intensity = Math.max(0.25, 1.6 * t);
      hemiLight.color.lerpColors(new THREE.Color(0x243454), new THREE.Color(0xffb884), t);
      hemiLight.groundColor.lerpColors(new THREE.Color(0x1b202b), new THREE.Color(0xb89e82), t);
      hemiLight.intensity = 0.45 + 0.4 * t;
      ambientLight.intensity = 0.28;
      skyMat.uniforms.topColor.value.lerpColors(new THREE.Color(0x101a30), new THREE.Color(0x3a6ca8), t);
      skyMat.uniforms.horizonColor.value.lerpColors(new THREE.Color(0x3b3548), new THREE.Color(0xf2b085), t);
      skyMat.uniforms.sunColor.value.setHex(0xff7b38);
      scene.fog.color.lerpColors(new THREE.Color(0x1d2436), new THREE.Color(0xe2b696), t);
    } else {
      // Night time in Dubai
      sunLight.color.setHex(0x6e8cb8);
      sunLight.intensity = 0.35;
      hemiLight.color.setHex(0x1e2c4a);
      hemiLight.groundColor.setHex(0x151922);
      hemiLight.intensity = 0.42;
      ambientLight.intensity = 0.25;
      skyMat.uniforms.topColor.value.setHex(0x0b1324);
      skyMat.uniforms.horizonColor.value.setHex(0x1c273d);
      skyMat.uniforms.sunColor.value.setHex(0x1c273d);
      scene.fog.color.setHex(0x141c2e);
    }

    skyMat.uniforms.sunDir.value.copy(info.direction);

    // Night / Evening window & street lamp glow
    const nightFactor = alt < 6 ? Math.min(1, Math.max(0, (6 - alt) / 8)) : 0;
    if (mats && mats.exteriorGlass) {
      mats.exteriorGlass.emissive.setHex(0xffbe6b);
      mats.exteriorGlass.emissiveIntensity = nightFactor * 0.65;
    }
    if (mats && mats.lampEmissive) {
      mats.lampEmissive.emissiveIntensity = 0.3 + nightFactor * 2.2;
    }
    for (const cb of nightCallbacks) {
      cb(nightFactor, info);
    }

    return info;
  }

  return {
    sunLight,
    hemiLight,
    ambientLight,
    skyMesh,
    update,
    onNightChange(cb) {
      nightCallbacks.push(cb);
    },
  };
}

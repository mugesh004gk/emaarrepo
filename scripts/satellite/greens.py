#!/usr/bin/env python3
"""Green spaces (parks, lawns, landscaped strips) inside each compound, from zoom-19 imagery.
   .venv/bin/python scripts/satellite/greens.py the-valley arabian-ranches-3 emaar-south
-> data/greens.json : {communities: {cid: [{ring: [[lng,lat],...], areaM2, kind}]}}
Vegetation = green hue with saturation; blobs >= 120 m2, smoothed, simplified to ~1.2 m; golf
fairways (very large blobs) are kept as kind 'golf' so they get lawn but sparse trees."""
import json, math, os, sys
import numpy as np, cv2
import run_v2 as R

APP = R.APP
LUSH_S = int(os.environ.get("LUSH_S", 40))
LUSH_F = float(os.environ.get("LUSH_F", 0.45))
MAX_GREEN = {"the-valley": 20000, "arabian-ranches-3": 20000}


def inpoly(x, y, poly):
    ins, j = False, len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]; xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            ins = not ins
        j = i
    return ins


def main(cids):
    comp = json.load(open(os.path.join(APP, 'data', 'compounds.json')))
    nara = json.load(open(os.path.join(APP, 'data', 'nara_data.json')))
    path = os.path.join(APP, 'data', 'greens.json')
    out = json.load(open(path)) if os.path.exists(path) else {'source': 'Esri World Imagery z19, vegetation detection (scripts/satellite/greens.py)', 'communities': {}}
    nara_ll = np.array([[u['lon'], u['lat']] for u in nara['units']], np.float32)
    nara_hull = cv2.convexHull(nara_ll)
    for cid in cids:
        rings = comp[cid]
        allp = [p for r in rings for p in r]
        lo0, lo1 = min(p[0] for p in allp), max(p[0] for p in allp)
        la0, la1 = min(p[1] for p in allp), max(p[1] for p in allp)
        X0, Y0 = map(int, R.fxy(la1, lo0))
        X1, Y1 = map(int, R.fxy(la0, lo1))
        X1 += 1; Y1 += 1
        tiles = R.Tiles(cid)
        tiles.ensure(range(X0, X1), range(Y0, Y1))
        mpp = R.mpp_at((la0 + la1) / 2)
        k = lambda m: cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (max(1, round(m / mpp)),) * 2)
        res = []
        hd = json.load(open(os.path.join(APP, 'data', 'homes_detected.json')))['communities'].get(cid, [])
        near = np.array([[r['lng'] * 101000.0, r['lat'] * 110574.0] for r in hd] + ([[u['lon'] * 101000.0, u['lat'] * 110574.0] for u in nara['units']] if cid == 'the-valley' else [])) if hd else None
        CH = 12
        for tx in range(X0, X1, CH):
            for ty in range(Y0, Y1, CH):
                ax0, ay0, ax1, ay1 = max(X0, tx - 1), max(Y0, ty - 1), min(X1, tx + CH + 1), min(Y1, ty + CH + 1)
                img = tiles.mosaic(ax0, ay0, ax1, ay1)
                hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
                h, s, v = cv2.split(hsv)
                veg = ((h >= 30) & (h <= 95) & (s >= 38) & (v >= 35)).astype(np.uint8) * 255
                veg = cv2.morphologyEx(veg, cv2.MORPH_CLOSE, k(2.0))
                veg = cv2.morphologyEx(veg, cv2.MORPH_OPEN, k(1.6))
                cnts, _ = cv2.findContours(veg, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                core = ((tx - ax0) * 256, (ty - ay0) * 256, (min(X1, tx + CH) - ax0) * 256, (min(Y1, ty + CH) - ay0) * 256)
                for c in cnts:
                    area = cv2.contourArea(c) * mpp * mpp
                    if area < 120 or area > MAX_GREEN.get(cid, 1e12):
                        continue  # (no golf course in The Valley / Arabian Ranches III: huge blobs are desert scrub)
                    M = cv2.moments(c)
                    cx, cy = M['m10'] / M['m00'], M['m01'] / M['m00']
                    if not (core[0] <= cx < core[2] and core[1] <= cy < core[3]):
                        continue  # each blob belongs to one chunk (blobs crossing chunks are cut there)
                    lat, lng = R.lonlat(cx / 256 + ax0, cy / 256 + ay0)
                    if not any(inpoly(lng, lat, r) for r in rings):
                        continue
                    if cv2.pointPolygonTest(nara_hull, (lng, lat), False) >= 0:
                        continue
                    # irrigated planting is vivid; desert scrub is pale and olive
                    msk = np.zeros(veg.shape, np.uint8)
                    cv2.drawContours(msk, [c], -1, 255, -1)
                    ms, mv = cv2.mean(s, msk)[0], cv2.mean(v, msk)[0]
                    if ms < 62 or mv < 55:
                        continue
                    # irrigated lawn is green almost everywhere inside its outline; scrub is green bushes
                    # scattered over sand, so most of its outline is sand
                    lush = ((h >= 30) & (h <= 90) & (s >= LUSH_S) & (v >= 45))
                    if cv2.mean(lush.astype(np.uint8), msk)[0] < LUSH_F:
                        continue
                    # only inside the built-up area (within 120 m of a detected home)
                    if near is not None:
                        q = np.array([lng * 101000.0, lat * 110574.0])
                        if np.min(np.hypot(*(near - q).T)) > 120:
                            continue
                    ap = cv2.approxPolyDP(c, 1.2 / mpp, True).reshape(-1, 2)
                    if len(ap) < 3:
                        continue
                    ring = []
                    for px, py in ap:
                        la, ln = R.lonlat(px / 256 + ax0, py / 256 + ay0)
                        ring.append([round(ln, 7), round(la, 7)])
                    res.append({'ring': ring, 'areaM2': round(area), 'kind': 'golf' if area > 15000 else 'park' if area > 600 else 'lawn'})
        out['communities'][cid] = res
        print(cid, len(res), 'green areas,', round(sum(g['areaM2'] for g in res) / 1e4, 1), 'ha', {k2: sum(1 for g in res if g['kind'] == k2) for k2 in ('lawn', 'park', 'golf')}, flush=True)
    json.dump(out, open(path, 'w'), separators=(',', ':'))


if __name__ == '__main__':
    main(sys.argv[1:])

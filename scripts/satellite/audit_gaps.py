#!/usr/bin/env python3
"""Coverage audit: built-up areas in the zoom-19 imagery (inside the compound) that have no 3D home.
  .venv/bin/python scripts/satellite/audit_gaps.py emaar-south
Prints the uncovered built area and writes data/homes_detected_check/<cid>_gaps.jpg (the 16
largest gaps, red = uncovered building, yellow = placed homes) and <cid>_gaps.json."""
import json, math, os, sys
import numpy as np, cv2
import run_v2 as R

APP = R.APP
ROOFS_ONLY = os.environ.get('ROOFS_ONLY') == '1'  # bright roofs only (no scrub)


def main(cid):
    comp = json.load(open(os.path.join(APP, 'data', 'compounds.json')))[cid]
    rows = json.load(open(os.path.join(APP, 'data', 'homes_detected.json')))['communities'][cid]
    nara = json.load(open(os.path.join(APP, 'data', 'nara_data.json')))
    allp = [p for r in comp for p in r]
    X0, Y0 = map(int, R.fxy(max(p[1] for p in allp), min(p[0] for p in allp)))
    X1, Y1 = map(int, R.fxy(min(p[1] for p in allp), max(p[0] for p in allp)))
    X1 += 1; Y1 += 1
    tiles = R.Tiles(cid)
    tiles.ensure(range(X0, X1), range(Y0, Y1))
    mpp = R.mpp_at(allp[0][1])
    to_px = lambda lat, lng: ((R.fxy(lat, lng)[0] - X0) * 256, (R.fxy(lat, lng)[1] - Y0) * 256)
    W, H = (X1 - X0) * 256, (Y1 - Y0) * 256
    S = 4  # work at 1/4 resolution for the full-community masks (~1.1 m/px)
    inside = np.zeros((H // S, W // S), np.uint8)
    for ring in comp:
        cv2.fillPoly(inside, [np.array([[x / S, y / S] for x, y in (to_px(la, lo) for lo, la in ring)], np.int32)], 255)
    if cid == 'the-valley':
        hull = cv2.convexHull(np.array([[x / S, y / S] for x, y in (to_px(u['lat'], u['lon']) for u in nara['units'])], np.float32)).astype(np.int32)
        cv2.fillPoly(inside, [hull], 0)
    covered = np.zeros_like(inside)
    for r in rows:
        x, y = to_px(r['lat'], r['lng'])
        a = math.radians(r['frontBearing'])
        f = np.array([math.sin(a), -math.cos(a)]); u = np.array([-f[1], f[0]])
        L, D = (r['L'] / 2 + 3) / mpp, (r['D'] / 2 + 3) / mpp
        c = np.array([x, y])
        q = np.array([c + u * L + f * D, c - u * L + f * D, c - u * L - f * D, c + u * L - f * D]) / S
        cv2.fillPoly(covered, [q.astype(np.int32)], 255)
    built = np.zeros_like(inside)
    CH = 12
    for tx in range(X0, X1, CH):
        for ty in range(Y0, Y1, CH):
            x1, y1 = min(X1, tx + CH), min(Y1, ty + CH)
            img = tiles.mosaic(tx, ty, x1, y1)
            mA, _ = R.building_mask(img, mpp)
            hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
            h, s, v = cv2.split(hsv)
            g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)
            mu = cv2.blur(g, (7, 7)); sd = np.sqrt(np.maximum(cv2.blur(g * g, (7, 7)) - mu * mu, 0))
            sand = (h >= 5) & (h <= 28) & (s >= 38)
            veg = (h >= 30) & (h <= 95) & (s >= 40)
            mC = ((sd > 14) & ~veg & ~(sand & (sd < 24))).astype(np.uint8) * 255
            m = mA if ROOFS_ONLY else cv2.bitwise_or(mA, mC)
            m = cv2.morphologyEx(m, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7)))
            sm = cv2.resize(m, ((x1 - tx) * 256 // S, (y1 - ty) * 256 // S), interpolation=cv2.INTER_AREA)
            oy, ox = (ty - Y0) * 256 // S, (tx - X0) * 256 // S
            built[oy:oy + sm.shape[0], ox:ox + sm.shape[1]] = np.maximum(built[oy:oy + sm.shape[0], ox:ox + sm.shape[1]], (sm > 127).astype(np.uint8) * 255)
    gap = cv2.bitwise_and(cv2.bitwise_and(built, inside), cv2.bitwise_not(covered))
    gap = cv2.morphologyEx(gap, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
    n, lab, st, cen = cv2.connectedComponentsWithStats(gap, 8)
    blobs = sorted([(st[i, 4] * (mpp * S) ** 2, i) for i in range(1, n) if st[i, 4] * (mpp * S) ** 2 >= (60 if ROOFS_ONLY else 150)], reverse=True)
    builtA = (cv2.bitwise_and(built, inside) > 0).sum() * (mpp * S) ** 2
    gapA = sum(a for a, _ in blobs)
    print(f'{cid}: built-up {builtA / 1e4:.1f} ha, uncovered gaps >=150 m2: {len(blobs)} ({gapA / 1e4:.1f} ha, {100 * gapA / max(1, builtA):.0f}%)')
    out = []
    crops = []
    for a, i in blobs[:16]:
        cx, cy = cen[i] * S
        lat, lng = R.lonlat(cx / 256 + X0, cy / 256 + Y0)
        out.append({'lat': lat, 'lng': lng, 'areaM2': round(a)})
        half = 90 / mpp
        bx0, by0 = int((cx - half) // 256) + X0, int((cy - half) // 256) + Y0
        bx1, by1 = int((cx + half) // 256) + X0 + 1, int((cy + half) // 256) + Y0 + 1
        im = tiles.mosaic(bx0, by0, bx1, by1)
        ox, oy = (bx0 - X0) * 256, (by0 - Y0) * 256
        gm = cv2.resize((lab == i).astype(np.uint8) * 255, (W, H), interpolation=cv2.INTER_NEAREST)[oy:oy + im.shape[0], ox:ox + im.shape[1]] if False else None
        cnts, _ = cv2.findContours(((lab == i).astype(np.uint8) * 255), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for c in cnts:
            cv2.polylines(im, [(c.reshape(-1, 2) * S - [ox, oy]).astype(np.int32)], True, (0, 0, 255), 3)
        for r in rows:
            x, y = to_px(r['lat'], r['lng'])
            if abs(x - cx) > half * 1.5 or abs(y - cy) > half * 1.5:
                continue
            aa = math.radians(r['frontBearing'])
            f = np.array([math.sin(aa), -math.cos(aa)]); u = np.array([-f[1], f[0]])
            c0 = np.array([x - ox, y - oy])
            q = np.array([c0 + u * r['L'] / 2 / mpp + f * r['D'] / 2 / mpp, c0 - u * r['L'] / 2 / mpp + f * r['D'] / 2 / mpp, c0 - u * r['L'] / 2 / mpp - f * r['D'] / 2 / mpp, c0 + u * r['L'] / 2 / mpp - f * r['D'] / 2 / mpp], np.int32)
            cv2.polylines(im, [q], True, (0, 255, 255), 2)
        cc = (int(cx - ox), int(cy - oy)); hh = int(half)
        crop = im[max(0, cc[1] - hh):cc[1] + hh, max(0, cc[0] - hh):cc[0] + hh]
        crop = cv2.resize(crop, (330, 330))
        cv2.putText(crop, f'{round(a)} m2', (6, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 255), 2)
        crops.append(crop)
    while len(crops) % 4:
        crops.append(np.zeros((330, 330, 3), np.uint8))
    if crops:
        cv2.imwrite(os.path.join(APP, 'data', 'homes_detected_check', f'{cid}_gaps{"_roofs" if ROOFS_ONLY else ""}.jpg'), np.vstack([np.hstack(crops[i:i + 4]) for i in range(0, len(crops), 4)]))
    json.dump(out, open(os.path.join(APP, 'data', 'homes_detected_check', f'{cid}_gaps{"_roofs" if ROOFS_ONLY else ""}.json'), 'w'))


if __name__ == '__main__':
    for c in sys.argv[1:]:
        main(c)

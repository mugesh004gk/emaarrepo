#!/usr/bin/env python3
"""Review picture: a placed site plan (data/siteplans/<project>.json) drawn on the satellite photo.

  python scripts/siteplan/clustermap/overlay.py <project> <out.png> [half_width_m] [lat lng]

Homes: red outline (house footprint L x D), green tick = front; street centre lines: cyan; the
mapped streets of data/site.json that stay: orange.
"""
import json, math, os, sys
import numpy as np
import cv2

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from place_cluster import sat  # noqa: E402

APP = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
KY = 110574.0


def main():
    proj, out = sys.argv[1], sys.argv[2]
    half = float(sys.argv[3]) if len(sys.argv) > 3 else 450
    sp = json.load(open(os.path.join(APP, 'data', 'siteplans', f'{proj}.json')))
    rows = sp['rows']
    lat, lng = (float(sys.argv[4]), float(sys.argv[5])) if len(sys.argv) > 5 else (np.mean([r['lat'] for r in rows]), np.mean([r['lng'] for r in rows]))
    img, mpp, (x0, y0), npx = sat(lat, lng, half)
    def px(la, lo):
        return ((lo + 180) / 360 * npx - x0, (1 - math.log(math.tan(math.radians(la)) + 1 / math.cos(math.radians(la))) / math.pi) / 2 * npx - y0)
    KX = 111320.0 * math.cos(math.radians(lat))
    site = json.load(open(os.path.join(APP, 'data', 'site.json')))['communities'][sp['community']]['streets']
    for s in site:
        if s['cls'] == 'path' or s.get('project') == proj:
            continue
        cv2.polylines(img, [np.int32([px(la, lo) for lo, la in s['pts']])], False, (0, 140, 255), 1)
    for rd in sp.get('roads', []):
        cv2.polylines(img, [np.int32([px(la, lo) for lo, la in rd['pts']])], False, (255, 255, 0), 2)
    for r in rows:
        f = math.radians(r['frontBearing']); fx, fy = math.sin(f), math.cos(f); ax, ay = fy, -fx
        L = sum(r.get('unitWidths') or [r['L']]) * (0.8 if r['kind'] == 'villa' else 1)
        q = []
        for su, sv in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            ex = ax * su * L / 2 + fx * sv * r['D'] / 2; ny = ay * su * L / 2 + fy * sv * r['D'] / 2
            q.append(px(r['lat'] + ny / KY, r['lng'] + ex / KX))
        cv2.polylines(img, [np.int32(q)], True, (0, 0, 255), 1)
        c = px(r['lat'], r['lng']); e = px(r['lat'] + fy * (r["D"] / 2 + 7) / KY, r['lng'] + fx * (r["D"] / 2 + 7) / KX)
        cv2.line(img, tuple(np.int32(c)), tuple(np.int32(e)), (0, 255, 0), 2)
    cv2.imwrite(out, img)
    print(out, img.shape)


if __name__ == '__main__':
    main()

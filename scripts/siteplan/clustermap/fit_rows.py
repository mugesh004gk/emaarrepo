#!/usr/bin/env python3
"""Refine a placed cluster (data/siteplans/<project>.json) on the street centre lines: one shift, scale
and rotation for the whole map, so that every row's house front stands the same distance from the
street in front of it (roofs in a satellite photo lean; streets lie on the ground).
  python scripts/siteplan/clustermap/fit_rows.py <project>"""
import json, math, os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from fit_streets import front_distances

APP = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
KY = 110574.0
proj = sys.argv[1]
path = os.path.join(APP, 'data', 'siteplans', f'{proj}.json')
sp = json.load(open(path))
site = json.load(open(os.path.join(APP, 'data', 'site.json')))['communities'][sp['community']]['streets']
lat0 = np.mean([r['lat'] for r in sp['rows']]); lng0 = np.mean([r['lng'] for r in sp['rows']])
KX = 111320.0 * math.cos(math.radians(lat0))
segs = []
for st in site:
    if st['cls'] == 'path' or st.get('source') in ('derived', 'siteplan'):
        continue
    p = [(lo * KX, la * KY) for lo, la in st['pts']]
    segs += [(p[i], p[i + 1]) for i in range(len(p) - 1)]
P = np.array([[(r['lng'] - lng0) * KX, (r['lat'] - lat0) * KY] for r in sp['rows']])
s = np.zeros(2); k = 0.0; w = 0.0; c = 12.0
def moved():
    out = []
    for r, p in zip(sp['rows'], P):
        mv = s + k * p + w * np.array([-p[1], p[0]])
        out.append(dict(r, lng=r['lng'] + mv[0] / KX, lat=r['lat'] + mv[1] / KY, frontBearing=(r['frontBearing'] - math.degrees(w)) % 360))
    return out
before = sorted(d for d, _, _ in front_distances(sp['rows'], segs, KX, [0, 0]) if d is not None and d < 24)
for it in range(15):
    fd = front_distances(moved(), segs, KX, [0, 0])
    idx = [i for i, (d, _, _) in enumerate(fd) if d is not None and d < 24]
    M = np.array([[fd[i][1], fd[i][2], fd[i][1] * P[i][0] + fd[i][2] * P[i][1], fd[i][1] * -P[i][1] + fd[i][2] * P[i][0], 1.0] for i in idx])
    y = np.array([fd[i][0] - c for i in idx])
    wt = np.where(np.abs(y) < 2.5, 1.0, 2.5 / np.maximum(np.abs(y), 1e-6))
    sol = np.linalg.lstsq(M * wt[:, None], y * wt, rcond=None)[0]
    s = s + sol[:2]; k += sol[2]; w += sol[3]; c += sol[4]
    if np.hypot(*sol[:2]) < 0.01:
        break
rows = moved()
after = sorted(d for d, _, _ in front_distances(rows, segs, KX, [0, 0]) if d is not None and d < 24)
for r in rows:
    r['lat'], r['lng'], r['frontBearing'] = round(r['lat'], 7), round(r['lng'], 7), round(r['frontBearing'], 2)
sp['rows'] = rows
sp['georeference']['street_fit'] = {'shift_m': [round(s[0], 2), round(s[1], 2)], 'scale': round(1 + k, 4), 'rotation_deg': round(-math.degrees(w), 3),
                                    'front_to_centreline_m': round(float(c), 2)}
json.dump(sp, open(path, 'w'), separators=(',', ':'))
q = lambda a: f"median {a[len(a) // 2]:.1f} m, 10-90% {a[len(a) // 10]:.1f}-{a[len(a) * 9 // 10]:.1f} m" if a else '-'
print(f"{proj}: shift {s[0]:+.2f} E {s[1]:+.2f} N, scale x{1 + k:.4f}, rotation {-math.degrees(w):+.2f} deg; house front -> street: before {q(before)}; after {q(after)}")

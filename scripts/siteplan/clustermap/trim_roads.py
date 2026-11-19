#!/usr/bin/env python3
"""Trim a project's generated street lines (block_roads.py) where they come closer than <clear_m> to a home's
centre: the part of the line inside that distance is cut out (the street stops short of the gardens).
  python trim_roads.py <project> <clear_m>
Only lines with source 'siteplan' generated between facing rows are touched; recorded in checks.roads.trimmed."""
import json, math, os, sys
APP = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
proj, clear = sys.argv[1], float(sys.argv[2])
p = os.path.join(APP, 'data', 'siteplans', f'{proj}.json'); sp = json.load(open(p))
KY = 110574.0; KX = 111320.0 * math.cos(math.radians(sp['rows'][0]['lat']))
homes = []
for r in sp['rows']:
    f = math.radians(r['frontBearing']); ax = (math.cos(f), -math.sin(f))  # along the row (east, north)
    n = r['units']
    for i, w in enumerate(r['unitWidths']):
        t = (i - (n - 1) / 2) * w
        homes.append((r['lng'] * KX + ax[0] * t, r['lat'] * KY + ax[1] * t))
def near(x, y):
    return min(math.hypot(x - hx, y - hy) for hx, hy in homes) < clear
out, cut = [], 0
for rd in sp['roads']:
    P = [(lo * KX, la * KY) for lo, la in rd['pts']]
    dense = []
    for i in range(len(P) - 1):
        L = math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]); k = max(1, int(L / 1.0))
        dense += [(P[i][0] + (P[i + 1][0] - P[i][0]) * j / k, P[i][1] + (P[i + 1][1] - P[i][1]) * j / k) for j in range(k)]
    dense.append(P[-1])
    run = []
    for q in dense:
        if near(*q):
            if len(run) > 1: out.append(dict(rd, pts=[[round(x / KX, 7), round(y / KY, 7)] for x, y in run]))
            if run: cut += 1
            run = []
        else:
            run.append(q)
    if len(run) > 1: out.append(dict(rd, pts=[[round(x / KX, 7), round(y / KY, 7)] for x, y in run]))
out = [r for r in out if sum(math.hypot((a[0] - b[0]) * KX, (a[1] - b[1]) * KY) for a, b in zip(r['pts'], r['pts'][1:])) > 8]
sp['roads'] = out
sp.setdefault('checks', {}).setdefault('roads', {})['trimmed'] = {'clear_m': clear, 'cuts': cut, 'lines': len(out)}
json.dump(sp, open(p, 'w'), separators=(',', ':'))
print(f'{proj}: {cut} cuts, {len(out)} street lines kept (clear {clear} m of every home centre)')

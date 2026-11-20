#!/usr/bin/env python3
"""The Valley: drop what only served satellite-detected roofs that belong to no project (no longer drawn as homes,
js/main.js): generated access streets (source 'derived') with no home within 45 m, and vegetation-detected lawn
patches (kind 'lawn') with no home within 60 m (yards of site cabins / construction compounds). Parks, golf and
mapped (OpenStreetMap / cluster-map) streets are kept. Also removes the planned lawn bases of the projects in NO_BASE.
  python3 scripts/valley_drop_orphans.py      (after derive_site.py)
"""
import json, math, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from derive_site import NO_BASE  # noqa: E402

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KY = 110574.0; KX = 111320.0 * math.cos(math.radians(25.0))


def main():
    hd = json.load(open(os.path.join(APP, 'data', 'homes_detected.json')))['communities']['the-valley']
    nara = json.load(open(os.path.join(APP, 'data', 'nara_data.json')))['units']
    homes = [(r['lng'] * KX, r['lat'] * KY) for r in hd if r.get('project') or r.get('placement') != 'estimated-satellite']
    homes += [(u['lon'] * KX, u['lat'] * KY) for u in nara]
    grid = {}
    for p in homes:
        grid.setdefault((int(p[0] // 60), int(p[1] // 60)), []).append(p)
    def near(x, y, d):
        gx, gy = int(x // 60), int(y // 60)
        return any(math.hypot(x - a, y - b) < d for i in (-2, -1, 0, 1, 2) for j in (-2, -1, 0, 1, 2) for a, b in grid.get((gx + i, gy + j), []))
    sp = os.path.join(APP, 'data', 'site.json'); site = json.load(open(sp))
    st = site['communities']['the-valley']['streets']; keep = []; dropped = 0
    for s in st:
        if s.get('source') == 'derived':
            P = [(lo * KX, la * KY) for lo, la in s['pts']]
            dense = [(P[i][0] + (P[i + 1][0] - P[i][0]) * t / 10, P[i][1] + (P[i + 1][1] - P[i][1]) * t / 10) for i in range(len(P) - 1) for t in range(11)]
            if not any(near(x, y, 45) for x, y in dense):
                dropped += 1; continue
        keep.append(s)
    site['communities']['the-valley']['streets'] = keep
    json.dump(site, open(sp, 'w'))
    gp = os.path.join(APP, 'data', 'greens.json'); g = json.load(open(gp))
    L = g['communities']['the-valley']; out = []; lawns = bases = 0
    for x in L:
        if x.get('kind') == 'base' and x.get('project') in NO_BASE:
            bases += 1; continue
        if x.get('kind') == 'lawn':
            P = [(lo * KX, la * KY) for lo, la in x['ring']]
            if not any(near(px, py, 60) for px, py in P):
                lawns += 1; continue
        out.append(x)
    g['communities']['the-valley'] = out
    json.dump(g, open(gp, 'w'), separators=(',', ':'))
    print(f'the-valley: dropped {dropped} orphan access streets (of {len(st)}), {lawns} lawn patches away from homes, {bases} planned bases')


if __name__ == '__main__':
    main()

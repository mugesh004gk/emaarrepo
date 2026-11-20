#!/usr/bin/env python3
"""Trim generated access streets (source 'derived', scripts/derive_site.py) of the given projects so they end
8 m past the last home they serve, instead of running on over open desert (Avelia / Ovelle: one ran 86 m past its
rows, across the Dubai-Al Ain road ramp, to Elea's edge). A street is the project's when part of it lies within
40 m of the project's homes; it is cut to the stretch within 35 m of those homes, plus 8 m at each end (homes of
other projects there have their own cluster-map streets).
  python3 scripts/trim_derived_streets.py <community> <project> [...]     (run after derive_site.py)
"""
import json, math, os, sys

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KY = 110574.0


def main():
    cid, pids = sys.argv[1], set(sys.argv[2:])
    path = os.path.join(APP, 'data', 'site.json'); site = json.load(open(path))
    hd = json.load(open(os.path.join(APP, 'data', 'homes_detected.json')))['communities'][cid]
    KX = 111320 * math.cos(math.radians(hd[0]['lat']))
    mine, allh = [], []
    for r in hd:
        f = math.radians(r['frontBearing']); ax = (math.cos(f), -math.sin(f)); n = r['units']; ws = r.get('unitWidths') or [r['L'] / n] * n
        for i, w in enumerate(ws):
            t = (i - (n - 1) / 2) * w; q = (r['lng'] * KX + ax[0] * t, r['lat'] * KY + ax[1] * t)
            allh.append(q)
            if r.get('project') in pids: mine.append(q)
    dmin = lambda q, L: min(math.hypot(q[0] - a, q[1] - b) for a, b in L)
    for s in site['communities'][cid]['streets']:
        if s.get('source') != 'derived' or len(s['pts']) != 2:
            continue
        (x0, y0), (x1, y1) = [(lo * KX, la * KY) for lo, la in s['pts']]
        L = math.hypot(x1 - x0, y1 - y0); m = max(2, int(L / 2))
        ts = [j / m for j in range(m + 1)]
        P = [(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t) for t in ts]
        if min(dmin(q, mine) for q in P) > 40:
            continue
        used = [t for t, q in zip(ts, P) if dmin(q, mine) < 35]
        a, b = max(0, min(used) - 8 / L), min(1, max(used) + 8 / L)
        if a <= 1e-3 and b >= 1 - 1e-3:
            continue
        nx0, ny0, nx1, ny1 = x0 + (x1 - x0) * a, y0 + (y1 - y0) * a, x0 + (x1 - x0) * b, y0 + (y1 - y0) * b
        s['pts'] = [[round(nx0 / KX, 7), round(ny0 / KY, 7)], [round(nx1 / KX, 7), round(ny1 / KY, 7)]]
        s['trimmed'] = f'to its homes + 8 m (was {L:.0f} m, now {L * (b - a):.0f} m) - scripts/trim_derived_streets.py'
        print(s['trimmed'])
    json.dump(site, open(path, 'w'))


if __name__ == '__main__':
    main()

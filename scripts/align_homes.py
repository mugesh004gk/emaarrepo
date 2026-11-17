#!/usr/bin/env python3
"""Align rows to their neighbourhood grid. For each row, the dominant direction of the rows within
150 m (length-weighted, 90-degree symmetric) is found; the row is rotated onto it when it is within
30 degrees, or always when it is a short piece (< 20 m) in a neighbourhood with a clear grid.
Run before clean_homes.py.  python3 scripts/align_homes.py"""
import json, math, os, cmath
APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
path = os.path.join(APP, 'data', 'homes_detected.json')
hd = json.load(open(path))
for cid, rows in hd['communities'].items():
    rs = [r for r in rows if r.get('kind') != 'apartment' and r.get('source') != 'planned']
    P = [(r['lng'] * 101000.0, r['lat'] * 110574.0) for r in rs]
    grid = {}
    for i, (x, y) in enumerate(P):
        grid.setdefault((int(x // 150), int(y // 150)), []).append(i)
    new, n = [], 0
    for i, r in enumerate(rs):
        x, y = P[i]
        s = 0j; tot = 0.0
        for gx in (-1, 0, 1):
            for gy in (-1, 0, 1):
                for j in grid.get((int(x // 150) + gx, int(y // 150) + gy), []):
                    if math.hypot(P[j][0] - x, P[j][1] - y) < 150:
                        w = rs[j]['L']
                        s += w * cmath.exp(1j * math.radians(rs[j]['frontBearing'] * 4)); tot += w
        if tot == 0 or abs(s) / tot < 0.45:
            new.append(r['frontBearing']); continue
        dom = math.degrees(cmath.phase(s)) / 4
        d = ((dom - r['frontBearing'] + 45) % 90) - 45
        if abs(d) < 30 or r['L'] < 20:
            new.append(round((r['frontBearing'] + d) % 360, 2)); n += abs(d) > 0.5
        else:
            new.append(r['frontBearing'])
    for r, b in zip(rs, new):
        r['frontBearing'] = b
    print(f'{cid}: aligned {n} of {len(rs)} rows to their neighbourhood grid')
# second pass: rows that share a street front (same direction, fronts within 5 m, neighbours along the
# line within 45 m) are moved onto one straight front line
for cid, rows in hd['communities'].items():
    rs = [r for r in rows if r.get('kind') != 'apartment' and r.get('source') != 'planned']
    info = []
    for r in rs:
        a_ = math.radians(r['frontBearing']); f = (math.sin(a_), math.cos(a_)); u = (f[1], -f[0])
        x, y = r['lng'] * 101000.0, r['lat'] * 110574.0
        info.append([f, u, x, y, x * f[0] + y * f[1] + r['D'] / 2, x * u[0] + y * u[1]])
    order = sorted(range(len(rs)), key=lambda i: (round(rs[i]['frontBearing'] / 2), info[i][4]))
    used = [False] * len(rs); moved = 0
    for i in order:
        if used[i]: continue
        grp = [i]; used[i] = True
        for j in order:
            if used[j]: continue
            db = abs((rs[j]['frontBearing'] - rs[i]['frontBearing'] + 180) % 360 - 180)
            if db > 2: continue
            fj = info[j][2] * info[i][0][0] + info[j][3] * info[i][0][1] + rs[j]['D'] / 2
            if abs(fj - info[i][4]) > 5: continue
            tj = info[j][2] * info[i][1][0] + info[j][3] * info[i][1][1]
            if any(abs(tj - (info[k][2] * info[i][1][0] + info[k][3] * info[i][1][1])) < (rs[j]['L'] + rs[k]['L']) / 2 + 45 for k in grp):
                grp.append(j); used[j] = True
        if len(grp) < 2: continue
        f = info[i][0]
        fronts = sorted((info[k][2] * f[0] + info[k][3] * f[1] + rs[k]['D'] / 2, rs[k]['L']) for k in grp)
        half = sum(w for _, w in fronts) / 2; acc = 0; target = fronts[0][0]
        for v, w in fronts:
            acc += w
            if acc >= half: target = v; break
        for k in grp:
            d = target - (info[k][2] * f[0] + info[k][3] * f[1] + rs[k]['D'] / 2)
            if abs(d) > 0.05:
                rs[k]['lng'] = round((info[k][2] + f[0] * d) / 101000.0, 7); rs[k]['lat'] = round((info[k][3] + f[1] * d) / 110574.0, 7); moved += 1
                rs[k]['frontBearing'] = rs[i]['frontBearing']
    print(f'{cid}: {moved} rows moved onto shared front lines')
json.dump(hd, open(path, 'w'), separators=(',', ':'))
sp = os.path.join(APP, 'data', 'site.json'); sd = json.load(open(sp))
for c in sd['communities'].values(): c['streets'] = [x for x in c['streets'] if x.get('source') != 'derived']
json.dump(sd, open(sp, 'w'))

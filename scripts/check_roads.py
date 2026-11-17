#!/usr/bin/env python3
"""Check: rows of homes whose 3D model (house + carport + driveway, as built in js/valley-detail.js)
reaches onto a carriageway. Prints per community: rows / homes on a road, and rows with no street.
  python3 scripts/check_roads.py [homes_detected.json] [site.json]"""
import json, math, os, sys

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KY = 110574.0


def plot_front(r):
    return max(r['D'] / 2, 17.4 - r['D'] / 2)


def seg_d(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    l2 = vx * vx + vy * vy or 1
    t = max(0, min(1, ((px - ax) * vx + (py - ay) * vy) / l2))
    return math.hypot(px - ax - vx * t, py - ay - vy * t)


def main():
    hd = json.load(open(sys.argv[1] if len(sys.argv) > 1 else os.path.join(APP, 'data', 'homes_detected.json')))
    site = json.load(open(sys.argv[2] if len(sys.argv) > 2 else os.path.join(APP, 'data', 'site.json')))
    for cid, rows in hd['communities'].items():
        KX = 111320.0 * math.cos(math.radians(rows[0]['lat']))
        segs = []
        for s in site['communities'][cid]['streets']:
            if s['cls'] == 'path':
                continue
            p = [(lo * KX, la * KY) for lo, la in s['pts']]
            segs += [(p[i][0], p[i][1], p[i + 1][0], p[i + 1][1], (s.get('width') or 7.3) / 2, s.get('source') == 'derived') for i in range(len(p) - 1)]
        grid = {}
        for sg in segs:
            for gx in range(int(min(sg[0], sg[2]) // 50) - 1, int(max(sg[0], sg[2]) // 50) + 2):
                for gy in range(int(min(sg[1], sg[3]) // 50) - 1, int(max(sg[1], sg[3]) // 50) + 2):
                    grid.setdefault((gx, gy), []).append(sg)
        on_mapped = on_derived = homes_on = 0
        no_street = 0
        total = 0
        for r in rows:
            if r.get('kind') == 'apartment':
                continue
            total += 1
            a = math.radians(r['frontBearing'])
            f = (math.sin(a), math.cos(a)); u = (f[1], -f[0])
            cx, cy = r['lng'] * KX, r['lat'] * KY
            pf = plot_front(r)
            pts = [(cx + u[0] * r['L'] / 2 * k + f[0] * dz, cy + u[1] * r['L'] / 2 * k + f[1] * dz)
                   for k in (-0.9, -0.45, 0, 0.45, 0.9) for dz in (-r['D'] / 2, 0, pf * 0.5, pf - 0.3)]
            hit = None
            for (x, y) in pts:
                for sg in grid.get((int(x // 50), int(y // 50)), []):
                    if seg_d(x, y, *sg[:4]) < sg[4] - 0.2:
                        hit = sg
                        break
                if hit:
                    break
            if hit:
                homes_on += r['units']
                if hit[5]: on_derived += 1
                else: on_mapped += 1
            F = (cx + f[0] * (pf + 5.65), cy + f[1] * (pf + 5.65))
            if min([seg_d(F[0], F[1], *sg[:4]) for sg in grid.get((int(F[0] // 50), int(F[1] // 50)), [])] or [1e9]) > 15:
                no_street += 1
        print(f'{cid}: {total} rows; on a road: {on_mapped + on_derived} rows ({homes_on} homes; mapped {on_mapped}, access {on_derived}); no street in front: {no_street}')


if __name__ == '__main__':
    main()

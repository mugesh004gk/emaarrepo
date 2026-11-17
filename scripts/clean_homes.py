#!/usr/bin/env python3
"""Final clean-up of data/homes_detected.json, run after detection, clipping and the footprint merge:
1. Snap each row's angle to the nearest street when they differ by < 20 degrees (rows run along
   their street), and face the row to that street.
2. Drop homes standing on a mapped street (road width + 1 m) or on water (lakes, ponds, pools).
3. Drop overlaps: rows sorted by confidence (mapped footprint > large > small); a row is removed when
   more than 12 % of its area is already taken by a kept row. No two homes ever intersect.
  python3 scripts/clean_homes.py"""
import json, math, os

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KY = 110574.0


def rect(r, KX, pad=0.0):
    a = math.radians(r['frontBearing'])
    f = (math.sin(a), math.cos(a)); u = (f[1], -f[0])
    cx, cy = r['lng'] * KX, r['lat'] * KY
    L, D = r['L'] / 2 + pad, r['D'] / 2 + pad
    return [(cx + u[0] * sx * L + f[0] * sy * D, cy + u[1] * sx * L + f[1] * sy * D) for sx, sy in ((1, 1), (-1, 1), (-1, -1), (1, -1))]


def clip(subject, clipper):
    """Sutherland-Hodgman (clipper convex, counter-clockwise or clockwise both handled)."""
    def inside(p, a, b, s):
        return s * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) >= 0
    def inter(p, q, a, b):
        x1, y1, x2, y2, x3, y3, x4, y4 = *p, *q, *a, *b
        d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
        if abs(d) < 1e-12:
            return q
        t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / d
        return (x1 + t * (x2 - x1), y1 + t * (y2 - y1))
    s = 1 if area_signed(clipper) > 0 else -1
    out = subject
    for i in range(len(clipper)):
        a, b = clipper[i], clipper[(i + 1) % len(clipper)]
        inp, out = out, []
        if not inp:
            break
        for j in range(len(inp)):
            p, q = inp[j - 1], inp[j]
            if inside(q, a, b, s):
                if not inside(p, a, b, s):
                    out.append(inter(p, q, a, b))
                out.append(q)
            elif inside(p, a, b, s):
                out.append(inter(p, q, a, b))
    return out


def area_signed(p):
    return sum(p[i][0] * p[(i + 1) % len(p)][1] - p[(i + 1) % len(p)][0] * p[i][1] for i in range(len(p))) / 2


def seg_dist(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    l2 = vx * vx + vy * vy or 1
    t = max(0, min(1, ((px - ax) * vx + (py - ay) * vy) / l2))
    return math.hypot(px - ax - vx * t, py - ay - vy * t), t, (vx, vy)


def inpoly(x, y, poly):
    ins, j = False, len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]; xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            ins = not ins
        j = i
    return ins


def main():
    path = os.path.join(APP, 'data', 'homes_detected.json')
    data = json.load(open(path))
    site = json.load(open(os.path.join(APP, 'data', 'site.json')))['communities']
    for cid, rows in data['communities'].items():
        if not rows:
            continue
        KX = 111320.0 * math.cos(math.radians(rows[0]['lat']))
        segs = []
        for s in site.get(cid, {}).get('streets', []):
            if s['cls'] == 'path':
                continue
            p = [(lo * KX, la * KY) for lo, la in s['pts']]
            for i in range(len(p) - 1):
                segs.append((*p[i], *p[i + 1], s['width']))
        sg = {}
        for k, (ax, ay, bx, by, w) in enumerate(segs):
            for gx in range(int(min(ax, bx) // 50) - 1, int(max(ax, bx) // 50) + 2):
                for gy in range(int(min(ay, by) // 50) - 1, int(max(ay, by) // 50) + 2):
                    sg.setdefault((gx, gy), []).append(k)
        water = [[(lo * KX, la * KY) for lo, la in w['ring']] for w in site.get(cid, {}).get('water', [])]
        snapped = dropped_road = dropped_water = 0
        keep1 = []
        for r in rows:
            cx, cy = r['lng'] * KX, r['lat'] * KY
            near = []
            for k in sg.get((int(cx // 50), int(cy // 50)), []):
                ax, ay, bx, by, w = segs[k]
                d, t, v = seg_dist(cx, cy, ax, ay, bx, by)
                near.append((d, w, v, ax + v[0] * t, ay + v[1] * t))
            near.sort()
            # 1. snap to the nearest street when nearly parallel
            if near and near[0][0] < 45 and r.get('kind') != 'apartment':
                d, w, (vx, vy), px, py = near[0]
                street_ang = math.degrees(math.atan2(vx, vy)) % 180  # bearing of the street axis
                a = math.radians(r['frontBearing'])
                row_ang = (math.degrees(math.atan2(math.cos(a), -math.sin(a)))) % 180  # bearing of the row's long axis
                diff = (street_ang - row_ang + 90) % 180 - 90
                if abs(diff) < 8:  # small corrections only: the neighbourhood grid (align_homes) wins
                    # face the street: front direction = perpendicular to the street, pointing at it
                    nx, ny = -vy, vx
                    nl = math.hypot(nx, ny) or 1
                    nx, ny = nx / nl, ny / nl
                    if (px - cx) * nx + (py - cy) * ny < 0:
                        nx, ny = -nx, -ny
                    r['frontBearing'] = round((math.degrees(math.atan2(nx, ny)) + 360) % 360, 2)
                    snapped += 1
            # 2. off roads and water
            corners = rect(r, KX, pad=-0.5)
            on_road = False
            for (d, w, v, px, py) in near:
                if d > 60:
                    break
            for k in sg.get((int(cx // 50), int(cy // 50)), []):
                ax, ay, bx, by, w = segs[k]
                hits = sum(seg_dist(x, y, ax, ay, bx, by)[0] < w / 2 + 0.5 for x, y in corners + [(cx, cy)])
                if hits >= 2:
                    on_road = True
                    break
            if on_road:
                dropped_road += 1
                continue
            if any(inpoly(cx, cy, wp) for wp in water):
                dropped_water += 1
                continue
            keep1.append(r)
        # 3. overlaps
        def prio(r):
            return (0 if r.get('source') == 'footprint' else 1, -r['L'] * r['D'])
        keep1.sort(key=prio)
        grid, kept = {}, []
        dropped_ov = 0
        for r in keep1:
            poly = rect(r, KX)
            cx, cy = r['lng'] * KX, r['lat'] * KY
            area = r['L'] * r['D']
            taken = 0.0
            cand = set()
            for gx in range(int(cx // 40) - 2, int(cx // 40) + 3):
                for gy in range(int(cy // 40) - 2, int(cy // 40) + 3):
                    cand.update(grid.get((gx, gy), []))
            for k in cand:
                ov = clip(poly, kept[k][1])
                if len(ov) >= 3:
                    taken += abs(area_signed(ov))
            if taken > 0.12 * area:
                dropped_ov += 1
                continue
            kept.append((r, poly))
            idx = len(kept) - 1
            for gx in range(int(cx // 40) - 1, int(cx // 40) + 2):
                for gy in range(int(cy // 40) - 1, int(cy // 40) + 2):
                    grid.setdefault((gx, gy), []).append(idx)
        data['communities'][cid] = [r for r, _ in kept]
        print(f'{cid}: {len(kept)} rows ({sum(r["units"] for r, _ in kept)} homes); aligned {snapped} to streets; removed {dropped_ov} overlapping, {dropped_road} on roads, {dropped_water} on water')
    json.dump(data, open(path, 'w'), separators=(',', ':'))


if __name__ == '__main__':
    main()

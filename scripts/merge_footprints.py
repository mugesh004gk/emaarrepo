#!/usr/bin/env python3
"""Add homes from mapped building footprints (Overture Maps: OpenStreetMap + Microsoft) wherever the
imagery detector has not placed a home. Exact outlines -> exact position, size and orientation.
  python3 scripts/merge_footprints.py <overture_buildings.json>
Input: {cid: [{src, geom (GeoJSON Polygon), ...}]} downloaded from
s3://overturemaps-us-west-2/release/<release>/theme=buildings/type=building (bbox of each compound)."""
import json, math, os, sys

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KY = 110574.0


def inpoly(x, y, poly):
    ins, j = False, len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]; xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            ins = not ins
        j = i
    return ins


def min_rect(pts):
    """Minimum-area rectangle of a convex-ish ring (metres): centre, long-axis unit, L, D."""
    best = None
    n = len(pts)
    for i in range(n):
        (x0, y0), (x1, y1) = pts[i], pts[(i + 1) % n]
        ex, ey = x1 - x0, y1 - y0
        l = math.hypot(ex, ey)
        if l < 0.5:
            continue
        ux, uy = ex / l, ey / l
        a = [px * ux + py * uy for px, py in pts]
        b = [-px * uy + py * ux for px, py in pts]
        area = (max(a) - min(a)) * (max(b) - min(b))
        if best is None or area < best[0]:
            ca, cb = (max(a) + min(a)) / 2, (max(b) + min(b)) / 2
            best = (area, (ca * ux - cb * uy, ca * uy + cb * ux), (ux, uy), max(a) - min(a), max(b) - min(b))
    _, c, u, la, lb = best
    if lb > la:
        u, la, lb = (-u[1], u[0]), lb, la
    return c, u, la, lb


def convex_hull(points):
    p = sorted(set(points))
    cr = lambda o, a, b: (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lo, up = [], []
    for q in p:
        while len(lo) >= 2 and cr(lo[-2], lo[-1], q) <= 0: lo.pop()
        lo.append(q)
    for q in reversed(p):
        while len(up) >= 2 and cr(up[-2], up[-1], q) <= 0: up.pop()
        up.append(q)
    return lo[:-1] + up[:-1]


def seg_m(lo, la, a, b, kx):
    """distance in metres from (lo, la) to the segment a-b (lon/lat)"""
    px, py = lo * kx, la * KY
    ax, ay, bx, by = a[0] * kx, a[1] * KY, b[0] * kx, b[1] * KY
    vx, vy = bx - ax, by - ay
    l2 = vx * vx + vy * vy or 1
    t = max(0, min(1, ((px - ax) * vx + (py - ay) * vy) / l2))
    return math.hypot(px - ax - vx * t, py - ay - vy * t)


def poly_area(pts):
    return abs(sum(pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1] for i in range(len(pts)))) / 2


def main(src_path):
    over = json.load(open(src_path))
    comp = json.load(open(os.path.join(APP, 'data', 'compounds.json')))
    site = json.load(open(os.path.join(APP, 'data', 'site.json')))['communities']
    projects = json.load(open(os.path.join(APP, 'data', 'projects.json')))
    nara = json.load(open(os.path.join(APP, 'data', 'nara_data.json')))
    path = os.path.join(APP, 'data', 'homes_detected.json')
    data = json.load(open(path))
    nlat = [u['lat'] for u in nara['units']]; nlon = [u['lon'] for u in nara['units']]
    # Nara's own 372 modelled homes: skip footprints inside the outline of its homes (+8 m), not its
    # lat/lon bounding box, whose corners reach over the neighbouring Eden blocks
    nara_hull = convex_hull([(lo, la) for la, lo in zip(nlat, nlon)])
    def in_nara(lo, la):
        if inpoly(lo, la, nara_hull):
            return True
        kx = 111320.0 * math.cos(math.radians(la))
        return min(seg_m(lo, la, nara_hull[i], nara_hull[(i + 1) % len(nara_hull)], kx) for i in range(len(nara_hull))) < 8
    sys.path.insert(0, os.path.join(APP, 'scripts', 'satellite'))
    kinds = {}
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location('rv2', os.path.join(APP, 'scripts', 'satellite', 'run_v2.py'))
    except Exception:
        spec = None
    for cid, feats in over.items():
        rows = [r for r in data['communities'].get(cid, []) if r.get('source') != 'footprint']
        lat0 = comp[cid][0][0][1]
        KX = 111320.0 * math.cos(math.radians(lat0))
        # existing homes as rectangles (metres) on a 40 m grid
        grid = {}
        def add(cx, cy, u, L, D):
            for gx in range(int((cx - 60) // 40), int((cx + 60) // 40) + 1):
                for gy in range(int((cy - 60) // 40), int((cy + 60) // 40) + 1):
                    grid.setdefault((gx, gy), []).append((cx, cy, u, L, D))
        for r in rows:
            a = math.radians(r['frontBearing'])
            f = (math.sin(a), math.cos(a))
            add(r['lng'] * KX, r['lat'] * KY, (f[1], -f[0]), r['L'], r['D'])
        def covered(x, y):
            for (cx, cy, u, L, D) in grid.get((int(x // 40), int(y // 40)), []):
                dx, dy = x - cx, y - cy
                if abs(dx * u[0] + dy * u[1]) <= L / 2 + 1 and abs(-dx * u[1] + dy * u[0]) <= D / 2 + 1:
                    return True
            return False
        streets = [[(lo * KX, la * KY) for lo, la in s['pts']] for s in site.get(cid, {}).get('streets', []) if s['cls'] != 'path']
        c = next(x for x in projects['communities'] if x['id'] == cid)
        pins = [(p['id'], p['lat'], p['lng']) for p in c['projects'] if not p.get('pinFlag') and p['id'] != 'nara']
        added = 0
        for ft in feats:
            g = ft['geom']
            if g['type'] != 'Polygon':
                continue
            ring = g['coordinates'][0][:-1]
            clo = sum(p[0] for p in ring) / len(ring); cla = sum(p[1] for p in ring) / len(ring)
            if not any(inpoly(clo, cla, r) for r in comp[cid]):
                continue
            if cid == 'the-valley' and in_nara(clo, cla):
                continue
            pts = [(lo * KX, la * KY) for lo, la in ring]
            area = poly_area(pts)
            if area < 70 or area > 3000:
                continue
            (cx, cy), u, L, D = min_rect(pts)
            if D < 6 or L > 140 or area / (L * D) < 0.55:
                continue
            # skip when an existing home covers most of it (centre and two ends)
            probes = [(cx, cy), (cx + u[0] * L * 0.35, cy + u[1] * L * 0.35), (cx - u[0] * L * 0.35, cy - u[1] * L * 0.35)]
            if sum(covered(x, y) for x, y in probes) >= 2:
                continue
            # front = side of the nearest street
            n = (-u[1], u[0])
            best = None
            for st in streets:
                for i in range(len(st) - 1):
                    (ax, ay), (bx, by) = st[i], st[i + 1]
                    vx, vy = bx - ax, by - ay
                    l2 = vx * vx + vy * vy or 1
                    t = max(0, min(1, ((cx - ax) * vx + (cy - ay) * vy) / l2))
                    px, py = ax + vx * t, ay + vy * t
                    d = math.hypot(px - cx, py - cy)
                    if best is None or d < best[0]:
                        best = (d, px, py)
            f = n
            if best and (best[1] - cx) * n[0] + (best[2] - cy) * n[1] < 0:
                f = (-n[0], -n[1])
            bearing = (math.degrees(math.atan2(f[0], f[1])) + 360) % 360
            lat, lng = cy / KY, cx / KX
            pid = min(pins, key=lambda q: (q[1] - lat) ** 2 + ((q[2] - lng) * math.cos(math.radians(lat))) ** 2)[0]
            villa = area < 520 and L < 32
            if villa:
                widths = [L]
            else:
                k = max(1, round(L / 7.6))
                widths = [L / k] * k
            rows.append({'lat': round(lat, 7), 'lng': round(lng, 7), 'L': round(L, 2), 'D': round(D, 2), 'frontBearing': round(bearing, 2),
                         'kind': 'villa' if villa else 'townhouse', 'units': len(widths), 'unitWidths': [round(w, 2) for w in widths],
                         'streetConf': 1.0, 'project': pid, 'source': 'footprint', 'footprintSource': ft['src']})
            add(cx, cy, u, L, D)
            added += 1
        data['communities'][cid] = rows
        print(f'{cid}: +{added} homes from mapped footprints ({sum(r["units"] for r in rows)} homes in total)')
    json.dump(data, open(path, 'w'), separators=(',', ':'))


if __name__ == '__main__':
    main(sys.argv[1])

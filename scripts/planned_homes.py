#!/usr/bin/env python3
"""Illustrative planned layouts for projects that are not built yet (open land in the imagery), so
selecting them shows homes in 3D. Rows of the project's home type (townhouse / villa) are laid out on
the open land around the project pin, parallel to the nearest street, avoiding built homes, roads,
water and the compound edge. Marked source='planned' (the app labels them as planned, illustrative).
Run after assign_projects.py.  python3 scripts/planned_homes.py"""
import json, math, os, sys

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(APP, 'scripts', 'satellite'))
from run_v2 import PROJECT_KIND  # noqa: E402

KY = 110574.0


def inpoly(x, y, poly):
    ins, j = False, len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]; xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            ins = not ins
        j = i
    return ins


def seg_d(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    l2 = vx * vx + vy * vy or 1
    t = max(0, min(1, ((px - ax) * vx + (py - ay) * vy) / l2))
    return math.hypot(px - ax - vx * t, py - ay - vy * t), (vx, vy)


def main():
    pj = json.load(open(os.path.join(APP, 'data', 'projects.json')))
    st = json.load(open(os.path.join(APP, 'data', 'project_status.json')))
    comp = json.load(open(os.path.join(APP, 'data', 'compounds.json')))
    site = json.load(open(os.path.join(APP, 'data', 'site.json')))['communities']
    path = os.path.join(APP, 'data', 'homes_detected.json')
    hd = json.load(open(path))
    for c in pj['communities']:
        cid = c['id']
        rows = [r for r in hd['communities'][cid] if r.get('source') != 'planned']
        KX = 111320.0 * math.cos(math.radians(c['center']['lat']))
        built = [(r['lng'] * KX, r['lat'] * KY, max(r['L'], r['D']) / 2 + 6) for r in rows]
        segs = []
        for s in site.get(cid, {}).get('streets', []):
            if s['cls'] == 'path':
                continue
            p = [(lo * KX, la * KY) for lo, la in s['pts']]
            segs += [(*p[i], *p[i + 1], s['width']) for i in range(len(p) - 1)]
        rings = [[(lo * KX, la * KY) for lo, la in r] for r in comp[cid]]
        kinds = PROJECT_KIND.get(cid, {})
        added = []
        planned_spots = []

        def place(px, py, u, n, L, D, row_gap, n_rows, kind, n_units, unit_w, pid):
            out = []
            for k in range(n_rows):
                for half in (-1, 1):
                    off = (k + 0.5) * row_gap * half
                    cx, cy = px + n[0] * off, py + n[1] * off
                    corners = [(cx + u[0] * a * L / 2 + n[0] * b * D / 2, cy + u[1] * a * L / 2 + n[1] * b * D / 2) for a in (-1, 0, 1) for b in (-1, 1)]
                    if not all(any(inpoly(x, y, r) for r in rings) for x, y in corners):
                        continue
                    if any(math.hypot(x - bx, y - by) < br for x, y in corners + [(cx, cy)] for bx, by, br in built):
                        continue
                    if any(seg_d(x, y, ax, ay, bx2, by2)[0] < w / 2 + 3 for x, y in corners + [(cx, cy)] for (ax, ay, bx2, by2, w) in segs):
                        continue
                    if any(math.hypot(cx - qx, cy - qy) < 25 for qx, qy in planned_spots + [(o[1], o[2]) for o in out]):
                        continue
                    f = (n[0] * half, n[1] * half)
                    bearing = (math.degrees(math.atan2(f[0], f[1])) + 360) % 360
                    out.append(({'lat': round(cy / KY, 7), 'lng': round(cx / KX, 7), 'L': round(L, 2), 'D': D, 'frontBearing': round(bearing, 2),
                                 'kind': kind, 'units': n_units, 'unitWidths': [unit_w] * n_units, 'streetConf': 0, 'project': pid, 'source': 'planned'}, cx, cy))
            return out
        for p in c['projects']:
            s0 = st.get(p['id'], {})
            if p.get('pinFlag') or s0.get('built') or p['id'] == 'nara':
                continue
            px, py = p['lng'] * KX, p['lat'] * KY
            kind = kinds.get(p['id']) or ('villa' if 'Villa' in (p.get('types') or []) and 'Townhouse' not in (p.get('types') or []) else 'townhouse')
            if cid == 'emaar-south' and 'Apartment' in (p.get('types') or []) and kind != 'villa':
                kind = 'townhouse'
            # street direction near the pin
            best = None
            for (ax, ay, bx, by, w) in segs:
                d, v = seg_d(px, py, ax, ay, bx, by)
                if best is None or d < best[0]:
                    best = (d, v)
            ang = math.atan2(best[1][1], best[1][0]) if best and best[0] < 400 else 0.0
            u = (math.cos(ang), math.sin(ang))  # along rows
            n = (-u[1], u[0])  # across rows
            if kind == 'villa':
                unit_w, D, row_gap, n_units, n_rows = 16.0, 14.0, 34.0, 6, 4
            else:
                unit_w, D, row_gap, n_units, n_rows = 7.6, 12.0, 30.0, 10, 4
            L = unit_w * n_units
            # search open land near the pin: the centre that fits the most rows wins
            best_rows = []
            for rad in (0, 40, 80, 120, 160, 200, 250):
                for t in range(1 if rad == 0 else 8):
                    a_ = t * math.pi / 4
                    cand = place(px + math.cos(a_) * rad, py + math.sin(a_) * rad, u, n, L, D, row_gap, n_rows, kind, n_units, unit_w, p['id'])
                    if len(cand) > len(best_rows):
                        best_rows = cand
                if len(best_rows) >= 6:
                    break
            for r, cx, cy in best_rows:
                added.append(r)
                planned_spots.append((cx, cy))
                built.append((cx, cy, L / 2 + 4))
            s0['planned'] = sum(r['units'] for r in added if r['project'] == p['id'])
            st[p['id']] = s0
            continue
            for k in range(n_rows):
                for half in (-1, 1):  # rows on both sides of the pin
                    off = (k + 0.5) * row_gap * half
                    cx, cy = px + n[0] * off, py + n[1] * off
                    corners = [(cx + u[0] * a * L / 2 + n[0] * b * D / 2, cy + u[1] * a * L / 2 + n[1] * b * D / 2) for a in (-1, 0, 1) for b in (-1, 1)]
                    if not all(any(inpoly(x, y, r) for r in rings) for x, y in corners):
                        continue
                    if any(math.hypot(x - bx, y - by) < br for x, y in corners + [(cx, cy)] for bx, by, br in built):
                        continue
                    if any(seg_d(x, y, ax, ay, bx2, by2)[0] < w / 2 + 3 for x, y in corners + [(cx, cy)] for (ax, ay, bx2, by2, w) in segs):
                        continue
                    if any(math.hypot(cx - qx, cy - qy) < 25 for qx, qy in planned_spots):
                        continue
                    # face the pin's nearest street side (front toward +n for rows on that side)
                    f = (n[0] * half, n[1] * half)
                    bearing = (math.degrees(math.atan2(f[0], f[1])) + 360) % 360
                    r = {'lat': round(cy / KY, 7), 'lng': round(cx / KX, 7), 'L': round(L, 2), 'D': D, 'frontBearing': round(bearing, 2),
                         'kind': kind, 'units': n_units, 'unitWidths': [unit_w] * n_units, 'streetConf': 0, 'project': p['id'], 'source': 'planned'}
                    added.append(r)
                    planned_spots.append((cx, cy))
                    built.append((cx, cy, L / 2 + 4))
            s0['planned'] = sum(r['units'] for r in added if r['project'] == p['id'])
            st[p['id']] = s0
        for p in c['projects']:
            mine = [r for r in added if r['project'] == p['id']]
            if mine:
                st[p['id']]['centroid'] = [round(sum(r['lat'] for r in mine) / len(mine), 6), round(sum(r['lng'] for r in mine) / len(mine), 6)]
        hd['communities'][cid] = rows + added
        print(cid, {p['name']: st[p['id']].get('planned') for p in c['projects'] if p['id'] in st and 'planned' in st[p['id']]})
    json.dump(hd, open(path, 'w'), separators=(',', ':'))
    json.dump(st, open(os.path.join(APP, 'data', 'project_status.json'), 'w'), indent=0)


if __name__ == '__main__':
    main()

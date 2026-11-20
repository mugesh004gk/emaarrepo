#!/usr/bin/env python3
"""Streets and landscaping where OpenStreetMap has none.
 - Every home row (built or planned) gets an access street along its front when no mapped street runs
   within 12 m of it: 7.3 m carriageway, 4.5 m beyond the front of the row, a little longer than the row.
 - Each planned (not yet built) project gets a landscaped green base under its whole layout.
The app's street and park builders then add asphalt, kerbs, footpaths, verges, street trees, shrubs,
lawns, trees and park furniture to these like to any other street or park.
Writes streets with source='derived' into data/site.json and greens with source='planned' into
data/greens.json (previous derived/planned entries are replaced). Run last in the pipeline.
  python3 scripts/derive_site.py"""
import json, math, os

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KY = 110574.0
# planned projects shown on bare ground (not built yet, desert on the satellite): no landscaped lawn base
NO_BASE = {'avelia-at-the-valley', 'ovelle-at-the-valley'}


def plot_front(r):
    """front of the 3D home's plot (carport + driveway) in front of the row centre, metres"""
    return max(r['D'] / 2, 17.4 - r['D'] / 2)


def seg_d(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    l2 = vx * vx + vy * vy or 1
    t = max(0, min(1, ((px - ax) * vx + (py - ay) * vy) / l2))
    return math.hypot(px - ax - vx * t, py - ay - vy * t)


def main():
    site = json.load(open(os.path.join(APP, 'data', 'site.json')))
    greens = json.load(open(os.path.join(APP, 'data', 'greens.json')))
    hd = json.load(open(os.path.join(APP, 'data', 'homes_detected.json')))
    for cid, rows in hd['communities'].items():
        if cid not in site['communities'] or not rows:
            continue
        KX = 111320.0 * math.cos(math.radians(rows[0]['lat']))
        sc = site['communities'][cid]
        sc['streets'] = [s for s in sc['streets'] if s.get('source') != 'derived']
        mapped = []
        for s in sc['streets']:
            if s['cls'] == 'path':
                continue
            p = [(lo * KX, la * KY) for lo, la in s['pts']]
            mapped += [(p[i][0], p[i][1], p[i + 1][0], p[i + 1][1]) for i in range(len(p) - 1)]
        grid = {}
        def gadd(seg, store):
            ax, ay, bx, by = seg
            for gx in range(int(min(ax, bx) // 60) - 1, int(max(ax, bx) // 60) + 2):
                for gy in range(int(min(ay, by) // 60) - 1, int(max(ay, by) // 60) + 2):
                    store.setdefault((gx, gy), []).append(seg)
        for seg in mapped:
            gadd(seg, grid)
        derived = []
        dgrid = {}
        for r in rows:
            if r.get('kind') == 'apartment':
                continue
            a = math.radians(r['frontBearing'])
            f = (math.sin(a), math.cos(a)); u = (f[1], -f[0])
            cx, cy = r['lng'] * KX, r['lat'] * KY
            off = plot_front(r) + 2.0 + 3.65  # footpath + half the carriageway
            mx, my = cx + f[0] * off, cy + f[1] * off
            near = grid.get((int(mx // 60), int(my // 60)), [])
            if r.get('source') != 'planned' and any(seg_d(mx, my, *s) < 18 for s in near):  # a mapped street already runs in front of this row
                continue
            # an already-derived street here (neighbouring row on the same street)?
            dn = dgrid.get((int(mx // 60), int(my // 60)), [])
            if any(seg_d(mx, my, *s) < 4 for s in dn):
                continue
            half = r['L'] / 2 + 4
            seg = (mx - u[0] * half, my - u[1] * half, mx + u[0] * half, my + u[1] * half)
            derived.append(seg)
            gadd(seg, dgrid)
        derived = merge_segments(derived)
        derived = network(derived, mapped, rows, KX)
        derived = no_crossings(derived, mapped)
        for (ax, ay, bx, by) in derived:
            sc['streets'].append({'cls': 'minor', 'width': 7.3, 'source': 'derived',
                                  'pts': [[round(ax / KX, 7), round(ay / KY, 7)], [round(bx / KX, 7), round(by / KY, 7)]]})
        # second pass: rows that still have no street at their front (curved villa streets, short rows)
        curved = curved_access(rows, mapped + derived, KX)
        for line in curved:
            sc['streets'].append({'cls': 'minor', 'width': 7.3, 'source': 'derived',
                                  'pts': [[round(x / KX, 7), round(y / KY, 7)] for x, y in line]})
        # no floating road pieces: a short access street must join another street at one end at least
        allst = [x for x in sc['streets'] if x['cls'] != 'path']
        ends = []
        for x in allst:
            p = [(lo * KX, la * KY) for lo, la in x['pts']]
            ends.append(p)
        segall = [(p[i][0], p[i][1], p[i + 1][0], p[i + 1][1], k) for k, p in enumerate(ends) for i in range(len(p) - 1)]
        sgrid = {}
        for sg in segall:
            for gx in range(int(min(sg[0], sg[2]) // 50) - 1, int(max(sg[0], sg[2]) // 50) + 2):
                for gy in range(int(min(sg[1], sg[3]) // 50) - 1, int(max(sg[1], sg[3]) // 50) + 2):
                    sgrid.setdefault((gx, gy), []).append(sg)
        def joined(x, y, k):
            return any(sg[4] != k and seg_d(x, y, *sg[:4]) < 6 for sg in sgrid.get((int(x // 50), int(y // 50)), []))
        drop = set()
        for k, (x, p) in enumerate(zip(allst, ends)):
            if x.get('source') != 'derived': continue
            length = sum(math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]) for i in range(len(p) - 1))
            if length < 60 and not joined(*p[0], k) and not joined(*p[-1], k):
                drop.add(id(x))
        if drop:
            sc['streets'] = [x for x in sc['streets'] if id(x) not in drop]
            print(f'{cid}: removed {len(drop)} short access streets joined to no other street')
        if curved:
            print(f'{cid}: +{len(curved)} streets along curved / short rows ({sum(sum(math.hypot(l[i+1][0]-l[i][0], l[i+1][1]-l[i][1]) for i in range(len(l)-1)) for l in curved) / 1000:.1f} km)')
        # landscaped base under planned projects
        gl = [g for g in greens['communities'].get(cid, []) if g.get('source') != 'planned']
        by_proj = {}
        for r in rows:
            if r.get('source') == 'planned' and r['project'] not in NO_BASE:
                by_proj.setdefault(r['project'], []).append(r)
        for pid, rs in by_proj.items():
            pts = []
            for r in rs:
                a = math.radians(r['frontBearing'])
                f = (math.sin(a), math.cos(a)); u = (f[1], -f[0])
                cx, cy = r['lng'] * KX, r['lat'] * KY
                for sa in (-1, 1):
                    for sb in (-1, 1):
                        pts.append((cx + u[0] * sa * (r['L'] / 2 + 14) + f[0] * sb * (r['D'] / 2 + 14), cy + u[1] * sa * (r['L'] / 2 + 14) + f[1] * sb * (r['D'] / 2 + 14)))
            hull = convex_hull(pts)
            area = abs(sum(hull[i][0] * hull[(i + 1) % len(hull)][1] - hull[(i + 1) % len(hull)][0] * hull[i][1] for i in range(len(hull)))) / 2
            gl.append({'ring': [[round(x / KX, 7), round(y / KY, 7)] for x, y in hull], 'areaM2': round(area), 'kind': 'base', 'source': 'planned', 'project': pid})
        greens['communities'][cid] = gl
        print(f'{cid}: +{len(derived)} access streets ({sum(math.hypot(s[2]-s[0], s[3]-s[1]) for s in derived) / 1000:.1f} km), landscaped bases for {len(by_proj)} planned projects')
    json.dump(site, open(os.path.join(APP, 'data', 'site.json'), 'w'))
    json.dump(greens, open(os.path.join(APP, 'data', 'greens.json'), 'w'), separators=(',', ':'))


def _cross(a, b):
    (x1, y1, x2, y2), (x3, y3, x4, y4) = a, b
    d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3)
    if abs(d) < 1e-9: return False
    t = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d
    u = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d
    return 0.04 < t < 0.96 and 0.04 < u < 0.96


def no_crossings(lines, mapped):
    """Keep the longest streets first; drop any that cut through a mapped street or a kept street
    (touching at the ends, i.e. a T-junction, is allowed)."""
    kept = []
    for s in sorted(lines, key=lambda q: -math.hypot(q[2] - q[0], q[3] - q[1])):
        if any(_cross(s, m) for m in mapped) or any(_cross(s, k) for k in kept):
            continue
        kept.append(s)
    return kept


def network(lines, mapped, rows, KX):
    """Cut streets where they would run through a home, drop leftovers, extend ends to the next street."""
    rects = {}
    for r in rows:
        if r.get('kind') == 'apartment': continue
        a = math.radians(r['frontBearing']); f = (math.sin(a), math.cos(a)); u = (f[1], -f[0])
        cx, cy = r['lng'] * KX, r['lat'] * KY
        for gx in range(int((cx - 90) // 60), int((cx + 90) // 60) + 1):
            for gy in range(int((cy - 90) // 60), int((cy + 90) // 60) + 1):
                rects.setdefault((gx, gy), []).append((cx, cy, u, f, r['L'] / 2 + 2.2, r['D'] / 2 + 6.5, plot_front(r) + 1.0))
    def blocked(x, y):
        for (cx, cy, u, f, hl, back, front) in rects.get((int(x // 60), int(y // 60)), []):
            dx, dy = x - cx, y - cy
            dz = dx * f[0] + dy * f[1]
            if abs(dx * u[0] + dy * u[1]) < hl and -back < dz < front:
                return True
        return False
    runs = []
    for (ax, ay, bx, by) in lines:
        l = math.hypot(bx - ax, by - ay)
        if l < 1: continue
        ux, uy = (bx - ax) / l, (by - ay) / l
        t, start = 0.0, None
        while t <= l + 0.01:
            free = not blocked(ax + ux * t, ay + uy * t)
            if free and start is None: start = t
            if (not free or t + 2 > l) and start is not None:
                end = t if free else t - 2
                if end - start >= 20: runs.append([ax + ux * start, ay + uy * start, ax + ux * end, ay + uy * end])
                start = None
            t += 2
    def near_street(x, y, skip):
        for s_ in mapped:
            if seg_d(x, y, *s_) < 4: return True
        for k, s_ in enumerate(runs):
            if k != skip and seg_d(x, y, *s_) < 4: return True
        return False
    for k, rn in enumerate(runs):
        l = math.hypot(rn[2] - rn[0], rn[3] - rn[1]); ux, uy = (rn[2] - rn[0]) / l, (rn[3] - rn[1]) / l
        for end, sg in ((0, -1), (2, 1)):
            x, y = rn[end], rn[end + 1]
            if near_street(x, y, k): continue
            for step in range(2, 62, 2):
                px, py = x + ux * sg * step, y + uy * sg * step
                if blocked(px, py): break
                if near_street(px, py, k):
                    rn[end], rn[end + 1] = px + ux * sg * 3, py + uy * sg * 3
                    break
    return [tuple(r) for r in runs]


def make_blocked(rows, KX):
    """(x, y) -> True when the point lies on a home (row rectangle + 2.2 m along, + 3.2 m deep)."""
    rects = {}
    for r in rows:
        if r.get('kind') == 'apartment': continue
        a = math.radians(r['frontBearing']); f = (math.sin(a), math.cos(a)); u = (f[1], -f[0])
        cx, cy = r['lng'] * KX, r['lat'] * KY
        for gx in range(int((cx - 90) // 60), int((cx + 90) // 60) + 1):
            for gy in range(int((cy - 90) // 60), int((cy + 90) // 60) + 1):
                rects.setdefault((gx, gy), []).append((cx, cy, u, f, r['L'] / 2 + 2.2, r['D'] / 2 + 6.5, plot_front(r) + 1.0))
    def blocked(x, y):
        for (cx, cy, u, f, hl, back, front) in rects.get((int(x // 60), int(y // 60)), []):
            dx, dy = x - cx, y - cy
            dz = dx * f[0] + dy * f[1]
            if abs(dx * u[0] + dy * u[1]) < hl and -back < dz < front:
                return True
        return False
    return blocked


def curved_access(rows, segs, KX):
    """Streets for rows with no street within 15 m of their front: the front points of neighbouring rows
    facing the same way (within 45 m, headings within 45 degrees, laid out along the street) are joined
    into one street that follows them (curved villa streets); a row on its own gets none. Streets are cut where they would run over a home and never cross another street."""
    grid = {}
    for sg in segs:
        for gx in range(int(min(sg[0], sg[2]) // 50) - 1, int(max(sg[0], sg[2]) // 50) + 2):
            for gy in range(int(min(sg[1], sg[3]) // 50) - 1, int(max(sg[1], sg[3]) // 50) + 2):
                grid.setdefault((gx, gy), []).append(sg)
    def street_near(x, y, d):
        return any(seg_d(x, y, *s) < d for s in grid.get((int(x // 50), int(y // 50)), []))
    cand = []
    for r in rows:
        if r.get('kind') == 'apartment': continue
        a = math.radians(r['frontBearing']); f = (math.sin(a), math.cos(a)); u = (f[1], -f[0])
        cx, cy = r['lng'] * KX, r['lat'] * KY
        F = (cx + f[0] * (plot_front(r) + 5.65), cy + f[1] * (plot_front(r) + 5.65))
        if street_near(F[0], F[1], 15): continue
        cand.append({'F': F, 'f': f, 'u': u, 'half': r['L'] / 2})
    cgrid = {}
    for i, c in enumerate(cand): cgrid.setdefault((int(c['F'][0] // 45), int(c['F'][1] // 45)), []).append(i)
    # best neighbour on each side along the street
    side = [[None, None] for _ in cand]
    for i, c in enumerate(cand):
        gx, gy = int(c['F'][0] // 45), int(c['F'][1] // 45)
        for a2 in (-1, 0, 1):
            for b2 in (-1, 0, 1):
                for j in cgrid.get((gx + a2, gy + b2), []):
                    if j == i: continue
                    d = cand[j]
                    vx, vy = d['F'][0] - c['F'][0], d['F'][1] - c['F'][1]
                    dist = math.hypot(vx, vy)
                    if dist < 1 or dist > 45: continue
                    if c['f'][0] * d['f'][0] + c['f'][1] * d['f'][1] < math.cos(math.radians(45)): continue
                    along = (vx * c['u'][0] + vy * c['u'][1]) / dist
                    if abs(along) < 0.75: continue
                    k = 0 if along > 0 else 1
                    if side[i][k] is None or dist < side[i][k][1]: side[i][k] = (j, dist)
    adj = [set() for _ in cand]
    for i in range(len(cand)):
        for k in (0, 1):
            if side[i][k] is None: continue
            j = side[i][k][0]
            if any(s2 is not None and s2[0] == i for s2 in side[j]):
                adj[i].add(j); adj[j].add(i)
    seen = set(); lines = []
    for i in range(len(cand)):
        if i in seen or len(adj[i]) > 1: continue
        chain = [i]; seen.add(i); prev = None; cur = i
        while True:
            nxt = [j for j in adj[cur] if j != prev and j not in seen]
            if not nxt: break
            prev, cur = cur, nxt[0]; chain.append(cur); seen.add(cur)
        a0, a1 = cand[chain[0]], cand[chain[-1]]
        if len(chain) == 1:
            continue  # a lone row: no stub road (its heading alone is not reliable enough)
        else:
            def ext(c, toward):  # extend past the end row along its own street direction
                u = c['u']; sgn = 1 if (u[0] * toward[0] + u[1] * toward[1]) > 0 else -1
                return (c['F'][0] + sgn * u[0] * (c['half'] + 4), c['F'][1] + sgn * u[1] * (c['half'] + 4))
            first = ext(a0, (a0['F'][0] - cand[chain[1]]['F'][0], a0['F'][1] - cand[chain[1]]['F'][1]))
            last = ext(a1, (a1['F'][0] - cand[chain[-2]]['F'][0], a1['F'][1] - cand[chain[-2]]['F'][1]))
            pts = [first] + [cand[k]['F'] for k in chain] + [last]
        lines.append(pts)
    return clean_lines(lines, rows, KX, segs)


def clean_lines(lines, rows, KX, others):
    """cut each street where it runs over a home; drop pieces shorter than 14 m and pieces that cross others"""
    blocked = make_blocked(rows, KX)
    out = []
    for pts in lines:
        cur = []
        dense = []
        for i in range(len(pts) - 1):
            (ax, ay), (bx, by) = pts[i], pts[i + 1]
            l = math.hypot(bx - ax, by - ay); n = max(1, int(l // 2))
            for k in range(n): dense.append((ax + (bx - ax) * k / n, ay + (by - ay) * k / n))
        dense.append(pts[-1])
        def flush():
            if len(cur) >= 2 and sum(math.hypot(cur[i + 1][0] - cur[i][0], cur[i + 1][1] - cur[i][1]) for i in range(len(cur) - 1)) >= 14:
                # keep every ~4th dense point (smooth enough), plus the ends
                out.append(cur[::4] + ([cur[-1]] if (len(cur) - 1) % 4 else []))
        for p in dense:
            if blocked(*p):
                flush(); cur = []
            else:
                cur.append(p)
        flush()
    kept, result = [], []
    for line in out:
        segs = [(line[i][0], line[i][1], line[i + 1][0], line[i + 1][1]) for i in range(len(line) - 1)]
        if any(_cross(s, m) for s in segs for m in others) or any(_cross(s, k) for s in segs for k in kept):
            continue
        kept += segs
        result.append(line)
    return result


def merge_segments(segs):
    """Join collinear street pieces (same direction within 4 degrees, within 3 m sideways, gap < 30 m)."""
    lines = []  # [ox, oy, ux, uy, tmin, tmax]
    for (ax, ay, bx, by) in sorted(segs, key=lambda q: -math.hypot(q[2] - q[0], q[3] - q[1])):
        l = math.hypot(bx - ax, by - ay) or 1
        ux, uy = (bx - ax) / l, (by - ay) / l
        done = False
        for ln in lines:
            if abs(ux * ln[2] + uy * ln[3]) < 0.9976:
                continue
            mx, my = (ax + bx) / 2 - ln[0], (ay + by) / 2 - ln[1]
            if abs(-mx * ln[3] + my * ln[2]) > 13:  # facing rows share one street
                continue
            t0 = (ax - ln[0]) * ln[2] + (ay - ln[1]) * ln[3]; t1 = (bx - ln[0]) * ln[2] + (by - ln[1]) * ln[3]
            lo, hi = min(t0, t1), max(t0, t1)
            if lo > ln[5] + 30 or hi < ln[4] - 30:
                continue
            ln[4], ln[5] = min(ln[4], lo), max(ln[5], hi); done = True
            break
        if not done:
            lines.append([ax, ay, ux, uy, 0.0, l])
    return [(o[0] + o[2] * o[4], o[1] + o[3] * o[4], o[0] + o[2] * o[5], o[1] + o[3] * o[5]) for o in lines]


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


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Line up the rows of homes with their neighbours (data/homes_detected.json).

Rows measured from the satellite photo come with direction noise (up to 45 degrees for a nearly square
villa, whose front cannot be told from its side) and a few metres of position noise, so a street of
houses looked scattered: each at its own angle and depth. snap_rows.py squares the rows that face a
mapped street; this step does the rest:
 1. block grid: every row turns to the main direction of the rows of its project around it (90 m; the
    peak of their directions mod 90 degrees, so a few rows measured 45 degrees off do not drag it);
 1b. a nearly square detached villa takes the street axis of the rows around it (length and depth
    swap, so its footprint stays);
 2. neighbour smoothing (straight and curved streets alike): each row moves part of the way to the
    front line of its left and right neighbours on the same street side, to the middle of the gap
    between them and to their direction - 14 small rounds; rows squared to a mapped street stay put
    and anchor the rest; a row whose two neighbours face the other way turns round;
 3. checks: a row that would reach onto a mapped carriageway or into another house goes back
    towards where it was, only as far as needed.
Runs after snap_rows.py and before derive_site.py (which lays the access streets in front of the rows).
  python3 scripts/line_rows.py"""
import json, math, os

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KY = 110574.0
GRID_R = 90.0  # m: rows within this radius set the block grid
MAX_SNAP = 30.0  # degrees: a row this far off its block grid is left alone (a different block)


def plot_front(r):
    return max(r['D'] / 2, 17.4 - r['D'] / 2)


def seg_d(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    l2 = vx * vx + vy * vy or 1
    t = max(0, min(1, ((px - ax) * vx + (py - ay) * vy) / l2))
    return math.hypot(px - ax - vx * t, py - ay - vy * t)


def fdir(b):
    a = math.radians(b)
    return math.sin(a), math.cos(a)


def adiff(a, b, m=360):
    return ((a - b + m / 2) % m) - m / 2


def house_poly(r, KX, x=None, y=None, b=None, L=None, D=None):
    """the 3D house as js/valley-detail.js builds it (its overlap test box): the row's length, 11.3 m
    deep from the detected back wall towards the street - whatever depth the roof measured"""
    x = r['lng'] * KX if x is None else x
    y = r['lat'] * KY if y is None else y
    f = fdir(r['frontBearing'] if b is None else b); u = (f[1], -f[0])
    hl = (r['L'] if L is None else L) / 2 - 0.4
    z0 = -(r['D'] if D is None else D) / 2 + 0.1
    z1 = z0 + 11.1
    return [(x + u[0] * su * hl + f[0] * z, y + u[1] * su * hl + f[1] * z)
            for su, z in ((-1, z0), (1, z0), (1, z1), (-1, z1))]


def clip(subject, clipper):
    """Sutherland-Hodgman: area of the intersection of two convex polygons"""
    def area(p):
        return sum(p[i][0] * p[(i + 1) % len(p)][1] - p[(i + 1) % len(p)][0] * p[i][1] for i in range(len(p))) / 2
    if area(clipper) < 0:
        clipper = clipper[::-1]
    out = subject
    for i in range(len(clipper)):
        a, b = clipper[i], clipper[(i + 1) % len(clipper)]
        inp, out = out, []
        if not inp:
            break
        side = lambda p: (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
        for j in range(len(inp)):
            p, q = inp[j], inp[(j + 1) % len(inp)]
            sp, sq = side(p), side(q)
            if sp >= 0:
                out.append(p)
            if (sp >= 0) != (sq >= 0):
                t = sp / (sp - sq)
                out.append((p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t))
    return abs(area(out)) if len(out) > 2 else 0.0


def main():
    hd = json.load(open(os.path.join(APP, 'data', 'homes_detected.json')))
    site = json.load(open(os.path.join(APP, 'data', 'site.json')))
    for cid, rows in hd['communities'].items():
        if cid not in site['communities'] or not rows:
            continue
        KX = 111320.0 * math.cos(math.radians(rows[0]['lat']))
        segs = []
        for s in site['communities'][cid]['streets']:
            if s.get('source') == 'derived' or s['cls'] == 'path':
                continue
            p = [(lo * KX, la * KY) for lo, la in s['pts']]
            segs += [(p[i][0], p[i][1], p[i + 1][0], p[i + 1][1], (s.get('width') or 7.3) / 2) for i in range(len(p) - 1)]
        sgrid = {}
        for sg in segs:
            for gx in range(int(min(sg[0], sg[2]) // 50) - 1, int(max(sg[0], sg[2]) // 50) + 2):
                for gy in range(int(min(sg[1], sg[3]) // 50) - 1, int(max(sg[1], sg[3]) // 50) + 2):
                    sgrid.setdefault((gx, gy), []).append(sg)

        def street_d(px, py):
            return min([seg_d(px, py, *sg[:4]) - sg[4] for sg in sgrid.get((int(px // 50), int(py // 50)), [])] or [1e9])

        def on_road(r, x, y, b, L, D):
            f = fdir(b); u = (f[1], -f[0])
            front = max(D / 2, 17.4 - D / 2)
            for k in (-1, -0.6, -0.25, 0.25, 0.6, 1):
                for dz in (-D / 2, 0, front / 2, front):
                    px, py = x + u[0] * L / 2 * k + f[0] * dz, y + u[1] * L / 2 * k + f[1] * dz
                    for sg in sgrid.get((int(px // 50), int(py // 50)), []):
                        if seg_d(px, py, *sg[:4]) < sg[4] - 0.3:
                            return True
            return False

        idx = [i for i, r in enumerate(rows) if r.get('kind') != 'apartment']
        orig = {i: (rows[i]['lng'], rows[i]['lat'], rows[i]['frontBearing']) for i in idx}
        orig_ld = {i: (rows[i]['L'], rows[i]['D']) for i in idx}
        P = {i: [rows[i]['lng'] * KX, rows[i]['lat'] * KY] for i in idx}
        cell = {}
        for i in idx:
            cell.setdefault((int(P[i][0] // GRID_R), int(P[i][1] // GRID_R)), []).append(i)

        def near(i, R):
            gx, gy = int(P[i][0] // GRID_R), int(P[i][1] // GRID_R)
            for a in (-1, 0, 1):
                for b in (-1, 0, 1):
                    for j in cell.get((gx + a, gy + b), []):
                        if j != i and math.hypot(P[j][0] - P[i][0], P[j][1] - P[i][1]) <= R:
                            yield j

        # 1. block grid (twice: the second pass starts from the smoothed directions)
        snapped = set()
        for _ in range(2):
            new = {}
            for i in idx:
                r = rows[i]
                if r.get('squared') == 'street':
                    continue
                # the block's main direction: the peak of the directions (mod 90 degrees) around it - a peak,
                # not a mean, so a few rows measured 45 degrees off do not drag the block
                hist = [0.0] * 90
                for j in list(near(i, GRID_R)) + [i]:
                    q = rows[j]
                    if q.get('project') != r.get('project'):
                        continue
                    w = q['L'] * (3 if q.get('squared') == 'street' else 1) * (0.5 if j == i else 1)
                    t = q['frontBearing'] % 90
                    for k in range(-8, 9):
                        hist[int(round(t + k)) % 90] += w * math.exp(-k * k / 18.0)
                pk = max(range(90), key=lambda k: hist[k])
                # refine: weighted mean of the directions within 8 degrees of the peak
                sx = sy = 0.0
                for j in list(near(i, GRID_R)) + [i]:
                    q = rows[j]
                    if q.get('project') == r.get('project') and abs(adiff(q['frontBearing'], pk, 90)) <= 8:
                        w = q['L'] * (3 if q.get('squared') == 'street' else 1)
                        t = math.radians(adiff(q['frontBearing'], pk, 90))
                        sx += w * math.cos(t); sy += w * math.sin(t)
                g = pk + math.degrees(math.atan2(sy, sx))
                d = adiff(r['frontBearing'], g, 90)
                guess = r['units'] <= 3 or 0.7 < r['L'] / r['D'] < 1.45  # small rows: the angle is a guess
                if 0.05 < abs(d) <= (45.1 if guess else MAX_SNAP):
                    new[i] = (r['frontBearing'] - d) % 360
            for i, b in new.items():
                rows[i]['frontBearing'] = round(b, 2)
            snapped |= set(new)

        def fixed_axis(r):
            """a terrace / long row / street-squared row: its long side is known"""
            return r['units'] > 1 or r.get('squared') == 'street' or r['L'] > 1.45 * r['D']

        # 2. street sides by neighbour smoothing (works on straight and curved streets). Every row looks at
        # its nearest row to the left and to the right along its street side (same axis, centres within
        # 10 m across, at most 30 m gap, no mapped street between) and moves part of the way to their
        # front line, to the middle of the gap between them, and to their direction. Rows squared to a
        # mapped street stay put and anchor the rest. 14 rounds, at most 1.2 m and 2 degrees a round.
        # 1b. a nearly square detached villa: the satellite could not tell its front from its side. It takes
        # the street axis of the rows around it (35 m) and keeps the side nearest its own as its front
        # (footprint unchanged: length and depth swap when it turns a quarter).
        axis_turned = 0
        for _ in range(2):
            for i in idx:
                r = rows[i]
                if r.get('squared') == 'street' or r['units'] != 1 or not (0.7 < r['L'] / r['D'] < 1.45):
                    continue
                v0 = v1 = 0.0  # weight for "runs along my axis" / "runs across it"
                for j in near(i, 35):
                    q = rows[j]
                    if q.get('project') != r.get('project') or abs(adiff(q['frontBearing'], r['frontBearing'], 90)) > 6:
                        continue
                    w = q['L'] * (3 if q['units'] > 1 or q.get('squared') == 'street' else 1)
                    if abs(adiff(q['frontBearing'], r['frontBearing'], 180)) < 45:
                        v0 += w
                    else:
                        v1 += w
                if v1 > v0 * 1.3:
                    r['frontBearing'] = round((r['frontBearing'] + 90) % 360, 2)
                    r['L'], r['D'] = r['D'], r['L']
                    if r.get('unitWidths') and len(r['unitWidths']) == 1:
                        r['unitWidths'] = [r['L']]
                    axis_turned += 1
        B = {i: rows[i]['frontBearing'] for i in idx}
        # where each row was detected (a villa turned a quarter: the same footprint, so the same place)
        start = {}
        for i in idx:
            b0 = orig[i][2]
            if (rows[i]['L'], rows[i]['D']) != orig_ld[i]:
                b0 = b0 + 90 if abs(adiff(B[i], b0 + 90, 360)) < abs(adiff(B[i], b0 - 90, 360)) else b0 - 90
            start[i] = (P[i][0], P[i][1], b0 % 360)
        anchor = {i for i in idx if rows[i].get('squared') == 'street'}

        def pfront(i):
            return plot_front(rows[i])

        def neighbours(i):
            fi = fdir(B[i]); ui = (fi[1], -fi[0])
            left = right = None
            for j in near(i, 60):
                if rows[j].get('project') != rows[i].get('project'):
                    continue
                if abs(adiff(B[j], B[i], 180)) > 8:
                    continue
                dx, dy = P[j][0] - P[i][0], P[j][1] - P[i][1]
                a = dx * ui[0] + dy * ui[1]
                pp = dx * fi[0] + dy * fi[1]
                # same side of the street: compare plot fronts (or centres when facing the other way)
                same = abs(adiff(B[j], B[i], 360)) < 90
                off = (pp + pfront(j) - pfront(i)) if same else pp
                if abs(off) > 10:
                    continue
                gap = abs(a) - (rows[i]['L'] + rows[j]['L']) / 2
                if gap > 30 or gap < -4:
                    continue
                if any(street_d(P[i][0] + dx * t, P[i][1] + dy * t) < 1.5 for t in (0.25, 0.5, 0.75)):
                    continue
                if a < 0 and (left is None or a > left[0]):
                    left = (a, j, off, gap, same)
                if a > 0 and (right is None or a < right[0]):
                    right = (a, j, off, gap, same)
            return left, right

        moved_rows = set()
        flipped = 0
        for it in range(14):
            nb = {i: neighbours(i) for i in idx}
            # facing: a row whose neighbours on both sides face the other way turns round
            if it in (0, 5):
                for i in idx:
                    if i in anchor:
                        continue
                    l, r_ = nb[i]
                    ns = [x for x in (l, r_) if x]
                    if len(ns) == 2 and not any(x[4] for x in ns):
                        B[i] = (B[i] + 180) % 360
                        flipped += 1
                nb = {i: neighbours(i) for i in idx}
            step = {}
            for i in idx:
                if i in anchor:
                    continue
                l, r_ = nb[i]
                ns = [x for x in (l, r_) if x]
                if not ns:
                    continue
                fi = fdir(B[i]); ui = (fi[1], -fi[0])
                w = [3.0 if x[1] in anchor else 1.0 for x in ns]
                # across: to the neighbours' front line
                df = sum(x[2] * wk for x, wk in zip(ns, w)) / sum(w) * 0.5
                # along: to the middle of the gap between them
                da = (r_[3] - l[3]) / 2 * 0.5 if (l and r_) else 0.0
                # direction: towards theirs
                db = sum(adiff(B[x[1]], B[i], 180) * wk for x, wk in zip(ns, w)) / sum(w) * 0.5
                df = max(-1.2, min(1.2, df)); da = max(-1.2, min(1.2, da)); db = max(-2, min(2, db))
                step[i] = (ui[0] * da + fi[0] * df, ui[1] * da + fi[1] * df, db)
            for i, (sx, sy, db) in step.items():
                P[i][0] += sx; P[i][1] += sy; B[i] = (B[i] + db) % 360
                moved_rows.add(i)

        # 3. checks: no house on a mapped carriageway, no house into another; a row that fails goes back
        # towards where it was, only as far as needed
        def bad(i, x, y, b, others):
            r = rows[i]
            if on_road(r, x, y, b, r['L'], r['D']) and not on_road(r, start[i][0], start[i][1], start[i][2], r['L'], r['D']):
                return True
            poly = house_poly(r, KX, x, y, b)
            ar = r['L'] * r['D']
            gx, gy = int(x // 60), int(y // 60)
            for j in [j for a in (-1, 0, 1) for c in (-1, 0, 1) for j in others.get((gx + a, gy + c), ())]:
                if j != i and clip(poly, placedp[j]) > 0.04 * min(ar, rows[j]['L'] * rows[j]['D']):
                    return True
            return False
        placedp = {i: house_poly(rows[i], KX, P[i][0], P[i][1], B[i]) for i in idx}
        hc = {}
        for i in idx:
            hc.setdefault((int(P[i][0] // 60), int(P[i][1] // 60)), set()).add(i)
        partial = back = 0
        for _ in range(3):
            changed = False
            for i in sorted(moved_rows | {k for k in idx if abs(adiff(B[k], start[k][2], 360)) > 0.05}):
                if not bad(i, P[i][0], P[i][1], B[i], hc):
                    continue
                x0, y0, b0 = start[i]
                ok_t = None
                for t in (0.75, 0.5, 0.25, 0.0):  # t = share of the move kept
                    x = x0 + (P[i][0] - x0) * t; y = y0 + (P[i][1] - y0) * t
                    b = (b0 + adiff(B[i], b0, 360) * t) % 360
                    if not bad(i, x, y, b, hc) or t == 0.0:
                        ok_t = (t, x, y, b)
                        break
                t, x, y, b = ok_t
                hc[(int(P[i][0] // 60), int(P[i][1] // 60))].discard(i)
                P[i] = [x, y]; B[i] = b
                hc.setdefault((int(x // 60), int(y // 60)), set()).add(i)
                placedp[i] = house_poly(rows[i], KX, x, y, b)
                changed = True
                if t > 0:
                    partial += 1
                else:
                    back += 1
            if not changed:
                break
        # 4. buildings apart. The 3D home's buildings (house + carport) reach from 1 m behind the detected
        # back wall to 18.4 m in front of it, deeper than the roof seen from above, so rows that stand close
        # can have houses inside each other. Rows whose buildings meet are pushed apart along the shortest
        # way out (half each; a row squared to a mapped street moves least), at most 0.8 m a round and 4 m
        # in all, never onto a mapped carriageway. What still meets is left to js/valley-detail.js.
        def built(i, x=None, y=None):
            r = rows[i]
            x = P[i][0] if x is None else x; y = P[i][1] if y is None else y
            f = fdir(B[i]); u = (f[1], -f[0])
            hl = r['L'] / 2 - 0.1
            z0, z1 = -r['D'] / 2 - 1.0, -r['D'] / 2 + 18.4
            return [(x + u[0] * su * hl + f[0] * z, y + u[1] * su * hl + f[1] * z) for su, z in ((-1, z0), (1, z0), (1, z1), (-1, z1))]

        def mtv(A, Bq):
            """shortest push (vector) taking A out of Bq, or None when apart"""
            best = None
            for poly in (A, Bq):
                for k in range(4):
                    ex, ey = poly[(k + 1) % 4][0] - poly[k][0], poly[(k + 1) % 4][1] - poly[k][1]
                    n = math.hypot(ex, ey) or 1
                    ax_, ay_ = -ey / n, ex / n
                    pa = [q[0] * ax_ + q[1] * ay_ for q in A]; pb = [q[0] * ax_ + q[1] * ay_ for q in Bq]
                    o = min(max(pa), max(pb)) - max(min(pa), min(pb))
                    if o <= 0.05:
                        return None
                    if best is None or o < best[0]:
                        sgn = 1 if (sum(pa) / 4) >= (sum(pb) / 4) else -1
                        best = (o, ax_ * sgn, ay_ * sgn)
            return best
        sep_start = {i: (P[i][0], P[i][1]) for i in idx}
        separated = set()
        for rnd in range(12):
            bc = {}
            for i in idx:
                bc.setdefault((int(P[i][0] // 40), int(P[i][1] // 40)), []).append(i)
            push = {}
            for i in idx:
                gx, gy = int(P[i][0] // 40), int(P[i][1] // 40)
                Ai = built(i)
                for j in [j for a in (-1, 0, 1) for c in (-1, 0, 1) for j in bc.get((gx + a, gy + c), ())]:
                    if j <= i or math.hypot(P[j][0] - P[i][0], P[j][1] - P[i][1]) > 45:
                        continue
                    m = mtv(Ai, built(j))
                    if not m:
                        continue
                    o, vx, vy = m
                    wi = 0.2 if i in anchor else 1.0
                    wj = 0.2 if j in anchor else 1.0
                    si, sj = wi / (wi + wj), wj / (wi + wj)
                    d = min(o + 0.3, 1.6)
                    push.setdefault(i, [0, 0]); push.setdefault(j, [0, 0])
                    push[i][0] += vx * d * si; push[i][1] += vy * d * si
                    push[j][0] -= vx * d * sj; push[j][1] -= vy * d * sj
            if not push:
                break
            for i, (dx, dy) in push.items():
                n = math.hypot(dx, dy)
                if n > 0.8:
                    dx, dy = dx * 0.8 / n, dy * 0.8 / n
                nx, ny = P[i][0] + dx, P[i][1] + dy
                if math.hypot(nx - sep_start[i][0], ny - sep_start[i][1]) > 4:
                    continue
                r = rows[i]
                if on_road(r, nx, ny, B[i], r['L'], r['D']) and not on_road(r, P[i][0], P[i][1], B[i], r['L'], r['D']):
                    continue
                P[i] = [nx, ny]
                separated.add(i)
        still = 0
        bc = {}
        for i in idx:
            bc.setdefault((int(P[i][0] // 40), int(P[i][1] // 40)), []).append(i)
        for i in idx:
            gx, gy = int(P[i][0] // 40), int(P[i][1] // 40)
            for j in [j for a in (-1, 0, 1) for c in (-1, 0, 1) for j in bc.get((gx + a, gy + c), ())]:
                if j > i and math.hypot(P[j][0] - P[i][0], P[j][1] - P[i][1]) < 45 and mtv(built(i), built(j)):
                    still += 1
        print(f'{cid}: buildings pushed apart: {len(separated)} rows moved; pairs still meeting {still}')

        n_rows = 0
        shifts = []
        for i in idx:
            r = rows[i]
            if i in anchor and i not in separated:
                continue
            d = math.hypot(P[i][0] - start[i][0], P[i][1] - start[i][1])
            r['lng'], r['lat'] = round(P[i][0] / KX, 7), round(P[i][1] / KY, 7)
            r['frontBearing'] = round(B[i] % 360, 2)
            if d < 0.05 and abs(adiff(B[i], start[i][2], 360)) < 0.05:
                continue  # as detected (perhaps put back)
            shifts.append(d)
            if r.get('squared') != 'street':
                r['squared'] = 'line'
            n_rows += 1
        shifts.sort()
        alone = sum(1 for i in idx if rows[i].get('squared') not in ('street', 'line'))
        print(f'{cid}: {len(idx)} rows; turned to the block grid {len(snapped)}, villas turned to the street axis {axis_turned}; lined up with their neighbours {n_rows} '
              f'(median move {shifts[len(shifts) // 2] if shifts else 0:.1f} m, {sum(s > 6 for s in shifts)} > 6 m; {flipped} turned round); '
              f'held back short of a road/house {partial}, put back {back}; {alone} rows with no neighbour')
    json.dump(hd, open(os.path.join(APP, 'data', 'homes_detected.json'), 'w'), separators=(',', ':'))


if __name__ == '__main__':
    main()

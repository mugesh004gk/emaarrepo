#!/usr/bin/env python3
"""Trace an official Emaar cluster site plan (brochure page) into verified roads, plots and rows.

  python scripts/siteplan/trace_siteplan.py data/siteplans/<project>.config.json
  (needs numpy, opencv-python, scikit-image, scipy; pdfimages from poppler)

Steps
 1. the plan image is taken from the brochure PDF (the embedded raster, full resolution);
 2. roads: the plan's asphalt (grey, unsaturated) inside the project boundary -> centre lines
    (skeleton) and carriageway width (distance transform);
 3. georeference: a similarity transform (scale, rotation, shift) from 3 rough control points,
    refined by fitting the plan's road centre lines onto the mapped (OpenStreetMap) centre lines
    (trimmed ICP). The residual says how well the mapped streets agree with Emaar's plan;
 4. mapped streets inside the boundary are checked against the plan's roads: a street whose
    points lie on the plan's carriageway is 'verified', others are flagged;
 5. rows: the roof blocks of the plan (terracotta and light roofs) -> oriented rectangles; the
    number of homes per block from its length (the plan's blocks come in fixed sizes), end and
    middle unit widths; each block faces the plan road on its nearer long side;
 6. plots: for every home a plot polygon - sides at the unit divisions, rear at the block's back
    wall plus the garden (half way to the next block behind, at most 8 m), front at the
    carriageway edge minus the footpath - with the street it faces and the road tangent there.
Output: data/siteplans/<project>.json (source provenance, georeference quality, verified streets,
plots, rows). scripts/siteplan/apply_siteplans.py puts it into the app data.
"""
import json, math, os, subprocess, sys, tempfile
import numpy as np
import cv2
from scipy.spatial import cKDTree
from skimage.morphology import skeletonize

APP = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
KY = 110574.0


def main(cfg_path):
    cfg = json.load(open(cfg_path))
    pdf = os.path.normpath(os.path.join(APP, cfg['pdf']))
    with tempfile.TemporaryDirectory() as td:
        subprocess.run(['pdfimages', '-j', '-f', str(cfg['page']), '-l', str(cfg['page']), pdf, os.path.join(td, 'p')], check=True)
        im = cv2.imread(os.path.join(td, f"p-{cfg['image_index']:03d}.jpg"))
    h_img, w_img = im.shape[:2]
    lat0, lng0 = cfg['control_points'][0][2], cfg['control_points'][0][3]
    KX = 111320.0 * math.cos(math.radians(lat0))
    to_m = lambda lat, lng: ((lng - lng0) * KX, (lat - lat0) * KY)
    to_ll = lambda x, y: (lat0 + y / KY, lng0 + x / KX)

    boundary = np.array(cfg['boundary_px'], np.int32)
    inside = np.zeros((h_img, w_img), np.uint8)
    cv2.fillPoly(inside, [boundary], 1)
    hsv = cv2.cvtColor(cv2.GaussianBlur(im, (3, 3), 0), cv2.COLOR_BGR2HSV)
    H, S, V = hsv[..., 0], hsv[..., 1], hsv[..., 2]

    # ---- 2. roads
    inner = cv2.erode(inside, np.ones((cfg.get('boundary_trim_px', 9),) * 2, np.uint8))  # keep clear of the outer roads at the boundary
    road = ((S <= 32) & (V >= 105) & (V <= 195) & (inner > 0)).astype(np.uint8)
    road = cv2.morphologyEx(road, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7)))
    road = cv2.morphologyEx(road, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    n, cc, st, _ = cv2.connectedComponentsWithStats(road)
    big = 1 + int(np.argmax(st[1:, 4]))
    road = (cc == big).astype(np.uint8)
    sk = skeletonize(road > 0)
    dt = cv2.distanceTransform(road, cv2.DIST_L2, 5)
    ys, xs = np.nonzero(sk)
    src = np.c_[xs, ys].astype(float)

    # ---- 3. georeference: similarity, then ICP onto the mapped centre lines
    def fit(P, Q):
        P2 = P * [1, -1]
        mp, mq = P2.mean(0), Q.mean(0)
        A, B = P2 - mp, Q - mq
        U, Sv, Vt = np.linalg.svd(A.T @ B)
        R = (U @ Vt).T
        if np.linalg.det(R) < 0:
            Vt[-1] *= -1
            R = (U @ Vt).T
        sc = Sv.sum() / (A ** 2).sum()
        return sc, R, mq - sc * R @ mp

    def apply(T, P):
        sc, R, t = T
        return (sc * (R @ (np.asarray(P, float) * [1, -1]).T)).T + t

    cp = np.array(cfg['control_points'], float)
    T = fit(cp[:, :2], np.array([to_m(a, b) for a, b in cp[:, 2:]]))
    site = json.load(open(os.path.join(APP, 'data', 'site.json')))
    streets = site['communities'][cfg['community']]['streets']
    tg, tg_street = [], []
    for si, s in enumerate(streets):
        if s.get('source') == 'derived' or s['cls'] == 'path':
            continue
        p = [to_m(la, lo) for lo, la in s['pts']]
        for a, b in zip(p, p[1:]):
            k = max(1, int(math.hypot(b[0] - a[0], b[1] - a[1])))
            for j in range(k):
                tg.append((a[0] + (b[0] - a[0]) * j / k, a[1] + (b[1] - a[1]) * j / k))
                tg_street.append(si)
    tg = np.array(tg)
    keep = np.hypot(tg[:, 0], tg[:, 1]) < 900
    tg, tg_street = tg[keep], np.array(tg_street)[keep]
    tree = cKDTree(tg)
    for rad in (60, 30, 15, 8, 5, 3, 3, 3):
        for _ in range(15):
            d, i = tree.query(apply(T, src))
            m = d < rad
            T = fit(src[m], tg[i[m]])
    d, _ = tree.query(apply(T, src))
    sc, R, t = T
    rot = math.degrees(math.atan2(R[1, 0], R[0, 0]))
    georef = {'scale_m_per_px': round(sc, 5), 'rotation_deg': round(rot, 3), 'shift_m': [round(t[0], 2), round(t[1], 2)],
              'origin': [lat0, lng0], 'fit_points': int(len(src)),
              'median_m': round(float(np.median(d)), 2), 'p80_m': round(float(np.percentile(d, 80)), 2),
              'method': 'plan road centre lines fitted to OpenStreetMap centre lines (trimmed ICP, similarity)'}

    def px_to_ll(x, y):
        m = apply(T, [[x, y]])[0]
        return to_ll(m[0], m[1])

    # ---- 4. mapped streets checked against the plan's carriageway
    inv = lambda mx, my: (np.linalg.inv(R) @ ((np.array([mx, my]) - t) / sc)) * [1, -1]
    road_w = float(np.percentile(dt[sk], 70)) * 2 * sc
    checked = []
    for si, s in enumerate(streets):
        if s.get('source') == 'derived' or s['cls'] == 'path':
            continue
        pts = [to_m(la, lo) for lo, la in s['pts']]
        samples = []
        for a, b in zip(pts, pts[1:]):
            k = max(1, int(math.hypot(b[0] - a[0], b[1] - a[1]) / 2))
            samples += [(a[0] + (b[0] - a[0]) * j / k, a[1] + (b[1] - a[1]) * j / k) for j in range(k)]
        ins = []
        for mx, my in samples:
            x, y = inv(mx, my)
            if 0 <= x < w_img and 0 <= y < h_img and inside[int(y), int(x)]:
                ins.append((x, y))
        if len(ins) < 5:
            continue
        on = [road[min(h_img - 1, max(0, int(round(y)))), min(w_img - 1, max(0, int(round(x))))] > 0 for x, y in ins]
        share = sum(on) / len(on)
        checked.append({'street_index': si, 'cls': s['cls'], 'samples_inside': len(ins), 'on_plan_carriageway': round(share, 3),
                        'status': 'verified' if share >= 0.85 else 'flagged'})

    # ---- 4b. the plan's road network as centre-line polylines (a graph: junctions joined,
    # driveway / parking stubs shorter than 14 m pruned), simplified and lightly smoothed
    skel = sk.copy()
    nb = lambda y, x: [(y + dy, x + dx) for dy in (-1, 0, 1) for dx in (-1, 0, 1) if (dy or dx) and 0 <= y + dy < h_img and 0 <= x + dx < w_img and skel[y + dy, x + dx]]
    def trace_edges():
        pts = set(zip(*np.nonzero(skel)))
        deg = {q: len(nb(*q)) for q in pts}
        nodes = {q for q, dg in deg.items() if dg != 2}
        seen, edges = set(), []
        for nd in nodes:
            for nx0 in nb(*nd):
                if (nd, nx0) in seen:
                    continue
                path, prev, cur = [nd], nd, nx0
                while True:
                    path.append(cur)
                    if cur in nodes:
                        break
                    nxt = [q for q in nb(*cur) if q != prev and q not in path[-3:]]
                    if not nxt:
                        break
                    prev, cur = cur, nxt[0]
                seen.add((path[-1], path[-2])); seen.add((nd, nx0))
                edges.append(path)
        return edges, deg
    for _ in range(3):  # prune short dead ends (driveways, parking stubs)
        edges, deg = trace_edges()
        cut = 0
        for e in edges:
            length = sum(math.hypot(a[0] - b[0], a[1] - b[1]) for a, b in zip(e, e[1:])) * sc
            if length < 14 and (deg.get(e[0]) == 1 or deg.get(e[-1]) == 1):
                for q in e[1:-1] + [q for q in (e[0], e[-1]) if deg.get(q) == 1]:
                    skel[q] = False
                cut += 1
        skel = skeletonize(skel)
        if not cut:
            break
    edges, deg = trace_edges()
    plan_lines = []
    for e in edges:
        length = sum(math.hypot(a[0] - b[0], a[1] - b[1]) for a, b in zip(e, e[1:])) * sc
        if length < 4 and (deg.get(e[0]) == 1 or deg.get(e[-1]) == 1):
            continue  # a tiny stub; short pieces between two junctions are kept (no gaps)
        xy = np.array([(q[1], q[0]) for q in e], float)
        # smoothing over ~10 m (the skeleton wobbles by a pixel or two), window shrinking towards the
        # ends so junction points stay exactly where the roads meet
        if len(xy) > 5:
            sm = xy.copy()
            for j in range(1, len(xy) - 1):
                hw = min(12, j, len(xy) - 1 - j)
                sm[j] = xy[j - hw:j + hw + 1].mean(0)
            xy = sm
        ap = cv2.approxPolyDP(xy.astype(np.float32).reshape(-1, 1, 2), 1.2, False).reshape(-1, 2)
        m = apply(T, ap)
        plan_lines.append({'pts_m': m, 'length_m': round(length, 1)})
    # junctions: line ends within 5 m of each other are one junction (closes small gaps too);
    # fragments lying inside a junction are dropped; lines meeting two at a time are merged
    ends = [(li, k) for li in range(len(plan_lines)) for k in (0, -1)]
    par = list(range(len(ends)))
    def fnd(i):
        while par[i] != i:
            par[i] = par[par[i]]
            i = par[i]
        return i
    for i in range(len(ends)):
        for j in range(i + 1, len(ends)):
            pa = plan_lines[ends[i][0]]['pts_m'][ends[i][1]]
            pb = plan_lines[ends[j][0]]['pts_m'][ends[j][1]]
            if float(np.hypot(*(pa - pb))) < 5:
                par[fnd(i)] = fnd(j)
    groups = {}
    for i, e in enumerate(ends):
        groups.setdefault(fnd(i), []).append(e)
    node_of = {}
    for g, mem in groups.items():
        c = np.mean([plan_lines[li]['pts_m'][k] for li, k in mem], axis=0)
        for li, k in mem:
            plan_lines[li]['pts_m'][k] = c
            node_of[(li, k)] = g
    plan_lines = [dict(ln, a=node_of[(li, 0)], b=node_of[(li, -1)]) for li, ln in enumerate(plan_lines)
                  if not (node_of[(li, 0)] == node_of[(li, -1)] and float(np.hypot(*(ln['pts_m'][0] - ln['pts_m'][-1]))) < 0.01
                          and ln['length_m'] < 12)]
    changed = True
    while changed:  # merge through nodes where exactly two lines meet
        changed = False
        cnt = {}
        for ln in plan_lines:
            cnt[ln['a']] = cnt.get(ln['a'], 0) + 1
            cnt[ln['b']] = cnt.get(ln['b'], 0) + 1
        for nd, c in cnt.items():
            if c != 2:
                continue
            two = [i for i, ln in enumerate(plan_lines) if nd in (ln['a'], ln['b'])]
            if len(two) != 2:
                continue
            i, j = two
            A, B = plan_lines[i], plan_lines[j]
            pa = A['pts_m'] if A['b'] == nd else A['pts_m'][::-1]
            pb = B['pts_m'] if B['a'] == nd else B['pts_m'][::-1]
            na = A['a'] if A['b'] == nd else A['b']
            nb2 = B['b'] if B['a'] == nd else B['a']
            merged = {'pts_m': np.vstack([pa, pb[1:]]), 'length_m': round(A['length_m'] + B['length_m'], 1), 'a': na, 'b': nb2}
            plan_lines = [ln for k, ln in enumerate(plan_lines) if k not in (i, j)] + [merged]
            changed = True
            break
    # two loose ends facing each other across a short gap (a junction blob in the drawing) are joined
    def loose_ends():
        cnt = {}
        for ln in plan_lines:
            for nd in (ln['a'], ln['b']):
                cnt[nd] = cnt.get(nd, 0) + 1
        return [(i, k) for i, ln in enumerate(plan_lines) for k in (0, -1) if cnt[ln['a'] if k == 0 else ln['b']] == 1]
    done = True
    while done:
        done = False
        le = loose_ends()
        best = None
        for x in range(len(le)):
            for y in range(x + 1, len(le)):
                (i, ki), (j, kj) = le[x], le[y]
                if i == j:
                    continue
                dd = float(np.hypot(*(plan_lines[i]['pts_m'][ki] - plan_lines[j]['pts_m'][kj])))
                if dd < 14 and (best is None or dd < best[0]):
                    best = (dd, i, ki, j, kj)
        if best:
            _, i, ki, j, kj = best
            A, B = plan_lines[i], plan_lines[j]
            pa = A['pts_m'][::-1] if ki == 0 else A['pts_m']
            pb = B['pts_m'] if kj == 0 else B['pts_m'][::-1]
            na = A['b'] if ki == 0 else A['a']
            nb2 = B['b'] if kj == 0 else B['a']
            merged = {'pts_m': np.vstack([pa, pb]), 'length_m': round(A['length_m'] + B['length_m'] + best[0], 1), 'a': na, 'b': nb2}
            plan_lines = [ln for k, ln in enumerate(plan_lines) if k not in (i, j)] + [merged]
            done = True
    # a short line whose two ends come back together is a parking aisle / turning loop, not a street
    plan_lines = [ln for ln in plan_lines if not (ln['length_m'] < 60 and float(np.hypot(*(ln['pts_m'][0] - ln['pts_m'][-1]))) < 10)]
    def end_degree(pt):
        return sum(1 for ln in plan_lines for k in (0, -1) if np.hypot(*(ln['pts_m'][k] - pt)) < 0.05)
    for li, ln in enumerate(plan_lines):
        for k in (0, -1):
            pt = ln['pts_m'][k]
            if end_degree(pt) > 1:
                continue
            best = None
            for lj, other in enumerate(plan_lines):
                if lj == li:
                    continue
                m = other['pts_m']
                for a, b in zip(m, m[1:]):
                    v = b - a; l2 = float(v @ v) or 1
                    tt = max(0, min(1, float((pt - a) @ v) / l2))
                    q = a + v * tt
                    dq = float(np.hypot(*(pt - q)))
                    if best is None or dq < best[0]:
                        best = (dq, q)
            if best and 0.3 < best[0] < 8:
                ln['pts_m'] = np.vstack([best[1][None], ln['pts_m']]) if k == 0 else np.vstack([ln['pts_m'], best[1][None]])
    pl_pts, pl_dir = [], []
    for li, ln in enumerate(plan_lines):
        m = ln['pts_m']
        for a, b in zip(m, m[1:]):
            k = max(1, int(np.hypot(*(b - a))))
            d = (b - a) / (np.hypot(*(b - a)) or 1)
            for j in range(k):
                pl_pts.append(a + (b - a) * j / k); pl_dir.append(d)
    pl_pts, pl_dir = np.array(pl_pts), np.array(pl_dir)
    pl_tree = cKDTree(pl_pts)

    # ---- 5. rows from the roof blocks
    roof = ((H >= 4) & (H <= 22) & (S >= 22) & (V >= 60) & (inside > 0) & (road == 0)).astype(np.uint8)
    roof = cv2.morphologyEx(roof, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7)))
    roof = cv2.morphologyEx(roof, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
    n, cc, st, _ = cv2.connectedComponentsWithStats(roof)
    road_dt_out = cv2.distanceTransform((1 - road).astype(np.uint8), cv2.DIST_L2, 5)  # px to the nearest carriageway
    blocks = []
    for k in range(1, n):
        if st[k, 4] < 900:
            continue
        pts = np.c_[np.nonzero(cc == k)[::-1]].astype(np.float32)
        (cx, cy), (w, h), a = cv2.minAreaRect(pts)
        if w < h:
            w, h, a = h, w, a + 90
        ang = math.radians(a)
        ux, uy = math.cos(ang), math.sin(ang)  # long axis (image px)
        nx, ny = -uy, ux  # across
        # front: the long side nearer to a carriageway
        def side_gap(sgn):
            best = 1e9
            for tt in (-0.3, 0, 0.3):
                px, py = cx + ux * w * tt + nx * sgn * (h / 2 + 2), cy + uy * w * tt + ny * sgn * (h / 2 + 2)
                if 0 <= px < w_img and 0 <= py < h_img:
                    best = min(best, road_dt_out[int(py), int(px)])
            return best
        g_plus, g_minus = side_gap(1), side_gap(-1)
        sgn = 1 if g_plus <= g_minus else -1
        fx, fy = nx * sgn, ny * sgn
        L, D = w * sc, h * sc
        units = next(u for lim, u in cfg['units_by_length_m'] if L < lim)
        e = cfg['end_unit_m']
        mid = (L - 2 * e) / (units - 2) if units > 2 else 0
        widths = [e] + [mid] * (units - 2) + [e] if units > 2 else [L / units] * units
        # gap from the block front to the carriageway edge, and room behind it
        def march(x0, y0, dx, dy, stop, maxm):
            for step in range(1, int(maxm / sc)):
                px, py = int(round(x0 + dx * step)), int(round(y0 + dy * step))
                if not (0 <= px < w_img and 0 <= py < h_img) or not inside[py, px] or stop(px, py):
                    return step * sc
            return maxm
        front_gap = np.median([march(cx + ux * w * tt + fx * h / 2, cy + uy * w * tt + fy * h / 2, fx, fy, lambda x, y: road[y, x] > 0, 30) for tt in (-0.3, 0, 0.3)])
        rear_room = np.median([march(cx + ux * w * tt - fx * h / 2, cy + uy * w * tt - fy * h / 2, -fx, -fy,
                                     lambda x, y: road[y, x] > 0 or (cc[y, x] > 0 and cc[y, x] != k), 30) for tt in (-0.3, 0, 0.3)])
        blocks.append(dict(cx=cx, cy=cy, ux=ux, uy=uy, fx=fx, fy=fy, w=w, h=h, L=L, D=D, units=units, widths=widths,
                           front_gap=float(front_gap), rear_room=float(rear_room)))

    # image direction -> map bearing (degrees from north, clockwise)
    def bearing(dx, dy):
        m = R @ np.array([dx, -dy])
        return math.degrees(math.atan2(m[0], m[1])) % 360

    plots, rows = [], []
    ctr_tree = cKDTree(tg)
    for bi, b in enumerate(sorted(blocks, key=lambda q: (q['cy'], q['cx']))):
        fb = bearing(b['fx'], b['fy'])
        lat, lng = px_to_ll(b['cx'], b['cy'])
        # the road tangent in front (Phase 3 check: block axis vs street direction)
        fmx, fmy = apply(T, [[b['cx'] + b['fx'] * (b['h'] / 2 + b['front_gap'] / sc + 3), b['cy'] + b['fy'] * (b['h'] / 2 + b['front_gap'] / sc + 3)]])[0]
        dd, ii = ctr_tree.query([fmx, fmy], k=1)
        _, pj = pl_tree.query([fmx, fmy])
        tx, ty = pl_dir[pj]
        street_bearing = math.degrees(math.atan2(tx, ty)) % 180
        axis = (fb + 90) % 180
        dev = abs(((axis - street_bearing + 90) % 180) - 90)
        rows.append({'lat': round(lat, 7), 'lng': round(lng, 7), 'L': round(b['L'], 2), 'D': round(b['D'], 2),
                     'frontBearing': round(fb, 2), 'kind': cfg['kind'], 'units': b['units'],
                     'unitWidths': [round(x, 2) for x in b['widths']], 'project': cfg['project'],
                     'source': 'siteplan', 'placement': 'verified-siteplan', 'block': bi,
                     'street': int(tg_street[ii]), 'streetAxisDeviationDeg': round(dev, 1)})
        # plots (metres in the plan's own frame -> lat/lng)
        garden = min(8.0, b['rear_room'] / 2 if b['rear_room'] < 30 else 8.0)
        edge_offset = max(0.0, (cfg.get('carriageway_m', road_w) - road_w) / 2)  # real kerb vs the plan's drawn core
        front = max(0.0, b['front_gap'] - edge_offset - cfg['footpath_m'])
        x = -b['w'] / 2
        for ui, uw in enumerate(b['widths']):
            uwp = uw / sc
            corners_img = []
            for (along, across) in ((x, -b['h'] / 2 - garden / sc), (x + uwp, -b['h'] / 2 - garden / sc),
                                    (x + uwp, b['h'] / 2 + front / sc), (x, b['h'] / 2 + front / sc)):
                corners_img.append((b['cx'] + b['ux'] * along + b['fx'] * across, b['cy'] + b['uy'] * along + b['fy'] * across))
            poly = [px_to_ll(*c) for c in corners_img]
            anchor = px_to_ll(b['cx'] + b['ux'] * (x + uwp / 2) - b['fx'] * b['h'] / 2, b['cy'] + b['uy'] * (x + uwp / 2) - b['fy'] * b['h'] / 2)
            plots.append({'id': f"{cfg['project']}-B{bi:02d}-{ui + 1}", 'block': bi, 'unit': ui + 1,
                          'polygon': [[round(lo, 7), round(la, 7)] for la, lo in poly],
                          'rear': [[round(poly[0][1], 7), round(poly[0][0], 7)], [round(poly[1][1], 7), round(poly[1][0], 7)]],
                          'right': [[round(poly[1][1], 7), round(poly[1][0], 7)], [round(poly[2][1], 7), round(poly[2][0], 7)]],
                          'front': [[round(poly[2][1], 7), round(poly[2][0], 7)], [round(poly[3][1], 7), round(poly[3][0], 7)]],
                          'left': [[round(poly[3][1], 7), round(poly[3][0], 7)], [round(poly[0][1], 7), round(poly[0][0], 7)]],
                          'depth_m': round(garden + b['D'] + front, 2), 'width_m': round(uw, 2),
                          'house_type': cfg['kind'], 'anchor_back_wall': [round(anchor[1], 7), round(anchor[0], 7)],
                          'front_bearing': round(fb, 2), 'street': int(tg_street[ii]), 'status': 'siteplan'})
            x += uwp
    bnd = [[round(px_to_ll(x, y)[1], 7), round(px_to_ll(x, y)[0], 7)] for x, y in cfg['boundary_px']]
    out = {'project': cfg['project'], 'community': cfg['community'],
           'source': {'document': os.path.basename(pdf), 'page': cfg['page'], 'note': cfg.get('note', ''), 'priority': 2},
           'georeference': georef, 'boundary': bnd, 'road_width_m': round(road_w, 2),
           'streets_checked': checked,
           'roads': [{'pts': [[round(to_ll(x, y)[1], 7), round(to_ll(x, y)[0], 7)] for x, y in ln['pts_m']], 'length_m': ln['length_m'],
                      'width': round(road_w, 2), 'source': 'siteplan'} for ln in plan_lines],
           'rows': rows, 'plots': plots}
    path = os.path.join(APP, 'data', 'siteplans', f"{cfg['project']}.json")
    json.dump(out, open(path, 'w'), indent=None, separators=(',', ':'))
    devs = sorted(r['streetAxisDeviationDeg'] for r in rows)
    print(f"{cfg['project']}: georeference median {georef['median_m']} m, p80 {georef['p80_m']} m, scale {georef['scale_m_per_px']} m/px, rotation {georef['rotation_deg']} deg")
    print(f"  carriageway width (plan) {road_w:.1f} m; mapped streets inside: {len(checked)}, verified {sum(c['status'] == 'verified' for c in checked)}, flagged {sum(c['status'] == 'flagged' for c in checked)}")
    print(f"  plan road network: {len(plan_lines)} centre lines, {sum(l['length_m'] for l in plan_lines) / 1000:.2f} km")
    print(f"  blocks {len(rows)}, homes {sum(r['units'] for r in rows)}, plots {len(plots)}; block axis vs street: median {devs[len(devs) // 2]:.1f} deg, max {devs[-1]:.1f} deg")
    print(f"  front gap (roof to carriageway) median {np.median([b['front_gap'] for b in blocks]):.1f} m; plot depth median {np.median([p['depth_m'] for p in plots]):.1f} m")
    print('  ->', path)


if __name__ == '__main__':
    main(sys.argv[1])

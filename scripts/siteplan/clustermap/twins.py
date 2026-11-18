#!/usr/bin/env python3
"""Twin villas (semi-detached pairs) of a cluster map: one block per pair, with its type from the legend.

  python scripts/siteplan/clustermap/twins.py <project> <brochure.pdf> <page>

Needs data/siteplans/<project>/units_raw.json (extract_units.py) and config.json:
  {"count": 486, "pairs": "odd-even",
   "legend": [{"design": "Clara", "beds": 5, "rgb": [238,124,75]}, ...]}     (legend fills of the map page)
On Emaar's twin-villa maps each building is one coloured block holding two numbers side by side
(2k-1, 2k). For every pair:
  - the two numbers must sit side by side, about one unit apart (else listed, not placed);
  - type = nearest legend colour of the block (both halves, text left out);
  - block = the connected region of that colour around the pair: axis along the pair, its length and
    depth from the region (minimum-area rectangle);
  - front = the side of the block with road (light grey, unsaturated) rather than garden / water.
Output data/siteplans/<project>/blocks.json (page points) + /tmp/blocks_<project>.png for review.
"""
import json, os, subprocess, sys, tempfile
import numpy as np
import cv2

APP = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
DPI = 216  # 3 px per point


def lab_of(rgb):
    return cv2.cvtColor(np.uint8([[rgb[::-1]]]), cv2.COLOR_BGR2LAB)[0, 0].astype(np.float32)


def main():
    proj, pdf, page = sys.argv[1], sys.argv[2], int(sys.argv[3])
    d = os.path.join(APP, 'data', 'siteplans', proj)
    cfg = json.load(open(os.path.join(d, 'config.json')))
    raw = json.load(open(os.path.join(d, 'units_raw.json')))
    N = cfg['count']
    P = {int(k): np.array(v, float) for k, v in raw['units'].items() if int(k) <= N}
    pitch = raw['pitch']
    td = tempfile.mkdtemp()
    subprocess.run(['pdftoppm', '-q', '-r', str(DPI), '-png', '-f', str(page), '-l', str(page), pdf, os.path.join(td, 'p')], check=True)
    im = cv2.imread(os.path.join(td, [f for f in os.listdir(td) if f.endswith('.png')][0]))
    k = DPI / 72.0
    H, W = im.shape[:2]
    blur = cv2.GaussianBlur(im, (3, 3), 0)
    lab = cv2.cvtColor(blur, cv2.COLOR_BGR2LAB).astype(np.float32)
    hsv = cv2.cvtColor(blur, cv2.COLOR_BGR2HSV)
    leg = cfg['legend']
    L = np.array([lab_of(x['rgb']) for x in leg])
    rv = cfg.get('road_v', [175, 231])  # roads are mid-light grey; yards and gardens are lighter
    road = ((hsv[..., 1] < 25) & (hsv[..., 2] >= rv[0]) & (hsv[..., 2] <= rv[1])).astype(np.float32)
    soft = (((hsv[..., 0] > 30) & (hsv[..., 0] < 95) & (hsv[..., 1] > 45)) | ((hsv[..., 0] >= 95) & (hsv[..., 0] < 130) & (hsv[..., 1] > 45))).astype(np.float32)

    def sample(p, r):
        x, y = int(p[0] * k), int(p[1] * k); r = int(r * k)
        return lab[max(0, y - r):y + r, max(0, x - r):x + r].reshape(-1, 3), hsv[max(0, y - r):y + r, max(0, x - r):x + r].reshape(-1, 3)

    def frac(mask, c, n, d0, d1, half, ax):
        cnt = tot = 0
        for t in np.linspace(d0, d1, 9):
            for s in np.linspace(-half, half, 7):
                q = c + n * t + ax * s
                x, y = int(q[0] * k), int(q[1] * k)
                if 0 <= x < W and 0 <= y < H:
                    tot += 1; cnt += mask[y, x]
        return cnt / tot if tot else 0

    blocks, problems = [], []
    # manual corrections read off the map by eye (config 'position_fixes': {no: {"p": [x, y], "why": ...}}),
    # page points; applied before everything else and listed in blocks.json
    fixes = cfg.get('position_fixes', {})
    for n, fx in fixes.items():
        if int(n) <= N:
            P[int(n)] = np.array(fx['p'], float)
    fixed = set(int(n) for n in fixes)
    single = cfg.get('pairs') == 'single'  # detached villas: one number per building
    # a twin with one number read: its partner sits beside it as in the nearest twin with both numbers read.
    # A twin whose two readings are not side by side (one misread elsewhere, or both on one spot) keeps the
    # reading that lies next to the neighbouring twins (n-2, n+2) and has the other inferred the same way.
    inferred, misread = [], []
    if not single:
        d_all = [np.hypot(*(P[2 * i] - P[2 * i - 1])) for i in range(1, N // 2 + 1) if 2 * i - 1 in P and 2 * i in P]
        d_all = [x for x in d_all if 0.45 * pitch < x < 2.2 * pitch]
        dtw = float(np.median(d_all)) if d_all else pitch  # the twin spacing: two labels of one twin
        okpair = lambda a, b: a in P and b in P and 0.6 * dtw < np.hypot(*(P[b] - P[a])) < 1.4 * dtw
        for i in range(1, N // 2 + 1):
            a, b = 2 * i - 1, 2 * i
            if a in P and b in P and not okpair(a, b):
                nbc = [(P[x] + P[y]) / 2 for x, y in ((a - 2, b - 2), (a + 2, b + 2)) if okpair(x, y)] or [P[a], P[b]]
                da = min(np.hypot(*(P[a] - c)) for c in nbc); db = min(np.hypot(*(P[b] - c)) for c in nbc)
                # first: a reading lying on another twin's label (within 0.6 twin spacing) is the wrong one
                clash = lambda x: any(np.hypot(*(P[x] - P[y])) < 0.6 * dtw for y in P if y not in (a, b))
                ca, cb = clash(a), clash(b)
                drop = a if ca and not cb else b if cb and not ca else (b if da <= db else a)
                if drop in fixed:
                    drop = b if drop == a else a
                if drop in fixed:
                    continue
                misread.append(drop); P.pop(drop)
        # a reading that lies on a twin whose two numbers are both read correctly (within 0.6 twin spacing of
        # either) is a misreading of that twin's label: dropped
        good_pts = [P[x] for i in range(1, N // 2 + 1) for x in (2 * i - 1, 2 * i) if okpair(2 * i - 1, 2 * i)]
        for i in range(1, N // 2 + 1):
            a, b = 2 * i - 1, 2 * i
            if okpair(a, b):
                continue
            for x in (a, b):
                if x in P and x not in fixed and any(0 < np.hypot(*(P[x] - q)) < 0.6 * dtw for q in good_pts):
                    misread.append(x); P.pop(x)
        # two twins claiming one spot (a lone reading within 0.6 twin spacing of another twin's lone reading):
        # the reading whose number continues its neighbours (n-2 / n+2 twins next to it) keeps the spot
        lone = [x for x in P if (x + 1 if x % 2 else x - 1) not in P]
        for x in sorted(lone):
            for y in sorted(lone):
                # the two lone readings may be the two halves of one twin (61 | 162): the partner each would
                # get lands on the other one's spot
                if x < y and x in P and y in P and np.hypot(*(P[x] - P[y])) < 1.6 * dtw:
                    def fit(z):
                        nb = [P[w] for w in (z - 2, z - 1, z + 1, z + 2, z - 3, z + 3) if w in P and w not in (x, y)]
                        return min((np.hypot(*(P[z] - q)) for q in nb), default=1e9)
                    drop = y if fit(x) <= fit(y) else x
                    if drop in fixed:
                        drop = x if drop == y else y
                    if drop in fixed:
                        continue
                    misread.append(drop); P.pop(drop)
        full = [(2 * i - 1, 2 * i) for i in range(1, N // 2 + 1) if okpair(2 * i - 1, 2 * i)]
        for i in range(1, N // 2 + 1):
            a, b = 2 * i - 1, 2 * i
            if (a in P) == (b in P):
                continue
            have = a if a in P else b
            ref = min(full, key=lambda q: np.hypot(*(P[q[0]] - P[have])))
            off = P[ref[1]] - P[ref[0]]
            if np.hypot(*(P[ref[0]] - P[have])) > 4 * pitch:
                continue
            if a in P:
                P[b] = P[a] + off
            else:
                P[a] = P[b] - off
            inferred.append(b if a == have else a)
    pairs = [(n, n) for n in range(1, N + 1)] if single else [(2 * i - 1, 2 * i) for i in range(1, N // 2 + 1)]
    # pass 1: the colour of every block (both halves around the numbers, dark text / outlines left out)
    good, cols = [], []
    for a, b in pairs:
        if a not in P or b not in P:
            problems.append({'pair': [a, b], 'why': 'number not read'}); continue
        dab = 0.45 * pitch if single else np.hypot(*(P[b] - P[a]))
        if not single and not (0.45 * pitch < dab < 2.2 * pitch):
            problems.append({'pair': [a, b], 'why': f'numbers {dab:.1f} pt apart, not side by side'}); continue
        cl = []
        for p in ((P[a],) if single else (P[a], P[b])):
            l_, h_ = sample(p, (0.4 if single else 0.32) * dab)
            cl.append(l_[h_[:, 2] > 150])
        good.append((a, b, dab)); cols.append(np.median(np.concatenate(cl), 0))
    # the printed raster is a little darker than the legend's vector swatches: the block colours fall in
    # as many clusters as the legend has types; each cluster is matched to one swatch (least total distance)
    from scipy.optimize import linear_sum_assignment
    Z = np.float32(cols)
    _, lbl, cen = cv2.kmeans(Z, len(L), None, (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 100, 0.2), 20, cv2.KMEANS_PP_CENTERS)
    ri, ci = linear_sum_assignment(np.linalg.norm(cen[:, None, :] - L[None, :, :], axis=2))
    cl2leg = dict(zip(ri, ci))
    calib = [{'legend': f"{leg[cl2leg[c]]['design']} {leg[cl2leg[c]]['beds']} BR", 'printed_lab': cen[c].round(1).tolist(),
              'distance_to_swatch': round(float(np.linalg.norm(cen[c] - L[cl2leg[c]])), 1), 'blocks': int((lbl == c).sum())} for c in range(len(L))]
    for (a, b, dab), col, c in zip(good, cols, lbl.ravel()):
        ti = cl2leg[c]
        dists = np.linalg.norm(cen - col, axis=1); srt = np.sort(dists)
        share = float(srt[1] / (srt[0] + srt[1] + 1e-6))  # 0.5 = between two clusters, 1 = on its cluster
        tcol = cen[c]
        # block region: pixels of that legend colour connected to the pair
        mid = (P[a] + P[b]) / 2
        R = int(2.2 * pitch * k)
        x0, y0 = max(0, int(mid[0] * k) - R), max(0, int(mid[1] * k) - R)
        sub = lab[y0:y0 + 2 * R, x0:x0 + 2 * R]
        m = (np.linalg.norm(sub - tcol, axis=2) < 16).astype(np.uint8)
        # numbers and the dividing line are dark: close them into the block
        m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
        cnt, labm, st, _ = cv2.connectedComponentsWithStats(m, 8)
        cx, cy = int(mid[0] * k) - x0, int(mid[1] * k) - y0
        ids = {labm[int(q[1] * k) - y0, int(q[0] * k) - x0] for q in (P[a], P[b], mid) if 0 <= int(q[1] * k) - y0 < m.shape[0] and 0 <= int(q[0] * k) - x0 < m.shape[1]} - {0}
        ax = (P[b] - P[a]) / dab if not single else np.array([1.0, 0.0])
        geom = None
        if ids:
            pts = np.column_stack(np.nonzero(np.isin(labm, list(ids))))[:, ::-1].astype(np.float32)
            if single and len(pts) > 30:
                # a detached building: its own outline gives the axis (minimum-area rectangle)
                (_, _), (rw, rh), ang = cv2.minAreaRect(pts)
                a_ = np.radians(ang if rw >= rh else ang + 90)
                ax = np.array([np.cos(a_), np.sin(a_)])
            if len(pts) > 30:
                pts_pt = (pts + [x0, y0]) / k
                rel = pts_pt - mid
                u = rel @ ax; v = rel @ np.array([-ax[1], ax[0]])
                lo_u, hi_u = np.percentile(u, [2, 98]); lo_v, hi_v = np.percentile(v, [2, 98])
                geom = (lo_u, hi_u, lo_v, hi_v)
        if geom is None or (geom[1] - geom[0]) < (0.6 if single else 0.8) * dab or (geom[1] - geom[0]) > 3.2 * dab:
            problems.append({'pair': [a, b], 'why': 'block outline not traced (pale colour); median block size used'})
            geom = None
        traced = geom is not None
        if not traced:
            geom = (-dab, dab, -0.8 * dab, 0.8 * dab)  # replaced by the median traced size below
        lo_u, hi_u, lo_v, hi_v = geom
        nrm = np.array([-ax[1], ax[0]])
        bc = mid + ax * (lo_u + hi_u) / 2 + nrm * (lo_v + hi_v) / 2
        Lb, Db = hi_u - lo_u, hi_v - lo_v
        front = nrm  # decided below, from the neighbouring blocks
        s1 = s2 = 0.0
        blocks.append({'units': [a] if single else [a, b], 'c': bc.round(2).tolist(), 'axis': ax.round(4).tolist(), 'front': front.round(4).tolist(),
                       'L': round(float(Lb), 2), 'D': round(float(Db), 2), 'design': leg[ti]['design'], 'beds': leg[ti]['beds'],
                       'type_share': round(float(share), 2), 'front_conf': round(abs(s1 - s2), 3), 'traced': traced, 'dab': round(float(dab), 2)})
    # detached villas: bedrooms from the plot colour around the building (TYPES legend), calibrated like
    # the building colours (clusters matched to the legend swatches)
    plot_leg = cfg.get('plot_legend')
    plot_calib = None
    if plot_leg:
        PL = np.array([lab_of(x['rgb']) for x in plot_leg])
        rc = []
        for bk in blocks:
            c = np.array(bk['c']); half = max(bk['L'], bk['D']) / 2
            got = []
            for ang in np.linspace(0, 2 * np.pi, 48, endpoint=False):
                for rr in np.linspace(half + 1.5, half + 0.22 * pitch, 4):
                    q = c + rr * np.array([np.cos(ang), np.sin(ang)])
                    x, y = int(q[0] * k), int(q[1] * k)
                    if 0 <= x < W and 0 <= y < H:
                        hh = hsv[y, x]
                        if hh[1] > 15 and hh[2] > 120 and not (35 < hh[0] < 95 and hh[1] > 60):
                            got.append(lab[y, x])
            rc.append(np.median(got, 0) if len(got) > 10 else None)
        ok = [i for i, c in enumerate(rc) if c is not None]
        Zp = np.float32([rc[i] for i in ok])
        _, lp, cp = cv2.kmeans(Zp, len(PL), None, (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 100, 0.2), 20, cv2.KMEANS_PP_CENTERS)
        r2, c2 = linear_sum_assignment(np.linalg.norm(cp[:, None, :] - PL[None, :, :], axis=2))
        m2 = dict(zip(r2, c2))
        for i, c in zip(ok, lp.ravel()):
            blocks[i]['beds'] = plot_leg[m2[c]]['beds']
        for i in range(len(blocks)):
            if rc[i] is None:
                blocks[i]['beds'] = None; problems.append({'pair': blocks[i]['units'], 'why': 'plot colour not read'})
        plot_calib = [{'legend': f"{plot_leg[m2[c]]['beds']} BR", 'printed_lab': cp[c].round(1).tolist(),
                       'distance_to_swatch': round(float(np.linalg.norm(cp[c] - PL[m2[c]])), 1), 'blocks': int((lp == c).sum())} for c in range(len(PL))]
    # blocks whose outline was not traced: the median size of the traced blocks (relative to the number
    # spacing), centred on the pair; facing as measured
    tr = [bk for bk in blocks if bk['traced']]
    if tr:
        rl = float(np.median([bk['L'] / bk['dab'] for bk in tr])); rd = float(np.median([bk['D'] / bk['dab'] for bk in tr]))
        for bk in blocks:
            # an outline that ran into the next block (two pale blocks touching) is not used either
            if bk['traced'] and (bk['L'] / bk['dab'] > 1.25 * rl or bk['D'] / bk['dab'] > 1.25 * rd or bk['L'] / bk['dab'] < 0.75 * rl):
                bk['traced'] = False
                problems.append({'pair': bk['units'], 'why': 'block outline merged with a neighbour; median block size used'})
            if not bk['traced']:
                mid = np.mean([P[u] for u in bk['units']], 0)
                bk['c'] = mid.round(2).tolist(); bk['L'] = round(rl * bk['dab'], 2); bk['D'] = round(rd * bk['dab'], 2)

    # facing: rows face each other across a road; their backs face water, green or the boundary. For each
    # block, on both long sides: the nearest block across (centre within the block's length along the row);
    # the strip halfway between them is sampled - road grey counts for the side, water / green against it.
    # A side with no block in reach (outer ring, open landscape) counts as a back.
    # a block turned against both of its nearest blocks (> 20 deg, a misplaced reading) takes their direction
    if not single and len(blocks) > 3:
        Cb0 = np.array([bk['c'] for bk in blocks]); A0 = np.array([bk['axis'] for bk in blocks])
        turned = 0
        for i, bk in enumerate(blocks):
            dd = np.hypot(*(Cb0 - Cb0[i]).T); dd[i] = 1e9
            j1, j2 = np.argsort(dd)[:2]
            c1, c2 = abs(np.dot(A0[i], A0[j1])), abs(np.dot(A0[i], A0[j2]))
            if c1 < 0.94 and c2 < 0.94 and abs(np.dot(A0[j1], A0[j2])) > 0.94:
                a_ = A0[j1] + A0[j2] * np.sign(np.dot(A0[j1], A0[j2])); a_ /= np.hypot(*a_)
                a_ = a_ * np.sign(np.dot(a_, A0[i]) or 1)
                bk['axis'] = a_.round(4).tolist(); bk['axis_from_neighbours'] = True; turned += 1
        if turned:
            print(f'  {turned} blocks turned to their neighbours\' direction')
    Cb = np.array([bk['c'] for bk in blocks]); Ab = np.array([bk['axis'] for bk in blocks])
    def strip(mask, c, nvec, ax, half_a, half_n):
        cnt = tot = 0
        for t in np.linspace(-half_n, half_n, 5):
            for s_ in np.linspace(-half_a, half_a, 9):
                q = c + nvec * t + ax * s_
                x, y = int(q[0] * k), int(q[1] * k)
                if 0 <= x < W and 0 <= y < H:
                    tot += 1; cnt += mask[y, x]
        return cnt / tot if tot else 0
    if single:
        # a detached villa is nearly square: the way its row runs comes from its neighbours (the line through
        # its two nearest villas), and its front is one of the two sides across that row
        for i, bk in enumerate(blocks):
            c = np.array(bk['c']); rel = Cb - c; dist = np.hypot(*rel.T); dist[i] = 1e9
            j1, j2 = np.argsort(dist)[:2]
            v1, v2 = rel[j1] / dist[j1], rel[j2] / dist[j2]
            r = (v1 - v2) if np.dot(v1, v2) < -0.3 else v1  # neighbours on both sides: the line through them
            r = r / (np.hypot(*r) or 1)
            if abs(np.dot(r, bk['axis'])) < 0.7:  # the outline's long side runs across: swap length and depth
                bk['L'], bk['D'] = bk['D'], bk['L']
            bk['axis'] = r.round(4).tolist()
        Ab = np.array([bk['axis'] for bk in blocks])

    soft_w = cfg.get('facing_green_weight', 1.0)  # 0 where the streets are tree-lined (The Farm Gardens)

    nearest_across = cfg.get('facing') == 'nearest_across'

    def side_score(i, c, d, lat_ax, depth, length):
        rel = Cb - c
        t = rel @ d; al = rel @ lat_ax
        cand = (t > 0.6 * depth) & (np.abs(al) < 1.3 * length) & (t < 5 * depth)
        cand[i] = False
        if cand.any():
            tj = float(t[cand].min())
            if nearest_across:
                # rows facing each other across a street stand closer than rows back to back (config)
                return 1.0 - tj / (5 * depth)
            mid = c + d * tj / 2
            gap = max(2.0, tj - depth)
            if single and gap < 0.5 * depth:
                return -1.0  # a side yard to the next villa, not a street
            return strip(road, mid, d, lat_ax, 0.35 * length, 0.42 * gap) - soft_w * strip(soft, mid, d, lat_ax, 0.35 * length, 0.42 * gap)
        # open side: a back, unless a road runs right along it (tie-break by the road share)
        return -0.5 + 0.2 * strip(road, c + d * (depth / 2 + 6), d, lat_ax, 0.35 * length, 3)

    for i, bk in enumerate(blocks):
        c, ax = np.array(bk['c']), np.array(bk['axis']); n = np.array([-ax[1], ax[0]])
        # twins / terraces: front on one of the two long sides; a detached villa: any of its four sides
        cands = [(n, ax, bk['D'], bk['L']), (-n, ax, bk['D'], bk['L'])]
        sc_ = [side_score(i, c, dv, la, dp, ln) for dv, la, dp, ln in cands]
        o = np.argsort(sc_)[::-1]
        fv = cands[o[0]][0]
        if single and o[0] >= 2:  # the front is on the other pair of sides: swap the axis
            bk['axis'] = np.array([fv[1], -fv[0]]).round(4).tolist()
            bk['L'], bk['D'] = round(float(bk['D']), 2), round(float(bk['L']), 2)
        bk['front'] = fv.round(4).tolist()
        bk['front_conf'] = round(float(sc_[o[0]] - sc_[o[1]]), 3)
        bk['front_scores'] = [round(float(x), 3) for x in sc_]
    if cfg.get('facing') == 'loop_inside':
        # villas numbered in one run around a loop street (a U): the street is inside the U. The run is cut
        # where consecutive numbers are more than 1.8 pitch apart; every villa of a run faces the side of
        # the run's direction (n-1 -> n+1) on which the run's centre lies for most of its villas.
        order = sorted(range(len(blocks)), key=lambda i: blocks[i]['units'][0])
        runs, cur = [], [order[0]]
        for a_, b_ in zip(order, order[1:]):
            if np.hypot(*(Cb[b_] - Cb[a_])) > 1.8 * pitch:
                runs.append(cur); cur = []
            cur.append(b_)
        runs.append(cur)
        loop_runs = []
        for run in runs:
            if len(run) < 3:
                continue  # too short to tell its inside: keeps the facing read above
            cen = Cb[run].mean(0)
            tans = []
            for q, i in enumerate(run):
                a_, b_ = run[max(0, q - 1)], run[min(len(run) - 1, q + 1)]
                t_ = Cb[b_] - Cb[a_]; tans.append(t_ / (np.hypot(*t_) or 1))
            lefts = [np.array([t_[1], -t_[0]]) for t_ in tans]  # image y down: (ty, -tx) is the left of travel
            vote = sum(np.sign(np.dot(l_, cen - Cb[i])) for l_, i in zip(lefts, run))
            side = 1 if vote >= 0 else -1
            for l_, i in zip(lefts, run):
                f_ = l_ * side
                bk = blocks[i]
                ax_ = np.array([f_[1], -f_[0]])
                if abs(np.dot(ax_, bk['axis'])) < 0.7:
                    bk['L'], bk['D'] = bk['D'], bk['L']
                bk['axis'] = ax_.round(4).tolist(); bk['front'] = f_.round(4).tolist(); bk['front_conf'] = 1.0
            loop_runs.append([blocks[run[0]]['units'][0], blocks[run[-1]]['units'][0]])
        print('  loop runs (first, last number):', loop_runs)
    # neighbours along a row face the same way: a block whose two row neighbours both face the other way
    # (and are surer) follows them
    for it in range(3):
        for i, bk in enumerate(blocks):
            c, ax = np.array(bk['c']), np.array(bk['axis']); n = np.array([-ax[1], ax[0]])
            rel = Cb - c
            nb = [j for j in range(len(blocks)) if j != i and abs(rel[j] @ n) < 0.5 * bk['D'] and abs(rel[j] @ ax) < 2.2 * bk['L'] and abs(Ab[j] @ ax) > 0.8]
            if len(nb) >= 2:
                f = np.array(bk['front'])
                opp = [j for j in nb if np.dot(blocks[j]['front'], f) < 0]
                if len(opp) == len(nb) and bk['front_conf'] < min(blocks[j]['front_conf'] for j in opp):
                    bk['front'] = (-f).round(4).tolist(); bk['front_smoothed'] = True
    out = {'project': proj, 'kind': 'twin', 'count': N, 'pitch': pitch, 'source': raw['source'], 'blocks': blocks, 'problems': problems,
           'legend': leg, 'colour_calibration': calib, 'partner_inferred': sorted(inferred), 'misread_dropped': sorted(misread), 'manual_fixes': fixes, 'plot_legend': plot_leg, 'plot_colour_calibration': plot_calib}
    json.dump(out, open(os.path.join(d, 'blocks.json'), 'w'), indent=0)
    vis = im.copy()
    for bk in blocks:
        c = np.array(bk['c']); ax = np.array(bk['axis']); n = np.array([-ax[1], ax[0]])
        q = [c + ax * su * bk['L'] / 2 + n * sv * bk['D'] / 2 for su, sv in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
        cv2.polylines(vis, [np.int32(np.array(q) * k)], True, (255, 0, 0), 2)
        f = np.array(bk['front'])
        cv2.arrowedLine(vis, tuple(np.int32(c * k)), tuple(np.int32((c + f * (bk['D'] / 2 + 8)) * k)), (0, 160, 0), 2)
    cv2.imwrite(f'/tmp/blocks_{proj}.png', vis)
    from collections import Counter
    types = Counter(f"{bk['design']} {bk['beds']} BR" for bk in blocks)
    print(f"{proj}: {len(blocks)} twin blocks ({2 * len(blocks)} units of {N}); problems {len(problems)} {problems[:6]}")
    for c in calib + (plot_calib or []):
        print('  colour', c)
    print('  types (blocks):', dict(types), '; ambiguous colour (<0.7):', sum(1 for bk in blocks if bk['type_share'] < 0.7),
          '; low facing confidence (<0.08):', sum(1 for bk in blocks if bk['front_conf'] < 0.08))


if __name__ == '__main__':
    main()

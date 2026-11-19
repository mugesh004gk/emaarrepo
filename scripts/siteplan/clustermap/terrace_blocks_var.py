#!/usr/bin/env python3
"""Terraces of mixed sizes found as drawn buildings, numbered by the readings inside them (Nima).

  python terrace_blocks_var.py <project> <map.pdf> [page]

For maps where the number reader places some labels off their homes (labels along curved rows) and the
terraces have several sizes (config "plex_sizes": [4, 6, 8, 10]):
1. buildings: the roof cells (white 3 BR and dark-grey 4 BR, unsaturated) joined into one block per terrace,
   kept when ringed by plot colour (config "plot_hsv") and of terrace proportions; outline = min-area rectangle;
2. size: the allowed size nearest to the outline length / home width (home width = median over buildings
   whose size is clear), or, more reliably, the number of dark-grey 4 BR end cells + white cells along it;
3. numbers: every reading inside the building, at a position i along it, votes for (first number, direction)
   = (reading - i) or (reading - (size - 1 - i)); the best-supported pair numbers the building. Overlapping
   number runs between buildings: the better-supported keeps it; a building with no reading takes the free run
   between its numbered neighbours when the size fits;
4. front: the long side with more road (light grey) next to it.
Writes layout.json in the format of layout_units.py (page points), so place_cluster.py follows.
"""
import json, os, subprocess, sys, tempfile
from collections import Counter
import numpy as np
import cv2

APP = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
DPI = 300


def main():
    proj, pdf = sys.argv[1], sys.argv[2]
    page = int(sys.argv[3]) if len(sys.argv) > 3 else 1
    d = os.path.join(APP, 'data', 'siteplans', proj)
    cfg = json.load(open(os.path.join(d, 'config.json')))
    raw = json.load(open(os.path.join(d, 'units_raw.json')))
    N, sizes = cfg['count'], cfg['plex_sizes']
    k = DPI / 72.0
    td = tempfile.mkdtemp()
    subprocess.run(['pdftoppm', '-q', '-r', str(DPI), '-png', '-f', str(page), '-l', str(page), pdf, os.path.join(td, 'p')], check=True)
    im = cv2.imread(os.path.join(td, [f for f in os.listdir(td) if f.endswith('.png')][0]))
    hsv = cv2.cvtColor(cv2.GaussianBlur(im, (3, 3), 0), cv2.COLOR_BGR2HSV)
    H, S, V = hsv[..., 0].astype(int), hsv[..., 1].astype(int), hsv[..., 2].astype(int)
    plot = np.zeros(H.shape, bool)
    for h0, h1, s0, s1, v0, v1 in cfg['plot_hsv']:
        plot |= (H >= h0) & (H <= h1) & (S >= s0) & (S <= s1) & (V >= v0) & (V <= v1)
    wl, gl = cfg.get('white_v', [215, 256]), cfg.get('grey_v', [80, 140])
    white = (S < 18) & (V >= wl[0]) & (V < wl[1])
    grey = (S < 18) & (V >= gl[0]) & (V < gl[1])
    roof = (white | grey).astype(np.uint8)
    if cfg.get('crop'):
        a, b, c, e = [int(v * k) for v in cfg['crop']]
        m = np.zeros_like(roof); m[b:e, a:c] = 1; roof &= m
    roof = cv2.morphologyEx(roof, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    roof0 = roof.copy()
    cl = cfg.get('close_px', 5)
    roof = cv2.morphologyEx(roof, cv2.MORPH_CLOSE, np.ones((cl, cl), np.uint8))  # cell borders and label text
    pw = cfg.get('home_w_pt', raw['pitch']) * k  # home width on the page, px (config, else from the readings)
    if cfg.get('blocks_from_plot'):
        # each terrace stands on its own plot (one colour per style): the plot area of one colour with its holes
        # filled (the roofs, courtyards) is the terrace block; the roofs inside it give the outline
        blocks = np.zeros(roof.shape, np.uint8)
        for h0, h1, s0, s1, v0, v1 in cfg['plot_hsv']:
            pc = ((H >= h0) & (H <= h1) & (S >= s0) & (S <= s1) & (V >= v0) & (V <= v1)).astype(np.uint8)
            pc = cv2.morphologyEx(pc, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
            cnts, _ = cv2.findContours(pc, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            filled = np.zeros_like(pc)
            cv2.drawContours(filled, cnts, -1, 1, -1)
            blocks |= filled & roof0  # roofs standing on this colour's plot
        roof = cv2.morphologyEx(blocks, cv2.MORPH_CLOSE, np.ones((int(0.9 * pw) | 1, int(0.9 * pw) | 1), np.uint8))
        roof = cv2.erode(roof, np.ones((3, 3), np.uint8))
    n_, cc, st, _ = cv2.connectedComponentsWithStats(roof, 4)
    comps = []
    for i in range(1, n_):
        area = st[i, cv2.CC_STAT_AREA]
        if area > 14 * pw * pw * 1.6:
            # two terraces joined by the closing: split them with a lighter closing inside this piece
            x, y, w, h = st[i, :4]
            sub = (roof0[y:y + h, x:x + w] & (cc[y:y + h, x:x + w] == i)).astype(np.uint8)
            sub = cv2.morphologyEx(sub, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
            sub = cv2.erode(sub, np.ones((3, 3), np.uint8))
            m2, c2, s2, _ = cv2.connectedComponentsWithStats(sub, 4)
            for jj in range(1, m2):
                me = np.zeros(roof.shape, np.uint8); me[y:y + h, x:x + w] = (c2 == jj)
                comps.append((s2[jj, cv2.CC_STAT_AREA], me))
        else:
            comps.append((area, None, i))
    B = []
    for item in comps:
        area = item[0]
        if area < 2.5 * pw * pw or area > 14 * pw * pw * 1.6:
            continue
        me = item[1] if item[1] is not None else (cc == item[2]).astype(np.uint8)
        ring = cv2.dilate(me, np.ones((15, 15), np.uint8)) & (1 - me)
        if plot[ring > 0].mean() < cfg.get('ring_plot', 0.3):
            continue
        pts = np.column_stack(np.nonzero(me))[:, ::-1].astype(np.float32)
        (cx, cy), (w, h), ang = cv2.minAreaRect(pts)
        if w < h:
            w, h, ang = h, w, ang + 90
        if not (cfg.get('aspect_min', 2.5) < w / max(h, 1) < 9):
            continue
        a_ = np.radians(ang); ax = np.array([np.cos(a_), np.sin(a_)])
        # count the dark-grey cells along the axis (4 BR ends): 2 per terrace on these maps
        B.append({'c': np.array([cx, cy]), 'ax': ax, 'L': w, 'D': h, 'fill': area / (w * h)})
    # home width: buildings' length / nearest allowed size, iterated on the median
    hw = pw
    for _ in range(0 if cfg.get('home_w_pt') else 3):
        est = [b['L'] / min(sizes, key=lambda s: abs(b['L'] / hw - s)) for b in B]
        hw = float(np.median(est)) if est else hw
    for b in B:
        b['n'] = min(sizes, key=lambda s: abs(b['L'] / hw - s))
        b['size_err'] = round(abs(b['L'] / hw - b['n']), 2)
    print(f'{proj}: {len(B)} buildings, home width {hw / k:.2f} pt, sizes {Counter(b["n"] for b in B)} = {sum(b["n"] for b in B)} homes (expected {N})')
    # readings inside each building -> votes for (first, direction)
    U = {int(kk): np.array(v) * k for kk, v in raw['units'].items() if int(kk) <= N}
    for b in B:
        b['reads'] = []
    for n, p in U.items():
        for j, b in enumerate(B):
            rel = p - b['c']; u = rel @ b['ax']; v = rel @ np.array([-b['ax'][1], b['ax'][0]])
            if abs(u) <= b['L'] / 2 + 0.3 * hw and abs(v) <= b['D'] / 2 + 0.25 * hw:
                b['reads'].append((n, u))
    for b in B:
        votes = Counter()
        for n, u in b['reads']:
            i = int(np.clip(np.floor((u + b['L'] / 2) / (b['L'] / b['n'])), 0, b['n'] - 1))
            for sgn, idx in ((1, i), (-1, b['n'] - 1 - i)):
                first = n - idx
                if 1 <= first and first + b['n'] - 1 <= N:
                    votes[(first, sgn)] += 1
        b['vote'] = votes.most_common(1)[0] if votes else (None, 0)
    # resolve overlapping runs: best supported first
    order = sorted(range(len(B)), key=lambda j: -B[j]['vote'][1])
    used = set(); assigned = {}
    for j in order:
        key, nv = B[j]['vote']
        if not key or nv < cfg.get('min_votes', 2):
            continue
        run = set(range(key[0], key[0] + B[j]['n']))
        if run & used:
            continue
        used |= run; assigned[j] = key
    # buildings without a run: the free run between numbered neighbours, when its length fits
    free = sorted(set(range(1, N + 1)) - used)
    runs, cur = [], []
    for n in free:
        if cur and n != cur[-1] + 1:
            runs.append(cur); cur = []
        cur.append(n)
    if cur:
        runs.append(cur)
    cen = {}
    for j, (f, s_) in assigned.items():
        for t in range(B[j]['n']):
            cen[f + t] = B[j]['c']
    elim = []
    for r in runs:
        cand = [j for j in range(len(B)) if j not in assigned and B[j]['n'] == len(r)]
        nb = [cen[x] for x in (r[0] - 1, r[-1] + 1) if x in cen]
        if not cand or not nb:
            continue
        mid = np.mean(nb, 0)
        j = min(cand, key=lambda j: np.hypot(*(B[j]['c'] - mid)))
        if np.hypot(*(B[j]['c'] - mid)) < 2.2 * B[j]['L']:
            # direction: from the run's neighbours (n-1 near the first end)
            a0 = cen.get(r[0] - 1); sgn = 1
            if a0 is not None:
                sgn = 1 if (a0 - B[j]['c']) @ B[j]['ax'] < 0 else -1
            assigned[j] = (r[0], sgn); elim.append(r[0])
    # front: long side with more light-grey road near it
    road = ((S < 18) & (V > 150) & (V < 214)).astype(np.uint8)
    units, rows = {}, []
    for j, (first, sgn) in assigned.items():
        b = B[j]; ax = b['ax'] * sgn; nrm = np.array([-ax[1], ax[0]])
        def side(sv):
            cnt = tot = 0
            for t in np.linspace(-0.4, 0.4, 9) * b['L']:
                for o in (0.6, 1.0, 1.4):
                    q = b['c'] + ax * t + nrm * sv * (b['D'] / 2 + o * hw)
                    x, y = int(q[0]), int(q[1])
                    if 0 <= x < im.shape[1] and 0 <= y < im.shape[0]:
                        tot += 1; cnt += road[y, x]
            return cnt / tot if tot else 0
        s1, s2 = side(1), side(-1)
        fr = nrm if s1 >= s2 else -nrm
        nums = list(range(first, first + b['n']))
        for i, n in enumerate(nums):
            p = b['c'] + ax * (i - (b['n'] - 1) / 2) * b['L'] / b['n']
            units[n] = {'p': (p / k).round(2).tolist(), 'axis': ax.round(4).tolist(), 'front': fr.round(4).tolist(),
                        'conf': round(abs(s1 - s2), 3), 'interp': not any(r == n for r, _ in b['reads'])}
        rows.append(nums)
    rows.sort()
    missing = [n for n in range(1, N + 1) if n not in units]
    out = {'project': proj, 'kind': 'terrace', 'count': N, 'pitch': hw / k, 'read': len(U),
           'interpolated': sorted(n for n, u in units.items() if u['interp']), 'missing': missing,
           'units': {str(kk): v for kk, v in sorted(units.items())}, 'rows': rows, 'source': raw['source'],
           'method': 'terrace_blocks_var: one terrace per drawn building (size from its length), numbered by the readings inside it',
           'groups_by_elimination': elim}
    json.dump(out, open(os.path.join(d, 'layout.json'), 'w'))
    vis = im.copy()
    for j, b in enumerate(B):
        q = cv2.boxPoints(((b['c'][0], b['c'][1]), (b['L'], b['D']), np.degrees(np.arctan2(b['ax'][1], b['ax'][0]))))
        cv2.polylines(vis, [np.int32(q)], True, (0, 150, 0) if j in assigned else (0, 0, 255), 3)
        if j in assigned:
            f, s_ = assigned[j]
            cv2.putText(vis, f'{f}-{f + b["n"] - 1}', tuple(np.int32(b['c']) + [-40, 0]), 0, 0.9, (200, 0, 0), 2)
    cv2.imwrite(os.path.join(tempfile.gettempdir(), f'tbv_{proj}.jpg'), cv2.resize(vis, None, fx=0.5, fy=0.5))
    print(f'  numbered buildings {len(assigned)} of {len(B)}, homes {len(units)} of {N}; by elimination {elim}; missing {len(missing)}: {missing[:40]}')


if __name__ == '__main__':
    main()

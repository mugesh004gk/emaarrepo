#!/usr/bin/env python3
"""Terraces of a cluster map whose labels are too small to read one by one (Elea): one terrace per drawn
building, numbered from the readings that fall inside it.

  python terrace_blocks.py <project> <map.png>

config.json: {"count": 128, "plex": 4, "plot_hsv": [[85, 125, 40, 255, 60, 255]] (H lo, H hi, S lo, S hi, V lo, V hi),
              "crop": [x0, y0, x1, y1]}
1. buildings: light, unsaturated blocks (S < 25, V > 185) ringed by plot colour, of one terrace's size,
   split from the street by the plot ring; outline = minimum-area rectangle;
2. number group: each building holds plex consecutive homes 'plex*k+1 .. plex*k+plex'; k = the group most of the
   readings inside it point to (a reading names one home; a stray reading is outvoted). Two buildings with
   the same group: the one with more votes keeps it. A building with no reading takes, by elimination, a group
   no building has, when its two neighbouring groups (k-1, k+1) are the nearest buildings to it;
3. order along the building: from the positions of the readings of different numbers (a straight-line fit
   number -> position along the axis); one reading only: its position from the centre gives the end;
4. front: the long side with the driveway notch (darker plot colour reaching the building) - checked against
   which side has the street.
Writes layout.json (units p / axis / front, rows) in the format of layout_units.py, so place_cluster.py
follows; + /tmp/tblocks_<project>.png.
"""
import json, os, sys
from collections import Counter
import numpy as np
import cv2

APP = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))


def main():
    proj, png = sys.argv[1], sys.argv[2]
    d = os.path.join(APP, 'data', 'siteplans', proj)
    cfg = json.load(open(os.path.join(d, 'config.json')))
    raw = json.load(open(os.path.join(d, 'units_raw.json')))
    N, plex = cfg['count'], cfg['plex']
    im = cv2.imread(png)
    hsv = cv2.cvtColor(cv2.GaussianBlur(im, (3, 3), 0), cv2.COLOR_BGR2HSV)
    H, S, V = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    plot = np.zeros(H.shape, bool)
    for h0, h1, s0, s1, v0, v1 in cfg['plot_hsv']:
        plot |= (H >= h0) & (H <= h1) & (S >= s0) & (S <= s1) & (V >= v0) & (V <= v1)
    light = ((S < 25) & (V > 185)).astype(np.uint8)
    if cfg.get('crop'):
        a, b, c, e = cfg['crop']; m = np.zeros_like(light); m[b:e, a:c] = 1; light &= m
    light = cv2.morphologyEx(light, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n_, cc, st, cen = cv2.connectedComponentsWithStats(light, 4)
    B = []
    for i in range(1, n_):
        area = st[i, cv2.CC_STAT_AREA]
        if area < cfg.get('min_area', 500) or area > cfg.get('max_area', 6000):
            continue
        me = (cc == i).astype(np.uint8)
        ring = cv2.dilate(me, np.ones((9, 9), np.uint8)) & (1 - me)
        if plot[ring > 0].mean() < cfg.get('ring_plot', 0.35):
            continue
        pts = np.column_stack(np.nonzero(me))[:, ::-1].astype(np.float32)
        (cx, cy), (w, h), ang = cv2.minAreaRect(pts)
        if w < h:
            w, h, ang = h, w, ang + 90
        if not (cfg.get('aspect', [1.6, 5.5])[0] < w / max(h, 1) < cfg.get('aspect', [1.6, 5.5])[1]):
            continue
        a_ = np.radians(ang)
        B.append({'c': np.array([cx, cy]), 'ax': np.array([np.cos(a_), np.sin(a_)]), 'L': w, 'D': h, 'lab': i})
    print(f'{proj}: {len(B)} buildings found (expected {N // plex})')
    # readings inside each building
    U = {int(k): np.array(v) for k, v in raw['units'].items() if int(k) <= N}
    for b in B:
        b['reads'] = []
    for n, p in U.items():
        best = None
        for j, b in enumerate(B):
            rel = p - b['c']; u = rel @ b['ax']; v = rel @ np.array([-b['ax'][1], b['ax'][0]])
            if abs(u) <= b['L'] / 2 + 3 and abs(v) <= b['D'] / 2 + 3:
                dd = np.hypot(u, v)
                if best is None or dd < best[0]:
                    best = (dd, j)
        if best:
            B[best[1]]['reads'].append((n, p))
    for b in B:
        votes = Counter((n - 1) // plex for n, _ in b['reads'])
        b['k'], b['votes'] = (votes.most_common(1)[0] if votes else (None, 0))
    # groups read by eye on the map (config 'group_fixes': [{"near": [x, y], "first": n, "why": ...}]): the building
    # nearest the point holds homes n .. n+plex-1; any other building given that group loses it
    for fx in cfg.get('group_fixes', []):
        k = (fx['first'] - 1) // plex
        j = min(range(len(B)), key=lambda j: np.hypot(*(B[j]['c'] - np.array(fx['near']))))
        for b in B:
            if b['k'] == k:
                b['k'] = None
        B[j]['k'] = k; B[j]['votes'] = 99; B[j]['fixed'] = fx['why']
        B[j]['reads'] = [(n, p) for n, p in B[j]['reads'] if (n - 1) // plex == k]
    # one building per group: most votes keeps it
    byk = {}
    for j, b in enumerate(B):
        if b['k'] is not None:
            byk.setdefault(b['k'], []).append(j)
    for k, js in byk.items():
        js.sort(key=lambda j: -B[j]['votes'])
        for j in js[1:]:
            B[j]['k'] = None
    # elimination: unnumbered buildings take a free group whose neighbours are nearest
    taken = {b['k'] for b in B if b['k'] is not None}
    free = [k for k in range(N // plex) if k not in taken]
    cent = {b['k']: b['c'] for b in B if b['k'] is not None}
    elim = []
    for k in free:
        nb = [cent[x] for x in (k - 1, k + 1) if x in cent]
        if not nb:
            continue
        mid = np.mean(nb, 0)
        cand = [j for j, b in enumerate(B) if b['k'] is None]
        if not cand:
            break
        j = min(cand, key=lambda j: np.hypot(*(B[j]['c'] - mid)))
        if np.hypot(*(B[j]['c'] - mid)) < 2.5 * B[j]['L']:
            B[j]['k'] = k; elim.append(k + 1); cent[k] = B[j]['c']
    numbered = [b for b in B if b['k'] is not None]
    # order along the axis and front side
    units, rows, notes = {}, [], []
    for b in numbered:
        k = b['k']; nums = list(range(plex * k + 1, plex * k + plex + 1))
        ax = b['ax']; nrm = np.array([-ax[1], ax[0]])
        rd = [(n, (p - b['c']) @ ax) for n, p in b['reads'] if (n - 1) // plex == k]
        sgn = 1
        if len({n for n, _ in rd}) >= 2:
            x = np.array([n for n, _ in rd], float); y = np.array([t for _, t in rd])
            sgn = 1 if np.polyfit(x, y, 1)[0] > 0 else -1
        elif rd:
            n, t = rd[0]; j = n - nums[0]
            expect = (j - (plex - 1) / 2) * b['L'] / plex
            sgn = 1 if (expect == 0 or np.sign(expect) == np.sign(t) or abs(t) < 2) else -1
            if expect == 0:
                notes.append(nums[0])
        else:
            notes.append(nums[0])
        # the first home's label read by eye (config 'first_at': {"n": [x, y]}): that end is the first
        fa = cfg.get('first_at', {}).get(str(nums[0]))
        if fa:
            sgn = -1 if (np.array(fa) - b['c']) @ ax > 0 else 1
            notes = [x for x in notes if x != nums[0]]
        # front: the long side where darker plot colour (driveway notch) touches the building
        def side(sv):
            cnt = tot = 0
            for t in np.linspace(-0.4, 0.4, 9) * b['L']:
                for o in (1.5, 3.0):
                    q = b['c'] + ax * t + nrm * sv * (b['D'] / 2 + o)
                    xq, yq = int(q[0]), int(q[1])
                    if 0 <= xq < im.shape[1] and 0 <= yq < im.shape[0]:
                        tot += 1; cnt += (V[yq, xq] < 170) and plot[yq, xq]
            return cnt / tot if tot else 0
        fr = nrm if side(1) >= side(-1) else -nrm
        for j, n in enumerate(nums):
            t = sgn * (j - (plex - 1) / 2) * b['L'] / plex
            units[n] = {'p': (b['c'] + ax * t).round(2).tolist(), 'axis': (ax * sgn).round(4).tolist(), 'front': fr.round(4).tolist(),
                        'conf': round(abs(side(1) - side(-1)), 3), 'interp': not any(r == n for r, _ in b['reads'])}
        rows.append(nums)
    rows.sort()
    missing = [n for n in range(1, N + 1) if n not in units]
    pitch = float(np.median([b['L'] / plex for b in numbered]))
    out = {'project': proj, 'kind': 'terrace', 'count': N, 'pitch': pitch, 'read': len(U), 'interpolated': sorted(n for n, u in units.items() if u['interp']),
           'missing': missing, 'units': {str(k): v for k, v in sorted(units.items())}, 'rows': rows, 'source': raw['source'],
           'method': 'terrace_blocks: one terrace per drawn building, numbered by the readings inside it',
           'groups_by_elimination': elim, 'order_unsure': notes, 'group_fixes': cfg.get('group_fixes', [])}
    json.dump(out, open(os.path.join(d, 'layout.json'), 'w'))
    vis = im.copy()
    for b in B:
        q = cv2.boxPoints(((b['c'][0], b['c'][1]), (b['L'], b['D']), np.degrees(np.arctan2(b['ax'][1], b['ax'][0]))))
        cv2.polylines(vis, [np.int32(q)], True, (0, 0, 255) if b['k'] is None else (0, 150, 0), 1)
    for n, u in units.items():
        cv2.putText(vis, str(n), (int(u['p'][0]) - 6, int(u['p'][1]) + 3), 0, 0.3, (200, 0, 0), 1)
        if (n - 1) % plex == 0:
            c = np.array(u['p']); f = np.array(u['front'])
            cv2.arrowedLine(vis, tuple(np.int32(c)), tuple(np.int32(c + f * 12)), (0, 0, 255), 1)
    cv2.imwrite(f'/tmp/tblocks_{proj}.png', vis)
    print(f'  numbered buildings {len(numbered)}, homes {len(units)} of {N}; groups by elimination {elim}; order unsure {notes}; missing {missing[:20]}')


if __name__ == '__main__':
    main()

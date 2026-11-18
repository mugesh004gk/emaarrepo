#!/usr/bin/env python3
"""Detached villas of a cluster map from their drawn buildings, numbered from the labels that can be read.

  python scripts/siteplan/clustermap/villa_buildings.py <project> <brochure.pdf> <page>

For maps whose labels the OCR reads only in part (Farm Gardens 2: 166 of 256). config.json:
  {"count": 256, "pairs": "single", "plot_styles": [{"design": "Horizon", "rgb": [...]}, ...],
   "building_beds": {"grey": 4, "white": 5}}
1. buildings: light, unsaturated blobs (grey or white) enclosed by a coloured plot (the style colours);
   thin plot dividers are opened away. Each building: centre, outline (minimum-area rectangle);
2. numbers: a building takes the read label that lies inside it (units_raw.json: OCR, second look);
3. the rest: the villas of a street are numbered in order. From each numbered building the chain is
   walked to the next building in the row (nearest, roughly straight on); a gap of unread buildings
   between n and m is numbered n+1 ... m-1 only if it holds exactly m-n-1 buildings (else left unnumbered
   and listed);
4. type: building grey = 4 BR, white = 5 BR (TYPES legend); style = the plot colour around it (STYLES);
   front = the side where the building meets its plot's edge on the street (buildings stand at the
   street edge of their plots): the side whose strip just outside the building is not plot colour.
Writes blocks.json in the format of twins.py (units [n]), so place_blocks.py / block_roads.py follow.
"""
import json, os, subprocess, sys, tempfile
from collections import Counter
import numpy as np
import cv2

APP = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
DPI = 216


def lab_of(rgb):
    return cv2.cvtColor(np.uint8([[rgb[::-1]]]), cv2.COLOR_BGR2LAB)[0, 0].astype(np.float32)


def main():
    proj, pdf, page = sys.argv[1], sys.argv[2], int(sys.argv[3])
    d = os.path.join(APP, 'data', 'siteplans', proj)
    cfg = json.load(open(os.path.join(d, 'config.json')))
    raw = json.load(open(os.path.join(d, 'units_raw.json')))
    N = cfg['count']
    td = tempfile.mkdtemp()
    subprocess.run(['pdftoppm', '-q', '-r', str(DPI), '-png', '-f', str(page), '-l', str(page), pdf, os.path.join(td, 'p')], check=True)
    im = cv2.imread(os.path.join(td, [f for f in os.listdir(td) if f.endswith('.png')][0]))
    k = DPI / 72.0
    hsv = cv2.cvtColor(cv2.GaussianBlur(im, (3, 3), 0), cv2.COLOR_BGR2HSV)
    lab = cv2.cvtColor(cv2.GaussianBlur(im, (3, 3), 0), cv2.COLOR_BGR2LAB).astype(np.float32)
    styles = cfg['plot_styles']
    SL = np.array([lab_of(s['rgb']) for s in styles])
    dist = np.linalg.norm(lab[:, :, None, :] - SL[None, None, :, :], axis=3)
    plot = (dist.min(2) < cfg.get('plot_tol', 22)) & (hsv[..., 1] > 40)
    plot_id = dist.argmin(2)
    # building fill: unsaturated light grey (4 BR) or near white (5 BR), cut off from the street strip by
    # the plot's thin dark edge line; opened so that touching pieces separate, then the label text closed in
    bld = ((hsv[..., 1] < 20) & (hsv[..., 2] > 195)).astype(np.uint8)
    bld = cv2.morphologyEx(bld, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5)))
    n0, cc0, st0, _ = cv2.connectedComponentsWithStats(bld, 8)
    keep = np.zeros(n0, np.uint8)
    keep[1:] = (st0[1:, cv2.CC_STAT_AREA] < 20000) & (st0[1:, cv2.CC_STAT_AREA] > 300)
    bld = keep[cc0]
    # the label's glyphs are holes in the fill: small holes are filled (closing would join neighbours)
    nh, ch, sth, _ = cv2.connectedComponentsWithStats((1 - bld).astype(np.uint8), 4)
    small = np.zeros(nh, np.uint8); small[1:] = sth[1:, cv2.CC_STAT_AREA] < 900
    bld = bld | small[ch]
    n_, cc, st, cen = cv2.connectedComponentsWithStats(bld, 8)
    areas = st[1:, cv2.CC_STAT_AREA]
    med = float(np.median(areas[areas > 400])) if (areas > 400).any() else 0
    B = []
    for i in range(1, n_):
        a = st[i, cv2.CC_STAT_AREA]
        if not (0.4 * med < a < 2.0 * med):
            continue
        ys, xs = np.nonzero(cc == i)
        pts = np.column_stack([xs, ys]).astype(np.float32)
        (cx, cy), (w, h), ang = cv2.minAreaRect(pts)
        # touching a plot on all sides (not a white patch of open ground)
        me = (cc == i).astype(np.uint8)
        ring = cv2.dilate(me, np.ones((23, 23), np.uint8)) & (1 - cv2.dilate(me, np.ones((9, 9), np.uint8)))  # 4-11 px out, past the outline
        rp = plot[ring > 0]
        if rp.mean() < 0.35:
            continue
        sty = Counter(plot_id[ring > 0][rp]).most_common(1)[0][0]
        vv = hsv[cc == i]
        grey = np.percentile(vv[:, 2], 60) < 228
        B.append({'c': [cx / k, cy / k], 'w': w / k, 'h': h / k, 'ang': ang, 'style': styles[sty]['design'],
                  'kind': 'grey' if grey else 'white', 'px': (cx, cy), 'lab': i, 'n': None})
    # villa buildings are all of one size; small round amenity markers / thin slivers are not villas
    sz = np.array([(min(b['w'], b['h']), max(b['w'], b['h'])) for b in B])
    mshort, mlong = np.median(sz[:, 0]), np.median(sz[:, 1])
    B = [b for b, (sh, lg) in zip(B, sz) if sh > 0.6 * mshort and lg > 0.6 * mlong and lg < 1.6 * mlong]
    print(f'{proj}: {len(B)} buildings found (expected {N})')
    # numbers read inside a building
    U = {int(n): np.array(v) for n, v in raw['units'].items() if int(n) <= N}
    owner = {}
    for n, p in U.items():
        x, y = int(p[0] * k), int(p[1] * k)
        if 0 <= y < cc.shape[0] and 0 <= x < cc.shape[1] and cc[y, x] > 0:
            owner.setdefault(cc[y, x], []).append(n)
        else:
            # a label just outside its building (anti-aliasing / dividers): nearest building centre within 0.6 bldg
            best = min(B, key=lambda b: np.hypot(b['c'][0] - p[0], b['c'][1] - p[1]))
            if np.hypot(best['c'][0] - p[0], best['c'][1] - p[1]) < 0.6 * max(best['w'], best['h']):
                owner.setdefault(best['lab'], []).append(n)
    conflicts = []
    for b in B:
        ns = owner.get(b['lab'], [])
        if len(ns) == 1:
            b['n'] = ns[0]
        elif len(ns) > 1:
            conflicts.append(ns)
    # (a building-by-building re-reading was tried: the labels in this map picture are about 9 x 8 pixels
    # at its native resolution - Vision OCR and digit templates both fail on them; not used)
    # a number claimed by two buildings: neither keeps it
    cnt = Counter(b['n'] for b in B if b['n'])
    for b in B:
        if b['n'] and cnt[b['n']] > 1:
            b['n'] = None
    # sequence check: a read number must have n-1 or n+1 (or an unnumbered building) among its 3 nearest
    # buildings - a number that sits among unrelated numbers is a misreading and is dropped
    Cc = np.array([b['c'] for b in B])
    dropped = []
    for i, b in enumerate(B):
        if not b['n']:
            continue
        dd = np.hypot(*(Cc - Cc[i]).T); dd[i] = 1e9
        near = [B[j]['n'] for j in np.argsort(dd)[:3]]
        if not any(x is None or abs(x - b['n']) == 1 for x in near):
            dropped.append(b['n']); b['n'] = None
    if dropped:
        print(f'  read numbers dropped (not beside n-1 / n+1): {sorted(dropped)}')
    read = sum(1 for b in B if b['n'] and not b.get('reread'))
    # chains: from each numbered building, next building in the row
    C = np.array([b['c'] for b in B]); size = float(np.median([max(b['w'], b['h']) for b in B]))
    byn = {b['n']: i for i, b in enumerate(B) if b['n']}

    def nxt(i, prev_dir):
        rel = C - C[i]; dd = np.hypot(*rel.T); dd[i] = 1e9
        cand = [j for j in np.argsort(dd)[:8] if dd[j] < 2.4 * size]
        if prev_dir is not None:
            cand = [j for j in cand if np.dot(rel[j] / dd[j], prev_dir) > 0.5]
        return cand[0] if cand else None

    filled = []
    for n in sorted(byn):
        m = next((x for x in range(n + 1, min(N, n + 16) + 1) if x in byn), None)
        if m is None or m == n + 1:
            continue
        i0, i1 = byn[n], byn[m]
        # direction: away from n-1 if known, else toward m
        if n - 1 in byn:
            v = C[i0] - C[byn[n - 1]]
        else:
            v = C[i1] - C[i0]
        v = v / (np.hypot(*v) or 1)
        path, cur, ok = [], i0, False
        for _ in range(m - n + 1):
            j = nxt(cur, v)
            if j is None:
                break
            if j == i1:
                ok = len(path) == m - n - 1
                break
            if B[j]['n'] is not None:
                break
            v2 = C[j] - C[cur]; v = v2 / (np.hypot(*v2) or 1)
            path.append(j); cur = j
        if ok:
            for q, j in enumerate(path):
                B[j]['n'] = n + 1 + q; B[j]['filled'] = True
                filled.append(n + 1 + q)
    nums = [b['n'] for b in B if b['n']]
    missing = [x for x in range(1, N + 1) if x not in nums]
    unnumbered = [b for b in B if not b['n']]
    print(f'  numbers: read in a building {read}, filled along the row {len(filled)}, still missing {len(missing)} {missing[:40]}; '
          f'buildings without a number {len(unnumbered)}; label conflicts {conflicts[:5]}')
    # front, step 1: the building side touching its plot's street edge = the side whose strip just outside
    # the building is not plot colour (right on straight rows; curved wedge plots can mislead it)
    blocks = []
    for b in B:
        a_ = np.radians(b['ang']); u = np.array([np.cos(a_), np.sin(a_)]); v = np.array([-u[1], u[0]])
        half = {tuple(u): b['w'] / 2, tuple(-u): b['w'] / 2, tuple(v): b['h'] / 2, tuple(-v): b['h'] / 2}
        best = None
        for dvec in (u, -u, v, -v):
            lat = v if dvec is u or dvec is -u else u
            hl = b['h'] / 2 if lat is v else b['w'] / 2
            cntp = tot = 0
            for t in np.linspace(-0.7 * hl, 0.7 * hl, 9):
                for o in (1.0, 2.0, 3.0):
                    q = np.array(b['c']) + dvec * (half[tuple(dvec)] + o) + lat * t
                    x, y = int(q[0] * k), int(q[1] * k)
                    if 0 <= x < plot.shape[1] and 0 <= y < plot.shape[0]:
                        tot += 1; cntp += plot[y, x]
            share = cntp / tot if tot else 1
            if best is None or share < best[0]:
                best = (share, dvec)
        f = best[1]
        ax = np.array([f[1], -f[0]])
        Lb = b['w'] if abs(np.dot(ax, u)) > 0.7 else b['h']; Db = b['h'] if Lb == b['w'] else b['w']
        blocks.append({'units': [b['n']], 'unnumbered': b['n'] is None, 'c': [round(b['c'][0], 2), round(b['c'][1], 2)], 'axis': ax.round(4).tolist(), 'front': f.round(4).tolist(),
                       'L': round(float(Lb), 2), 'D': round(float(Db), 2), 'design': b['style'], 'beds': cfg['building_beds'][b['kind']],
                       'traced': True, 'number': 'filled along the row' if b.get('filled') else 'read (building alone)' if b.get('reread') else 'read', 'front_conf': round(1 - best[0], 2)})
    # front, step 2: villas numbered in one run along a street all face it from the same side of the run:
    # each run (consecutive numbers, neighbours within 1.8 building sizes) takes the side (left / right of
    # n-1 -> n+1) that most of its villas show; every villa of the run then faces that side
    nb_ = {bk['units'][0]: bk for bk in blocks if bk['units'][0] is not None}
    keys = sorted(nb_)
    runs, cur = [], [keys[0]] if keys else []
    for a_, b_ in zip(keys, keys[1:]):
        if b_ != a_ + 1 or np.hypot(*(np.array(nb_[b_]['c']) - nb_[a_]['c'])) > 1.8 * size:
            runs.append(cur); cur = []
        cur.append(b_)
    if cur:
        runs.append(cur)
    flipped = 0
    for run in runs:
        if len(run) < 3:
            continue
        lefts = []
        for q, n in enumerate(run):
            a_, b_ = run[max(0, q - 1)], run[min(len(run) - 1, q + 1)]
            t_ = np.array(nb_[b_]['c']) - nb_[a_]['c']; t_ /= (np.hypot(*t_) or 1)
            lefts.append(np.array([t_[1], -t_[0]]))
        vote = sum(np.sign(np.dot(nb_[n]['front'], l_)) for n, l_ in zip(run, lefts))
        side = 1 if vote >= 0 else -1
        for n, l_ in zip(run, lefts):
            bk = nb_[n]; f_ = l_ * side
            if np.dot(f_, bk['front']) < 0.7:
                flipped += 1
            ax_ = np.array([f_[1], -f_[0]])
            if abs(np.dot(ax_, bk['axis'])) < 0.7:
                bk['L'], bk['D'] = bk['D'], bk['L']
            bk['front'] = f_.round(4).tolist(); bk['axis'] = ax_.round(4).tolist()
    print(f'  facing: {len(runs)} runs; {flipped} villas turned to their run\'s street side')
    blocks.sort(key=lambda x: (x['units'][0] is None, x['units'][0] or 0))
    out = {'project': proj, 'kind': 'villa', 'count': N, 'pitch': raw['pitch'], 'source': raw['source'], 'blocks': blocks,
           'problems': [{'pair': [x, x], 'why': 'number not legible on the map (its building may be among the unnumbered ones)'} for x in missing],
           'dropped_readings': sorted(dropped),
           'buildings_without_number': [[round(b['c'][0], 1), round(b['c'][1], 1)] for b in unnumbered], 'numbers_filled_along_row': filled}
    json.dump(out, open(os.path.join(d, 'blocks.json'), 'w'), indent=0)
    vis = im.copy()
    for b in B:
        col = (0, 160, 0) if b['n'] and not b.get('filled') else (0, 140, 255) if b['n'] else (0, 0, 255)
        cv2.circle(vis, (int(b['px'][0]), int(b['px'][1])), 10, col, -1)
        if b['n']:
            cv2.putText(vis, str(b['n']), (int(b['px'][0]) - 20, int(b['px'][1]) + 34), 0, 0.8, col, 2)
    for bk in blocks:
        c = np.array(bk['c']) * k; f = np.array(bk['front'])
        cv2.arrowedLine(vis, tuple(np.int32(c)), tuple(np.int32(c + f * 40)), (255, 0, 0), 3)
    cv2.imwrite(f'/tmp/buildings_{proj}.png', vis)
    tc = Counter(f"{b['design']} {b['beds']} BR" for b in blocks)
    print(f'  types: {dict(tc)}')


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Terrace layout from number runs read by eye (maps whose labels the reader finds but cannot group: Nima).

  python terraces_from_eye.py <project> <map.pdf> [page]

config.json "terraces": [[first, last, style], ...]  every terrace's number run as printed, read by eye; must
  cover 1..count exactly once (checked).
config.json "terrace_flip": [first, ...]  terraces whose facing was checked by eye against the driveways on the map
  and is the opposite of the road test (a river walk / path taken for the street).
config.json "terrace_ends": {"<first>": [[x0, y0], [x1, y1]]}  label positions (page points) of the first and
  last home, read by eye, for terraces where the reader found too few labels.
Per terrace:
  line   = the reader's labels of this run (units_raw.json) that agree with each other: the pair of readings whose
           line explains the most other readings (within 0.5 home of where their number should sit, home spacing
           0.7-1.4 x pitch) wins; a reading off that line is a misread position and is dropped; least squares on
           the agreeing readings; fewer than 2 agreeing readings -> terrace_ends, else the terrace is reported
  homes  = evenly along the line at the fitted spacing, in number order
  facing = the side of the line with more road (light grey, unsaturated) at 0.8-1.8 homes from it
Writes layout.json in the format of layout_units.py (kind terrace) + /tmp/terraces_<project>.jpg for checking.
"""
import json, math, os, subprocess, sys, tempfile
from itertools import combinations
import numpy as np
import cv2

APP = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
DPI = 150


def main():
    proj, pdf = sys.argv[1], sys.argv[2]
    page = int(sys.argv[3]) if len(sys.argv) > 3 else 1
    d = os.path.join(APP, 'data', 'siteplans', proj)
    cfg = json.load(open(os.path.join(d, 'config.json')))
    raw = json.load(open(os.path.join(d, 'units_raw.json')))
    R = {int(k): np.array(v, float) for k, v in raw['units'].items()}
    pitch = raw['pitch']; N = cfg['count']
    T = cfg['terraces']; ends = cfg.get('terrace_ends', {}); flip = set(cfg.get('terrace_flip', []))
    cover = sorted(n for a, b, _ in T for n in range(a, b + 1))
    if cover != list(range(1, N + 1)):
        raise SystemExit(f'terraces do not cover 1..{N} exactly once')
    td = tempfile.mkdtemp()
    subprocess.run(['pdftoppm', '-q', '-r', str(DPI), '-png', '-f', str(page), '-l', str(page), pdf, os.path.join(td, 'p')], check=True)
    im = cv2.imread(os.path.join(td, [f for f in os.listdir(td) if f.endswith('.png')][0]))
    hsv = cv2.cvtColor(cv2.GaussianBlur(im, (5, 5), 0), cv2.COLOR_BGR2HSV)
    road = ((hsv[..., 1] < 28) & (hsv[..., 2] > 150) & (hsv[..., 2] < 238)).astype(np.uint8)
    H, W = road.shape; k = DPI / 72.0
    units, rows, report, from_ends = {}, [], [], []
    for a, b, style in T:
        ns = list(range(a, b + 1))
        have = [n for n in ns if n in R]
        best = None
        for i, j in combinations(have, 2):
            step = (R[j] - R[i]) / (j - i)
            if not 0.7 * pitch < np.hypot(*step) < 1.4 * pitch:
                continue
            inl = [n for n in have if np.hypot(*(R[i] + step * (n - i) - R[n])) < 0.5 * pitch]
            if best is None or len(inl) > len(best):
                best = inl
        if best and len(best) >= 2:
            t = np.array(best, float); X = np.array([R[n] for n in best])
            A_ = np.vstack([np.ones_like(t), t]).T
            coef, *_ = np.linalg.lstsq(A_, X, rcond=None)
            pos = {n: coef[0] + coef[1] * n for n in ns}
            used = best
        elif str(a) in ends:
            p0, p1 = np.array(ends[str(a)][0], float), np.array(ends[str(a)][1], float)
            pos = {n: p0 + (p1 - p0) * (n - a) / max(1, b - a) for n in ns}
            used = []; from_ends.append(a)
        else:
            report.append((a, b, 'no position: add terrace_ends')); continue
        ax = pos[b] - pos[a]; ax = ax / (np.hypot(*ax) or 1); nrm = np.array([-ax[1], ax[0]])
        c = (pos[a] + pos[b]) / 2; L = np.hypot(*(pos[b] - pos[a])) + pitch
        def side(sv):
            cnt = tot = 0
            for tt in np.linspace(-0.4, 0.4, 7) * L:
                for o in np.linspace(0.8, 1.8, 6) * pitch:
                    q = (c + ax * tt + nrm * sv * o) * k; x, y = int(q[0]), int(q[1])
                    if 0 <= x < W and 0 <= y < H:
                        tot += 1; cnt += road[y, x]
            return cnt / tot if tot else 0
        s1, s2 = side(1), side(-1)
        fr = nrm if s1 >= s2 else -nrm
        conf = round(abs(s1 - s2), 3)
        if a in flip:  # facing read by eye (driveway side drawn on the map): the road test picked a path / river walk
            fr = -fr; conf = 1.0
        for n in ns:
            units[n] = {'p': [round(float(pos[n][0]), 2), round(float(pos[n][1]), 2)], 'axis': ax.round(4).tolist(), 'front': fr.round(4).tolist(),
                        'conf': conf, 'interp': False, 'label_on_run': n not in used, 'style_by_eye': style}
        rows.append(ns)
        if conf < 0.05:
            report.append((a, b, f'facing unsure ({conf})'))
    lay = {'project': proj, 'kind': 'terrace', 'count': N, 'pitch': pitch, 'read': len(units),
           'interpolated': [],  # every number read by eye from its terrace run
           'label_position_from_run': sorted(n for n, u in units.items() if u['label_on_run']), 'missing': sorted(set(range(1, N + 1)) - set(units)),
           'units': {str(n): u for n, u in sorted(units.items())}, 'rows': rows, 'source': {'document': os.path.basename(pdf), 'page': page},
           'method': 'terraces_from_eye: number runs read by eye; position from the agreeing label readings; facing toward the road',
           'from_terrace_ends': from_ends}
    json.dump(lay, open(os.path.join(d, 'layout.json'), 'w'))
    vis = im.copy()
    for r in rows:
        p0, p1 = np.array(units[r[0]]['p']) * k, np.array(units[r[-1]]['p']) * k
        cv2.line(vis, tuple(p0.astype(int)), tuple(p1.astype(int)), (0, 0, 255), 2)
        for n in r:
            p = np.array(units[n]['p']) * k; f = np.array(units[n]['front'])
            cv2.circle(vis, tuple(p.astype(int)), 3, (0, 160, 0) if not units[n]['label_on_run'] else (0, 140, 255), -1)
        m = (p0 + p1) / 2; f = np.array(units[r[0]]['front'])
        cv2.arrowedLine(vis, tuple(m.astype(int)), tuple((m + f * pitch * k * 1.5).astype(int)), (255, 0, 0), 2, tipLength=0.4)
        cv2.putText(vis, f'{r[0]}-{r[-1]}', tuple((p0 + np.array([0, -8])).astype(int)), 0, 0.4, (0, 0, 0), 1)
    cv2.imwrite(os.path.join(tempfile.gettempdir(), f'terraces_{proj}.jpg'), vis)
    print(f"{proj}: {len(rows)} terraces, {len(units)} homes; label positions from the run line {len(lay['label_position_from_run'])}; "
          f"from terrace_ends {from_ends}; issues {report}")


if __name__ == '__main__':
    main()

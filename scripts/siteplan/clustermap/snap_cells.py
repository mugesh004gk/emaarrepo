#!/usr/bin/env python3
"""Slide each terrace along its own line so its homes sit on the map's cells: the 4 BR end homes are drawn
dark grey and the 3 BR middle homes white (TYPES legend). Used after layout_units.py when the reader's
positions only give the terrace's line, not where along it the homes are (Elva).

  python snap_cells.py <project> <map.pdf> [page]

For every terrace whose plan puts 4 BR at both ends (config "end_beds": true), shifts of -1.5 .. +1.5 home
widths are tried; the shift whose end positions read darkest and middle positions lightest is kept (only
when it is clearly better than no shift). layout.json is rewritten; the shifts are recorded in it.
"""
import json, os, subprocess, sys, tempfile
import numpy as np
import cv2

APP = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
DPI = 200


def main():
    proj, pdf = sys.argv[1], sys.argv[2]
    page = int(sys.argv[3]) if len(sys.argv) > 3 else 1
    d = os.path.join(APP, 'data', 'siteplans', proj)
    L = json.load(open(os.path.join(d, 'layout.json')))
    td = tempfile.mkdtemp()
    subprocess.run(['pdftoppm', '-q', '-r', str(DPI), '-png', '-f', str(page), '-l', str(page), pdf, os.path.join(td, 'p')], check=True)
    im = cv2.imread(os.path.join(td, [f for f in os.listdir(td) if f.endswith('.png')][0]))
    hsv = cv2.cvtColor(im, cv2.COLOR_BGR2HSV)
    k = DPI / 72.0; pitch = L['pitch']; U = L['units']

    def val(p):
        x, y = int(p[0] * k), int(p[1] * k); r = max(2, int(0.18 * pitch * k))
        h = hsv[max(0, y - r):y + r, max(0, x - r):x + r].reshape(-1, 3)
        h = h[h[:, 1] < 35]  # unsaturated only (cell fill, not plot colour)
        return float(np.percentile(h[:, 2], 70)) if len(h) > 5 else None

    shifts = {}
    for r in L['rows']:
        if len(r) < 3:
            continue
        ax = np.array(U[str(r[0])]['axis']); P = {n: np.array(U[str(n)]['p']) for n in r}
        best = None
        for s in np.arange(-1.5, 1.51, 0.25):
            vs = [val(P[n] + ax * s * pitch) for n in r]
            if any(v is None for v in vs):
                continue
            ends = (vs[0] + vs[-1]) / 2; mids = float(np.mean(vs[1:-1]))
            score = mids - ends  # white middles, dark-grey ends
            if best is None or score > best[0]:
                best = (score, s)
        base = [val(P[n]) for n in r]
        base_score = (np.mean(base[1:-1]) - (base[0] + base[-1]) / 2) if None not in base else -1e9
        if best and best[1] != 0 and best[0] > base_score + 25:
            for n in r:
                U[str(n)]['p'] = (P[n] + ax * best[1] * pitch).round(2).tolist()
            shifts[r[0]] = float(best[1])
    L['cell_snap'] = {str(k_): v for k_, v in shifts.items()}
    json.dump(L, open(os.path.join(d, 'layout.json'), 'w'))
    print(f'{proj}: {len(shifts)} terraces slid onto their cells: {shifts}')


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""From the unit numbers read on a cluster map (units_raw.json) to homes: position, row, facing.

  python scripts/siteplan/clustermap/layout_units.py <project> <brochure.pdf> <page> <terrace|villa>

 - a number missing in the reading but lying between two read numbers of the same row is placed
   on the line between them (interpolated, flagged);
 - row direction from the neighbouring numbers; a terrace = consecutive numbers at house pitch on one
   line; a villa = its own row;
 - facing: the side of the row where the map shows road (light grey, unsaturated) nearer to the
   house; a row whose neighbour across a green / water faces away from it.
Output: data/siteplans/<project>/layout.json (plan points, page units) + debug image in /tmp.
"""
import json, math, os, subprocess, sys, tempfile
import numpy as np
import cv2

APP = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
DPI = 150


def main():
    proj, pdf, page, kind = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
    d = os.path.join(APP, 'data', 'siteplans', proj)
    raw = json.load(open(os.path.join(d, 'units_raw.json')))
    P = {int(k): np.array(v, float) for k, v in raw['units'].items()}
    # the total: the highest number with a well-read run below it (a stray high number is not a unit)
    N = max([n for n in P if sum(1 for k in range(n - 9, n + 1) if k in P) >= 6] or [raw['count']])
    P = {n: v for n, v in P.items() if n <= N}
    raw['read'] = len(P)
    pitch = raw['pitch']
    # interpolate missing numbers inside a row
    interp = []
    for n in range(1, N + 1):
        if n in P:
            continue
        lo = next((k for k in range(n - 1, max(0, n - 8), -1) if k in P), None)
        hi = next((k for k in range(n + 1, min(N + 1, n + 8)) if k in P), None)
        if lo is None or hi is None:
            continue
        dist = np.hypot(*(P[hi] - P[lo]))
        if abs(dist / ((hi - lo) * pitch) - 1) < 0.35:
            P[n] = P[lo] + (P[hi] - P[lo]) * (n - lo) / (hi - lo)
            interp.append(n)
    # page render for colours
    td = tempfile.mkdtemp()
    subprocess.run(['pdftoppm', '-q', '-r', str(DPI), '-png', '-f', str(page), '-l', str(page), pdf, os.path.join(td, 'p')], check=True)
    im = cv2.imread(os.path.join(td, [f for f in os.listdir(td) if f.endswith('.png')][0]))
    hsv = cv2.cvtColor(cv2.GaussianBlur(im, (5, 5), 0), cv2.COLOR_BGR2HSV)
    H, W = im.shape[:2]
    k = DPI / 72.0
    road = ((hsv[..., 1] < 28) & (hsv[..., 2] > 150) & (hsv[..., 2] < 238)).astype(np.uint8)
    green = ((hsv[..., 0] > 30) & (hsv[..., 0] < 90) & (hsv[..., 1] > 50)).astype(np.uint8)
    blue = ((hsv[..., 0] > 90) & (hsv[..., 0] < 130) & (hsv[..., 1] > 50)).astype(np.uint8)
    plotc = ((((hsv[..., 0] >= 78) & (hsv[..., 0] <= 102) & (hsv[..., 1] >= 45)) | ((hsv[..., 0] >= 15) & (hsv[..., 0] <= 34) & (hsv[..., 1] >= 30) & (hsv[..., 2] >= 200)))).astype(np.uint8)

    def frac(mask, x, y, ux, uy, d0, d1, half):
        cnt = tot = 0
        for t in np.linspace(d0, d1, 8):
            for s in np.linspace(-half, half, 5):
                px, py = int((x + ux * t - uy * s) * k), int((y + uy * t + ux * s) * k)
                if 0 <= px < W and 0 <= py < H:
                    tot += 1; cnt += mask[py, px]
        return cnt / tot if tot else 0

    units = {}
    for n in sorted(P):
        nb = [P[m] for m in (n - 1, n + 1) if m in P and np.hypot(*(P[m] - P[n])) < 1.6 * pitch]
        if len(nb) == 2:
            ax = nb[1] - nb[0]
        elif len(nb) == 1:
            ax = (nb[0] - P[n]) * (1 if (n + 1 in P and np.allclose(nb[0], P[n + 1])) else -1)
        else:
            far = [P[m] for m in (n - 1, n + 1) if m in P]
            ax = (far[-1] - far[0]) if len(far) == 2 else np.array([1.0, 0.0])
        ax = ax / (np.hypot(*ax) or 1)
        nx, ny = -ax[1], ax[0]
        # road on which side: road share near the house (0.6-2.2 pitch out), green/water count against
        s1 = frac(road, P[n][0], P[n][1], nx, ny, 0.6 * pitch, 2.2 * pitch, 0.3 * pitch) - 0.5 * frac(green + blue, P[n][0], P[n][1], nx, ny, 0.6 * pitch, 2.2 * pitch, 0.3 * pitch)
        s2 = frac(road, P[n][0], P[n][1], -nx, -ny, 0.6 * pitch, 2.2 * pitch, 0.3 * pitch) - 0.5 * frac(green + blue, P[n][0], P[n][1], -nx, -ny, 0.6 * pitch, 2.2 * pitch, 0.3 * pitch)
        if os.environ.get('FACE') == 'plot':
            # villas on coloured plots: the rear garden is plot colour, the front opens onto the road
            q1 = frac(plotc, P[n][0], P[n][1], nx, ny, 0.45 * pitch, 1.1 * pitch, 0.25 * pitch)
            q2 = frac(plotc, P[n][0], P[n][1], -nx, -ny, 0.45 * pitch, 1.1 * pitch, 0.25 * pitch)
            s1, s2 = q2, q1
        f = (nx, ny) if s1 >= s2 else (-nx, -ny)
        units[n] = dict(p=P[n].tolist(), axis=ax.tolist(), front=list(f), conf=round(abs(s1 - s2), 3), interp=n in interp)
    # facing agreement along a row: neighbours in a terrace face the same way
    if kind == 'terrace':
        for n in units:
            nbs = [units[m] for m in (n - 1, n + 1) if m in units and np.hypot(*(np.array(units[m]['p']) - units[n]['p'])) < 1.6 * pitch]
            if len(nbs) == 2 and all(np.dot(b['front'], units[n]['front']) < 0 for b in nbs) and units[n]['conf'] < max(b['conf'] for b in nbs):
                units[n]['front'] = [-units[n]['front'][0], -units[n]['front'][1]]
    # rows
    rows = []
    cur = []
    for n in sorted(units):
        u = units[n]
        if cur and kind == 'terrace':
            v = units[cur[-1]]
            dd = np.hypot(*(np.array(u['p']) - v['p']))
            same = n == cur[-1] + 1 and dd < 1.45 * pitch and np.dot(u['front'], v['front']) > 0.7 and np.dot(u['axis'], v['axis']) ** 2 > 0.9
            if not same:
                rows.append(cur); cur = []
        elif cur:
            rows.append(cur); cur = []
        cur.append(n)
    if cur:
        rows.append(cur)
    # a short run (1-2 homes) next to a terrace with consecutive numbers belongs to it (its facing was misread)
    if kind == 'terrace':
        changed = True
        while changed:
            changed = False
            for i, r in enumerate(rows):
                if len(r) > 2:
                    continue
                for j in (i - 1, i + 1):
                    if 0 <= j < len(rows) and len(rows[j]) > 2:
                        a, b = (rows[j][-1], r[0]) if j < i else (r[-1], rows[j][0])
                        if b == a + 1 and np.hypot(*(np.array(units[a]['p']) - units[b]['p'])) < 1.6 * pitch:
                            for n in r:
                                units[n]['front'] = units[rows[j][0]]['front']
                            rows[j] = sorted(rows[j] + r); rows.pop(i); changed = True
                            break
                if changed:
                    break
    out = dict(project=proj, kind=kind, count=N, pitch=pitch, read=raw['read'], interpolated=interp,
               missing=[n for n in range(1, N + 1) if n not in units], units={str(k): v for k, v in units.items()}, rows=rows,
               source=raw['source'])
    json.dump(out, open(os.path.join(d, 'layout.json'), 'w'))
    # debug image
    vis = im.copy()
    for r in rows:
        pts = np.array([[units[n]['p'][0] * k, units[n]['p'][1] * k] for n in r], np.int32)
        if len(pts) > 1:
            cv2.polylines(vis, [pts], False, (255, 0, 0), 2)
    for n, u in units.items():
        x, y = int(u['p'][0] * k), int(u['p'][1] * k)
        cv2.circle(vis, (x, y), 3, (0, 0, 255) if not u['interp'] else (0, 165, 255), -1)
        cv2.line(vis, (x, y), (int(x + u['front'][0] * pitch * k), int(y + u['front'][1] * pitch * k)), (0, 200, 0), 2)
    cv2.imwrite(f'/tmp/layout_{proj}.png', vis)
    print(f"{proj}: {N} units, read {raw['read']}, interpolated {len(interp)}, still missing {len(out['missing'])}; rows {len(rows)} (sizes {sorted(set(len(r) for r in rows))})")


if __name__ == '__main__':
    main()

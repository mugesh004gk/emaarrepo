#!/usr/bin/env python3
"""Ground correction for a site plan placed on satellite roofs: one shift (metres east/north) for the
whole plan, so that each terrace's house front stands its plan distance from the mapped street centre
line in front of it (front yard + half the carriageway). Roofs in a satellite photo lean away from the
camera (2-storey homes: a few metres); streets lie on the ground, so they fix the position.

  python scripts/siteplan/fit_streets.py eden 12      (needs numpy; writes street_shift_m into data/siteplans/eden/georef.json)
Rerun build_eden.py afterwards.
"""
import json, math, os, sys

APP = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
KY = 110574.0


def front_distances(rows, segs, KX, shift):
    out = []
    for r in rows:
        cx, cy = r['lng'] * KX + shift[0], r['lat'] * KY + shift[1]
        f = math.radians(r['frontBearing']); fx, fy = math.sin(f), math.cos(f)
        px, py = cx + fx * r['D'] / 2, cy + fy * r['D'] / 2
        best = None
        for (a, b) in segs:
            vx, vy = b[0] - a[0], b[1] - a[1]
            den = fx * vy - fy * vx
            if abs(den) < 1e-9:
                continue
            t = ((a[0] - px) * vy - (a[1] - py) * vx) / den
            u = ((a[0] - px) * fy - (a[1] - py) * fx) / den
            if 0 <= u <= 1 and -6 < t < 30 and (best is None or t < best):
                best = t
        out.append((best, fx, fy))
    return out


def main(pid, target):
    sp = json.load(open(os.path.join(APP, 'data', 'siteplans', f'{pid}.json')))
    gpath = os.path.join(APP, 'data', 'siteplans', pid, 'georef.json')
    g = json.load(open(gpath))
    old = g.get('street_shift_m', [0.0, 0.0])
    site = json.load(open(os.path.join(APP, 'data', 'site.json')))['communities'][sp['community']]['streets']
    KX = 111320.0 * math.cos(math.radians(sp['rows'][0]['lat']))
    segs = []
    for st in site:
        if st['cls'] == 'path' or st.get('source') in ('derived', 'siteplan'):
            continue
        p = [(lo * KX, la * KY) for lo, la in st['pts']]
        segs += [(p[i], p[i + 1]) for i in range(len(p) - 1)]
    # unknowns: shift (east, north), scale change k, rotation w (radians, counter-clockwise) about the
    # plan's mean point, and the common front -> centre-line distance c (streets run midway between facing
    # terraces). A row at p moves by s + k p + w R90 p; its front distance changes by -(move . f).
    # Iteratively reweighted least squares; rows with no street in reach are left out.
    import numpy as np
    x0, y0 = g['lng'] * KX, g['lat'] * KY
    shift = np.zeros(2); k = 0.0; w = 0.0; c = target
    P = np.array([[r['lng'] * KX - x0, r['lat'] * KY - y0] for r in sp['rows']])
    for it in range(15):
        moved = []
        for r, p in zip(sp['rows'], P):
            mv = shift + k * p + w * np.array([-p[1], p[0]])
            moved.append(dict(r, lng=r['lng'] + mv[0] / KX, lat=r['lat'] + mv[1] / KY))
        fd = front_distances(moved, segs, KX, [0, 0])
        idx = [i for i, (d, _, _) in enumerate(fd) if d is not None and d < 24]
        M = np.array([[fd[i][1], fd[i][2], fd[i][1] * P[i][0] + fd[i][2] * P[i][1], fd[i][1] * -P[i][1] + fd[i][2] * P[i][0], 1.0] for i in idx])
        y = np.array([fd[i][0] - c for i in idx])
        wt = np.where(np.abs(y) < 2.5, 1.0, 2.5 / np.maximum(np.abs(y), 1e-6))
        sol = np.linalg.lstsq(M * wt[:, None], y * wt, rcond=None)[0]
        shift = shift + sol[:2]; k += sol[2]; w += sol[3]; c += sol[4]
        if np.hypot(*sol[:2]) < 0.01 and abs(sol[2]) < 1e-5 and abs(sol[3]) < 1e-5:
            break
    g['scale'] = g['scale'] * (1 + k)
    g['bearing'] = (g['bearing'] - math.degrees(w)) % 360
    target = round(float(c), 2)
    moved = []
    for r, p in zip(sp['rows'], P):
        mv = shift + k * p + w * np.array([-p[1], p[0]])
        moved.append(dict(r, lng=r['lng'] + mv[0] / KX, lat=r['lat'] + mv[1] / KY))
    print(f"  scale x{1 + k:.4f} (now {g['scale']:.5f} m/px), rotation {-math.degrees(w):+.3f} deg (map-up now {g['bearing']:.2f})")
    shift = list(shift)
    after = sorted(d for d, _, _ in front_distances(moved, segs, KX, [0, 0]) if d is not None and d < 24)
    g['street_shift_m'] = [round(old[0] + shift[0], 2), round(old[1] + shift[1], 2)]
    g['street_fit'] = {'rows': len(after), 'target_m': target, 'median_m': round(after[len(after) // 2], 2),
                       'min_m': round(after[0], 2), 'max_m': round(after[-1], 2)}
    json.dump(g, open(gpath, 'w'), indent=1)
    print(f"{pid}: shift {shift[0]:+.2f} m east, {shift[1]:+.2f} m north (total {g['street_shift_m']}); "
          f"house front -> street centre: median {g['street_fit']['median_m']} m, range {after[0]:.1f}-{after[-1]:.1f} m over {len(after)} terraces")


if __name__ == '__main__':
    main(sys.argv[1], float(sys.argv[2]))

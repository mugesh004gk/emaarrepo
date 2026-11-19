#!/usr/bin/env python3
"""Place a project map that is not built yet from the NEIGHBOURING homes it draws (grey context homes at its
edges) matched to those neighbours' homes already placed in the app (verified placements only).

  python georef_neighbours.py <project> <map.pdf> "<x0,y0,x1,y1>;..." <neighbour,neighbour> <scale_lo,scale_hi> <up_lo,up_hi>

- map side: light / grey roof cells (unsaturated) inside the given page-point boxes (the neighbours' parts of
  the map only), as a mask at 1 pt;
- ground side: the footprints (L x D boxes) of the neighbours' placed rows, rasterised at 1 m;
- search: map-up bearing and scale over the given ranges, translation by FFT correlation (normalised).
Writes data/siteplans/<project>/georef.json (page points -> east/north metres about lat0/lng0) with the score,
and an overlay picture /tmp/georef_nb_<project>.jpg.
"""
import json, math, os, subprocess, sys, tempfile
import numpy as np
import cv2

APP = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
LAT0, LNG0, KY = 25.006, 55.447, 110574.0
KX = 111320.0 * math.cos(math.radians(LAT0))


def main():
    proj, pdf, boxes, nbs = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4].split(',')
    s_lo, s_hi = map(float, sys.argv[5].split(',')); u_lo, u_hi = map(float, sys.argv[6].split(','))
    td = tempfile.mkdtemp()
    subprocess.run(['pdftoppm', '-q', '-r', '72', '-png', pdf, os.path.join(td, 'p')], check=True)
    im = cv2.imread(os.path.join(td, sorted(os.listdir(td))[0]))
    hsv = cv2.cvtColor(im, cv2.COLOR_BGR2HSV).astype(int)
    roof = ((hsv[..., 1] < 22) & (hsv[..., 2] > 150)).astype(np.float32)
    keep = np.zeros_like(roof)
    for b in boxes.split(';'):
        x0, y0, x1, y1 = map(int, b.split(',')); keep[y0:y1, x0:x1] = 1
    M = roof * keep
    M = cv2.morphologyEx(M, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    ys, xs = np.nonzero(M)
    mx0, my0 = xs.min(), ys.min(); M = M[my0:ys.max() + 1, mx0:xs.max() + 1]
    # ground raster of the neighbours' placed homes
    rows = []
    for nb in nbs:
        rows += json.load(open(os.path.join(APP, 'data', 'siteplans', f'{nb}.json')))['rows']
    E = [((r['lng'] - LNG0) * KX, (r['lat'] - LAT0) * KY, r) for r in rows]
    ex = np.array([e[0] for e in E]); ny = np.array([e[1] for e in E])
    e0, n1 = ex.min() - 400, ny.max() + 400
    W, H = int(ex.max() + 400 - e0), int(n1 - (ny.min() - 400))
    G = np.zeros((H, W), np.float32)
    for e, n, r in E:
        f = math.radians(r['frontBearing']); fv = np.array([math.sin(f), math.cos(f)]); av = np.array([fv[1], -fv[0]])
        c = np.array([e - e0, n1 - n]); L, D = r['L'], r['D']
        pts = [np.array([e, n]) + av * sa * L / 2 + fv * sb * D / 2 for sa, sb in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
        cv2.fillPoly(G, [np.int32([[p[0] - e0, n1 - p[1]] for p in pts])], 1.0)
    best = None
    Gf = G - G.mean()
    for up in np.arange(u_lo, u_hi + 0.01, 0.5):
        for sc in np.exp(np.arange(math.log(s_lo), math.log(s_hi) + 1e-9, 0.01)):
            # map pt -> ground px (1 m): rotate so map-up points to bearing 'up'
            th = math.radians(up)
            R = sc * np.array([[math.cos(th), math.sin(th)], [-math.sin(th), math.cos(th)]])  # image coords (x right, y down)
            h, w = M.shape
            corners = np.array([[0, 0], [w, 0], [w, h], [0, h]], float) @ R.T
            off = -corners.min(0); size = (corners.max(0) - corners.min(0)).astype(int) + 2
            A = np.hstack([R, off[:, None]])
            T = cv2.warpAffine(M, A, (int(size[0]), int(size[1])), flags=cv2.INTER_AREA)
            if T.shape[0] >= H or T.shape[1] >= W or T.sum() < 50:
                continue
            res = cv2.matchTemplate(G, T, cv2.TM_CCORR_NORMED)
            _, v, _, loc = cv2.minMaxLoc(res)
            if best is None or v > best[0]:
                best = (v, up, sc, loc, A)
    v, up, sc, loc, A = best
    # page pt (x, y) -> template px = A @ [x - mx0, y - my0, 1]; -> ground px = + loc; -> east/north
    Mfull = np.array([[A[0, 0], A[0, 1], A[0, 2] - A[0, 0] * mx0 - A[0, 1] * my0 + loc[0]],
                      [A[1, 0], A[1, 1], A[1, 2] - A[1, 0] * mx0 - A[1, 1] * my0 + loc[1]]])
    # ground px (gx, gy) -> east = gx + e0, north = n1 - gy
    Aen = [[Mfull[0, 0], Mfull[0, 1], Mfull[0, 2] + e0], [-Mfull[1, 0], -Mfull[1, 1], n1 - Mfull[1, 2]]]
    g = {'image': f'{os.path.basename(pdf)} (page points)', 'lat0': LAT0, 'lng0': LNG0,
         'A': [[round(float(x), 6) for x in r] for r in Aen], 'scale_m_per_px': round(float(sc), 4),
         'method': f"neighbouring homes drawn on the map ({', '.join(nbs)}) matched to their placed homes (normalised correlation {v:.3f}, map-up {up:.1f} deg, {sc:.4f} m/pt)",
         'accuracy': 'provisional: not built yet; placed from its neighbours as drawn on its own map'}
    json.dump(g, open(os.path.join(APP, 'data', 'siteplans', proj, 'georef.json'), 'w'), indent=1)
    vis = cv2.cvtColor((G * 120).astype(np.uint8), cv2.COLOR_GRAY2BGR)
    T = cv2.warpAffine(roof * 0 + (hsv[..., 1] < 22) * (hsv[..., 2] > 150) * 1.0, np.array(Mfull, np.float32), (W, H))
    vis[T > 0.3] = (0, 0, 255)
    vis[(G > 0) & (T > 0.3)] = (0, 255, 255)
    cv2.imwrite(os.path.join(tempfile.gettempdir(), f'georef_nb_{proj}.jpg'), cv2.resize(vis, None, fx=0.5, fy=0.5))
    print(f'{proj}: corr {v:.3f}, map-up {up:.1f}, scale {sc:.4f} m/pt')


if __name__ == '__main__':
    main()

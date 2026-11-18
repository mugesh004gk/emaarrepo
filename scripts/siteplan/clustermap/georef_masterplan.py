#!/usr/bin/env python3
"""Place an Emaar community masterplan image on the ground, then any project map inside it.

  python georef_masterplan.py master <masterplan.png> <lat> <lng> <half_m> <out.json>
  python georef_masterplan.py project <masterplan.json> <project_map.png> <out.json> [x0 y0 x1 y1]

`master`: the masterplan's drawn homes (light blocks) are matched to the bright roofs of the satellite photo
(Esri, zoom 16, ~2.2 m/px) over map-up bearing and scale, by normalised correlation of blurred masks; the
already-built neighbourhoods carry the fit. Result: pixel -> (lat, lng) as an affine (scale, rotation, shift).

`project`: for a project not built yet, its own cluster map is matched to the same homes drawn on the
masterplan (optionally only inside the box x0 y0 x1 y1 of the masterplan where Emaar's locator puts it),
over scale and rotation; composing the two gives the project map's pixel -> (lat, lng).
Both write the affine as {"A": [[a, b, c], [d, e, f]]} with east / north metres = A @ [x, y, 1] about the
anchor (lat0, lng0), plus the correlation, so the accuracy can be judged.
"""
import json, math, os, sys, urllib.request
import numpy as np
import cv2

KY = 110574.0
TILES = os.environ.get('TILES', '/tmp/tiles')


def sat(lat, lng, half_m, z):
    os.makedirs(TILES, exist_ok=True)
    n = 2 ** z * 256
    px = lambda la, lo: ((lo + 180) / 360 * n, (1 - math.log(math.tan(math.radians(la)) + 1 / math.cos(math.radians(la))) / math.pi) / 2 * n)
    mpp = 156543.03 * math.cos(math.radians(lat)) / 2 ** z
    cx, cy = px(lat, lng); h = half_m / mpp
    x0, y0, x1, y1 = cx - h, cy - h, cx + h, cy + h
    img = np.zeros((int(y1 - y0), int(x1 - x0), 3), np.uint8)
    for tx in range(int(x0 // 256), int(x1 // 256) + 1):
        for ty in range(int(y0 // 256), int(y1 // 256) + 1):
            fn = os.path.join(TILES, f'{z}_{tx}_{ty}.jpg')
            if not os.path.exists(fn):
                req = urllib.request.Request(f'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{ty}/{tx}', headers={'User-Agent': 'Mozilla/5.0'})
                open(fn, 'wb').write(urllib.request.urlopen(req, timeout=30).read())
            t = cv2.imread(fn); ox, oy = int(tx * 256 - x0), int(ty * 256 - y0)
            xs, ys = max(0, ox), max(0, oy); xe, ye = min(img.shape[1], ox + 256), min(img.shape[0], oy + 256)
            if xe > xs and ye > ys:
                img[ys:ye, xs:xe] = t[ys - oy:ye - oy, xs - ox:xe - ox]
    return img, mpp, (x0, y0), n


def homes_mask(img, drawn=True):
    hsv = cv2.cvtColor(cv2.GaussianBlur(img, (3, 3), 0), cv2.COLOR_BGR2HSV)
    if drawn:  # drawn homes: light, nearly unsaturated blocks
        return ((hsv[..., 1] < 40) & (hsv[..., 2] > 200)).astype(np.float32)
    return ((hsv[..., 2] > 175) & (hsv[..., 1] < 50)).astype(np.float32)  # roofs in the photo


def search(target, src, scales, bears, blur):
    """best placement of src (rotated by -bear, scaled) inside target: (corr, scale, bear, loc, M)"""
    T = cv2.GaussianBlur(target, (blur, blur), 0)
    best = None
    h, w = src.shape
    for bear in bears:
        for sc in scales:
            M = cv2.getRotationMatrix2D((w / 2, h / 2), bear, sc)  # +angle = counter-clockwise in the image
            cos, sin = abs(M[0, 0]), abs(M[0, 1])
            nw, nh = int(h * sin + w * cos) + 2, int(h * cos + w * sin) + 2
            M[0, 2] += nw / 2 - w / 2; M[1, 2] += nh / 2 - h / 2
            tp = cv2.warpAffine(src, M, (nw, nh))
            if tp.shape[0] >= T.shape[0] or tp.shape[1] >= T.shape[1] or tp.sum() < 50:
                continue
            tp = cv2.GaussianBlur(tp, (blur, blur), 0)
            r = cv2.matchTemplate(T, tp, cv2.TM_CCOEFF_NORMED); _, v, _, loc = cv2.minMaxLoc(r)
            if best is None or v > best[0]:
                best = (v, sc, bear, loc, M)
    return best


def master(path, lat, lng, half, out):
    z = int(os.environ.get('Z', 16))
    img, mpp, (x0, y0), n = sat(lat, lng, half, z)
    roofs = homes_mask(img, drawn=False)
    mp = cv2.imread(path)
    mm = homes_mask(mp)
    # work at the satellite's pixel size: the masterplan is scaled by s (sat px per plan px)
    s_lo, s_hi = [float(x) for x in os.environ.get('S', '0.8,3.0').split(',')]
    coarse = search(roofs, mm, np.exp(np.arange(math.log(s_lo), math.log(s_hi), 0.04)), np.arange(0, 360, 3), 5)
    v, sc, bear, loc, M = coarse
    fine = search(roofs, mm, sc * np.arange(0.95, 1.051, 0.01), np.arange(bear - 2.5, bear + 2.51, 0.5), 5)
    v, sc, bear, loc, M = fine
    # plan px -> satellite px -> lat/lng
    M3 = np.vstack([M, [0, 0, 1]]); Tm = np.array([[1, 0, loc[0]], [0, 1, loc[1]], [0, 0, 1]]) @ M3
    lat0, lng0 = lat, lng
    KX = 111320.0 * math.cos(math.radians(lat0))
    gx0, gy0 = ((lng0 + 180) / 360 * n - x0), ((1 - math.log(math.tan(math.radians(lat0)) + 1 / math.cos(math.radians(lat0))) / math.pi) / 2 * n - y0)
    # satellite px -> east/north metres about (lat0, lng0): x east, y south
    S = np.array([[mpp, 0, -gx0 * mpp], [0, -mpp, gy0 * mpp], [0, 0, 1]])
    A = (S @ Tm)[:2]
    json.dump({'image': os.path.basename(path), 'lat0': lat0, 'lng0': lng0, 'A': A.round(6).tolist(), 'corr': round(v, 3),
               'scale_m_per_px': round(sc * mpp, 4), 'rotation_deg': round(bear, 2)}, open(out, 'w'), indent=1)
    vis = img.copy()
    warped = cv2.warpAffine(mp, Tm[:2], (img.shape[1], img.shape[0]))
    vis = cv2.addWeighted(vis, 0.55, warped, 0.45, 0)
    cv2.imwrite(out.replace('.json', '.jpg'), cv2.resize(vis, (1200, 1200)))
    print(f'masterplan placed: corr {v:.3f}, {sc * mpp:.3f} m/px, rotation {bear:.1f} deg -> {out}')


def project(mjson, ppath, out, box=None):
    m = json.load(open(mjson))
    mp_img = cv2.imread(os.path.join(os.path.dirname(mjson), m['image'])) if os.path.exists(os.path.join(os.path.dirname(mjson), m['image'])) else cv2.imread(os.environ['MASTER'])
    target = drawn_homes(mp_img)
    # the masterplan's name labels (dark boxes with light text) are not homes
    dark = (cv2.cvtColor(mp_img, cv2.COLOR_BGR2GRAY) < 110).astype(np.uint8)
    dark = cv2.morphologyEx(dark, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    n_, cc_, st_, _ = cv2.connectedComponentsWithStats(dark, 8)
    for i in range(1, n_):
        if st_[i, cv2.CC_STAT_AREA] > 400:
            x, y, w, h = st_[i, :4]; target[max(0, y - 3):y + h + 3, max(0, x - 3):x + w + 3] = 0
    ox = oy = 0
    if box:
        x0, y0, x1, y1 = box; target = target[y0:y1, x0:x1]; ox, oy = x0, y0
    pm = cv2.imread(ppath)
    src = homes_mask(pm)
    cx0 = cy0 = 0
    if os.environ.get('CROP'):  # the map area of the image (legend and title left out); positions keep image pixels
        a, b, c, d = map(int, os.environ['CROP'].split(','))
        src = src[b:d, a:c]; pm = pm[b:d, a:c]; cx0, cy0 = a, b
    up = float(os.environ.get('UP', 4))  # the masterplan is coarse: compare at UP x its size
    T = cv2.resize(target, None, fx=up, fy=up, interpolation=cv2.INTER_LINEAR)
    s_lo, s_hi = [float(x) for x in os.environ.get('S', '0.05,0.6').split(',')]
    # ROT="a": the map's turn onto the masterplan, read from how its ends meet the masterplan (searched +/- 5 deg)
    rot = os.environ.get('ROT')
    bears0 = np.arange(float(rot) - 5, float(rot) + 5.01, 1.0) if rot else np.arange(0, 360, 2)
    best = search(T, src, np.exp(np.arange(math.log(s_lo * up), math.log(s_hi * up), 0.03)), bears0, 3)
    v, sc, bear, loc, M = best
    best = search(T, src, sc * np.arange(0.96, 1.041, 0.008), np.arange(bear - 2, bear + 2.01, 0.4), 3)
    v, sc, bear, loc, M = best
    M3 = np.vstack([M, [0, 0, 1]])
    P2T = np.array([[1, 0, loc[0]], [0, 1, loc[1]], [0, 0, 1]]) @ M3            # project px -> upscaled target px
    T2M = np.array([[1 / up, 0, ox], [0, 1 / up, oy], [0, 0, 1]])                # upscaled target px -> masterplan px
    Am = np.vstack([np.array(m['A']), [0, 0, 1]])
    C2I = np.array([[1, 0, -cx0], [0, 1, -cy0], [0, 0, 1]])                    # image px -> cropped px
    A = (Am @ T2M @ P2T @ C2I)[:2]
    mpx = np.hypot(A[0, 0], A[1, 0])
    json.dump({'image': os.path.basename(ppath), 'lat0': m['lat0'], 'lng0': m['lng0'], 'A': A.round(6).tolist(), 'corr_in_masterplan': round(v, 3),
               'scale_m_per_px': round(mpx, 4), 'masterplan': os.path.basename(mjson), 'masterplan_corr': m['corr']}, open(out, 'w'), indent=1)
    vis = cv2.cvtColor((T * 255).astype(np.uint8), cv2.COLOR_GRAY2BGR)
    warped = cv2.warpAffine(pm, P2T[:2], (T.shape[1], T.shape[0]))
    cv2.imwrite(out.replace('.json', '.jpg'), cv2.addWeighted(vis, 0.5, warped, 0.5, 0))
    print(f'{os.path.basename(ppath)} in the masterplan: corr {v:.3f}, rotation {bear:.1f} deg, {mpx:.3f} m/px -> {out}')


def drawn_homes(img):
    """homes drawn on a masterplan: blocks lighter than their surroundings (white top-hat, 9 px)"""
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)
    th = cv2.morphologyEx(g, cv2.MORPH_TOPHAT, cv2.getStructuringElement(cv2.MORPH_RECT, (9, 9)))
    return (th > 10).astype(np.float32)


def homes_raster(app, cid, mpp, lat0, lng0, half):
    """the homes the app places (data/homes_detected.json: site plans + satellite) as a north-up mask"""
    hd = json.load(open(os.path.join(app, 'data', 'homes_detected.json')))['communities'][cid]
    KX = 111320.0 * math.cos(math.radians(lat0))
    W = int(2 * half / mpp)
    R = np.zeros((W, W), np.float32)
    for r in hd:
        if r.get('kind') == 'apartment' or r.get('placement') == 'estimated-planned':
            continue
        e, n = (r['lng'] - lng0) * KX, (r['lat'] - lat0) * KY
        f = math.radians(r['frontBearing']); fx, fy = math.sin(f), math.cos(f); ax, ay = fy, -fx
        q = [((e + ax * su * r['L'] / 2 + fx * sv * r['D'] / 2) / mpp + W / 2, W / 2 - (n + ay * su * r['L'] / 2 + fy * sv * r['D'] / 2) / mpp)
             for su, sv in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
        cv2.fillPoly(R, [np.round(np.array(q)).astype(np.int32)], 1.0)
    return R


def master_homes(app, cid, path, lat0, lng0, half, out):
    mp = cv2.imread(path)
    mm = drawn_homes(mp)
    best = None
    for mpp, sc_rng, br_rng, blur in ((8.0, None, None, 5), (4.0, 'fine', 'fine', 5), (2.0, 'fine2', 'fine2', 3)):
        R = homes_raster(app, cid, mpp, lat0, lng0, half)
        if best is None:
            scales = np.exp(np.arange(math.log(2.5 / mpp), math.log(7.0 / mpp), 0.03)); bears = np.arange(0, 360, 2.0)
        else:
            m_per_px = best[1] * prev_mpp
            step = 0.5 if sc_rng == 'fine' else 0.15
            scales = (m_per_px / mpp) * np.arange(0.96, 1.041, 0.01 if sc_rng == 'fine' else 0.004)
            bears = np.arange(best[2] - 3 * step, best[2] + 3 * step + 1e-6, step)
        b = search(R, mm, scales, bears, blur)
        best, prev_mpp = b, mpp
        print(f'  at {mpp} m/px: corr {b[0]:.3f}, plan {b[1] * mpp:.3f} m/px, rotation {b[2]:.2f} deg', flush=True)
    v, sc, bear, loc, M = best
    M3 = np.vstack([M, [0, 0, 1]]); Tm = np.array([[1, 0, loc[0]], [0, 1, loc[1]], [0, 0, 1]]) @ M3
    W = R.shape[0]
    S = np.array([[mpp, 0, -W / 2 * mpp], [0, -mpp, W / 2 * mpp], [0, 0, 1]])  # raster px -> east / north metres
    A = (S @ Tm)[:2]
    json.dump({'image': os.path.basename(path), 'lat0': lat0, 'lng0': lng0, 'A': A.round(6).tolist(), 'corr': round(v, 3),
               'scale_m_per_px': round(sc * mpp, 4), 'rotation_deg': round(bear, 2),
               'method': "masterplan homes matched to the homes already placed in the app (site plans + satellite)"}, open(out, 'w'), indent=1)
    vis = cv2.cvtColor((R * 160).astype(np.uint8), cv2.COLOR_GRAY2BGR)
    warped = cv2.warpAffine(mp, Tm[:2], (W, W))
    cv2.imwrite(out.replace('.json', '.jpg'), cv2.resize(cv2.addWeighted(vis, 0.5, warped, 0.6, 0), (1200, 1200)))
    print(f'masterplan placed: corr {v:.3f}, {sc * mpp:.3f} m/px, rotation {bear:.2f} deg -> {out}')


if __name__ == '__main__':
    if sys.argv[1] == 'master_homes':
        master_homes(sys.argv[2], sys.argv[3], sys.argv[4], float(sys.argv[5]), float(sys.argv[6]), float(sys.argv[7]), sys.argv[8])
    elif sys.argv[1] == 'master':
        master(sys.argv[2], float(sys.argv[3]), float(sys.argv[4]), float(sys.argv[5]), sys.argv[6])
    elif sys.argv[1] == 'project':
        project(sys.argv[2], sys.argv[3], sys.argv[4], [int(x) for x in sys.argv[5:9]] if len(sys.argv) > 8 else None)


def slide(gpath, img_path, crop, half=600, max_shift=220):
    """refine a georef.json by translation only: the map's drawn buildings (its own and the existing
    neighbours it shows) against the satellite roofs; scale and rotation are kept"""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from place_cluster import sat as sat18
    g = json.load(open(gpath)); A = np.array(g['A'])
    KX = 111320.0 * math.cos(math.radians(g['lat0']))
    mp = cv2.imread(img_path); a, b, c, d = crop
    cx, cy = (a + c) / 2, (b + d) / 2
    e, n = A @ [cx, cy, 1]; lat, lng = g['lat0'] + n / KY, g['lng0'] + e / KX
    img, mpp, (x0, y0), npx = sat18(lat, lng, half)
    px = lambda la, lo: ((lo + 180) / 360 * npx - x0, (1 - math.log(math.tan(math.radians(la)) + 1 / math.cos(math.radians(la))) / math.pi) / 2 * npx - y0)
    def ll(x, y):
        e, n = A @ [x, y, 1]; return g['lat0'] + n / KY, g['lng0'] + e / KX
    src = np.float32([[a, b], [c, b], [a, d]]); dst = np.float32([px(*ll(x, y)) for x, y in src])
    M = cv2.getAffineTransform(src, dst)
    if os.environ.get('SLIDE_ON') == 'roads':
        # the map's roads (light grey, unsaturated bands) against the photo's asphalt (dark grey)
        hsv_m = cv2.cvtColor(cv2.GaussianBlur(mp, (3, 3), 0), cv2.COLOR_BGR2HSV)
        hm = ((hsv_m[..., 1] < 18) & (hsv_m[..., 2] > 200) & (hsv_m[..., 2] < 238)).astype(np.float32)
        hm = cv2.morphologyEx(hm, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
        hsv_s = cv2.cvtColor(cv2.GaussianBlur(img, (3, 3), 0), cv2.COLOR_BGR2HSV)
        roofs = ((hsv_s[..., 1] < 45) & (hsv_s[..., 2] < 115)).astype(np.float32)
    else:
        hm = homes_mask(mp)
        roofs = homes_mask(img, drawn=False)
    keep = np.zeros_like(hm); keep[b:d, a:c] = 1; hm *= keep
    W = cv2.warpAffine(hm, M, (img.shape[1], img.shape[0]))
    m = int(max_shift / mpp)
    ys, xs = np.nonzero(W > 0.5); X0, X1, Y0, Y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    tp = cv2.GaussianBlur(W[Y0:Y1, X0:X1], (5, 5), 0)
    win = cv2.GaussianBlur(roofs, (5, 5), 0)[max(0, Y0 - m):Y1 + m, max(0, X0 - m):X1 + m]
    r = cv2.matchTemplate(win, tp, cv2.TM_CCOEFF_NORMED); _, v, _, loc = cv2.minMaxLoc(r)
    r0 = r[min(m, Y0) if Y0 - m < 0 else m, min(m, X0) if X0 - m < 0 else m]
    dx = (loc[0] - (X0 - max(0, X0 - m))) * mpp; dy = (loc[1] - (Y0 - max(0, Y0 - m))) * mpp
    g['A'][0][2] += dx; g['A'][1][2] -= dy
    g['method'] += f'; slid {dx:+.1f} m east, {-dy:+.1f} m north onto the satellite ('+os.environ.get('SLIDE_ON', 'roofs')+' drawn on the map; corr {r0:.3f} -> {v:.3f})'
    json.dump(g, open(gpath, 'w'), indent=1)
    print(f'slide: {dx:+.1f} m east, {-dy:+.1f} m north; corr {r0:.3f} -> {v:.3f}')


if __name__ == '__main__' and sys.argv[1] == 'slide':
    slide(sys.argv[2], sys.argv[3], [int(x) for x in sys.argv[4:8]])


def local(app, cid, mjson, box, out, max_shift=250, mpp=2.0):
    """the masterplan's fit refined for one corner: scale and rotation of the whole fit kept, the corner's
    drawn homes (box x0 y0 x1 y1, masterplan px) shifted onto the homes the app already places there"""
    m = json.load(open(mjson)); A = np.array(m['A'])
    mp = cv2.imread(os.path.join(os.path.dirname(mjson), m['image']))
    hm = drawn_homes(mp); x0, y0, x1, y1 = box
    keep = np.zeros_like(hm); keep[y0:y1, x0:x1] = 1; hm *= keep
    half = 4500
    R = homes_raster(app, cid, mpp, m['lat0'], m['lng0'], half)
    W = R.shape[0]
    S = np.array([[1 / mpp, 0, W / 2], [0, -1 / mpp, W / 2], [0, 0, 1]])          # metres -> raster px
    T = S @ np.vstack([A, [0, 0, 1]])
    warped = cv2.warpAffine(hm, T[:2], (W, W))
    ys, xs = np.nonzero(warped > 0.5); X0, X1, Y0, Y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    mm = int(max_shift / mpp)
    tp = cv2.GaussianBlur(warped[Y0:Y1, X0:X1], (5, 5), 0)
    win = cv2.GaussianBlur(R, (5, 5), 0)[Y0 - mm:Y1 + mm, X0 - mm:X1 + mm]
    r = cv2.matchTemplate(win, tp, cv2.TM_CCOEFF_NORMED); _, v, _, loc = cv2.minMaxLoc(r)
    dx, dy = (loc[0] - mm) * mpp, (loc[1] - mm) * mpp
    m2 = dict(m); A2 = A.copy(); A2[0, 2] += dx; A2[1, 2] -= dy; m2['A'] = A2.round(6).tolist()
    m2['local'] = {'box': box, 'shift_m': [round(dx, 1), round(-dy, 1)], 'corr': round(v, 3), 'corr_before': round(float(r[mm, mm]), 3)}
    json.dump(m2, open(out, 'w'), indent=1)
    print(f'local refit of {box}: {dx:+.1f} m east, {-dy:+.1f} m north; corr {r[mm, mm]:.3f} -> {v:.3f}')


if __name__ == '__main__' and sys.argv[1] == 'local':
    local(sys.argv[2], sys.argv[3], sys.argv[4], [int(x) for x in sys.argv[5:9]], sys.argv[9])

#!/usr/bin/env python3
"""Place a cluster map on the ground and write its homes for the app.

  python scripts/siteplan/clustermap/place_cluster.py <project> <community> <terrace|villa> [lat lng]

 1. georeference: the map's homes drawn as footprints are matched to the roofs in the satellite photo
    (normalised correlation), searching scale, rotation (The Valley plans: map-up 322.5 deg +/- 6) and
    position around the project's homes; then refined;
 2. homes: terraces -> one row per run of attached homes; villas -> one row per villa; each with its
    official unit number(s); house depth/width from the map pitch;
 3. writes data/siteplans/<project>.json (same format as eden.json) for apply_siteplans.py.
"""
import json, math, os, sys
import numpy as np
import cv2

APP = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
TILES = os.environ.get('TILES', '/private/tmp/claude-501/-Users-mugesh-Downloads-digital-twin-dubai/ef2bd3be-cd3c-4b35-a01e-92e638053d0a/scratchpad/tiles')
KY = 110574.0
Z = 18


def sat(lat, lng, half_m):
    import urllib.request
    n = 2 ** Z * 256
    px = lambda la, lo: ((lo + 180) / 360 * n, (1 - math.log(math.tan(math.radians(la)) + 1 / math.cos(math.radians(la))) / math.pi) / 2 * n)
    mpp = 156543.03 * math.cos(math.radians(lat)) / 2 ** Z
    cx, cy = px(lat, lng); h = half_m / mpp
    x0, y0, x1, y1 = cx - h, cy - h, cx + h, cy + h
    img = np.zeros((int(y1 - y0), int(x1 - x0), 3), np.uint8)
    for tx in range(int(x0 // 256), int(x1 // 256) + 1):
        for ty in range(int(y0 // 256), int(y1 // 256) + 1):
            fn = os.path.join(TILES, f'{Z}_{tx}_{ty}.jpg')
            if not os.path.exists(fn):
                req = urllib.request.Request(f'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{Z}/{ty}/{tx}', headers={'User-Agent': 'Mozilla/5.0'})
                open(fn, 'wb').write(urllib.request.urlopen(req, timeout=30).read())
            t = cv2.imread(fn); ox, oy = int(tx * 256 - x0), int(ty * 256 - y0)
            xs, ys = max(0, ox), max(0, oy); xe, ye = min(img.shape[1], ox + 256), min(img.shape[0], oy + 256)
            if xe > xs and ye > ys:
                img[ys:ye, xs:xe] = t[ys - oy:ye - oy, xs - ox:xe - ox]
    return img, mpp, (x0, y0), n


def main():
    proj, cid, kind = sys.argv[1], sys.argv[2], sys.argv[3]
    lay = json.load(open(os.path.join(APP, 'data', 'siteplans', proj, 'layout.json')))
    U = {int(k): v for k, v in lay['units'].items()}
    pitch = lay['pitch']
    st = json.load(open(os.path.join(APP, 'data', 'project_status.json'))).get(proj, {})
    lat, lng = (float(sys.argv[4]), float(sys.argv[5])) if len(sys.argv) > 5 else st['centroid']
    unit_w = 7.6 if kind == 'terrace' else None  # metres per pitch for terraces; villas: searched
    img, mpp, (x0, y0), npx = sat(lat, lng, float(os.environ.get('HALF', 650)))
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    BLUR = int(os.environ.get('BLUR', 5)) | 1  # villas: match the pattern of homes, not single roofs
    roof = cv2.GaussianBlur(((hsv[..., 2] > 175) & (hsv[..., 1] < 50)).astype(np.float32), (BLUR, BLUR), 0)
    pts = np.array([U[n]['p'] for n in sorted(U)]); PM = pts.mean(0)
    # footprint of each home in plan units: along the row x across it
    along, across = (0.92, 1.55) if kind == 'terrace' else (0.55, 0.55)
    quads = []
    for n in sorted(U):
        p = np.array(U[n]['p']); a = np.array(U[n]['axis']); f = np.array(U[n]['front'])
        quads.append([p + a * sa * along * pitch / 2 + f * sf * across * pitch / 2 for sa, sf in ((-1, -1), (1, -1), (1, 1), (-1, 1))])
    quads = np.array(quads)

    def to_m(Q, sc, bear):
        th = math.radians(-bear); R = np.array([[math.cos(th), -math.sin(th)], [math.sin(th), math.cos(th)]])
        return (sc * (R @ ((Q - PM) * [1, -1]).reshape(-1, 2).T)).T.reshape(Q.shape)

    def template(sc, bear):
        M = to_m(quads, sc, bear) / mpp; M[..., 1] *= -1
        mn = M.reshape(-1, 2).min(0) - 4; M = M - mn; sz = (M.reshape(-1, 2).max(0) + 4).astype(int)
        tp = np.zeros((sz[1], sz[0]), np.float32)
        for q in M:
            cv2.fillPoly(tp, [np.round(q).astype(np.int32)], 1.0)
        return tp, mn
    scales = [unit_w / pitch * f for f in (0.9, 0.95, 1.0, 1.05, 1.1)] if unit_w else [m / pitch for m in np.arange(12, 30, 1.5)]
    best = None
    for bear in np.arange(316.5, 328.6, 1.0):
        for sc in scales:
            tp, mn = template(sc, bear)
            if tp.shape[0] >= roof.shape[0] or tp.shape[1] >= roof.shape[1]:
                continue
            if BLUR > 5:
                tp = cv2.GaussianBlur(tp, (BLUR, BLUR), 0)
            r = cv2.matchTemplate(roof, tp, cv2.TM_CCOEFF_NORMED); _, v, _, loc = cv2.minMaxLoc(r)
            if best is None or v > best[0]:
                best = (v, bear, sc, loc, mn)
    v, bear, sc, loc, mn = best
    for bear2 in np.arange(bear - 0.8, bear + 0.81, 0.2):
        for sc2 in np.arange(sc * 0.97, sc * 1.031, sc * 0.006):
            tp, mn2 = template(sc2, bear2)
            if tp.shape[0] >= roof.shape[0] or tp.shape[1] >= roof.shape[1]:
                continue
            if BLUR > 5:
                tp = cv2.GaussianBlur(tp, (BLUR, BLUR), 0)
            r = cv2.matchTemplate(roof, tp, cv2.TM_CCOEFF_NORMED); _, v2, _, loc2 = cv2.minMaxLoc(r)
            if v2 > v:
                v, bear, sc, loc, mn = v2, bear2, sc2, loc2, mn2
    spx = np.array(loc) - mn
    gx, gy = x0 + spx[0], y0 + spx[1]
    lng_c = gx / npx * 360 - 180; lat_c = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * gy / npx))))
    print(f"{proj}: placed with correlation {v:.3f}, map-up {bear:.1f} deg, scale {sc:.4f} m/pt (pitch {pitch * sc:.1f} m)")
    # debug overlay
    vis = img.copy()
    M = to_m(quads, sc, bear) / mpp; M[..., 1] *= -1; M = M + spx
    for q in M:
        cv2.polylines(vis, [np.round(q).astype(np.int32)], True, (0, 0, 255), 1)
    cv2.imwrite(f'/tmp/place_{proj}.png', cv2.resize(vis, (1100, 1100)))
    KX = 111320.0 * math.cos(math.radians(lat_c))
    th = math.radians(-bear)

    def ll(p):
        q = to_m(np.array([p], float), sc, bear)[0]
        return lat_c + q[1] / KY, lng_c + q[0] / KX

    def bearing(dx, dy):
        ex = math.cos(th) * dx - math.sin(th) * (-dy); ny = math.sin(th) * dx + math.cos(th) * (-dy)
        return math.degrees(math.atan2(ex, ny)) % 360
    rows = []
    pw = pitch * sc
    for r in lay['rows']:
        r = [n for n in r if n in U]
        if not r:
            continue
        P = np.array([U[n]['p'] for n in r]); c = P.mean(0)
        f = np.mean([U[n]['front'] for n in r], 0); f = f / (np.hypot(*f) or 1)
        a = np.array([-f[1], f[0]])  # along the row, TH order: viewer facing the house... kept as map order below
        # order units along the model's +x (js/valley-detail.js: plan +x = rr = (-cos t, -sin t) in world)
        la, lo = ll(c)
        fb = bearing(f[0], f[1])
        n = len(r)
        L = pw * n if kind == 'terrace' else pw * 0.72
        D = 12.4 if kind == 'terrace' else min(16.0, pw * 0.75)
        # model unit 0 sits at -x; x runs to the viewer's left when facing the house from the street
        left = np.array([f[1], -f[0]])  # image coords (y down): the house's own left seen from the street
        order = sorted(r, key=lambda m: -np.dot(np.array(U[m]['p']) - c, left))
        rows.append({'lat': round(la, 7), 'lng': round(lo, 7), 'L': round(L, 2), 'D': round(D, 2), 'frontBearing': round(fb, 2),
                     'kind': 'townhouse' if kind == 'terrace' else 'villa', 'units': n, 'unitWidths': [round(L / n, 2)] * n,
                     'project': proj, 'source': 'siteplan', 'placement': 'verified-siteplan',
                     'unitNumbers': order, 'unitPlans': [{'no': m, 'interp': U[m]['interp']} for m in order]})
    # villa clusters: the loop roads of the map run in front of each run of villas (in number order);
    # their centre line: plot front + footpath + half the carriageway in front of the villa
    roads = []
    if kind == 'villa':
        chain = []
        def flush():
            if len(chain) >= 2:
                roads.append({'pts': [[round(lo, 7), round(la, 7)] for la, lo in chain], 'width': 7.3, 'source': 'siteplan'})
        prev = None
        for r in rows:
            n = r['unitNumbers'][0]
            D = r['D']; off = max(D / 2, 17.4 - D / 2) + 2.0 + 3.65
            f = math.radians(r['frontBearing'])
            pt = (r['lat'] + math.cos(f) * off / KY, r['lng'] + math.sin(f) * off / KX)
            if prev is not None and (n != prev[0] + 1 or math.hypot((pt[0] - prev[1][0]) * KY, (pt[1] - prev[1][1]) * KX) > 2.2 * pw):
                flush(); chain = []
            chain.append(pt); prev = (n, pt)
        flush()
    corners = [ll(q) for qq in quads for q in qq]
    from scipy.spatial import ConvexHull
    pts2 = np.array([[lo, la] for la, lo in corners]); hull = pts2[ConvexHull(pts2).vertices]
    cxm = hull.mean(0); bnd = []
    for lo, la in hull:
        dx, dy = (lo - cxm[0]) * KX, (la - cxm[1]) * KY; dd = math.hypot(dx, dy) or 1
        bnd.append([round(lo + dx / dd * 20 / KX, 7), round(la + dy / dd * 20 / KY, 7)])
    out = {'project': proj, 'community': cid,
           'source': {'document': lay['source']['document'], 'page': lay['source']['page'], 'priority': 2,
                      'note': f"Emaar brochure cluster map: unit numbers 1-{lay['count']}"},
           'georeference': {'scale_m_per_pt': round(sc, 5), 'map_up_bearing_deg': round(bear, 2), 'correlation': round(v, 3),
                            'method': 'map homes matched to satellite roofs', 'boundary_status': 'homes hull + 20 m; DDA GIS boundary pending'},
           'checks': {'units': sum(r['units'] for r in rows), 'official_count': lay['count'], 'read': lay['read'],
                      'interpolated': lay['interpolated'], 'missing': lay['missing']},
           'boundary': bnd, 'roads': roads, 'keep_mapped_streets': True, 'streets_checked': [], 'rows': rows, 'plots': []}
    json.dump(out, open(os.path.join(APP, 'data', 'siteplans', f'{proj}.json'), 'w'), separators=(',', ':'))
    print(f"  {len(rows)} rows, {out['checks']['units']} homes of {lay['count']} on the map")


if __name__ == '__main__':
    main()

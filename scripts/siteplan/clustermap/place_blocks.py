#!/usr/bin/env python3
"""Place the building blocks of a cluster map (twins.py -> blocks.json) on the ground and write the homes.

  python scripts/siteplan/clustermap/place_blocks.py <project> <community> [--keep]

Facing comes from the cluster map (twins.py); the nearest mapped street is only compared.
1. georeference: the blocks (their real outlines on the map) are matched to the roofs of the satellite
   photo by normalised correlation - first coarse (2 m pixels, map scale 0.4-1.4 m/pt, map-up 310-336 deg)
   over the whole area around the project, then fine (0.54 m pixels) around the best match;
   --keep re-uses the earlier scale / map-up / anchor (more units read, nothing moves);
2. facing: each block faces the mapped street (OSM / derived centre lines of data/site.json) on one of
   its two long sides - the nearer one within 40 m; where no street is in reach, the map's own road
   colour decides. Both readings are kept for the report;
3. rows: one row per block (kind 'villa', its units side by side, unit 0 = left end seen from the street),
   unit width = the plot width along the street (spacing to the next block, at most 1.6 x the block);
   depth = the block depth (house footprint).
Writes data/siteplans/<project>.json (format of eden.json / orania) + /tmp/place_<project>.png.
"""
import json, math, os, sys
import numpy as np
import cv2

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from place_cluster import sat  # noqa: E402  (Esri z18 tiles, cached)

APP = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
KY = 110574.0
MIN_UNIT_W = 9.2  # m: narrowest villa plot the app draws (0.75 x the 11.25 m model plot + side yard)


def main():
    proj, cid = sys.argv[1], sys.argv[2]
    keep = '--keep' in sys.argv
    d = os.path.join(APP, 'data', 'siteplans', proj)
    B = json.load(open(os.path.join(d, 'blocks.json')))
    blocks = B['blocks']
    st = json.load(open(os.path.join(APP, 'data', 'project_status.json'))).get(proj, {})
    lat0, lng0 = st['centroid']
    img, mpp, (x0, y0), npx = sat(lat0, lng0, float(os.environ.get('HALF', 750)))
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    roof = ((hsv[..., 2] > 175) & (hsv[..., 1] < 50)).astype(np.float32)
    C = np.array([b['c'] for b in blocks]); PM = C.mean(0)
    quads = []
    for b in blocks:
        c, ax = np.array(b['c']), np.array(b['axis']); n = np.array([-ax[1], ax[0]])
        quads.append([c + ax * su * b['L'] / 2 + n * sv * b['D'] / 2 for su, sv in ((-1, -1), (1, -1), (1, 1), (-1, 1))])
    quads = np.array(quads)

    def to_m(Q, sc, bear):  # page points -> metres east / north of the map's mean point
        th = math.radians(-bear); R = np.array([[math.cos(th), -math.sin(th)], [math.sin(th), math.cos(th)]])
        return (sc * (R @ ((Q - PM) * [1, -1]).reshape(-1, 2).T)).T.reshape(Q.shape)

    def template(sc, bear, pxm, blur):
        M = to_m(quads, sc, bear) / pxm; M[..., 1] *= -1
        mn = M.reshape(-1, 2).min(0) - 6; M = M - mn; sz = (M.reshape(-1, 2).max(0) + 6).astype(int)
        tp = np.zeros((sz[1], sz[0]), np.float32)
        for q in M:
            cv2.fillPoly(tp, [np.round(q).astype(np.int32)], 1.0)
        if blur > 1:
            tp = cv2.GaussianBlur(tp, (blur, blur), 0)
        return tp, mn

    if keep:
        old = json.load(open(os.path.join(APP, 'data', 'siteplans', f'{proj}.json')))['georeference']
        sc, bear, v = old['scale_m_per_pt'], old['map_up_bearing_deg'], old.get('correlation', 0)
        lat_c, lng_c = old['anchor']['lat'], old['anchor']['lng']
        PM = np.array(old['anchor']['plan_pt'])
    else:
        # coarse: 4x smaller satellite (about 2.2 m pixels)
        f = 4
        rs = cv2.resize(cv2.GaussianBlur(roof, (5, 5), 0), None, fx=1 / f, fy=1 / f, interpolation=cv2.INTER_AREA)
        best = None
        lo, hi = map(float, os.environ.get('SCALES', '0.4,1.4').split(','))
        for bear in np.arange(310.0, 336.1, 1.5):
            for sc in np.exp(np.arange(math.log(lo), math.log(hi), 0.03)):
                tp, mn = template(sc, bear, mpp * f, 3)
                if tp.shape[0] >= rs.shape[0] or tp.shape[1] >= rs.shape[1]:
                    continue
                r = cv2.matchTemplate(rs, tp, cv2.TM_CCOEFF_NORMED); _, val, _, loc = cv2.minMaxLoc(r)
                if best is None or val > best[0]:
                    best = (val, bear, sc, np.array(loc) - mn)
        v, bear, sc, spx_c = best
        print(f'{proj}: coarse match {v:.3f} at map-up {bear:.1f} deg, scale {sc:.3f} m/pt')
        # fine: full resolution, search window around the coarse position
        rb = cv2.GaussianBlur(roof, (3, 3), 0)
        best = None
        for bear2 in np.arange(bear - 1.5, bear + 1.51, 0.25):
            for sc2 in sc * np.arange(0.96, 1.041, 0.005):
                tp, mn = template(sc2, bear2, mpp, 3)
                # where the map's mean point falls, from the coarse match, +/- 25 m
                cx, cy = spx_c * f
                m = int(25 / mpp)
                ox, oy = int(cx + mn[0] * 0 - m), int(cy - m)
                X0 = max(0, int(cx + mn[0]) - m); Y0 = max(0, int(cy + mn[1]) - m)
                win = rb[Y0:Y0 + tp.shape[0] + 2 * m, X0:X0 + tp.shape[1] + 2 * m]
                if win.shape[0] < tp.shape[0] or win.shape[1] < tp.shape[1]:
                    continue
                r = cv2.matchTemplate(win, tp, cv2.TM_CCOEFF_NORMED); _, val, _, loc = cv2.minMaxLoc(r)
                if best is None or val > best[0]:
                    best = (val, bear2, sc2, np.array([X0 + loc[0], Y0 + loc[1]]) - mn)
        v, bear, sc, spx = best
        gx, gy = x0 + spx[0], y0 + spx[1]
        lng_c = gx / npx * 360 - 180; lat_c = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * gy / npx))))
        print(f'{proj}: placed with correlation {v:.3f}, map-up {bear:.2f} deg, scale {sc:.4f} m/pt')
    KX = 111320.0 * math.cos(math.radians(lat_c))
    px = lambda la, lo: ((lo + 180) / 360 * npx - x0, (1 - math.log(math.tan(math.radians(la)) + 1 / math.cos(math.radians(la))) / math.pi) / 2 * npx - y0)

    def ll(p):
        q = to_m(np.array([p], float), sc, bear)[0]
        return lat_c + q[1] / KY, lng_c + q[0] / KX

    th = math.radians(-bear)

    def bearing(dx, dy):  # page direction -> ground bearing
        ex = math.cos(th) * dx - math.sin(th) * (-dy); ny = math.sin(th) * dx + math.cos(th) * (-dy)
        return math.degrees(math.atan2(ex, ny)) % 360

    # streets on the ground (metres), for the facing
    site = json.load(open(os.path.join(APP, 'data', 'site.json')))['communities'][cid]['streets']
    segs = []
    for s_ in site:
        if s_['cls'] == 'path' or (s_.get('source') == 'siteplan' and s_.get('project') == proj):
            continue
        p = [((lo - lng_c) * KX, (la - lat_c) * KY) for lo, la in s_['pts']]
        segs += [(p[i], p[i + 1]) for i in range(len(p) - 1)]
    S = np.array([[a[0], a[1], b_[0], b_[1]] for a, b_ in segs])

    def ray(o, dvec, tmax=40):
        ax_, ay_, bx_, by_ = S.T
        vx, vy = bx_ - ax_, by_ - ay_
        den = dvec[0] * vy - dvec[1] * vx
        with np.errstate(divide='ignore', invalid='ignore'):
            t = ((ax_ - o[0]) * vy - (ay_ - o[1]) * vx) / den
            u = ((ax_ - o[0]) * dvec[1] - (ay_ - o[1]) * dvec[0]) / den
        ok = (np.abs(den) > 1e-9) & (u >= 0) & (u <= 1) & (t > 0) & (t < tmax)
        return float(t[ok].min()) if ok.any() else None

    # plot width along the street: spacing to the neighbouring blocks of the same row
    Cm = to_m(C[:, None, :], sc, bear)[:, 0, :]
    cfg = json.load(open(os.path.join(d, 'config.json')))
    pbb = cfg.get('plans_by_beds', {})

    def plan_of(beds):
        # floor plan by bedroom count, where the project's floor plans are published per bedroom count only
        q = pbb.get(str(beds))
        if not q:
            return {'plan': None, 'page': None, 'sqft': None, 'sqm': None}
        return {'plan': q['plan'], 'page': q['page'], 'pages': q.get('pages'), 'sqft': q['sqft'], 'sqm': q['sqm'], 'plan_by': 'bedroom count'}
    rows, agree, disagree, by_map = [], 0, 0, 0
    widened = []
    face_report = []
    for i, b in enumerate(blocks):
        ax = np.array(b['axis']); n = np.array([-ax[1], ax[0]])
        c_m = Cm[i]
        axm = to_m(np.array([[PM + ax]]), sc, bear)[0, 0] - to_m(np.array([[PM]]), sc, bear)[0, 0]; axm /= np.hypot(*axm)
        nm = np.array([-axm[1], axm[0]])
        Lm, Dm = b['L'] * sc, b['D'] * sc
        # map's +n in metres: page normal n -> ground
        nmg = to_m(np.array([[PM + n]]), sc, bear)[0, 0] - to_m(np.array([[PM]]), sc, bear)[0, 0]; nmg /= np.hypot(*nmg)
        t1 = ray(c_m + nmg * Dm / 2, nmg); t2 = ray(c_m - nmg * Dm / 2, -nmg)
        map_front = np.array(b['front'])
        map_side = 1 if np.dot(map_front, n) > 0 else -1
        # the map's own reading (rows face each other across the road between them; twins.py) decides;
        # the mapped street nearest each side is compared for the report (derived streets can be off)
        side, how = map_side, 'cluster map (road between rows)'
        if t1 is None and t2 is None:
            by_map += 1
        elif (1 if (t2 is None or (t1 is not None and t1 <= t2)) else -1) == map_side:
            agree += 1
        else:
            disagree += 1
        f_pg = n * side
        # spacing to the nearest block along the axis (same orientation, beside it)
        rel = Cm - c_m
        along = rel @ axm; across = rel @ nm
        same = (np.abs(across) < 0.6 * Dm) & (np.abs(along) > 0.3 * Lm)
        gaps = np.abs(along[same]); gaps = gaps[gaps >= 1.0 * Lm]  # a block nearer than its own length is not beside it
        gap = float(gaps.min()) if len(gaps) else None
        plot_w = min(gap, 1.6 * Lm) if gap else 1.35 * Lm
        nu = len(b['units'])
        unit_w = plot_w / nu
        if unit_w < MIN_UNIT_W:  # the villa model is not drawn narrower (js/valley-detail.js: scale >= 0.75)
            widened.append(b['units']); unit_w = MIN_UNIT_W
        la, lo = ll(np.array(b['c']))
        fb = bearing(f_pg[0], f_pg[1])
        left = np.array([f_pg[1], -f_pg[0]])  # page coords: the house's own left
        U = {b['units'][0]: None}
        # numbers: left end seen from the street first (= house's own right), as the model's unit 0
        pos = {u: np.array(b['c']) + ax * (j - (nu - 1) / 2) * b['L'] / nu for j, u in enumerate(b['units'])}
        order = sorted(b['units'], key=lambda u: np.dot(pos[u] - np.array(b['c']), left)) if None not in b['units'] else list(b['units'])
        rows.append({'lat': round(la, 7), 'lng': round(lo, 7), 'L': round(unit_w * nu, 2), 'D': round(Dm, 2), 'frontBearing': round(fb, 2),
                     'kind': 'villa', 'units': nu, 'unitWidths': [round(unit_w, 2)] * nu, 'project': proj, 'source': 'siteplan',
                     'placement': 'verified-siteplan', 'block': i, 'unitNumbers': order,
                     'unitPlans': [{'no': u, 'design': b['design'], 'beds': b['beds'], **plan_of(b['beds']),
                                    'position': 'twin' if nu == 2 else 'villa', 'pair': [x for x in order if x != u][0] if nu == 2 else None,
                                    'type_source': 'map legend colour', 'map_page': B['source']['page']} for u in order]})
        face_report.append({'units': b['units'], 'how': how, 'street_m': [t1, t2], 'map_agrees': side == map_side})
    # debug overlay
    vis = img.copy()
    M = to_m(quads, sc, bear)
    for q, r in zip(M, rows):
        pts = np.array([px(lat_c + y_ / KY, lng_c + x_ / KX) for x_, y_ in q])
        cv2.polylines(vis, [np.round(pts).astype(np.int32)], True, (0, 0, 255), 2)
        c = pts.mean(0); fbr = math.radians(r['frontBearing'])
        cv2.line(vis, tuple(np.int32(c)), tuple(np.int32(c + np.array([math.sin(fbr), -math.cos(fbr)]) * 14 / mpp)), (0, 255, 0), 2)
    for s_ in site:
        if s_['cls'] == 'path':
            continue
        pts = np.array([px(la, lo) for lo, la in s_['pts']])
        cv2.polylines(vis, [np.round(pts).astype(np.int32)], False, (255, 160, 0), 1)
    cv2.imwrite(f'/tmp/place_{proj}.png', vis)
    # boundary: hull of the blocks + 20 m
    from scipy.spatial import ConvexHull
    corners = np.array([[lng_c + x_ / KX, lat_c + y_ / KY] for q in M for x_, y_ in q])
    hull = corners[ConvexHull(corners).vertices]; cm = hull.mean(0); bnd = []
    for lo, la in hull:
        dx, dy = (lo - cm[0]) * KX, (la - cm[1]) * KY; dd = math.hypot(dx, dy) or 1
        bnd.append([round(lo + dx / dd * 20 / KX, 7), round(la + dy / dd * 20 / KY, 7)])
    nums = [u for r in rows for u in r['unitNumbers'] if u is not None]
    unnumbered = sum(1 for r in rows for u in r['unitNumbers'] if u is None)
    out = {'project': proj, 'community': cid,
           'source': {'document': B['source']['document'], 'page': B['source']['page'], 'priority': 2,
                      'note': f"Emaar brochure cluster map: {len(nums)} units in {len(rows)} twin villas, type from the map legend"},
           'georeference': {'scale_m_per_pt': round(float(sc), 5), 'map_up_bearing_deg': round(float(bear), 2), 'correlation': round(float(v), 3),
                            'method': 'map building blocks matched to satellite roofs (coarse-to-fine)' + ('; kept from the earlier run' if keep else ''),
                            'anchor': {'plan_pt': [round(float(PM[0]), 2), round(float(PM[1]), 2)], 'lat': round(lat_c, 7), 'lng': round(lng_c, 7)},
                            'boundary_status': 'blocks hull + 20 m; DDA GIS boundary pending'},
           'checks': {'units': len(nums) + unnumbered, 'numbered': len(nums), 'placed_without_number': unnumbered,
                      'official_count': B['count'], 'numbers_unique': len(set(nums)), 'blocks': len(rows),
                      'numbers_missing': [x for x in range(1, B['count'] + 1) if x not in set(nums)],
                      'not_placed': [p for p in B['problems'] if 'not read' in p['why'] or 'side by side' in p['why']],
                      'outline_not_traced': [p['pair'] for p in B['problems'] if 'outline' in p['why']],
                      'drawn_at_minimum_width': widened,
                      'facing': {'source': 'cluster map (rows face each other across their street)',
                                 'nearest_mapped_street_agrees': agree, 'nearest_mapped_street_differs': disagree,
                                 'no_mapped_street_within_40m': by_map}},
           'boundary': bnd, 'roads': [], 'keep_mapped_streets': True, 'streets_checked': [], 'rows': rows, 'plots': []}
    json.dump(out, open(os.path.join(APP, 'data', 'siteplans', f'{proj}.json'), 'w'), separators=(',', ':'))
    json.dump(face_report, open(os.path.join(d, 'facing.json'), 'w'))
    print(f"  {len(rows)} blocks, {len(nums)} units; facing from the map; nearest mapped street agrees {agree}, differs {disagree}, none in reach {by_map}")


if __name__ == '__main__':
    main()

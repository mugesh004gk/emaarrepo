#!/usr/bin/env python3
"""Eden (The Valley): every home from Emaar's cluster map, with its unit number and exact floor plan.

  python3 scripts/siteplan/build_eden.py      -> data/siteplans/eden.json   (then apply_siteplans.py)

Source: EDEN_floorplan.pdf (Emaar). Page 2 is the cluster map with unit numbers 1-362 and the house
type of every home (Spruce / Iris / May Bell; pages 3, 10, 16 show one type each). Pages 4-20 are the
floor plans; each lists the terrace positions it applies to ("8 PLEX - TH 02") with the area.

Extraction (tools in scripts/siteplan/clustermap/, results in data/siteplans/eden/):
 - terraces.py: terrace buildings detected on the map image; unit numbers read with macOS Vision
   text recognition (ocr.swift) and assigned by position along each terrace. 7 terraces needed a
   documented correction (fixes.json): 362/362 numbers, each exactly once, terraces of 6/8/9/10 homes;
 - georef_img.py: the plan is placed on the satellite photo by matching its buildings to the roofs
   (scale, rotation and shift only). Plan orientation found: 322.5 deg - the same as Nara's
   official site plan (322.51 deg);
 - units.py: street side of each terrace from its carports; TH01 is the left end seen from the
   street (the key plans on every floor-plan page draw the street below the terrace, TH01 at the
   left); position -> floor plan from the PDF tables. Check: the house type of all 362 homes agrees
   with Emaar's colour maps (pages 3, 10, 16);
 - areas.json: built-up area per terrace position, read from the floor-plan pages.
Outer placement: the agreed reference is the DDA GIS outer boundary (gis.dda.government.ae); until it
is received the plan is placed on the satellite roofs (see georeference in the output).
"""
import json, math, os

APP = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(APP, 'data', 'siteplans', 'eden')
KY = 110574.0
FIX_AREA = {'10-3': {'sqft': 2038.68, 'sqm': 189.40,
                     'why': 'image text unreadable; value from the PDF text layer of page 6 (2038.68 SQ FT / 189.40 SQM)'}}


def hull(points):
    pts = sorted(set(points))
    if len(pts) < 3:
        return pts
    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lo, hi = [], []
    for p in pts:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], p) <= 0:
            lo.pop()
        lo.append(p)
    for p in reversed(pts):
        while len(hi) >= 2 and cross(hi[-2], hi[-1], p) <= 0:
            hi.pop()
        hi.append(p)
    return lo[:-1] + hi[:-1]


def main():
    T = json.load(open(os.path.join(SRC, 'terraces_fixed.json')))
    U = json.load(open(os.path.join(SRC, 'units.json')))
    g = json.load(open(os.path.join(SRC, 'georef.json')))
    areas = json.load(open(os.path.join(SRC, 'areas.json')))
    fixes = json.load(open(os.path.join(SRC, 'fixes.json')))
    for k, v in FIX_AREA.items():
        areas[k].update({'sqft': v['sqft'], 'sqm': v['sqm']})
    sc, bear = g['scale'], g['bearing']
    th = math.radians(-bear)
    PM = g['plan_mean']
    KX = 111320.0 * math.cos(math.radians(g['lat']))

    def to_m(x, y):  # plan px -> metres east/north of the plan's mean point
        px, py = (x - PM[0]), -(y - PM[1])
        return sc * (math.cos(th) * px - math.sin(th) * py), sc * (math.sin(th) * px + math.cos(th) * py)

    shift = g.get('street_shift_m', [0.0, 0.0])  # ground correction from the street centre lines (see fit_streets)

    def to_ll(x, y):
        ex, ny = to_m(x, y)
        return g['lat'] + (ny + shift[1]) / KY, g['lng'] + (ex + shift[0]) / KX

    def dir_bearing(dx, dy):  # plan px direction -> map bearing
        ex = math.cos(th) * dx - math.sin(th) * (-dy)
        ny = math.sin(th) * dx + math.cos(th) * (-dy)
        return math.degrees(math.atan2(ex, ny)) % 360

    # terraces on the plan's grid are exactly parallel: an axis within 5 degrees of the image grid is
    # snapped to it (the detected outline wobbles by 2-3 degrees); terraces on the curve keep theirs
    for t in T:
        ang = math.degrees(math.atan2(t['u'][1], t['u'][0]))
        snap = round(ang / 90) * 90
        if abs(ang - snap) <= 5:
            a = math.radians(snap)
            t['u'] = [math.cos(a), math.sin(a)]
            sgn = 1 if (t['n'][0] * -math.sin(a) + t['n'][1] * math.cos(a)) >= 0 else -1
            t['n'] = [-math.sin(a) * sgn, math.cos(a) * sgn]

    rows, plots, corners = [], [], []
    for ti, (t, u) in enumerate(zip(T, U)):
        cx, cy = t['c']; ax, ay = t['u']; nx, ny = t['n']; side = u['side']
        fx, fy = nx * side, ny * side  # toward the street
        lat, lng = to_ll(cx, cy)
        fb = dir_bearing(fx, fy)
        L, Dm = t['L'] * sc, t['T'] * sc
        n = t['nunits']
        plans = []
        for r in sorted(u['units'], key=lambda r: r['th']):  # TH01 first = model unit 0 (js/valley-detail.js)
            a = areas.get(f"{n}-{r['th']}", {})
            plans.append({'no': r['no'], 'th': r['th'], 'plex': n, 'design': r['design'], 'beds': r['beds'], 'plan': r['plan'],
                          'page': r['page'], 'sqft': a.get('sqft'), 'sqm': a.get('sqm'),
                          'position': 'end' if r['th'] in (1, n) else 'mid'})
        rows.append({'lat': round(lat, 7), 'lng': round(lng, 7), 'L': round(L, 2), 'D': round(Dm, 2), 'frontBearing': round(fb, 2),
                     'kind': 'townhouse', 'units': n, 'unitWidths': [round(L / n, 2)] * n, 'project': 'eden',
                     'source': 'siteplan', 'placement': 'verified-siteplan', 'block': ti,
                     'unitNumbers': [p['no'] for p in plans], 'unitPlans': plans})
        # plots: slot width x (rear garden + house + front), from the plan's coloured plot areas
        front, rear = t.get('front_px', 47) , t.get('rear_px', 43)
        for p in plans:
            slot = next(r['slot'] for r in u['units'] if r['no'] == p['no'])
            a0 = -t['L'] / 2 + slot * t['L'] / n; a1 = a0 + t['L'] / n
            quad = [(cx + ax * a + fx * d, cy + ay * a + fy * d) for a, d in ((a0, -t['T'] / 2 - rear), (a1, -t['T'] / 2 - rear), (a1, t['T'] / 2 + front), (a0, t['T'] / 2 + front))]
            ll = [to_ll(*q) for q in quad]
            corners += [(q[1], q[0]) for q in ll]
            plots.append({'id': f"eden-{p['no']}", 'unit': p['no'], 'polygon': [[round(q[1], 7), round(q[0], 7)] for q in ll],
                          'rear': [[round(ll[0][1], 7), round(ll[0][0], 7)], [round(ll[1][1], 7), round(ll[1][0], 7)]],
                          'front': [[round(ll[2][1], 7), round(ll[2][0], 7)], [round(ll[3][1], 7), round(ll[3][0], 7)]],
                          'depth_m': round((t['T'] + front + rear) * sc, 2), 'width_m': round(L / n, 2),
                          'house_type': f"{p['design']} {p['beds']} BR {p['plan']}", 'front_bearing': round(fb, 2), 'status': 'siteplan'})
    # area replaced in the app: around all plots (+12 m); the DDA GIS outer boundary will replace it
    hx = hull(corners)
    cxm = sum(p[0] for p in hx) / len(hx); cym = sum(p[1] for p in hx) / len(hx)
    bnd = []
    for lo, la in hx:
        dx, dy = (lo - cxm) * KX, (la - cym) * KY
        d = math.hypot(dx, dy) or 1
        bnd.append([round(lo + dx / d * 12 / KX, 7), round(la + dy / d * 12 / KY, 7)])
    out = {'project': 'eden', 'community': 'the-valley',
           'source': {'document': 'EDEN_floorplan.pdf', 'page': 2, 'priority': 2,
                      'note': 'Emaar Eden floor-plan PDF: cluster map p.2 (unit numbers 1-362, house types), floor plans p.4-20 (terrace positions, areas)'},
           'georeference': {'scale_m_per_px': round(sc, 5), 'map_up_bearing_deg': bear, 'method': 'plan buildings matched to satellite roofs (normalised correlation %.2f); orientation equals Nara official plan (322.51 deg)' % g['corr'],
                            'boundary_status': 'plots hull + 12 m; to be replaced by the DDA GIS outer boundary'},
           'checks': {'units': sum(r['units'] for r in rows), 'numbers_unique': len({p['no'] for r in rows for p in r['unitPlans']}),
                      'type_matches_colour_maps': '362/362', 'manual_fixes': fixes, 'area_fixes': FIX_AREA},
           'boundary': bnd, 'roads': [], 'keep_mapped_streets': True, 'streets_checked': [], 'rows': rows, 'plots': plots}
    json.dump(out, open(os.path.join(APP, 'data', 'siteplans', 'eden.json'), 'w'), separators=(',', ':'))
    print(f"eden: {len(rows)} terraces, {out['checks']['units']} homes, {out['checks']['numbers_unique']} unique numbers, {len(plots)} plots")


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Boundary review data: one record per built Valley property, for the 'Boundaries' review view.

  python3 scripts/siteplan/export_boundaries.py      -> data/property_boundaries.json

Reads only what the pipeline already wrote (data/siteplans/<project>.json, data/nara_data.json,
data/floorplans.json, data/unit_counts.json) - nothing is estimated here. Each record says:
 - the boundary drawn in the app and how it was made (hull of the placed homes + margin) - it is our
   working outline, NOT the DDA GIS plot boundary (ddaBoundary stays null until DDA files arrive);
 - which cluster map it was traced from, and how the map was put on the ground;
 - homes placed / numbered against the official count;
 - which floor-plan PDF the homes link to and how many homes have a plan.
"""
import glob, json, math, os

APP = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MEDIA = 'media/research/the-valley/properties'
KY = 110574.0
ORDER = ['nara', 'eden', 'orania-at-the-valley', 'elora', 'rivana', 'alana', 'the-farm-gardens', 'farm-gardens-2',
         'kaia-at-the-valley', 'elea-at-the-valley', 'rivera-at-the-valley-phase-2', 'lillia', 'venera-at-the-valley', 'talia', 'elva-at-the-valley', 'velora-2-at-the-valley-phase-2']
# floor-plan facts that are not in the data files (checked by hand on the PDFs)
FLOOR_NOTES = {
    'rivana': 'broker copy with 5 of the 12 sheets (no Kai 4 BR); scanned, areas not readable',
    'alana': 'broker copy of the Emaar floor plans; which twin uses the mirrored sheet is not stated',
    'farm-gardens-2': 'broker copy of the Emaar floor plans; which villa uses the mirrored sheet is not stated',
    'the-farm-gardens': 'floor plan by bedroom count; which villas use the mirrored plan is not stated',
    'elea-at-the-valley': '10 homes without a plan: bedroom count to confirm (34, 35, 50, 51, 54, 55, 58, 59, 94, 110)',
}


def hull_plus(pts, margin):
    """convex hull of [lng, lat] points pushed out by margin metres (same rule as place_cluster.py)"""
    pts = sorted(set(map(tuple, pts)))
    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lo, up = [], []
    for p in pts:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], p) <= 0: lo.pop()
        lo.append(p)
    for p in reversed(pts):
        while len(up) >= 2 and cross(up[-2], up[-1], p) <= 0: up.pop()
        up.append(p)
    hull = lo[:-1] + up[:-1]
    KX = 111320.0 * math.cos(math.radians(hull[0][1]))
    cx = sum(p[0] for p in hull) / len(hull); cy = sum(p[1] for p in hull) / len(hull)
    out = []
    for x, y in hull:
        dx, dy = (x - cx) * KX, (y - cy) * KY; d = math.hypot(dx, dy) or 1
        out.append([round(x + dx / d * margin / KX, 7), round(y + dy / d * margin / KY, 7)])
    return out


def media(pid, sub, pick=None):
    fs = sorted(glob.glob(os.path.join(APP, MEDIA, pid, sub, '*')))
    fs = [f for f in fs if f.lower().endswith(('.png', '.jpg', '.pdf'))]
    if pick:
        fs = [f for f in fs if pick(os.path.basename(f))] or fs
    return os.path.relpath(fs[0], APP) if fs else None


def main():
    names = {}
    for c in json.load(open(os.path.join(APP, 'data', 'projects.json')))['communities']:
        for p in c['projects']:
            n = p.get('shortName') or p['name']
            names[p['id']] = n.title() if n.isupper() else n
    fp = json.load(open(os.path.join(APP, 'data', 'floorplans.json')))
    counts = json.load(open(os.path.join(APP, 'data', 'unit_counts.json')))['projects']
    out = []
    for pid in ORDER:
        cmap = media(pid, 'clustermap', lambda n: '_p' in n or '_client.png' in n)
        if pid == 'nara':
            nd = json.load(open(os.path.join(APP, 'data', 'nara_data.json')))
            us = nd['units']
            rec = {
                'boundary': hull_plus([[u['lon'], u['lat']] for u in us], 20),
                'boundaryMethod': 'Outline around the 372 surveyed homes + 20 m',
                'placement': {'kind': 'satellite', 'text': 'Official Emaar site plan; every home matched to its roof on the satellite photo'},
                'clusterMap': {'document': 'NARA_floorplan.pdf', 'page': 17, 'image': cmap},
                'units': {'official': 372, 'placed': len(us), 'numbered': len(us), 'missingNumbers': 0},
                'linked': sum(1 for u in us if u.get('planName')),
            }
        else:
            sp = json.load(open(os.path.join(APP, 'data', 'siteplans', f'{pid}.json')))
            g, ck = sp['georeference'], sp.get('checks', {})
            ups = [p for r in sp['rows'] for p in (r.get('unitPlans') or [])]
            placed = sum(r['units'] for r in sp['rows'])
            numbered = sum(1 for r in sp['rows'] for n in (r.get('unitNumbers') or []) if n is not None)
            official = ck.get('official_count') or (counts.get(pid) or {}).get('total') or ck.get('units')
            bs = g.get('boundary_status', '')
            prov = 'provisional' in bs or 'masterplan' in g.get('method', '').lower()
            what = bs.split(';')[0].replace('homes hull', 'Outline around the placed homes').replace('blocks hull', 'Outline around the placed villas').replace('plots hull', 'Outline around the plots')
            rec = {
                'boundary': sp['boundary'],
                'boundaryMethod': what,
                'placement': ({'kind': 'masterplan', 'text': 'Not built yet: placed from the Valley masterplan (provisional, about 30-50 m)'} if prov else
                              {'kind': 'satellite', 'text': 'Cluster map matched to the built homes on the satellite photo' + (f" (match score {g['correlation']:.2f})" if g.get('correlation') else '')}),
                'placementDetail': g.get('method'),
                'clusterMap': {'document': sp['source']['document'], 'page': sp['source'].get('page'), 'image': cmap},
                'units': {'official': official, 'placed': placed, 'numbered': numbered, 'missingNumbers': max(0, (official or 0) - numbered)},
                'linked': sum(1 for p in ups if p.get('plan') or p.get('page')),
            }
        f = fp.get(pid)
        rec['floorPlan'] = {'document': os.path.basename(f['src']) if f else None, 'url': f['src'] if f and os.path.exists(os.path.join(APP, f['src'])) else None,
                            'linkedUnits': rec.pop('linked'), 'note': FLOOR_NOTES.get(pid)}
        u = rec['units']
        rec['status'] = 'complete' if u['official'] and u['numbered'] >= u['official'] else 'partial'
        out.append({'id': pid, 'name': names.get(pid, pid), 'community': 'the-valley', **rec,
                    'ddaBoundary': None, 'ddaNote': 'DDA GIS plot boundary not received yet: when it arrives it replaces this outline'})
        print(f"{pid:32s} {rec['status']:9s} placed {u['placed']:4d} numbered {u['numbered']:4d} / {u['official']}  plan-linked {rec['floorPlan']['linkedUnits']:4d}  {rec['placement']['kind']}")
    json.dump({'_about': 'Working boundaries of the built Valley properties (hull of the placed homes + margin) with how each was made. '
                         'Not DDA GIS boundaries. Written by scripts/siteplan/export_boundaries.py.', 'properties': out},
              open(os.path.join(APP, 'data', 'property_boundaries.json'), 'w'), indent=1)


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Label anchors for The Valley's properties, from their placed homes (not from the marketing pins).

  python3 scripts/siteplan/label_anchors.py      (after apply_siteplans.py)

For every Valley project with homes in the app, the anchor is the medoid of its homes (the home with the
smallest total distance to all others): it always lies on one of the project's own homes, so inside its
footprint even for L-, U- or heart-shaped sites where the centroid falls outside. Written to
data/projects.json as project['anchor'] = {lat, lng, source}; the pins (lat / lng) are not changed - only the
map labels use the anchor. Nara (its own model) uses its surveyed units.
"""
import json, math, os

APP = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
KY = 110574.0


def medoid(pts):
    KX = 111320.0 * math.cos(math.radians(pts[0][0]))
    P = [(lo * KX, la * KY) for la, lo in pts]
    if len(P) > 1500:
        P2 = P[::len(P) // 1500 + 1]
    else:
        P2 = P
    best = min(range(len(P)), key=lambda i: sum(math.hypot(P[i][0] - q[0], P[i][1] - q[1]) for q in P2))
    return pts[best]


def main():
    path = os.path.join(APP, 'data', 'projects.json'); pj = json.load(open(path))
    hd = json.load(open(os.path.join(APP, 'data', 'homes_detected.json')))['communities']['the-valley']
    nara = json.load(open(os.path.join(APP, 'data', 'nara_data.json')))['units']
    for c in pj['communities']:
        if c['id'] != 'the-valley':
            continue
        for p in c['projects']:
            if p['id'] == 'nara':
                pts = [(u['lat'], u['lon']) for u in nara]; src = 'medoid of the 372 surveyed Nara homes'
            else:
                rows = [r for r in hd if r.get('project') == p['id']]
                if not rows:
                    p.pop('anchor', None); continue
                pts = [(r['lat'], r['lng']) for r in rows]
                kind = 'cluster-map homes' if rows[0].get('placement') == 'verified-siteplan' else 'estimated homes'
                src = f'medoid of its {len(rows)} placed {kind} rows'
            la, lo = medoid(pts)
            d = math.hypot((la - p['lat']) * KY, (lo - p['lng']) * 111320 * math.cos(math.radians(la)))
            p['anchor'] = {'lat': round(la, 7), 'lng': round(lo, 7), 'source': src}
            print(f"{p['id'][:30]:30s} anchor {d:5.0f} m from the pin")
    json.dump(pj, open(path, 'w'), ensure_ascii=False, separators=(',', ':'))


if __name__ == '__main__':
    main()

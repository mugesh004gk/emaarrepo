#!/usr/bin/env python3
"""Put the traced official site plans (data/siteplans/<project>.json) into the app data, and label
every row and street with where its geometry comes from.

  python3 scripts/siteplan/apply_siteplans.py        (last step of the data pipeline, after derive_site.py)

For each traced project, inside its site-plan boundary:
 - rows: the satellite-detected rows are replaced by the plan's rows (source 'siteplan',
   placement 'verified-siteplan'); the detected originals stay untouched in
   data/source/homes_as_detected.json;
 - streets: derived (generated) access streets are removed; mapped streets lying mostly inside are
   replaced by the plan's own road centre lines (source 'siteplan'); a plan road that ends within
   15 m of a kept street is joined to it, so junctions connect;
Everywhere else rows are labelled placement 'estimated-satellite' (or 'estimated-planned' for the
illustrative layouts of unbuilt projects) and streets keep source 'osm' / 'derived'.
Writes data/placement_provenance.json with the per-community counts.
"""
import glob, json, math, os

APP = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
KY = 110574.0
CARRIAGEWAY = 7.3  # m - standard minor-road width; a satellite crop of Raya shows about 7-8 m of asphalt. Not a surveyed value: the plan raster draws only the light core (~5 m)


def inside(pt, poly):
    x, y = pt
    c = False
    for i in range(len(poly)):
        (x1, y1), (x2, y2) = poly[i], poly[i - 1]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            c = not c
    return c


def seg_near(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    l2 = vx * vx + vy * vy or 1
    t = max(0, min(1, ((px - ax) * vx + (py - ay) * vy) / l2))
    qx, qy = ax + vx * t, ay + vy * t
    return math.hypot(px - qx, py - qy), qx, qy


def main():
    hd = json.load(open(os.path.join(APP, 'data', 'homes_detected.json')))
    site = json.load(open(os.path.join(APP, 'data', 'site.json')))
    plans = [json.load(open(f)) for f in sorted(glob.glob(os.path.join(APP, 'data', 'siteplans', '*.json'))) if not f.endswith('.config.json')]
    for sp in plans:
        cid, pid, bnd = sp['community'], sp['project'], sp['boundary']  # boundary [[lng, lat]]
        rows = hd['communities'][cid]
        before = len(rows)
        kept_rows, untagged = [], 0
        for r in rows:
            if r.get('source') == 'siteplan' and r.get('project') == pid:
                continue  # re-applied below
            if r.get('source') == 'siteplan':
                kept_rows.append(r)  # a neighbouring project's official plan is never replaced by another's boundary
                continue
            if r.get('kind') != 'apartment' and inside((r['lng'], r['lat']), bnd):
                continue  # replaced by the plan
            if r.get('project') == pid:
                # tagged with this project by distance to its pin, but outside its official plan: a home of
                # a neighbouring cluster - kept where it is, project unknown
                r = dict(r, project=None, projectNote=f'outside the {pid} site plan')
                untagged += 1
            kept_rows.append(r)
        rows = kept_rows
        removed = before - len(rows)
        for r in sp['rows']:
            rows.append(dict(r))
        hd['communities'][cid] = rows
        # streets
        KX = 111320.0 * math.cos(math.radians(bnd[0][1]))
        streets = site['communities'][cid]['streets']
        kept, dropped_derived, replaced = [], 0, 0
        for s in streets:
            if s.get('source') == 'siteplan' and s.get('project') == pid:
                continue  # re-applied below
            ins = [inside(p, bnd) for p in s['pts']]
            share = sum(ins) / len(ins)
            if s.get('source') == 'derived' and share > 0:
                dropped_derived += 1
                continue
            if s['cls'] != 'path' and s.get('source') != 'derived' and share >= 0.6 and not sp.get('keep_mapped_streets'):
                replaced += 1
                continue
            kept.append(s)
        # plan roads, joined to the street network they end near
        segs = []
        for s in kept:
            if s['cls'] == 'path':
                continue
            p = [(lo * KX, la * KY) for lo, la in s['pts']]
            segs += [(p[i][0], p[i][1], p[i + 1][0], p[i + 1][1]) for i in range(len(p) - 1)]
        plan_ends = []
        for rd in sp['roads']:
            p = [(lo * KX, la * KY) for lo, la in rd['pts']]
            plan_ends += [p[0], p[-1]]
        joined = 0
        new = []
        for rd in sp['roads']:
            pts = [list(q) for q in rd['pts']]
            for end in (0, -1):
                ex, ey = pts[end][0] * KX, pts[end][1] * KY
                # an end that is not a junction with another plan road
                if sum(1 for q in plan_ends if math.hypot(q[0] - ex, q[1] - ey) < 1.0) > 1:
                    continue
                best = None
                for sg in segs:
                    d, qx, qy = seg_near(ex, ey, *sg)
                    if best is None or d < best[0]:
                        best = (d, qx, qy)
                if best and 0.5 < best[0] <= 15:
                    q = [round(best[1] / KX, 7), round(best[2] / KY, 7)]
                    if end == 0:
                        pts.insert(0, q)
                    else:
                        pts.append(q)
                    joined += 1
            new.append({'cls': 'minor', 'width': CARRIAGEWAY, 'pts': pts, 'source': 'siteplan', 'project': pid,
                        'verified': f"{sp['source']['document']} p.{sp['source']['page']}"})
        # entrance streets from outside: an end within 4 m of a plan road runs on to it
        psegs = []
        for rd in new:
            q = [(lo * KX, la * KY) for lo, la in rd['pts']]
            psegs += [(q[i][0], q[i][1], q[i + 1][0], q[i + 1][1]) for i in range(len(q) - 1)]
        entr = 0
        for s in kept:
            if s['cls'] == 'path':
                continue
            for end in (0, -1):
                ex, ey = s['pts'][end][0] * KX, s['pts'][end][1] * KY
                best = min((seg_near(ex, ey, *sg) for sg in psegs), default=None)
                if best and 0.05 < best[0] <= 4:
                    q = [round(best[1] / KX, 7), round(best[2] / KY, 7)]
                    if end == 0:
                        s['pts'].insert(0, q)
                    else:
                        s['pts'].append(q)
                    entr += 1
        joined += entr
        site['communities'][cid]['streets'] = kept + new
        print(f"{cid}/{pid}: rows {removed} detected inside the plan -> {len(sp['rows'])} from the site plan; {untagged} rows outside it untagged (kept) ({sum(r['units'] for r in sp['rows'])} homes); "
              f"streets: {replaced} mapped replaced by {len(new)} plan centre lines ({joined} ends joined), {dropped_derived} derived removed")
    # provenance labels and counts
    prov = {}
    for cid, rows in hd['communities'].items():
        c = {}
        for r in rows:
            if r.get('source') != 'siteplan':
                r['placement'] = 'estimated-planned' if r.get('source') == 'planned' else 'estimated-satellite'
            c[r['placement']] = c.get(r['placement'], 0) + (r.get('units') or 1)
        st = {}
        for s in site['communities'][cid]['streets']:
            k = s.get('source') or 'osm'
            st[k] = st.get(k, 0) + 1
        prov[cid] = {'homes_by_placement': c, 'streets_by_source': st}
    json.dump(prov, open(os.path.join(APP, 'data', 'placement_provenance.json'), 'w'), indent=1)
    json.dump(hd, open(os.path.join(APP, 'data', 'homes_detected.json'), 'w'), separators=(',', ':'))
    json.dump(site, open(os.path.join(APP, 'data', 'site.json'), 'w'))
    print(json.dumps(prov))


if __name__ == '__main__':
    main()

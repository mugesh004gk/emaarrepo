#!/usr/bin/env python3
"""Check that the unit numbers of every placed row run the same way in 3D as on the cluster map.

  python scripts/siteplan/clustermap/check_order.py <project>

In the app (js/valley-detail.js) unit i of a row sits at plan x increasing toward bearing frontBearing - 90
(unit 0 = left end seen from the street). On the map the row runs from unitNumbers[0] to unitNumbers[-1];
with the map-up bearing that is a ground bearing too. The two must agree (angle < 90 deg).
"""
import json, math, os, sys

APP = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))


def main(proj):
    sp = json.load(open(os.path.join(APP, 'data', 'siteplans', f'{proj}.json')))
    lp = os.path.join(APP, 'data', 'siteplans', proj, 'layout.json')
    lay = json.load(open(lp)) if os.path.exists(lp) and json.load(open(lp)).get('kind') == 'terrace' else {'units': {}}
    U = lay['units']
    if not U:  # villas / twins: positions of the numbers from blocks.json (read or inferred)
        U = {}
        for b in json.load(open(os.path.join(APP, 'data', 'siteplans', proj, 'blocks.json')))['blocks']:
            ns = b['units']; c, ax = b['c'], b['axis']
            for j, n in enumerate(ns):
                if n is not None:
                    t = (j - (len(ns) - 1) / 2) * b['L'] / max(1, len(ns))
                    U[str(n)] = {'p': [c[0] + ax[0] * t, c[1] + ax[1] * t]}
    up = sp['georeference']['map_up_bearing_deg']
    ok = bad = 0; badrows = []
    for r in sp['rows']:
        nums = r['unitNumbers']
        if len(nums) < 2 or None in nums:
            continue
        a, b = U[str(nums[0])]['p'], U[str(nums[-1])]['p']
        dx, dy = b[0] - a[0], b[1] - a[1]
        map_b = (up + math.degrees(math.atan2(dx, -dy))) % 360
        model_b = (r['frontBearing'] - 90) % 360
        diff = abs((map_b - model_b + 180) % 360 - 180)
        if diff < 90:
            ok += 1
        else:
            bad += 1; badrows.append(nums[0])
    print(f'{proj}: rows numbered the same way as the map {ok}, mirrored {bad}' + (f' (rows starting {badrows[:12]})' if bad else ''))
    return bad


if __name__ == '__main__':
    sys.exit(1 if main(sys.argv[1]) else 0)

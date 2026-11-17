#!/usr/bin/env python3
"""Keep only detected homes inside their community compound (data/compounds.json).
   python3 scripts/clip_compounds.py"""
import json, os
APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
def inpoly(x, y, poly):
    ins, j = False, len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]; xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            ins = not ins
        j = i
    return ins
comp = json.load(open(os.path.join(APP, 'data', 'compounds.json')))
path = os.path.join(APP, 'data', 'homes_detected.json')
hd = json.load(open(path))
for cid, rows in hd['communities'].items():
    rings = comp.get(cid)
    if not rings:
        continue
    keep = [r for r in rows if any(inpoly(r['lng'], r['lat'], ring) for ring in rings)]
    print(f'{cid}: kept {len(keep)} of {len(rows)} rows ({sum(r["units"] for r in keep)} homes); removed {len(rows) - len(keep)} outside the compound')
    hd['communities'][cid] = keep
json.dump(hd, open(path, 'w'), separators=(',', ':'))

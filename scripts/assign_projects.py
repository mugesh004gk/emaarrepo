#!/usr/bin/env python3
"""Assign every detected home to a project, and mark which projects are built.

Emaar's map pins do not sit on their own homes (median ~300 m away) and new launches have pins on
open land, so "nearest pin" handed built homes to unbuilt launches. Now:
  1. A project is built only when at least 12 homes stand within 120 m of its pin.
  2. Homes are assigned to the nearest built project's pin, of the same home type when known
     (townhouse / villa, from the developer PDFs, see run_v2.PROJECT_KIND), within 900 m.
  3. Homes further than 900 m from any built pin keep project=None (community only).
Writes data/project_status.json {projectId: {built, homes, homesNearPin, centroid:[lat,lng]}}.
  python3 scripts/assign_projects.py"""
import json, math, os, sys

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(APP, 'scripts', 'satellite'))
try:
    from run_v2 import PROJECT_KIND
except Exception:
    PROJECT_KIND = {}


def dist(a_lat, a_lng, b_lat, b_lng):
    return math.hypot((a_lat - b_lat) * 110574, (a_lng - b_lng) * 101000)


def main():
    pj = json.load(open(os.path.join(APP, 'data', 'projects.json')))
    path = os.path.join(APP, 'data', 'homes_detected.json')
    hd = json.load(open(path))
    status = {}
    for c in pj['communities']:
        rows = hd['communities'].get(c['id'], [])
        kinds = PROJECT_KIND.get(c['id'], {})
        pins = [p for p in c['projects'] if not p.get('pinFlag') and p['id'] != 'nara']
        built = []
        for p in pins:
            near = sum(r['units'] for r in rows if dist(r['lat'], r['lng'], p['lat'], p['lng']) < 120)
            status[p['id']] = {'built': near >= 12, 'homesNearPin': near}
            if near >= 12:
                built.append(p)
        for r in rows:
            cand = [p for p in built if kinds.get(p['id'], r.get('kind')) == r.get('kind')] or built
            best = min(cand, key=lambda p: dist(r['lat'], r['lng'], p['lat'], p['lng']), default=None)
            r['project'] = best['id'] if best and dist(r['lat'], r['lng'], best['lat'], best['lng']) <= 900 else None
        for p in c['projects']:
            mine = [r for r in rows if r['project'] == p['id']]
            st = status.setdefault(p['id'], {'built': p['id'] == 'nara', 'homesNearPin': 0})
            st['homes'] = 372 if p['id'] == 'nara' else sum(r['units'] for r in mine)
            if mine:
                w = sum(r['units'] for r in mine)
                st['centroid'] = [round(sum(r['lat'] * r['units'] for r in mine) / w, 6), round(sum(r['lng'] * r['units'] for r in mine) / w, 6)]
        print(c['name'], '| built:', [p['name'] for p in pins if status[p['id']]['built']], '| not built:', [p['name'] for p in pins if not status[p['id']]['built']])
    json.dump(hd, open(path, 'w'), separators=(',', ':'))
    json.dump(status, open(os.path.join(APP, 'data', 'project_status.json'), 'w'), indent=0)


if __name__ == '__main__':
    main()

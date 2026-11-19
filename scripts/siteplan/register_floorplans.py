#!/usr/bin/env python3
"""Attach floor-plan PDFs received later (client agent packs, broker copies) to their projects in data/projects.json.

  python3 scripts/siteplan/register_floorplans.py      (then extract_floorplans.py, render_docs.py)

Each entry replaces the project's floor-plan list. Sources are recorded in
emaarcommunity/research/the-valley/AGENT_PACK_RECEIVED.md and TANAMI_SOURCES.md.
"""
import json, os, subprocess

APP = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
P = 'media/research/the-valley/properties'
FLOORPLANS = {
    # client agent pack: the correct Kaia sheets (Ava / Vina / Luna); the earlier KAIA_floorplan.pdf held the Elea sheets
    'kaia-at-the-valley': f'{P}/kaia-at-the-valley/floorplans/KAIA_TV_FLOORPLAN.pdf',
    # broker copies (tanamiproperties.com) of the Emaar floor plans
    'alana': f'{P}/alana/floorplans/ALANA_floorplan_tanami.pdf',
    'farm-gardens-2': f'{P}/farm-gardens-2/floorplans/FARM-GARDENS-2_floorplan_tanami.pdf',
    'rivana': f'{P}/rivana/floorplans/RIVANA_floorplan_tanami.pdf',
    'avena-2-at-the-valley': f'{P}/avena-2-at-the-valley/floorplans/AVENA-2_floorplan_tanami.pdf',
    # client agent packs (19 Nov 2026)
    'lillia': f'{P}/lillia/floorplans/LILLIA_TV_FLOOR_PLANS.pdf',
    'venera-at-the-valley': f'{P}/venera-at-the-valley/floorplans/VENERA_THE_VALLEY_FLOORPLAN.pdf',
    'talia': f'{P}/talia/floorplans/TV_TALIA_FLOOR_PLANS.pdf',
}


def main():
    path = os.path.join(APP, 'data', 'projects.json')
    d = json.load(open(path))
    for c in d['communities']:
        for p in c['projects']:
            src = FLOORPLANS.get(p['id'])
            if not src:
                continue
            real = os.path.realpath(os.path.join(APP, src))
            pages = int(next(l.split()[-1] for l in subprocess.run(['pdfinfo', real], capture_output=True, text=True).stdout.splitlines() if l.startswith('Pages')))
            p['floorplans'] = [{'src': src, 'pages': pages, 'mb': round(os.path.getsize(real) / 1e6, 1)}]
            print(p['id'], p['floorplans'])
    json.dump(d, open(path, 'w'), ensure_ascii=False, separators=(',', ':'))


if __name__ == '__main__':
    main()

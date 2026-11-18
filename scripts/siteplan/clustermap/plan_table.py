#!/usr/bin/env python3
"""Floor-plan table of a terrace project, read from Emaar's floor-plan PDF.

  python scripts/siteplan/clustermap/plan_table.py <project> <floorplan.pdf> <design>=<first>-<last> [...]
  e.g. orania-at-the-valley ORANIA_floorplan.pdf Bold=2-9 Sleek=10-17

Every page is one plan: '<beds> BEDROOM I <letter>' (MIRRORED for the mirrored variant) and the terrace
positions it applies to with their area, '<n> PLEX - TH <k> <sqft> SQ FT <sqm> SQ M'. The design of a page
is given on the command line (the design name on the sheet is drawn as interleaved letters).
Output: data/siteplans/<project>/plans.json
  {design: {"<plex>-<th>": {beds, plan, mirrored, page, sqft, sqm}}, "_pages": {page: {...}}}
"""
import json, os, re, subprocess, sys

APP = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
POS = re.compile(r'(\d+)\s*PLEX\s*(\d)?\s*-\s*TH\s*(\d+)\s+([\d.]+)\s*S\s*Q\s*F\s*T\s*([\d.]+)\s*S\s*Q\s*M')


def page_text(pdf, page):
    out = []
    for mode in ('-raw', '-layout', None):
        args = ['pdftotext', '-q', '-f', str(page), '-l', str(page)] + ([mode] if mode else []) + [pdf, '-']
        out.append(re.sub(r'\s+', ' ', subprocess.run(args, capture_output=True, text=True).stdout))
    return out


def main():
    proj, pdf = sys.argv[1], sys.argv[2]
    designs = {}
    for a in sys.argv[3:]:
        name, rng = a.split('=')
        lo, hi = map(int, rng.split('-'))
        for pg in range(lo, hi + 1):
            designs[pg] = name
    table, pages = {}, {}
    for pg, design in sorted(designs.items()):
        texts = page_text(pdf, pg)
        m = None
        for t in texts:
            m = re.search(r'([3-6])\s*BEDROOM\s*I?\s*([A-F])\b', t)
            if m:
                break
        if not m:
            print(f'  page {pg}: no plan title found'); continue
        beds, letter = int(m.group(1)), m.group(2)
        mirrored = any('MIRRORED' in t for t in texts)
        pos = {}
        for t in texts:  # union of the readings: one text mode can drop a line another keeps
            for x in POS.finditer(t):
                plex = x.group(1) + (f'.{x.group(2)}' if x.group(2) else '')
                pos.setdefault(f'{plex}-{int(x.group(3))}', (float(x.group(4)), float(x.group(5))))
        pages[pg] = {'design': design, 'beds': beds, 'plan': letter, 'mirrored': mirrored, 'positions': sorted(pos)}
        for k, (sqft, sqm) in pos.items():
            if k in table.get(design, {}):
                print(f'  {design} {k}: listed on page {table[design][k]["page"]} and {pg}; first kept')
                continue
            table.setdefault(design, {})[k] = {'beds': beds, 'plan': letter, 'mirrored': mirrored, 'page': pg, 'sqft': sqft, 'sqm': sqm}
        print(f'  page {pg}: {design} {beds} BR {letter}{" (mirrored)" if mirrored else ""}: {", ".join(sorted(pos)) or "no positions"}')
    out = dict(table); out['_pages'] = pages; out['_source'] = {'document': os.path.basename(pdf)}
    d = os.path.join(APP, 'data', 'siteplans', proj); os.makedirs(d, exist_ok=True)
    json.dump(out, open(os.path.join(d, 'plans.json'), 'w'), indent=1)
    for design, t in table.items():
        plexes = sorted({k.split('-')[0] for k in t}, key=float)
        for p in plexes:
            n = int(float(p))
            have = [int(k.split('-')[1]) for k in t if k.split('-')[0] == p]
            gaps = [k for k in range(1, n + 1) if k not in have]
            print(f'{design} {p}-plex: TH {sorted(have)}' + (f'  NOT LISTED: {gaps}' if gaps else '  (complete)'))


if __name__ == '__main__':
    main()

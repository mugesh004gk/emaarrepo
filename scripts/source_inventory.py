#!/usr/bin/env python3
"""Source-document inventory per property of a community: what we hold and whether it is usable.

  python3 scripts/source_inventory.py arabian-ranches-3 emaar-south   -> data/source_inventory.json (+ table)

Per property (media/research/<community>/properties/<pid>/):
  docs           every PDF / image with its folder (brochures, clustermap, floorplans, factsheet, masterplan, ...)
  cluster map    a page that is a unit map: from clustermap/ files, else brochure pages whose text holds many
                 distinct 1-3 digit numbers (unit labels). numbered_text = distinct numbers in the best page's text
                 layer (machine-readable unit numbers), max_label = highest of them
  floor plans    pages, and how many carry a printed area in their text layer (SQ FT / SQFT)
  fact sheet     total units if printed
  app            current homes in the app and how they are placed (homes_detected.json)
"""
import json, os, re, subprocess, sys
from collections import Counter

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
R = os.path.join(APP, 'media', 'research')


def text(pdf, page=None):
    a = ['pdftotext', '-q', '-layout'] + (['-f', str(page), '-l', str(page)] if page else []) + [pdf, '-']
    return subprocess.run(a, capture_output=True, text=True).stdout


def pages(pdf):
    m = re.search(r'Pages:\s+(\d+)', subprocess.run(['pdfinfo', pdf], capture_output=True, text=True).stdout)
    return int(m.group(1)) if m else 0


def numbers(t):
    return {int(x) for x in re.findall(r'(?<![\d.,])(\d{1,3})(?![\d.,%])', t) if 0 < int(x) <= 999}


def best_map_page(pdf):
    """the page whose text holds the longest near-complete run 1..N of numbers (unit labels)"""
    best = (0, None, 0)
    for p in range(1, pages(pdf) + 1):
        ns = numbers(text(pdf, p))
        if len(ns) < 20:
            continue
        n = 0
        while (n + 1) in ns or (n + 2) in ns:
            n += 1
        run = len([x for x in ns if x <= n])
        if run > best[0]:
            best = (run, p, n)
    return best  # (distinct labels found within 1..max, page, max)


def main():
    hd = json.load(open(os.path.join(APP, 'data', 'homes_detected.json')))['communities']
    uc = json.load(open(os.path.join(APP, 'data', 'unit_counts.json')))['projects']
    pj = json.load(open(os.path.join(APP, 'data', 'projects.json')))
    names = {p['id']: p['name'] for c in pj['communities'] for p in c['projects']}
    out = {}
    for cid in sys.argv[1:]:
        base = os.path.join(R, cid, 'properties')
        rows = {}
        for pid in sorted(os.listdir(base)):
            d = os.path.join(base, pid)
            if not os.path.isdir(d):
                continue
            docs = []
            for root, _, fs in os.walk(d):
                for f in fs:
                    if f.lower().endswith(('.pdf', '.png', '.jpg', '.jpeg', '.webp')) and '/images' not in root:
                        docs.append(os.path.relpath(os.path.join(root, f), d))
            pdfs = [x for x in docs if x.lower().endswith('.pdf')]
            # cluster map: dedicated files first, then brochures
            cm = None
            for x in sorted(pdfs, key=lambda x: (not x.startswith('clustermap'), not x.startswith('brochures'))):
                if x.startswith(('clustermap', 'brochures', 'masterplan')):
                    run, pg, mx = best_map_page(os.path.join(d, x))
                    if pg and (cm is None or run > cm['numbered_text']):
                        cm = {'file': x, 'page': pg, 'numbered_text': run, 'max_label': mx}
            cm_images = [x for x in docs if x.startswith('clustermap') and not x.lower().endswith('.pdf')]
            fp = None
            for x in pdfs:
                if x.startswith('floorplans'):
                    n = pages(os.path.join(d, x))
                    with_area = sum(1 for p in range(1, n + 1) if re.search(r'SQ\.?\s*FT|SQFT|sq\.?\s*ft', text(os.path.join(d, x), p)))
                    if fp is None or with_area > fp['pages_with_area']:
                        fp = {'file': x, 'pages': n, 'pages_with_area': with_area}
            fact_total = None
            for x in pdfs:
                if x.startswith('factsheet'):
                    t = text(os.path.join(d, x))
                    m = re.search(r'Total(?: Units)?:?\s*(\d{2,4})|(\d{2,4})\s+total units|Total\s+(\d{2,4})', t, re.I)
                    if m:
                        fact_total = int(next(g for g in m.groups() if g))
            app_rows = [r for r in hd.get(cid, []) if r.get('project') == pid]
            rows[pid] = {
                'name': names.get(pid, pid), 'docs': sorted(docs),
                'cluster_map': cm, 'cluster_map_images': cm_images, 'floor_plans': fp,
                'fact_sheet_total': fact_total, 'official_total': (uc.get(pid) or {}).get('total'),
                'app': {'homes': sum(r['units'] for r in app_rows), 'placement': dict(Counter(r.get('placement') for r in app_rows))},
            }
        out[cid] = rows
        print(f'== {cid}')
        print(f"{'property':34s} {'map: labels/max (file p.)':44s} {'floor plans':14s} {'fact':5s} {'offic':5s} app")
        for pid, r in rows.items():
            cm = r['cluster_map']
            cms = f"{cm['numbered_text']}/{cm['max_label']} ({cm['file'][-30:]} p{cm['page']})" if cm else ('image only: ' + ','.join(r['cluster_map_images'])[:30] if r['cluster_map_images'] else '-')
            fpl = f"{r['floor_plans']['pages_with_area']}/{r['floor_plans']['pages']} pg" if r['floor_plans'] else '-'
            print(f"{pid[:34]:34s} {cms[:44]:44s} {fpl:14s} {str(r['fact_sheet_total'] or '-'):5s} {str(r['official_total'] or '-'):5s} {r['app']['homes']} {r['app']['placement']}")
    json.dump(out, open(os.path.join(APP, 'data', 'source_inventory.json'), 'w'), indent=1)


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Render every brochure / floor-plan PDF used by the app into page images, so the documents open on
any host (emaar.com refuses to be shown inside other sites, and the PDFs total 1.5 GB).
 - output: media/docs/<pdf path under media/research, without .pdf>/<n>.jpg  (n = 1..pages)
 - floor plans: 1600 px, JPEG q76; brochures: 1400 px, JPEG q68
 - writes data/doc_pages.json: { "<pdf src as used in the data>": {"dir": ..., "pages": n} }
 - skips PDFs already rendered (same page count), runs one pdftoppm per CPU.
  python3 scripts/render_docs.py"""
import json, os, re, subprocess, sys
from concurrent.futures import ThreadPoolExecutor

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(APP, 'media', 'docs')


def pdf_srcs():
    s = set()
    def c(o):
        if isinstance(o, dict):
            for v in o.values(): c(v)
        elif isinstance(o, list):
            for v in o: c(v)
        elif isinstance(o, str) and o.startswith('media/research/') and o.lower().endswith('.pdf'):
            s.add(o)
    for f in ['projects.json', 'floorplans.json']:
        c(json.load(open(os.path.join(APP, 'data', f))))
    return sorted(s)


def pages_of(path):
    out = subprocess.run(['pdfinfo', path], capture_output=True, text=True).stdout
    m = re.search(r'^Pages:\s+(\d+)', out, re.M)
    return int(m.group(1)) if m else 0


def render(src):
    pdf = os.path.realpath(os.path.join(APP, src))
    if not os.path.exists(pdf):
        return src, None
    rel = src[len('media/research/'):-4]
    d = os.path.join(OUT, rel)
    n = pages_of(pdf)
    if n and os.path.isdir(d) and len([f for f in os.listdir(d) if f.endswith('.jpg')]) == n:
        return src, {'dir': 'media/docs/' + rel, 'pages': n}
    os.makedirs(d, exist_ok=True)
    for f in os.listdir(d):
        os.remove(os.path.join(d, f))
    plan = '/floorplans/' in src or 'floorplan' in src.lower()
    size, q = (1600, 76) if plan else (1400, 68)
    subprocess.run(['pdftoppm', '-jpeg', '-jpegopt', f'quality={q},optimize=y', '-scale-to', str(size), pdf, os.path.join(d, 'p')],
                   capture_output=True)
    files = sorted(f for f in os.listdir(d) if f.startswith('p-') and f.endswith('.jpg'))
    for f in files:  # p-01.jpg / p-001.jpg -> 1.jpg
        os.rename(os.path.join(d, f), os.path.join(d, f'{int(f[2:-4])}.jpg'))
    return src, {'dir': 'media/docs/' + rel, 'pages': len(files)}


def main():
    srcs = pdf_srcs()
    res = {}
    with ThreadPoolExecutor(max_workers=os.cpu_count() or 4) as ex:
        for i, (src, info) in enumerate(ex.map(render, srcs), 1):
            if info and info['pages']:
                res[src] = info
            else:
                print('FAILED', src, file=sys.stderr)
            if i % 10 == 0:
                print(f'{i}/{len(srcs)}', flush=True)
    json.dump(res, open(os.path.join(APP, 'data', 'doc_pages.json'), 'w'), indent=0)
    print(f'{len(res)}/{len(srcs)} documents, {sum(v["pages"] for v in res.values())} pages')


if __name__ == '__main__':
    main()

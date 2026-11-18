#!/usr/bin/env python3
"""Read every unit number on a brochure cluster map, with its position.

  python scripts/siteplan/clustermap/extract_units.py <project> <brochure.pdf> <page> [--image N]

 - numbers stored as PDF text (Rivana, The Farm Gardens): exact, from `pdftotext -bbox`;
 - numbers drawn in the map picture: the embedded map image is upscaled 3x and read in overlapping
   tiles with macOS Vision text recognition (ocr.swift, compiled to ./ocr next to this file).
Then the sequence is cleaned: a number read in two places keeps the one that sits next to its
neighbours (n-1, n+1); a number that sits far from both neighbours is dropped.
Output: data/siteplans/<project>/units_raw.json  {frame, size, units: {no: [x, y]}, missing, count}
"""
import json, os, re, subprocess, sys, tempfile, html
import numpy as np

APP = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
HERE = os.path.dirname(os.path.abspath(__file__))


def from_text(pdf, page):
    out = subprocess.run(['pdftotext', '-q', '-bbox', '-f', str(page), '-l', str(page), pdf, '-'], capture_output=True, text=True).stdout
    hits = []
    for m in re.finditer(r'<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)</word>', out):
        t = html.unescape(m.group(5)).strip()
        if re.fullmatch(r'\d{1,3}', t):
            x0, y0, x1, y1 = map(float, m.group(1, 2, 3, 4))
            hits.append((int(t), (x0 + x1) / 2, (y0 + y1) / 2))
    pm = re.search(r'<page width="([\d.]+)" height="([\d.]+)"', out)
    return hits, ('pdf-points', [float(pm.group(1)), float(pm.group(2))])


def ocr_tile(td, tile, k):
    p = os.path.join(td, f't{k}.png'); tile.save(p)
    res = subprocess.run([os.path.join(HERE, 'ocr'), p], capture_output=True, text=True).stdout
    out = []
    for line in res.splitlines():
        parts = line.split('\t')
        if len(parts) < 5:
            continue
        txt = parts[0]; bx, by, bw, bh = map(float, parts[1:5])
        toks = re.findall(r'\d{1,3}', txt.replace('O', '0').replace('o', '0'))
        for i, t in enumerate(toks):  # a run of numbers read as one line: split it evenly along the box
            out.append((int(t), bx + bw * (i + 0.5) / len(toks), by + bh / 2))
    return out


def from_image(pdf, page, index, passes=((400, (0, 90, -90)), (600, (0,)), (500, (30, -30, 60, -60)))):
    """render the whole page (picture + vector labels) and read it in tiles, at several resolutions and
    rotations (labels along rows are often turned); every hit is mapped back to page points"""
    from PIL import Image
    import math
    from concurrent.futures import ThreadPoolExecutor
    Image.MAX_IMAGE_PIXELS = None
    td = tempfile.mkdtemp()
    hits = []
    jobs = []
    for dpi, angles in passes:
        subprocess.run(['pdftoppm', '-q', '-r', str(dpi), '-png', '-f', str(page), '-l', str(page), pdf, os.path.join(td, f'p{dpi}')], check=True)
        f = [x for x in os.listdir(td) if x.startswith(f'p{dpi}') and x.endswith('.png')][0]
        im = Image.open(os.path.join(td, f)).convert('RGB')
        W, H = im.size
        T, O = 1000, 180
        for y in range(0, H, T - O):
            for x in range(0, W, T - O):
                tile = im.crop((x, y, min(x + T, W), min(y + T, H)))
                for ang in angles:
                    jobs.append((dpi, x, y, tile, ang))
    def run(j):
        k, (dpi, x, y, tile, ang) = j
        w, h = tile.size
        img = tile.rotate(ang, expand=True, resample=Image.BICUBIC, fillcolor=(255, 255, 255)) if ang else tile
        res = ocr_tile(td, img, k)
        out = []
        cw, ch = img.size
        a = math.radians(ang)
        for n, px, py in res:
            # back from the rotated image to the tile (PIL rotates counter-clockwise about the centre)
            dx, dy = px - cw / 2, py - ch / 2
            tx = w / 2 + dx * math.cos(a) - dy * math.sin(a)
            ty = h / 2 + dx * math.sin(a) + dy * math.cos(a)
            out.append((n, (x + tx) * 72 / dpi, (y + ty) * 72 / dpi))
        return out
    with ThreadPoolExecutor(6) as ex:
        for r in ex.map(run, enumerate(jobs)):
            hits += r
    return hits, ('pdf-points', [W * 72 / dpi, H * 72 / dpi])


def from_embedded(pdf, page):
    """the embedded map picture, upscaled 3x and read in tiles; positions mapped to page points by
    finding the picture on a 72 dpi render of the page (scale from its placement resolution)"""
    from PIL import Image
    import cv2
    td = tempfile.mkdtemp()
    lst = subprocess.run(['pdfimages', '-list', '-f', str(page), '-l', str(page), pdf], capture_output=True, text=True).stdout.splitlines()[2:]
    rows = [l.split() for l in lst if l.split() and l.split()[2] == 'image']
    if not rows:
        return []
    big = max(rows, key=lambda r: int(r[3]) * int(r[4]))
    num, ppi = int(big[1]), float(big[12])
    subprocess.run(['pdfimages', '-png', '-f', str(page), '-l', str(page), pdf, os.path.join(td, 'e')], check=True)
    f = sorted(x for x in os.listdir(td) if x.startswith('e-'))[num]
    im = Image.open(os.path.join(td, f)).convert('RGB')
    subprocess.run(['pdftoppm', '-q', '-r', '72', '-png', '-f', str(page), '-l', str(page), pdf, os.path.join(td, 'pg')], check=True)
    pg = cv2.imread(os.path.join(td, [x for x in os.listdir(td) if x.startswith('pg')][0]), 0)
    sc = 72.0 / ppi  # points per image pixel
    small = cv2.resize(cv2.cvtColor(np.array(im), cv2.COLOR_RGB2GRAY), (max(1, int(im.width * sc)), max(1, int(im.height * sc))))
    if small.shape[0] > pg.shape[0] or small.shape[1] > pg.shape[1]:
        return []
    r = cv2.matchTemplate(pg, small, cv2.TM_CCOEFF_NORMED); _, v, _, loc = cv2.minMaxLoc(r)
    if v < 0.5:
        return []
    W, H = im.size; S, T, O = 3, 420, 80
    hits = []; k = 0
    for y in range(0, H, T - O):
        for x in range(0, W, T - O):
            tile = im.crop((x, y, min(x + T, W), min(y + T, H)))
            tile = tile.resize((tile.width * S, tile.height * S), Image.LANCZOS)
            for n, px, py in ocr_tile(td, tile, k):
                hits.append((n, loc[0] + (x + px / S) * sc, loc[1] + (y + py / S) * sc))
            k += 1
    return hits


def clean(hits):
    cand = {}
    for n, x, y in hits:
        if n <= 0:
            continue
        lst = cand.setdefault(n, [])
        for c in lst:
            if np.hypot(c[0] - x, c[1] - y) < 3:
                c[2].append((x, y)); break
        else:
            lst.append([x, y, [(x, y)]])
    pos = {n: [np.mean(c[2], 0) for c in lst] for n, lst in cand.items()}
    # typical spacing between consecutive numbers
    d = []
    for n, ps in pos.items():
        if n + 1 in pos:
            d.append(min(np.hypot(*(a - b)) for a in ps for b in pos[n + 1]))
    pitch = float(np.median(d)) if d else 20.0
    chosen = {}
    for n, ps in pos.items():
        if len(ps) == 1:
            chosen[n] = ps[0]; continue
        def score(p):
            s = [np.hypot(*(p - q)) for k in (n - 1, n + 1, n - 2, n + 2) for q in pos.get(k, [])]
            return min(s) if s else 1e9
        chosen[n] = min(ps, key=score)
    # drop numbers far from every neighbour in the sequence (stray digits: scale bars, amenity letters)
    keep = {}
    for n, p in chosen.items():
        near = [np.hypot(*(p - chosen[k])) for k in (n - 2, n - 1, n + 1, n + 2) if k in chosen]
        if near and min(near) <= 4 * pitch:
            keep[n] = p
    return keep, pitch


def main():
    proj, pdf, page = sys.argv[1], sys.argv[2], int(sys.argv[3])
    index = int(sys.argv[sys.argv.index('--image') + 1]) if '--image' in sys.argv else None
    hits, frame = from_text(pdf, page)
    if len([h for h in hits if h[0] > 0]) < 20:
        hits, frame = from_image(pdf, page, index)
        hits += from_embedded(pdf, page)
    units, pitch = clean(hits)
    top = max(units) if units else 0
    # the total: the highest number that is part of the sequence
    missing = [k for k in range(1, top + 1) if k not in units]
    out = {'project': proj, 'source': {'document': os.path.basename(pdf), 'page': page}, 'frame': frame[0], 'size': frame[1],
           'image_index': frame[2] if len(frame) > 2 else None, 'pitch': pitch, 'count': top, 'read': len(units),
           'missing': missing, 'units': {str(k): [round(float(v[0]), 1), round(float(v[1]), 1)] for k, v in sorted(units.items())}}
    d = os.path.join(APP, 'data', 'siteplans', proj); os.makedirs(d, exist_ok=True)
    json.dump(out, open(os.path.join(d, 'units_raw.json'), 'w'))
    print(f"{proj}: numbers 1-{top}; read {len(units)}; missing {len(missing)} {missing[:30]}{'...' if len(missing) > 30 else ''}")


if __name__ == '__main__':
    main()

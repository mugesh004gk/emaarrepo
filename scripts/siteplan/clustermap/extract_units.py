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
    words = []
    for m in re.finditer(r'<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)</word>', out):
        t = html.unescape(m.group(5)).strip()
        if re.fullmatch(r'\d{1,3}', t):
            words.append([t, *map(float, m.group(1, 2, 3, 4))])
    # a number set with wide letter spacing comes out in pieces ('18' '1'): pieces on one line with
    # (almost) no gap between them are one number
    # (rows of a map are often slanted: the pieces of one number differ a little in height)
    words.sort(key=lambda w: w[1])
    used = set()
    merged = []
    for i, p in enumerate(words):
        if i in used:
            continue
        p = list(p)
        while True:
            h = p[4] - p[2]
            j = next((j for j, w in enumerate(words) if j not in used and j != i and abs(w[2] - p[2]) < 0.3 * h
                      and -0.1 * h <= w[1] - p[3] < 0.35 * h and len(p[0] + w[0]) <= 3), None)
            if j is None:
                break
            used.add(j); p[0] += words[j][0]; p[3] = words[j][3]; p[4] = max(p[4], words[j][4])
        used.add(i)
        merged.append(p)
    hits = [(int(t), (x0 + x1) / 2, (y0 + y1) / 2) for t, x0, y0, x1, y1 in merged]
    pm = re.search(r'<page width="([\d.]+)" height="([\d.]+)"', out)
    return hits, ('pdf-points', [float(pm.group(1)), float(pm.group(2))])


def ocr_tile(td, tile, k, single_only=False):
    p = os.path.join(td, f't{k}.png'); tile.save(p)
    res = subprocess.run([os.path.join(HERE, 'ocr'), p], capture_output=True, text=True).stdout
    out = []
    for line in res.splitlines():
        parts = line.split('\t')
        if len(parts) < 5:
            continue
        txt = parts[0]; bx, by, bw, bh = map(float, parts[1:5])
        toks = re.findall(r'\d{1,3}', txt.replace('O', '0').replace('o', '0'))
        if os.environ.get('LABEL_DIGITS'):  # maps that print every label zero-padded ('004'): a shorter token is a fragment
            nd = int(os.environ['LABEL_DIGITS'])
            toks = [t for t in re.findall(r'\d+', txt.replace('O', '0').replace('o', '0')) if len(t) == nd]
        if single_only and len(toks) > 1:
            continue  # a line of several numbers read on a turned copy: spreading them along its box misplaces them
        for i, t in enumerate(toks):  # a run of numbers read as one line: split it evenly along the box
            if len(toks) > 1 and bh > 1.5 * bw:  # a stack of labels, one above another
                out.append((int(t), bx + bw / 2, by + bh * (i + 0.5) / len(toks)))
            else:
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
        res = ocr_tile(td, img, k, single_only=os.environ.get('ANGLED_SINGLE') is not None and ang % 90 != 0)
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


def from_raster(png, scales=(3,), angles=(0,), tile=(300, 200), step=(200, 120)):
    """a map given as an image (not a PDF): small overlapping tiles, each enlarged (Lanczos) and read;
    positions in image pixels (= page points of the one-page PDF made from the image at 72 dpi)"""
    from PIL import Image
    import math
    from concurrent.futures import ThreadPoolExecutor
    td = tempfile.mkdtemp()
    im = Image.open(png).convert('RGB')
    W, H = im.size
    jobs = []
    for s in scales:
        for y in range(0, H, step[1]):
            for x in range(0, W, step[0]):
                for a in angles:
                    jobs.append((s, x, y, a))

    def run(j):
        k, (s, x, y, a) = j
        t = im.crop((x, y, min(x + tile[0], W), min(y + tile[1], H)))
        w, h = t.size
        t = t.resize((w * s, h * s), Image.LANCZOS)
        if a:
            t = t.rotate(a, expand=True, resample=Image.BICUBIC, fillcolor=(255, 255, 255))
        out = []
        cw, ch = t.size; ar = math.radians(a)
        for n, px, py in ocr_tile(td, t, f'r{k}'):
            dx, dy = px - cw / 2, py - ch / 2
            tx = w * s / 2 + dx * math.cos(ar) - dy * math.sin(ar); ty = h * s / 2 + dx * math.sin(ar) + dy * math.cos(ar)
            out.append((n, x + tx / s, y + ty / s))
        return out
    hits = []
    with ThreadPoolExecutor(6) as ex:
        for r in ex.map(run, enumerate(jobs)):
            hits += r
    return hits, ('pdf-points', [float(W), float(H)])


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


def fill_missing(pdf, page, units, pitch, missing, dpi=400):
    """second look at the numbers not read: end homes are often printed on a grey fill, where dark text on
    grey is missed. Around each missing number's neighbours (n-1, n+1) the grey fill is whitened and the
    crop read again (0 / 90 / -90 deg); a hit counts only if it is that number and lies next to a neighbour.
    Returns {n: [x, y]} in page points."""
    from PIL import Image
    import cv2, math
    Image.MAX_IMAGE_PIXELS = None
    td = tempfile.mkdtemp()
    subprocess.run(['pdftoppm', '-q', '-r', str(dpi), '-png', '-f', str(page), '-l', str(page), pdf, os.path.join(td, 'g')], check=True)
    im = cv2.imread(os.path.join(td, [x for x in os.listdir(td) if x.endswith('.png')][0]))
    hsv = cv2.cvtColor(im, cv2.COLOR_BGR2HSV)
    grey = (hsv[..., 1] < 35) & (hsv[..., 2] > 120) & (hsv[..., 2] < 225)
    clean_im = im.copy(); clean_im[grey] = 255
    k = dpi / 72.0
    found = {}
    for n in missing:
        nb = [np.array(units[m]) for m in (n - 1, n + 1) if m in units]
        if not nb:
            continue
        c = np.mean(nb, 0); r = 2.6 * pitch
        x0, y0 = int(max(0, (c[0] - r) * k)), int(max(0, (c[1] - r) * k))
        x1, y1 = int(min(im.shape[1], (c[0] + r) * k)), int(min(im.shape[0], (c[1] + r) * k))
        tile = Image.fromarray(cv2.cvtColor(clean_im[y0:y1, x0:x1], cv2.COLOR_BGR2RGB))
        best = None
        for ang in (0, 90, -90):
            img = tile.rotate(ang, expand=True, resample=Image.BICUBIC, fillcolor=(255, 255, 255)) if ang else tile
            img = img.resize((img.width * 2, img.height * 2), Image.LANCZOS)
            a = math.radians(ang); w, h = tile.size; cw, ch = img.size[0] / 2, img.size[1] / 2
            for m, px, py in ocr_tile(td, img, f'f{n}_{ang}'):
                if m != n:
                    continue
                dx, dy = px / 2 - cw / 2, py / 2 - ch / 2
                tx = w / 2 + dx * math.cos(a) - dy * math.sin(a); ty = h / 2 + dx * math.sin(a) + dy * math.cos(a)
                p = np.array([(x0 + tx) / k, (y0 + ty) / k])
                d = min(np.hypot(*(p - q)) for q in nb)
                if d < 2.2 * pitch and (best is None or d < best[0]):
                    best = (d, p)
        if best is not None:
            found[n] = [round(float(best[1][0]), 1), round(float(best[1][1]), 1)]
            continue
        # a lone digit ('1') is not returned by the reader: the end home on the grey fill that continues the
        # run (..., n+2, n+1 -> n, or n-2, n-1 -> n) one step on and holds no other number is that unit
        for a, b in ((n + 1, n + 2), (n - 1, n - 2)):
            if a not in units or b not in units:
                continue
            pa, pb = np.array(units[a]), np.array(units[b])
            step = pa - pb
            if not (0.6 * pitch < np.hypot(*step) < 1.4 * pitch):
                continue
            g8 = grey.astype(np.uint8)
            cnt, lab, stats, cents = cv2.connectedComponentsWithStats(g8, 8)
            want = pa + step * 1.15
            best = None
            for i in range(1, cnt):
                if stats[i, cv2.CC_STAT_AREA] < (0.3 * pitch * k) ** 2:
                    continue
                c = cents[i] / k
                d = np.hypot(*(c - want))
                taken = any(np.hypot(*(np.array(v) - c)) < 0.45 * pitch for v in units.values())
                if d < 0.8 * pitch and not taken and (best is None or d < best[0]):
                    best = (d, c)
            if best is not None:
                found[n] = [round(float(best[1][0]), 1), round(float(best[1][1]), 1)]
                GREY_CELL.add(n)
                break
    return found


GREY_CELL = set()  # numbers placed on their grey end cell (not read as text)


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
    if '--fill' in sys.argv:
        # keep the earlier reading; only look again for the numbers it missed (recorded as 'filled')
        path = os.path.join(APP, 'data', 'siteplans', proj, 'units_raw.json')
        raw = json.load(open(path))
        units = {int(k): v for k, v in raw['units'].items()}
        # two numbers recorded on one home (< 0.45 pitch apart): the one that does not continue its own
        # sequence (n-1 / n+1 about one pitch away) is a misplaced reading; it is dropped and read again
        P = {n: np.array(v) for n, v in units.items()}
        def fits(n):
            return any(0.6 * raw['pitch'] < np.hypot(*(P[n] - P[m])) < 1.6 * raw['pitch'] for m in (n - 1, n + 1) if m in P)
        bad = set()
        for a in P:
            for b in P:
                if a < b and np.hypot(*(P[a] - P[b])) < 0.45 * raw['pitch']:
                    fa, fb = fits(a), fits(b)
                    bad |= {b} if fa and not fb else {a} if fb and not fa else {a, b}
        for n in bad:
            units.pop(n); raw['units'].pop(str(n))
        raw['misplaced_dropped'] = sorted(set(raw.get('misplaced_dropped', [])) | bad)
        raw['missing'] = sorted(set(raw['missing']) | bad)
        if bad:
            print(f'{proj}: misplaced readings dropped {sorted(bad)}')
        found = fill_missing(pdf, page, units, raw['pitch'], raw['missing'])
        for n, p in found.items():
            raw['units'][str(n)] = p
        raw['units'] = {str(k): raw['units'][str(k)] for k in sorted(int(x) for x in raw['units'])}
        raw['filled'] = sorted(set(raw.get('filled', [])) | set(found))
        raw['grey_end_cell'] = sorted(set(raw.get('grey_end_cell', [])) | GREY_CELL)
        raw['missing'] = [n for n in raw['missing'] if n not in found]
        raw['read'] = len(raw['units'])
        json.dump(raw, open(path, 'w'))
        print(f"{proj}: second look found {sorted(found)}; still missing {raw['missing']}")
        return
    index = int(sys.argv[sys.argv.index('--image') + 1]) if '--image' in sys.argv else None
    if '--raster' in sys.argv:  # the map is an image: <pdf> is the image file (a one-page PDF of it at 72 dpi
        # has the same coordinates); RASTER_ANGLES="0,40,-40" for turned labels
        ang = tuple(int(a) for a in os.environ.get('RASTER_ANGLES', '0').split(','))
        sc = tuple(int(a) for a in os.environ.get('RASTER_SCALES', '2,3,4').split(','))
        hits, frame = from_raster(pdf, scales=sc, angles=ang)
        h2, _ = from_raster(pdf, scales=sc, angles=ang, tile=(420, 280), step=(310, 170))  # a second, offset tile grid
        hits += h2
    else:
        hits, frame = from_text(pdf, page)
    if '--raster' not in sys.argv and (len([h for h in hits if h[0] > 0]) < 20 or '--ocr' in sys.argv):  # --ocr: text layer split into digits (Vindera)
        # OCR_PASSES="400:0;600:0" reads upright labels only (rotated passes invent numbers on maps
        # whose labels are all upright, e.g. Alana)
        ps = os.environ.get('OCR_PASSES')
        passes = tuple((int(a), tuple(int(x) for x in b.split(','))) for a, b in (q.split(':') for q in ps.split(';'))) if ps else None
        hits, frame = from_image(pdf, page, index, passes) if passes else from_image(pdf, page, index)
        if not ps:
            hits += from_embedded(pdf, page)
    units, pitch = clean(hits)
    cfgp = os.path.join(APP, 'data', 'siteplans', proj, 'config.json')
    if os.path.exists(cfgp) and json.load(open(cfgp)).get('count'):
        cnt = json.load(open(cfgp))['count']
        units = {n: v for n, v in units.items() if n <= cnt}
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

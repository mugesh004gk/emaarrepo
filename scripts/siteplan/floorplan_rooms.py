#!/usr/bin/env python3
"""Maid's room per floor-plan sheet page, read from the developer PDF (never inferred).

  python3 scripts/siteplan/floorplan_rooms.py [project ...]   -> data/floorplan_rooms.json

For every page of each project's floor-plan PDF:
  - the PDF text layer (pdftotext), and
  - OCR (macOS Vision, scripts/siteplan/clustermap/ocr) of the page rendered at 250 dpi in 4 overlapping
    tiles, enlarged 1.6x (sheets whose room names are drawn as outlines, not text);
  maid  = true  when 'MAID' (MAID'S ROOM / MAID ROOM) is printed on the page;
          false ONLY when checked by eye on the sheet (BY_EYE): text layer and OCR both miss room labels
                (Farm Gardens 2 p.6 has a MAID'S ROOM that neither found), so 'not found' is never taken as 'no';
          null  not found by text / OCR and not yet checked by eye - unresolved.
  BY_EYE: pages looked at by eye (scanned sheets, and every page where nothing was found) - kept on reruns.
  python3 scripts/siteplan/floorplan_rooms.py --eye   re-applies BY_EYE to data/floorplan_rooms.json only.
"""
import json, os, re, subprocess, sys, tempfile
from concurrent.futures import ThreadPoolExecutor

APP = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OCR = os.path.join(APP, 'scripts', 'siteplan', 'clustermap', 'ocr')
ROOM_WORDS = ('KITCHEN', 'LIVING', 'DINING', 'MASTER')


def words(t):
    return re.sub(r'[^A-Z]', '', t.upper())


def page(src, pg, td):
    txt = words(subprocess.run(['pdftotext', '-q', '-f', str(pg), '-l', str(pg), src, '-'], capture_output=True, text=True).stdout)
    if 'MAID' in txt:
        return True, 'text layer'
    base = os.path.join(td, f'p{pg}')
    # 250 dpi, but never wider than 7000 px (Lillia's sheets are 4040 pt wide)
    w_pt = float(re.search(r'size:\s*([\d.]+)', subprocess.run(['pdfinfo', '-f', str(pg), '-l', str(pg), src], capture_output=True, text=True).stdout).group(1))
    dpi = min(250, int(7000 * 72 / w_pt))
    subprocess.run(['pdftoppm', '-q', '-r', str(dpi), '-f', str(pg), '-l', str(pg), '-png', '-singlefile', src, base], check=True)
    import cv2
    im = cv2.imread(base + '.png'); h, w = im.shape[:2]; ocr = ''
    for i, (x0, x1) in enumerate(((0, 0.55), (0.45, 1.0))):
        for j, (y0, y1) in enumerate(((0, 0.55), (0.45, 1.0))):
            c = im[int(h * y0):int(h * y1), int(w * x0):int(w * x1)]
            c = cv2.resize(c, None, fx=1.6, fy=1.6, interpolation=cv2.INTER_CUBIC)
            f = f'{base}_{i}{j}.png'; cv2.imwrite(f, c)
            ocr += subprocess.run([OCR, f], capture_output=True, text=True).stdout + ' '
    ocr = words(ocr)
    if 'MAID' in txt or 'MAID' in ocr:
        return True, 'text layer' if 'MAID' in txt else 'OCR'
    if any(x in txt for x in ROOM_WORDS) or any(x in ocr for x in ROOM_WORDS):
        return None, 'room names read, no maid room found by text / OCR - to check by eye'
    return None, 'room names not readable'


def deep(src, pg, td):
    """second pass for pages where nothing was found: page at up to 600 dpi (never wider than 10000 px), cut in
    overlapping 1800 px tiles, each OCR'd (the room labels on many sheets are ~4 pt)"""
    import cv2
    w_pt = float(re.search(r'size:\s*([\d.]+)', subprocess.run(['pdfinfo', '-f', str(pg), '-l', str(pg), src], capture_output=True, text=True).stdout).group(1))
    dpi = min(600, int(10000 * 72 / w_pt)); base = os.path.join(td, f'd{pg}')
    subprocess.run(['pdftoppm', '-q', '-r', str(dpi), '-f', str(pg), '-l', str(pg), '-png', '-singlefile', src, base], check=True)
    im = cv2.imread(base + '.png'); h, w = im.shape[:2]; T, S = 1800, 1400; txt = ''
    for y in range(0, max(1, h - T + S), S):
        for x in range(0, max(1, w - T + S), S):
            f = f'{base}_{x}_{y}.png'; cv2.imwrite(f, im[y:y + T, x:x + T])
            txt += subprocess.run([OCR, f], capture_output=True, text=True).stdout + ' '
    return 'MAID' in words(txt)


# (project, page) -> (maid, what was seen)
BY_EYE = {
    # RIVANA_floorplan_binayah.pdf (12 sheets, Kai / Clara 3-5 BR, normal + mirrored): all checked by eye 20 Nov 2026
    **{('rivana', p): (True, "read by eye: MAID'S ROOM 2.2 x 2.6 M + MAID'S BATH, ground floor") for p in range(1, 13)},
    ('farm-gardens-2', 4): (True, "read by eye: MAID'S ROOM + MAID'S BATH, ground floor"),
    ('talia', 13): (None, 'read by eye: Pharo 3 BR C - ground-floor room with a single bed drawn and its own WC, but NOT named '
                          'on the sheet (no label, no size) - maid room or not: client to confirm'),
    **{('velora-2-at-the-valley-phase-2', p): (True, "read by eye: MAID'S ROOM 2.40 x 2.10 m + MAID'S BATHROOM, ground floor (TH04 4 BR)") for p in (6, 11, 16)},
    **{('farm-grove-at-the-valley', p): (False, 'read by eye: detached / semi-detached 4 BR - ground floor has GUEST BEDROOM, LINEN ROOM, STORE; no maid room')
       for p in (6, 7, 8, 9, 10, 11)},
    ('elora', 3): (False, 'read by eye: Moon 3 BR - ground floor has STORE ROOM 2.2 x 2.2 M, no maid room'),
    ('elora', 4): (False, 'read by eye: Mysk 3 BR A - ground floor has STORE ROOM 2.2 x 2.2 M, no maid room'),
    ('elora', 5): (False, 'read by eye: Mysk 3 BR B (mirrored) - STORE ROOM 2.2 x 2.2 M, no maid room'),
    ('farm-gardens-2', 6):(True, "read by eye: MAID'S ROOM 2.8 x 2.1 M + MAID'S BATH, ground floor (also DRIVER ROOM)"),
}


def apply_eye(out):
    for (pid, pg), (m, how) in BY_EYE.items():
        if pid in out:
            out[pid]['pages'][str(pg)] = {'maid': m, 'how': how}
    for v in out.values():
        for p in v['pages'].values():
            if p['maid'] is False and not p['how'].startswith('read by eye'):
                p['maid'] = None; p['how'] = 'room names read, no maid room found by text / OCR - to check by eye'


def main():
    if sys.argv[1:2] == ['--deep']:  # --deep <project> <page,page,...>
        path = os.path.join(APP, 'data', 'floorplan_rooms.json'); out = json.load(open(path))
        pid = sys.argv[2]; pages = [int(x) for x in sys.argv[3].split(',')]
        src = os.path.join(APP, json.load(open(os.path.join(APP, 'data', 'floorplans.json')))[pid]['src']); td = tempfile.mkdtemp()
        with ThreadPoolExecutor(4) as ex:
            res = list(ex.map(lambda pg: (pg, deep(src, pg, td)), pages))
        out = json.load(open(path))
        for pg, m in res:
            if m:
                out[pid]['pages'][str(pg)] = {'maid': True, 'how': 'OCR at 600 dpi'}
        apply_eye(out); json.dump(out, open(path, 'w'), indent=0)
        print(pid, ' '.join(f"p{pg}:{'M' if m else '?'}" for pg, m in res)); return
    if sys.argv[1:] == ['--eye']:
        path = os.path.join(APP, 'data', 'floorplan_rooms.json'); out = json.load(open(path)); apply_eye(out)
        json.dump(out, open(path, 'w'), indent=0); return
    fps = json.load(open(os.path.join(APP, 'data', 'floorplans.json')))
    path = os.path.join(APP, 'data', 'floorplan_rooms.json')
    out = json.load(open(path)) if os.path.exists(path) else {}
    ids = sys.argv[1:] or [k for k, v in fps.items() if '/the-valley/' in v['src']]
    for pid in ids:
        f = fps[pid]; src = os.path.join(APP, f['src']); td = tempfile.mkdtemp()
        with ThreadPoolExecutor(6) as ex:
            res = list(ex.map(lambda pg: (pg, page(src, pg, td)), range(1, f['pages'] + 1)))
        out[pid] = {'pdf': os.path.basename(f['src']), 'pages': {str(pg): {'maid': m, 'how': how} for pg, (m, how) in res}}
        apply_eye(out)
        print(f'{pid[:30]:30s}', ''.join('M' if m else ('n' if m is False else '?') for _, (m, _) in res))
        json.dump(out, open(path, 'w'), indent=0)


if __name__ == '__main__':
    main()

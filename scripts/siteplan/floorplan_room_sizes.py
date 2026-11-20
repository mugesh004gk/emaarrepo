#!/usr/bin/env python3
"""Printed room sizes per floor-plan sheet page, read from the developer PDF (never estimated).

  python3 scripts/siteplan/floorplan_room_sizes.py [project ...]   -> data/floorplan_room_sizes.json

For every page of a project's floor-plan PDF:
  1. labels with their positions: the PDF text layer (PyMuPDF spans; letter-spaced titles such as 'K I TC H E N'
     are closed up), or - when the page has fewer than 3 printed sizes in its text layer (room names drawn as
     outlines) - OCR of the page at up to 600 dpi in overlapping tiles (macOS Vision, positions kept);
  2. a room = a printed size 'a x b' (metres) and the room name printed on the same line or just above it;
  3. floor = the floor caption (GROUND / FIRST / SECOND FLOOR, ROOF ...) whose plan column holds the label
     (nearest caption by x; captions sit under their plans).
Sizes are kept exactly as printed (e.g. '3.9 x 3.9'). A name or size that does not read cleanly is left out;
a page with fewer than MIN_ROOMS clean rooms is left out entirely (the panel then points to the sheet).
Output: {project: {pdf, pages: {page: {source: 'text'|'ocr', floors: [{name, rooms: [{name, dims}]}]}}}}
"""
import json, os, re, subprocess, sys, tempfile
from concurrent.futures import ThreadPoolExecutor

APP = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OCR = os.path.join(APP, 'scripts', 'siteplan', 'clustermap', 'ocr')
DIM = re.compile(r'(\d{1,2}(?:[.,]\d{1,3})?)\s*M?\s*[xX×]\s*(\d{1,2}(?:[.,]\d{1,3})?)\s*M?\b')
FLOOR = re.compile(r'\b(GROUND|FIRST|SECOND|THIRD|ROOF)\s*(FLOOR|LEVEL|TERRACE|DECK)?\b')
SKIP = re.compile(r'TOTAL|AREA|SQ ?FT|SQM|PLEX|UNIT|KEY PLAN|FLOOR PLAN|BEDROOM [IV]+ ?[A-D]?$|^\d|STREET|DIMENSIONS')
# a page whose labels read only in part (blurred raster labels) gets no list: a short list would look complete
MIN_ROOMS = 6
FLOOR_ORDER = ['GROUND', 'FIRST', 'SECOND', 'THIRD', 'ROOF']


def close_up(t):
    """'K I TC H E N' -> 'KITCHEN', 'B AT H' -> 'BATH' (title letters spaced out in the PDF); real words kept"""
    parts = t.split()
    if len(parts) > 1 and sum(len(p) <= 2 for p in parts) >= len(parts) - 1:
        return ''.join(parts)
    return t


def text_items(src, pg):
    import fitz
    doc = fitz.open(src); page = doc[pg - 1]
    out = []
    for b in page.get_text('dict')['blocks']:
        for ln in b.get('lines', []):
            t = ' '.join(s['text'] for s in ln['spans']).strip()
            if t:
                x0, y0, x1, y1 = ln['bbox']
                out.append((re.sub(r'\s+', ' ', t), x0, y0, x1, y1))
    return out, page.rect.width


def ocr_items(src, pg, td):
    import cv2
    w_pt = float(re.search(r'size:\s*([\d.]+)', subprocess.run(['pdfinfo', '-f', str(pg), '-l', str(pg), src], capture_output=True, text=True).stdout).group(1))
    dpi = min(600, int(10000 * 72 / w_pt)); base = os.path.join(td, f'r{pg}')
    subprocess.run(['pdftoppm', '-q', '-r', str(dpi), '-f', str(pg), '-l', str(pg), '-png', '-singlefile', src, base], check=True)
    im = cv2.imread(base + '.png'); h, w = im.shape[:2]; T, S = 1800, 1400; k = 72 / dpi
    raw = []
    for y in range(0, max(1, h - T + S), S):
        for x in range(0, max(1, w - T + S), S):
            f = f'{base}_{x}_{y}.png'; cv2.imwrite(f, im[y:y + T, x:x + T])
            for line in subprocess.run([OCR, f], capture_output=True, text=True).stdout.splitlines():
                p = line.split('\t')
                if len(p) == 5:
                    t, bx, by, bw, bh = p[0], *map(float, p[1:])
                    tw, th_ = min(T, w - x), min(T, h - y)
                    # a label cut by the tile edge reads wrong ('4.20m' -> '20'); the overlapping tile has it whole
                    if (bx < 6 and x > 0) or (by < 6 and y > 0) or (bx + bw > tw - 6 and x + tw < w) or (by + bh > th_ - 6 and y + th_ < h):
                        continue
                    raw.append((t.strip(), (x + bx) * k, (y + by) * k, (x + bx + bw) * k, (y + by + bh) * k))
    # overlapping tiles read the same label twice: keep one per text and place
    out = []
    for it in sorted(raw, key=lambda r: -len(r[0])):
        if not any(o[0].upper() == it[0].upper() and abs(o[1] - it[1]) < 6 and abs(o[2] - it[2]) < 6 for o in out):
            out.append(it)
    return out, w_pt


WORDS = set('''LIVING ROOM DINING KITCHEN BEDROOM MASTER GUEST BATH BATHROOM MAID'S MAIDS MAID LAUNDRY LAU STORE STORAGE POWDER
PWDR RM ENTRY ENTRANCE FOYER ENT CORRIDOR BALCONY TERRACE WALK-IN WALKIN WALK IN WARDROBE DRESS DRESSING PUMP LOUNGE FAMILY SHOW
DRIVER DRIVER'S TOILET ROOF MAJLIS STUDY PANTRY LIFT GARAGE CARPORT GARDEN POOL DECK UTILITY WC HALL MEP HEAT SITTING OFFICE
PRAYER LOBBY PASSAGE STAIR STAIRS LANDING GYM MULTI PURPOSE MULTIPURPOSE CINEMA PLAY PLAYROOM OPEN SKY COURTYARD PATIO
SERVICE KIDS KID'S MEDIA BBQ OUTDOOR INDOOR FORMAL INFORMAL SUITE AND WITH OF / & - ROOF-TOP ROOFTOP VOID UPPER LOWER
GROUND FIRST SECOND SITTINGROOM ENSUITE EN-SUITE SHOWER LINEN CLOSET W.I.W WIW W.I.C WIC JR JUNIOR MAIN'''.split())


def clean_name(name):
    """OCR'd names: every word must be a room-label word (optionally numbered, e.g. BEDROOM 2 / BATHROOM3)"""
    for w in re.split(r'[ /&]+', name):
        w = w.strip('.()-')
        if not w or re.fullmatch(r'\d{1,2}', w):
            continue
        if re.sub(r'\d+$', '', w).replace('’', "'") not in WORDS:
            return False
    return True


def rooms_of(items, ocr=False):
    items = [(close_up(t).upper(), x0, y0, x1, y1) for t, x0, y0, x1, y1 in items]
    caps = []
    for t, x0, y0, x1, y1 in items:
        m = FLOOR.fullmatch(t.strip())
        if m:
            caps.append((m.group(1), (x0 + x1) / 2, y0))
    rooms = []
    for t, x0, y0, x1, y1 in items:
        m = DIM.search(t)
        if not m:
            continue
        a, b = (v.replace(',', '.') for v in m.groups())
        if not (0.5 <= float(a) <= 25 and 0.5 <= float(b) <= 25):
            continue
        if ocr and not (re.fullmatch(r'\d{1,2}\.\d{1,3}', a) and re.fullmatch(r'\d{1,2}\.\d{1,3}', b) and float(a) <= 15 and float(b) <= 15):
            continue  # OCR'd size not in the sheets' own form (decimals, under 15 m): a misread, never corrected by guess
        name = t[:m.start()].strip(' .:-')
        lh = (y1 - y0) or 6
        if not re.search(r'[A-Z]{3}', name):
            # name above: letters-only lines just above this one, overlapping it horizontally (up to two lines)
            above = sorted([(y0 - yy1, tt) for tt, xx0, yy0, xx1, yy1 in items
                            if -0.6 * lh <= y0 - yy1 < 1.6 * lh and yy0 < y0 - 0.2 * lh and min(x1, xx1) - max(x0, xx0) > -0.3 * lh and re.fullmatch(r"[A-Z][A-Z0-9'’ /&.-]{2,}", tt.strip()) and re.search(r'[A-Z]{3}', tt) and not DIM.search(tt)])
            picked = []
            for _, tt in above:  # nearest first; an OCR fragment of a longer label ('BAT' of 'BATHROOM') is dropped
                tt = tt.strip()
                if any(tt in q or q in tt for q in picked):
                    picked = [q for q in picked if q not in tt] + ([tt] if not any(tt in q for q in picked) else [])
                    continue
                picked.append(tt)
                if len(picked) == 2:
                    break
            name = ' '.join(reversed(picked))
        name = re.sub(r'\s+', ' ', name).strip(' .:-')
        if not re.fullmatch(r"[A-Z][A-Z0-9'’ /&.()-]{2,40}", name) or SKIP.search(name):
            continue
        if ocr and not clean_name(name):
            continue
        if name in ('ROOM', 'AREA'):  # a bare word: the rest of the name was not read
            continue
        cx = (x0 + x1) / 2
        fl = min(caps, key=lambda c: abs(c[1] - cx))[0] if caps else None
        rooms.append({'floor': fl, 'name': name.title().replace("'S", "'s").replace('’S', "'s"), 'dims': f'{a} x {b}', 'x': cx, 'y': y0})
    # one per label position (a label read in two text modes)
    seen, out = set(), []
    for r in rooms:
        k = (r['name'], r['dims'], round(r['x'] / 8), round(r['y'] / 8))
        if k not in seen:
            seen.add(k); out.append(r)
    floors = []
    for f in sorted({r['floor'] for r in out}, key=lambda f: FLOOR_ORDER.index(f) if f in FLOOR_ORDER else 9):
        rs = sorted([r for r in out if r['floor'] == f], key=lambda r: (r['y'], r['x']))
        floors.append({'name': f'{f.title()} floor' if f and f != 'ROOF' else ('Roof' if f else 'Rooms'),
                       'rooms': [{'name': r['name'], 'dims': r['dims']} for r in rs]})
    return floors


def page(src, pg, td):
    items, _ = text_items(src, pg)
    n_dims = sum(1 for t, *_ in items if DIM.search(close_up(t).upper()))
    count = lambda fl: sum(len(f['rooms']) for f in fl)
    best = ('text', rooms_of(items)) if n_dims >= 3 else ('text', [])
    if count(best[1]) < 8:  # text layer missing labels (Farm Gardens 2): try the page image too, keep the fuller reading
        o = rooms_of(ocr_items(src, pg, td)[0], ocr=True)
        if count(o) > count(best[1]):
            best = ('ocr', o)
    return best


def main():
    fps = json.load(open(os.path.join(APP, 'data', 'floorplans.json')))
    path = os.path.join(APP, 'data', 'floorplan_room_sizes.json')
    out = json.load(open(path)) if os.path.exists(path) else {}
    ids = sys.argv[1:] or [k for k, v in fps.items() if '/the-valley/' in v['src'] and k != 'nara']
    for pid in ids:
        f = fps[pid]; src = os.path.join(APP, f['src']); td = tempfile.mkdtemp()
        with ThreadPoolExecutor(4) as ex:
            res = list(ex.map(lambda pg: (pg, page(src, pg, td)), range(2, f['pages'] + 1)))
        out[pid] = {'pdf': os.path.basename(f['src']),
                    'pages': {str(pg): {'source': s, 'floors': fl} for pg, (s, fl) in res if sum(len(x['rooms']) for x in fl) >= MIN_ROOMS}}
        print(f"{pid[:30]:30s}", ' '.join(f"p{pg}:{s[0]}{sum(len(x['rooms']) for x in fl)}" for pg, (s, fl) in res))
        json.dump(out, open(path, 'w'), indent=0, ensure_ascii=False)


if __name__ == '__main__':
    main()

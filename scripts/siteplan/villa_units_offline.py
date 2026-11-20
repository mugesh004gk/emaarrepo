#!/usr/bin/env python3
"""Unit data of a villa cluster map whose location is not confirmed yet (kept OFF the 3D map).

  python3 scripts/siteplan/villa_units_offline.py <project> <cluster_map.pdf> <floorplan.pdf> <fact 4BR,5BR-Medium,5BR-Premium>
      -> data/offline/<project>.json

- unit numbers and their positions: the cluster map's PDF text layer (every label 01..N);
- style (plot colour around the home) -> nearest STYLES legend swatch (CIELAB), 6 styles;
- the roof colour (UNIT TYPES legend) is recorded only as a note: on these maps the 4BR and 5BR Premium roofs are
  almost the same brown, so it cannot decide anything;
- every reading is drawn onto the map and checked by eye; misreads are corrected in EYE_FIXES with the reason
  (never guessed); totals per bedroom type must equal the fact sheet;
- floor-plan page per style from the sheet titles (p2 4BR A ... p7 5BR Premium B), built-up area from the
  sheet's table (PDF text);
- totals per bedroom type compared with the fact sheet.
"""
import json, os, re, subprocess, sys
from collections import Counter
import numpy as np, cv2, fitz

APP = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
STYLES = ['5BR Premium TYPE A', '5BR Premium TYPE B', '5BR Medium TYPE A', '5BR Medium TYPE B', '4BR TYPE A', '4BR TYPE B']
UTYPES = ['5BR Premium', '5BR Medium', '4BR']
STYLE_TYPE = {s: s.rsplit(' TYPE', 1)[0] for s in STYLES}
SHEET = {'4BR TYPE A': 2, '4BR TYPE B': 3, '5BR Medium TYPE A': 4, '5BR Medium TYPE B': 5, '5BR Premium TYPE A': 6, '5BR Premium TYPE B': 7}
K = 4.0  # px per pt
# readings corrected after the by-eye check of the overlay (plot colour on the map)
EYE_FIXES = {
    'ovelle-at-the-valley': {n: ('5BR Premium TYPE B', 'bright-orange plot (5BR Premium Type B); the big brown Premium roof made the sampler read 5BR Medium Type B')
                             for n in (42, 43, 45, 52)},
}
EYE_CHECKED = {'avelia-at-the-valley': '20 Nov 2026: all 139 readings checked by eye on the cluster map (no correction needed)',
               'ovelle-at-the-valley': '20 Nov 2026: all 133 readings checked by eye on the cluster map; 4 corrected (EYE_FIXES)'}


def lab(img):
    return cv2.cvtColor(img, cv2.COLOR_BGR2LAB).astype(np.float32)


def main():
    pid, cm, fp, fact = sys.argv[1], sys.argv[2], sys.argv[3], [int(x) for x in sys.argv[4].split(',')]
    doc = fitz.open(cm); pg = doc[0]
    pix = pg.get_pixmap(matrix=fitz.Matrix(K, K), alpha=False)
    im = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, 3)[:, :, ::-1].copy()
    L = lab(cv2.GaussianBlur(im, (5, 5), 0))
    words = []
    for b in pg.get_text('dict')['blocks']:
        for ln in b.get('lines', []):
            t = ' '.join(s['text'] for s in ln['spans']).strip()
            if t:
                words.append((t, ln['bbox']))
    # legend swatches: the square left of each legend label
    def swatch(name):
        for t, (x0, y0, x1, y1) in words:
            if t.strip().lower() == name.lower():
                cy = (y0 + y1) / 2 * K; cx = (x0 - 12) * K
                return np.median(L[int(cy - 8):int(cy + 8), int(cx - 8):int(cx + 8)].reshape(-1, 3), 0)
        raise SystemExit(f'legend label not found: {name}')
    sw_s = np.array([swatch(s) for s in STYLES]); sw_t = np.array([swatch(t) for t in UTYPES])
    units = {}
    for t, (x0, y0, x1, y1) in words:
        if re.fullmatch(r'\d{2,3}', t) and y0 < 680:  # map area (the legend sits below)
            units[int(t)] = ((x0 + x1) / 2 * K, (y0 + y1) / 2 * K, (x1 - x0) * K, (y1 - y0) * K)
    pts = np.array([u[:2] for u in units.values()])
    d = np.sqrt(((pts[:, None] - pts[None]) ** 2).sum(-1)); np.fill_diagonal(d, 1e9)
    sp = float(np.median(d.min(1)))  # typical spacing between neighbouring labels
    H, W = L.shape[:2]; out = []
    for n in sorted(units):
        cx, cy, lw, lh = units[n]
        def votes(r_in, r_out, sw, thr):
            yy, xx = np.mgrid[max(0, int(cy - r_out)):min(H, int(cy + r_out)), max(0, int(cx - r_out)):min(W, int(cx + r_out))]
            rr = np.hypot(xx - cx, yy - cy); m = (rr >= r_in) & (rr <= r_out)
            px = L[yy[m], xx[m]]
            # skip the label box itself (white with dark digits)
            inbox = (np.abs(xx[m] - cx) < lw / 2 + 3) & (np.abs(yy[m] - cy) < lh / 2 + 3)
            px = px[~inbox]
            dd = np.sqrt(((px[:, None] - sw[None]) ** 2).sum(-1)); k = dd.argmin(1); ok = dd.min(1) < thr
            c = Counter(k[ok].tolist()); tot = max(1, ok.sum())
            return [(i, c[i] / tot) for i in sorted(c, key=c.get, reverse=True)], int(ok.sum())
        vs, ns = votes(0.35 * sp, 0.55 * sp, sw_s, 9.0)
        vt, nt = votes(0, 0.3 * sp, sw_t, 9.0)
        style = STYLES[vs[0][0]] if vs else None; utype = UTYPES[vt[0][0]] if vt else None
        s_share = vs[0][1] if vs else 0; t_share = vt[0][1] if vt else 0
        rec = {'no': n, 'style': style, 'style_share': round(s_share, 2), 'roof_reading_note': utype,
               'x_pt': round(cx / K, 1), 'y_pt': round(cy / K, 1)}
        fx = EYE_FIXES.get(pid, {}).get(n)
        if fx:
            rec.update(style=fx[0], style_reading=style, style_source=f'corrected by eye: {fx[1]}')
        else:
            rec['style_source'] = 'plot colour (map legend)'
        rec['status'] = 'verified by eye' if pid in EYE_CHECKED and (fx or s_share >= 0.4) else 'check by eye'
        out.append(rec)
    # floor plans
    fd = fitz.open(fp); sheets = {}
    for s, p in SHEET.items():
        t = re.sub(r'\s+', ' ', subprocess.run(['pdftotext', '-q', '-layout', '-f', str(p), '-l', str(p), fp, '-'], capture_output=True, text=True).stdout)
        m = re.search(r'BUILT UP AREA ([\d.]+) SQFT ([\d.]+)', t)
        sheets[s] = {'page': p, 'bua_sqft': float(m.group(1)) if m else None, 'bua_sqm': float(m.group(2)) if m else None}
    # maid's / driver's room per sheet: printed room names (data/floorplan_room_sizes.json, PDF text layer)
    rs = json.load(open(os.path.join(APP, 'data', 'floorplan_room_sizes.json'))).get(pid, {}).get('pages', {})
    for s_, sh in sheets.items():
        names = [r['name'].lower().replace(' ', '') for f in rs.get(str(sh['page']), {}).get('floors', []) for r in f['rooms']]
        sh['maid'] = any("maid'sroom" in n or 'maidroom' in n for n in names) if names else None
        sh['driver_room'] = any('driver' in n for n in names) if names else None
    for u in out:
        if u['style']:
            sh = sheets[u['style']]
            beds = 4 if u['style'].startswith('4BR') else 5
            u.update(beds=beds, maid=sh['maid'], driver_room=sh['driver_room'], config=f"{beds} Bedroom" + (' + Maid' if sh['maid'] else ''),
                     plan=f"{u['style'].replace('TYPE', 'Type')}", page=sh['page'], bua_sqft=sh['bua_sqft'], bua_sqm=sh['bua_sqm'])
    cnt = Counter(STYLE_TYPE[u['style']] for u in out if u['style'])
    res = {'project': pid, 'located': False, 'eye_check': EYE_CHECKED.get(pid), 'note': 'Unit data only: kept off the 3D map until a verified location reference is received.',
           'sources': {'cluster_map': os.path.basename(cm), 'floor_plans': os.path.basename(fp)},
           'units_total': len(out), 'numbers': f"{min(units)}-{max(units)}", 'missing_numbers': sorted(set(range(1, max(units) + 1)) - set(units)),
           'fact_sheet': dict(zip(UTYPES[::-1], fact)), 'from_map': {k: cnt.get(k, 0) for k in UTYPES[::-1]},
           'styles': dict(Counter(u['style'] for u in out)), 'check_by_eye': [u['no'] for u in out if u['status'] != 'verified by eye'],
           'sheets': sheets, 'units': out}
    res['fact_sheet_agrees'] = res['fact_sheet'] == res['from_map']
    json.dump(res, open(os.path.join(APP, 'data', 'offline', f'{pid}.json'), 'w'), indent=1)
    print(pid, 'units', len(out), res['numbers'], 'missing', res['missing_numbers'], '| map', res['from_map'], 'fact', res['fact_sheet'],
          'agree' if res['fact_sheet_agrees'] else 'DIFFER', '| styles', res['styles'], '| check by eye', res['check_by_eye'], '| spacing px', round(sp))


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""House type and floor plan of every unit of a cluster-map project (terraces), from Emaar's own sheets.

  python scripts/siteplan/clustermap/assign_plans.py <project> <brochure.pdf> <page>

Needs (written by the earlier steps):
  data/siteplans/<project>.json           rows placed from the cluster map (place_cluster.py), unit numbers
                                          in TH order (TH01 = left end seen from the street, as on the
                                          floor-plan key plans)
  data/siteplans/<project>/layout.json    unit positions on the map page
  data/siteplans/<project>/plans.json     floor-plan table (plan_table.py)
  data/siteplans/<project>/config.json    {"styles": {"<design>": "<legend word>"}, "cell_beds": {"grey": 4, "white": 3},
                                           "plex_alias": {"4": ["4.1", "4.2"]}}   (optional alias list)
For every terrace:
  design   = the plot colour around the terrace, matched to the legend colours of the map (STYLES);
  bedrooms = the colour of each home's cell on the map (TYPES legend: grey = 4 BR, white = 3 BR);
  plan     = the floor-plan sheet that lists this terrace size and position (<n> PLEX - TH <k>),
             with its built-up area.
Check: the bedrooms read from the map colour must equal the bedrooms of the plan at that position.
Writes unitPlans into data/siteplans/<project>.json and a summary into its 'checks'.
"""
import json, os, re, subprocess, sys, tempfile, html
from collections import Counter
import numpy as np
import cv2

APP = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
DPI = 200


def legend_colours(pdf, page, words, im, k, swatches=None):
    if swatches:
        # legend drawn inside the map picture: swatch centres given in page points (config 'swatches')
        lab = cv2.cvtColor(im, cv2.COLOR_BGR2LAB).astype(np.float32)
        r = int(3 * k)
        return {dz: np.median(lab[int(y * k) - r:int(y * k) + r, int(x * k) - r:int(x * k) + r].reshape(-1, 3), 0) for dz, (x, y) in swatches.items()}
    out = subprocess.run(['pdftotext', '-q', '-bbox', '-f', str(page), '-l', str(page), pdf, '-'], capture_output=True, text=True).stdout
    boxes = [(html.unescape(m.group(5)).strip().upper(), *map(float, m.group(1, 2, 3, 4)))
             for m in re.finditer(r'<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)</word>', out)]
    lab = cv2.cvtColor(im, cv2.COLOR_BGR2LAB).astype(np.float32)
    res = {}
    for design, word in words.items():
        b = next((x for x in boxes if x[0] == word.upper()), None)
        if b is None:
            raise SystemExit(f'legend word {word!r} not found on page {page}')
        _, x0, y0, x1, y1 = b
        h = y1 - y0; yc = (y0 + y1) / 2
        X0, X1 = int((x0 - 6 * h) * k), int((x0 - 0.3 * h) * k)
        Y0, Y1 = int((yc - 1.3 * h) * k), int((yc + 1.3 * h) * k)
        reg = lab[Y0:Y1, X0:X1].reshape(-1, 3)
        bg = np.median(lab[Y0:Y1, X0:X0 + 3].reshape(-1, 3), 0)
        sw = reg[np.linalg.norm(reg - bg, axis=1) > 12]
        if len(sw) < 20:
            raise SystemExit(f'no legend swatch next to {word!r}')
        res[design] = np.median(sw, 0)
    return res


def main():
    proj, pdf, page = sys.argv[1], sys.argv[2], int(sys.argv[3])
    d = os.path.join(APP, 'data', 'siteplans', proj)
    cfg = json.load(open(os.path.join(d, 'config.json')))
    lay = json.load(open(os.path.join(d, 'layout.json')))
    raw = json.load(open(os.path.join(d, 'units_raw.json')))
    plans = json.load(open(os.path.join(d, 'plans.json')))
    spath = os.path.join(APP, 'data', 'siteplans', f'{proj}.json')
    sp = json.load(open(spath))
    U = {int(n): u for n, u in lay['units'].items()}
    pitch = lay['pitch']
    td = tempfile.mkdtemp()
    subprocess.run(['pdftoppm', '-q', '-r', str(DPI), '-png', '-f', str(page), '-l', str(page), pdf, os.path.join(td, 'p')], check=True)
    im = cv2.imread(os.path.join(td, [f for f in os.listdir(td) if f.endswith('.png')][0]))
    k = DPI / 72.0
    H, W = im.shape[:2]
    hsv = cv2.cvtColor(im, cv2.COLOR_BGR2HSV)
    lab = cv2.cvtColor(im, cv2.COLOR_BGR2LAB).astype(np.float32)
    leg = legend_colours(pdf, page, cfg['styles'], im, k, cfg.get('swatches'))
    names = list(leg); L = np.array([leg[n] for n in names])

    def px(p):
        return int(round(p[0] * k)), int(round(p[1] * k))

    # cell_at_label: read a home's cell colour at its number label (units_raw) rather than at the evenly spaced
    # layout position - terraces whose end homes are wider than the middle ones (Venera)
    raw_lab = {}
    if cfg.get('cell_at_label'):
        raw_lab = {int(k_): v for k_, v in json.load(open(os.path.join(APP, 'data', 'siteplans', proj, 'units_raw.json')))['units'].items()}
        raw_lab.update({int(k_): v for k_, v in cfg.get('manual_units', {}).items() if not k_.startswith('_')})

    # end_cell_out: the end homes of a terrace are wider than the middle ones; on an evenly spaced layout their
    # cell colour is read this fraction of a pitch further out along the terrace (Venera)
    ends = {}
    if cfg.get('end_cell_out'):
        for r_ in lay['rows']:
            if len(r_) >= 2:
                a0, a1 = np.array(U[r_[0]]['p']), np.array(U[r_[-1]]['p']); ax_ = (a1 - a0) / (np.hypot(*(a1 - a0)) or 1)
                ends[r_[0]] = -ax_; ends[r_[-1]] = ax_

    def cpos(n):
        if n in ends:
            return (np.array(U[n]['p']) + ends[n] * cfg['end_cell_out'] * pitch).tolist()
        return raw_lab.get(n, U[n]['p'])

    def cell_v(n):
        x, y = px(cpos(n)); r = int(0.28 * pitch * k)
        h = hsv[max(0, y - r):y + r, max(0, x - r):x + r].reshape(-1, 3)
        h = h[(h[:, 2] > 130) & (h[:, 1] < 35)]
        return float(np.percentile(h[:, 2], 80)) if len(h) else None

    rel_kind = {}
    if cfg.get('cell_mode') == 'relative':
        # a low-resolution map: grey and white cells differ by brightness within their own terrace (the
        # absolute level varies with the image): a cell more than 'cell_gap' below the terrace's lightest is grey
        gap = cfg.get('cell_gap', 9)
        for r in sp['rows']:
            vs = {n: cell_v(n) for n in r['unitNumbers']}
            top = max([v for v in vs.values() if v is not None] or [0])
            for n, v in vs.items():
                rel_kind[n] = None if v is None else ('grey' if v < top - gap else 'white')

    def cell_kind(n):
        if rel_kind:
            return rel_kind.get(n)
        # the home's own cell around its number: grey fill (4 BR) or white (3 BR); dark text left out
        if cfg.get('cell_offset'):  # a small map: the label covers the cell, so read the fill just beside it
            ox, oy = cfg['cell_offset']; x, y = px([U[n]['p'][0] + ox, U[n]['p'][1] + oy])
            h = hsv[max(0, y - 6):y + 7, max(0, x - 8):x + 9].reshape(-1, 3)
            v = float(np.median(h[:, 2])); s_ = float(np.median(h[:, 1]))
            return None if s_ >= 35 else 'grey' if v < 225 else 'white'
        x, y = px(cpos(n)); r = int(0.28 * pitch * k)
        h = hsv[max(0, y - r):y + r, max(0, x - r):x + r].reshape(-1, 3)
        h = h[h[:, 2] > 130]
        if not len(h):
            return None
        # the label's anti-aliased text darkens the median: the light end (80th percentile) is the fill
        s, v = np.median(h[:, 1]), np.percentile(h[:, 2], 80)
        if s < 35 and v < 225:
            return 'grey'
        if s < 35:
            return 'white'
        return None

    # plot colours kept for the style vote: saturation above plot_min_sat, hue outside the trees' range
    # (plot_tree_hue); Venera's legend has a pale blue (SERENE, S 36) and a teal (NASH, hue 94) style
    min_sat = cfg.get('plot_min_sat', 40); tree_lo, tree_hi = cfg.get('plot_tree_hue', [30, 95])

    rechecked = set(cfg.get('map_beds_rechecked', {}).get('units', []))

    def row_design(nums):
        # coloured plot area around the terrace (gardens, driveways): every coloured pixel within ~1.3 pitch
        # of the row votes for the nearest legend colour
        votes = Counter()
        for n in nums:
            x, y = px(U[n]['p']); r = int(1.3 * pitch * k)
            sub_h = hsv[max(0, y - r):y + r, max(0, x - r):x + r].reshape(-1, 3)
            sub_l = lab[max(0, y - r):y + r, max(0, x - r):x + r].reshape(-1, 3)
            keep = (sub_h[:, 1] > min_sat) & (sub_h[:, 2] > 120) & ~((sub_h[:, 0] > tree_lo) & (sub_h[:, 0] < tree_hi))  # not trees / grass
            c = sub_l[keep]
            if not len(c):
                continue
            dist = np.linalg.norm(c[:, None, :] - L[None, :, :], axis=2)
            near = dist.argmin(1); ok = dist.min(1) < 40
            for i in near[ok]:
                votes[names[i]] += 1
        if not votes:
            return None, 0
        (best, nb), = votes.most_common(1)
        return best, round(nb / sum(votes.values()), 2)

    def unit_design(n):
        # one home's own plot colour (projects whose terraces mix styles, e.g. Elora: MOON ends, MYSK middles)
        votes = Counter()
        x, y = px(U[n]['p']); r = int(0.75 * pitch * k)
        sub_h = hsv[max(0, y - r):y + r, max(0, x - r):x + r].reshape(-1, 3)
        sub_l = lab[max(0, y - r):y + r, max(0, x - r):x + r].reshape(-1, 3)
        keep = (sub_h[:, 1] > 25) & (sub_h[:, 2] > 110) & ~((sub_h[:, 0] > 35) & (sub_h[:, 0] < 95) & (sub_h[:, 1] > 60))
        c = sub_l[keep]
        if len(c):
            dist = np.linalg.norm(c[:, None, :] - L[None, :, :], axis=2)
            near = dist.argmin(1); ok = dist.min(1) < 40
            for i in near[ok]:
                votes[names[i]] += 1
        return votes.most_common(1)[0][0] if votes else None

    alias = cfg.get('plex_alias', {})
    per_unit = cfg.get('design_per_unit', False)
    design_mismatch = []
    cell_beds = cfg.get('cell_beds', {'grey': 4, 'white': 3})
    filled = set(raw.get('filled', [])); grey_cell = set(raw.get('grey_end_cell', []))
    mism, unplanned, low_conf = [], [], []
    designs, beds_count, plan_count = Counter(), Counter(), Counter()
    for r in sp['rows']:
        nums = r['unitNumbers']; n = len(nums)
        design, share = row_design(nums)
        if share < 0.6:
            low_conf.append({'units': [nums[0], nums[-1]], 'design': design, 'share': share})
        ups = []
        for i, no in enumerate(nums):
            th = i + 1
            ck = cell_kind(no)
            mb = cell_beds.get(ck) if ck else None
            dz = (unit_design(no) or design) if per_unit else design
            pl = None
            for key in [str(n)] + alias.get(str(n), []):
                pl = plans.get(dz, {}).get(f'{key}-{th}')
                if pl:
                    break
            if pl is None and per_unit:
                # the floor plans list this position under the other style: the sheet decides, the map colour
                # disagreement is recorded
                for d2 in names:
                    for key in [str(n)] + alias.get(str(n), []):
                        if plans.get(d2, {}).get(f'{key}-{th}'):
                            pl = plans[d2][f'{key}-{th}']; design_mismatch.append({'no': no, 'map_style': dz, 'plan_style': d2, 'plex': n, 'th': th}); dz = d2
                            break
                    if pl:
                        break
            src = 'interpolated' if U[no].get('interp') else 'grey end cell' if no in grey_cell else 'second reading' if no in filled else 'read'
            up = {'no': no, 'th': th, 'plex': n, 'design': dz, 'position': 'end' if th in (1, n) else 'mid', 'number': src}
            if pl:
                up.update({'beds': pl['beds'], 'plan': pl['plan'] + (' mirrored' if pl['mirrored'] else ''), 'page': pl['page'],
                           'sqft': pl['sqft'], 'sqm': pl['sqm']})
                plan_count[f"{dz} {pl['beds']} BR {pl['plan']}"] += 1
                if mb is None and no in rechecked and cfg.get('map_beds_rechecked', {}).get('covers_unread'):
                    # the automatic reader found no cell colour; the cell was looked at by eye (map_beds_rechecked)
                    up['map_beds_auto'] = None; mb = pl['beds']
                if mb is not None and mb != pl['beds'] and no in rechecked:
                    # cell colour looked at by eye on the map (config map_beds_rechecked): it shows the sheet's type;
                    # the automatic reading missed the cell
                    up['map_beds_auto'] = mb; mb = pl['beds']
                if mb is not None and mb != pl['beds']:
                    mism.append({'no': no, 'map_beds': mb, 'plan_beds': pl['beds'], 'th': th, 'plex': n})
                    if cfg.get('map_beds_win'):
                        # the map shows another type than the sheet published for this position: the map's
                        # bedrooms are kept and no plan is linked (no sheet for that type at that position)
                        up.update({'beds': mb, 'plan': None, 'page': None, 'sqft': None, 'sqm': None, 'note': 'type on the map differs from the published position sheet'})
            else:
                up.update({'beds': mb, 'plan': None, 'page': None, 'sqft': None, 'sqm': None})
                unplanned.append({'no': no, 'plex': n, 'th': th, 'design': dz})
            up['map_beds'] = mb
            ups.append(up)
            designs[dz] += 1; beds_count[up['beds']] += 1
        r['unitPlans'] = ups
    total = sum(len(r['unitNumbers']) for r in sp['rows'])
    nums = [x for r in sp['rows'] for x in r['unitNumbers']]
    sp['source']['floorplans'] = plans.get('_source', {}).get('document')
    sp['checks'].update({
        'units': total, 'numbers_unique': len(set(nums)), 'duplicates': sorted(x for x, c in Counter(nums).items() if c > 1),
        'designs': dict(designs), 'beds': {str(b): c for b, c in beds_count.items()}, 'plans': dict(plan_count),
        'type_matches_colour_map': f'{total - len(mism) - sum(1 for r in sp["rows"] for u in r["unitPlans"] if u["map_beds"] is None)}/{total}',
        'type_mismatches': mism, 'map_colour_unread': [u['no'] for r in sp['rows'] for u in r['unitPlans'] if u['map_beds'] is None],
        'without_plan': unplanned, 'design_low_confidence': [] if per_unit else low_conf,
        'style_per_unit': per_unit, 'style_colour_vs_floor_plan_mismatch': design_mismatch,
        'legend_colours_lab': {k2: [round(float(x), 1) for x in v] for k2, v in leg.items()},
    })
    json.dump(sp, open(spath, 'w'), separators=(',', ':'))
    print(f"{proj}: {total} units ({len(set(nums))} unique numbers); designs {dict(designs)}; beds {dict(beds_count)}")
    print(f"  floor plan found for {total - len(unplanned)}/{total}; bedrooms map colour = plan: {sp['checks']['type_matches_colour_map']}"
          f"; mismatches {mism[:8]}; colour unread {sp['checks']['map_colour_unread'][:10]}; low-confidence design rows {[] if per_unit else low_conf}"
          + (f"; style colour vs floor-plan sheet differs for {len(design_mismatch)} homes {design_mismatch[:6]}" if per_unit else ''))


if __name__ == '__main__':
    main()

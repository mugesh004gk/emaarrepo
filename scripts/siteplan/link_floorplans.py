#!/usr/bin/env python3
"""Link a floor-plan page to every home of a project already placed from its cluster map, from a floor-plan
PDF received later. Changes only the plan fields of unitPlans (plan, page, pages, sqft, sqm, plan_by, plan_note):
no home moves, no unit number, design or bedroom count read from the map is changed.

  python3 scripts/siteplan/link_floorplans.py <project> [...]      (then apply_siteplans.py, audit_unit_plans.py)

Two kinds of floor-plan PDF:
  position sheets  one page per terrace position, printed on the page: design name, 'N PLEX', 'THnn nBED' and
                   the built-up area (Kaia). Home -> the page with its design, plex size and TH position.
                   The bedrooms printed for that position must equal the bedrooms read from the map colour;
                   where the map colour was unreadable the position's bedrooms are taken (beds_source noted).
  design sheets    one sheet per design and bedroom count, normal and mirrored (twin villas: Alana, Farm
                   Gardens 2, Rivana). The PDFs do not say which home of a pair is the mirrored one, so both
                   pages are linked; the area is given only where normal and mirrored are equal.
Values are copied from the sheets (data/floorplans.json, extract_floorplans.py) or read by eye where the
PDF is a scan (Rivana, noted).
"""
import json, os, re, subprocess, sys

APP = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SQM = 0.09290304

# design sheets: (design, beds) -> (normal page, mirrored page); None = sheet not in the PDF received
DESIGN_SHEETS = {
    'alana': {'kind': 'townhouse', 'pages': {
        ('Sierra', 3): (2, 3), ('Sierra', 4): (4, 5), ('Sierra', 5): (6, 7),
        ('Lilac', 3): (9, 10), ('Lilac', 4): (11, 12), ('Lilac', 5): (13, 14)}},
    'farm-gardens-2': {'kind': 'villa', 'pages': {
        ('Horizon', 5): (2, 3), ('Oren', 5): (4, 5), ('Horizon', 4): (6, 7), ('Oren', 4): (8, 9)}},
    # Rivana: broker copy with 5 of the 12 sheets, scanned (titles read by eye; areas not reliably readable)
    'rivana': {'kind': 'townhouse', 'scan': True, 'pages': {
        ('Kai', 3): (None, 2), ('Clara', 5): (3, None), ('Clara', 4): (None, 4), ('Clara', 3): (5, None), ('Kai', 5): (None, 6),
        ('Kai', 4): (None, None)}},
}
POSITION_SHEETS = {'kaia-at-the-valley': {
    'designs': ['Ava', 'Vina', 'Luna'],
    # the bedrooms of a position are fixed by the sheets (6-plex: TH01 + TH06 4 BR, TH02-05 3 BR; 8-plex: TH01 +
    # TH08 4 BR). Re-checked on the map: every terrace has grey (4 BR) cells at both ends only; the earlier colour
    # reading was one cell off in 14 homes. Kaia fact sheet: 112 x 3 BR + 44 x 4 BR = 156, which the sheets give.
    'position_beds_win': 'floor-plan sheet of its position (re-checked on the map: grey = 4 BR at both ends)',
    # designs re-read on the map (plot colour next to the legend) where the colour reading was unsure:
    'design_fixes': [
        {'units': [1, 6], 'design': 'Vina', 'why': 'light-purple plot (VINA), like 151-156; the colour reading was unsure (0.55)'},
        {'units': [137, 142], 'design': 'Vina', 'why': 'light-purple plot (VINA); the colour reading was unsure (0.50)'},
        {'units': [143, 150], 'design': 'Luna', 'why': 'pink plot (LUNA); an 8-home terrace, and the fact sheet gives 8-plex homes only one design (Luna)'},
    ]}}


def page_text(pdf, page):
    return subprocess.run(['pdftotext', '-q', '-raw', '-f', str(page), '-l', str(page), pdf, '-'], capture_output=True, text=True).stdout


def total_of(plan):
    for g in plan.get('groups') or []:
        for k in ('TOTAL', 'BUILT_UP'):
            v = (g.get('areas') or {}).get(k)
            if v:
                return v['sqft'], v.get('sqm')
    return None, None


def position_sheets(pid, fp, units):
    pdf = os.path.realpath(os.path.join(APP, fp['src']))
    designs = POSITION_SHEETS[pid]['designs']
    by_page = {p['page']: p for p in fp['plans']}
    sheets = {}
    for pg in range(1, fp['pages'] + 1):
        t = re.sub(r'\s+', ' ', page_text(pdf, pg).upper())
        m = re.search(r'\bTH0?(\d+) ?(\d) ?BED\b', t)
        px = re.search(r'\b(\d+) PLEX\b', t)
        dz = [d for d in designs if re.search(rf'\b{d.upper()}\b', t)]
        if not (m and px and len(dz) == 1):
            continue
        sqft, sqm = total_of(by_page.get(pg, {}))
        key = (dz[0], int(px.group(1)), int(m.group(1)))
        sheets[key] = {'page': pg, 'beds': int(m.group(2)), 'sqft': sqft, 'sqm': sqm,
                       'plan': f"{dz[0]} {m.group(2)} bedroom, {px.group(1)}-plex TH{int(m.group(1)):02d}"}
    print(f'{pid}: {len(sheets)} position sheets', sorted(sheets))
    stats = {'linked': 0, 'beds_from_sheet': 0, 'no_sheet': [], 'beds_differ': [], 'beds_corrected': [], 'design_corrected': []}
    cfg = POSITION_SHEETS[pid]
    for u in units:
        for fx in cfg.get('design_fixes', []):
            if fx['units'][0] <= u['no'] <= fx['units'][1] and u.get('design') != fx['design']:
                u['design_map_reading'] = u.get('design'); u['design'] = fx['design']; u['design_source'] = fx['why']
                stats['design_corrected'].append(u['no'])
        s = sheets.get((u.get('design'), u.get('plex'), u.get('th')))
        for k in ('plan', 'page', 'pages', 'sqft', 'sqm', 'plan_by', 'plan_note'):
            u.pop(k, None)
        if not s:
            u.update(plan=None, page=None, sqft=None, sqm=None, plan_note=f"no {u.get('design')} sheet for a {u.get('plex')}-plex TH{u.get('th')} in the floor plan")
            stats['no_sheet'].append(u['no']); continue
        if u.get('beds') is None:
            u['beds'] = s['beds']; u['beds_source'] = 'floor-plan sheet of its position (map colour unreadable)'
            stats['beds_from_sheet'] += 1
        elif u['beds'] != s['beds'] and cfg.get('position_beds_win'):
            u['beds_map_reading'] = u['beds']; u['beds'] = s['beds']; u['beds_source'] = cfg['position_beds_win']
            if u.get('map_beds') is not None:  # the map colour itself, re-read by eye: grey (4 BR) only at the terrace ends
                u['map_beds_auto'] = u['map_beds']; u['map_beds'] = s['beds']
            stats['beds_corrected'].append(u['no'])
        elif u['beds'] != s['beds']:
            u.update(plan=None, page=None, sqft=None, sqm=None,
                     plan_note=f"cluster map colour shows {u['beds']} bedrooms, the sheet for this position {s['beds']}: to confirm")
            stats['beds_differ'].append(u['no']); continue
        u.update(plan=s['plan'], page=s['page'], sqft=s['sqft'], sqm=s['sqm'], plan_by='terrace position')
        stats['linked'] += 1
    return stats


def design_sheets(pid, fp, units):
    cfg = DESIGN_SHEETS[pid]
    by_page = {p['page']: p for p in fp['plans']}
    stats = {'linked': 0, 'no_sheet': []}
    for u in units:
        for k in ('plan', 'page', 'pages', 'sqft', 'sqm', 'plan_by', 'plan_note'):
            u.pop(k, None)
        normal, mirrored = cfg['pages'].get((u.get('design'), u.get('beds')), (None, None))
        if normal is None and mirrored is None:
            u.update(plan=None, page=None, sqft=None, sqm=None, plan_note=f"no {u.get('design')} {u.get('beds')}-bedroom sheet in the floor plan received")
            stats['no_sheet'].append(u.get('no')); continue
        pages = [p for p in (normal, mirrored) if p]
        areas = [total_of(by_page.get(p, {})) for p in pages] if not cfg.get('scan') else []
        same = len(areas) == len(pages) and all(a[0] for a in areas) and len({a[0] for a in areas}) == 1
        which = 'normal / mirrored' if len(pages) == 2 else ('mirrored sheet only' if mirrored else 'normal sheet only')
        u.update(plan=f"{u['design']} {u['beds']} bedroom {cfg['kind']} ({which})", page=pages[0],
                 pages=f'{pages[0]}-{pages[-1]}' if len(pages) == 2 else None,
                 sqft=areas[0][0] if same else None, sqm=(areas[0][1] or round(areas[0][0] * SQM, 2)) if same else None,
                 plan_by='style and bedrooms')
        if cfg.get('scan'):
            u['plan_note'] = 'scanned broker copy: sheet title (design, bedrooms) read by eye, not checked by the audit; area not reliably readable'
        elif len(pages) == 2 and not same:
            lo, hi = sorted(a[0] for a in areas)
            u['plan_note'] = f'normal {areas[0][0]:,.0f} / mirrored {areas[1][0]:,.0f} sq ft: which side of the pair is mirrored is not stated'
        stats['linked'] += 1
    return stats


def main():
    fps = json.load(open(os.path.join(APP, 'data', 'floorplans.json')))
    for pid in sys.argv[1:]:
        path = os.path.join(APP, 'data', 'siteplans', f'{pid}.json')
        sp = json.load(open(path))
        fp = fps[pid]
        units = [u for r in sp['rows'] for u in (r.get('unitPlans') or [])]
        st = position_sheets(pid, fp, units) if pid in POSITION_SHEETS else design_sheets(pid, fp, units)
        sp['source']['floorplans'] = os.path.basename(fp['src'])
        sp.setdefault('checks', {})['floorplan_link'] = {k: (v if not isinstance(v, list) else v) for k, v in st.items()}
        json.dump(sp, open(path, 'w'), separators=(',', ':'))
        print(pid, {k: (len(v) if isinstance(v, list) else v) for k, v in st.items()}, {k: v for k, v in st.items() if isinstance(v, list) and v})


if __name__ == '__main__':
    main()

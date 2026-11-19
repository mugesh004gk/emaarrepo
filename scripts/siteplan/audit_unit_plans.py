#!/usr/bin/env python3
"""Floor plan per home, checked against the developer's floor-plan PDF - independent of the pipeline that
assigned the plans (it re-reads the PDF pages with pdftotext).

  python3 scripts/siteplan/audit_unit_plans.py      -> data/unit_plan_audit.json (+ summary printed)

For every home of the built Valley properties (Nara + data/siteplans/*.json) the plan page given to it in
the app is checked against that page of the PDF:
  position  the page lists the home's terrace position (e.g. '6 PLEX - TH 02', or 'TH01' on villa sheets)
  beds      the page's bedroom count = the home's
  area      the page's total area for that position (or the sheet's total / built-up area) = the home's
  style     the page names the home's design (Bold, Sleek, Slate, Magnolia...) when the PDF names designs
  map       the cluster map's colour gives the same bedrooms / design (from the cluster-map reading)
Status per home:
  verified    every check that applies passes AND the PDF lists the home's position on that page
  type-match  every check that applies passes, but the PDF does not list positions (villa sheets):
              the plan follows from the design / bedrooms on the cluster map
  check       a check fails - shown with the reason
  no-plan     no plan given (no PDF received, wrong PDF, or the cluster map and the PDF disagree)
"""
import json, os, re, subprocess

APP = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ORDER = ['nara', 'eden', 'orania-at-the-valley', 'elora', 'rivana', 'alana', 'the-farm-gardens', 'farm-gardens-2',
         'kaia-at-the-valley', 'elea-at-the-valley', 'rivera-at-the-valley-phase-2']
NO_PDF = {
    'rivana': 'No floor-plan PDF received: design and bedrooms from the cluster-map legend only',
    'alana': 'No floor-plan PDF received: design and bedrooms from the cluster-map legend only',
    'farm-gardens-2': 'No floor-plan PDF received: design and bedrooms from the cluster-map legend only',
    'kaia-at-the-valley': 'KAIA_floorplan.pdf contains the Elea sheets: no Kaia (Ava / Vina / Luna) floor plans yet',
}
_txt = {}


def page_text(pdf, page, mode=None):
    k = (pdf, page, mode)
    if k not in _txt:
        _txt[k] = subprocess.run(['pdftotext', '-q'] + ([mode] if mode else []) + ['-f', str(page), '-l', str(page), pdf, '-'], capture_output=True, text=True).stdout
    return _txt[k]


POS_RE = re.compile(r'(?<!\d)(\d{1,2})\s*P\s*L\s*E\s*X\s*([A-Z0-9]?)\s*-?\s*T\s*H\s*(\d)\s*(\d)')


def page_positions(pdf, page, plexes):
    """every 'N PLEX - TH nn' on the page; the PDF layout splits and interleaves them, so all three text modes are read"""
    out = set()
    for mode in (None, '-raw', '-layout'):
        for m in POS_RE.finditer(page_text(pdf, page, mode).upper()):
            if int(m.group(1)) in plexes:
                out.add((int(m.group(1)), int(m.group(3) + m.group(4))))
    return out


def squash(s):
    return re.sub(r'[^A-Z0-9.]', '', s.upper())


def subseq(word, text):
    """the word's letters in order within a short stretch of the text (a title whose letters the PDF
    interleaves with another word, e.g. 'S BO O LL ID D'); never across the whole page"""
    span = int(len(word) * 2.5)
    for i, ch in enumerate(text):
        if ch == word[0]:
            it = iter(text[i:i + span])
            if all(c in it for c in word):
                return True
    return False


def min_window(word, text):
    """length of the shortest stretch of text holding the word's letters in order"""
    best = None
    for i, ch in enumerate(text):
        if ch != word[0]:
            continue
        k, j = 0, i
        while j < len(text) and k < len(word):
            if text[j] == word[k]:
                k += 1
            j += 1
        if k == len(word) and (best is None or j - i < best):
            best = j - i
    return best


def page_design(text, designs):
    """the design a floor-plan page is titled with: the name whose letters sit closest together (the PDF
    interleaves title letters, e.g. 'S BO O LL ID D'); None when no name reads clearly"""
    t = squash(text)
    score = {}
    for d in designs:
        w = min_window(squash(d), t)
        if w is not None:
            score[d] = w / len(squash(d))
    if not score:
        return None
    d = min(score, key=score.get)
    return d if score[d] <= 2.5 else None


def names_design(text, design, designs):
    return page_design(text, designs) == design


def parse_pos(s):
    m = re.match(r'\s*(\d+)\s*PLEX\s*([A-Z0-9]*)\s*-\s*TH\s*0*(\d+)', s.upper())
    return (int(m.group(1)), m.group(2), int(m.group(3))) if m else None


def page_beds(text):
    m = re.search(r'(\d)\s*BED\s*ROOM', text.upper().replace(' ', '')) or re.search(r'(\d)BED', text.upper().replace(' ', ''))
    return int(m.group(1)) if m else None


def sheet_area(plan):
    for g in plan.get('groups') or []:
        a = g.get('areas') or {}
        for k in ('TOTAL', 'BUILT_UP'):
            if a.get(k):
                return a[k]['sqft'] if isinstance(a[k], dict) else a[k]
    return None


def sheet_ths(text):
    """villa / townhouse sheets: the TH named right after 'TOTAL AREA' (the key plan lists all of them)"""
    t = re.sub(r'\s+', ' ', text.upper())
    m = re.search(r'TOTAL AREA ((?:TH ?\d+ ?)+)', t)
    return {int(x) for x in re.findall(r'TH ?0*(\d+)', m.group(1))} if m else set()


def audit_unit(u, pdf, plans_by_page, designs, plexes):
    pages = [u['page']] if u.get('page') else []
    if u.get('pages'):
        a, _, b = str(u['pages']).partition('-')
        pages = list(range(int(a), int(b or a) + 1))
    ck = {}
    listed = False
    if not pages:
        return 'no-plan', ck, u.get('note') or 'no plan page'
    # position + area on the page's table
    rows = [(parse_pos(r['unit']), r.get('sqft')) for p in pages for r in (plans_by_page.get(p, {}).get('rows') or [])]
    rows = [(q, a) for q, a in rows if q]
    ths = set().union(*(sheet_ths(page_text(pdf, p)) for p in pages))
    # a sheet that names its own TH under TOTAL AREA (Elea) is read that way; its key plan lists every TH
    text_pos = set().union(*(page_positions(pdf, p, plexes) for p in pages)) if u.get('plex') and u.get('th') and not ths else set()
    if (rows or text_pos) and u.get('plex') and u.get('th'):
        hit = [a for q, a in rows if q[0] == u['plex'] and q[2] == u['th']]
        on_page = bool(hit) or (u['plex'], u['th']) in text_pos
        ck['position'] = on_page
        listed = on_page
        if hit and u.get('sqft'):
            ck['area'] = any(a and abs(a - u['sqft']) < 0.6 for a in hit)
    else:
        if ths and u.get('th'):
            ck['position'] = u['th'] in ths
            listed = ck['position']
        sa = [sheet_area(plans_by_page[p]) for p in pages if p in plans_by_page]
        sa = [a for a in sa if a]
        if sa and u.get('sqft'):
            ck['area'] = any(abs(a - u['sqft']) < 0.6 for a in sa)
    pb = [plans_by_page[p].get('beds') if p in plans_by_page else page_beds(page_text(pdf, p)) for p in pages]
    pb = [b for b in pb if b]
    if pb and u.get('beds'):
        ck['beds'] = u['beds'] in pb
    if u.get('design') and len(designs) > 1:
        named = [names_design(page_text(pdf, p), u['design'], designs) for p in pages]
        any_named = any(page_design(page_text(pdf, p), designs) for p in pages)
        if any_named:
            ck['style'] = any(named)
    if u.get('map_beds') is not None and u.get('beds'):
        ck['map'] = u['map_beds'] == u['beds']
    bad = [k for k, v in ck.items() if v is False]
    if bad:
        why = {'position': 'its terrace position is not listed on that PDF page', 'beds': 'bedrooms differ from the PDF page',
               'area': 'area differs from the PDF page', 'style': 'the PDF page is for another design',
               'map': 'cluster-map colour gives other bedrooms'}
        return 'check', ck, '; '.join(why[k] for k in bad)
    return ('verified' if listed else 'type-match'), ck, None


def main():
    fps = json.load(open(os.path.join(APP, 'data', 'floorplans.json')))
    out = {}
    for pid in ORDER:
        fp = fps.get(pid)
        pdf = os.path.join(APP, fp['src']) if fp else None
        plans_by_page = {p['page']: p for p in fp['plans']} if fp else {}
        if pid == 'nara':
            nd = json.load(open(os.path.join(APP, 'data', 'nara_data.json')))
            units = []
            for x in nd['units']:
                plex = int(re.match(r'\d+', x['plex']).group())
                # Nara keeps no page: the page is the one whose table lists this position with this area
                pg = None
                for p in fp['plans']:
                    for r in p.get('rows') or []:
                        q = parse_pos(r['unit'])
                        if q and q[0] == plex and q[2] == x['th'] and r.get('sqft') and abs(r['sqft'] - x['buaSqft']) < 0.6 and p.get('beds') == x['bedrooms']:
                            pg = pg or p['page']
                units.append({'no': x['unit'], 'plex': plex, 'th': x['th'], 'design': x['design'], 'beds': x['bedrooms'],
                              'plan': x['planName'], 'page': pg, 'sqft': x['buaSqft']})
        else:
            sp = json.load(open(os.path.join(APP, 'data', 'siteplans', f'{pid}.json')))
            units = [u for r in sp['rows'] for u in (r.get('unitPlans') or []) if u.get('no') is not None]
            # homes whose cluster-map colour and the PDF's sheet for their position disagree: say what each one says
            for m in sp.get('checks', {}).get('type_mismatches') or []:
                for u in units:
                    if u['no'] == m.get('no') and not u.get('plan'):
                        u['note'] = (f"Cluster map colour shows {m['map_beds']} bedrooms, but the PDF sheet for TH{m['th']:02d} of a "
                                     f"{m['plex']}-plex is {m['plan_beds']} bedrooms: bedroom count to confirm")
        designs = sorted({u['design'] for u in units if u.get('design')})
        plexes = {u['plex'] for u in units if u.get('plex')}
        recs = []
        for u in sorted(units, key=lambda v: v['no']):
            if pid in NO_PDF or not fp:
                st, ck, why = 'no-plan', {}, NO_PDF.get(pid, 'no floor-plan PDF')
            else:
                st, ck, why = audit_unit(u, pdf, plans_by_page, designs, plexes)
                if st == 'no-plan' and u.get('note'):
                    why = u['note']
            pos = f"{u['plex']}-plex TH{u['th']:02d}" if u.get('plex') and u.get('th') else (u.get('position') or '')
            recs.append({'no': u['no'], 'design': u.get('design'), 'beds': u.get('beds'), 'position': pos,
                         'plan': u.get('plan'), 'page': u.get('pages') or u.get('page'), 'sqft': u.get('sqft'),
                         'status': st, 'checks': ck, 'why': why})
        cnt = {s: sum(1 for r in recs if r['status'] == s) for s in ('verified', 'type-match', 'check', 'no-plan')}
        # plan types: which homes use which PDF page, and what the PDF says about that page
        types = {}
        for r in recs:
            if not r['page']:
                continue
            k = (r['design'], r['plan'], str(r['page']))
            t = types.setdefault(k, {'design': r['design'], 'plan': r['plan'], 'page': r['page'], 'beds': r['beds'], 'sqft': set(), 'homes': 0, 'positions': set()})
            t['homes'] += 1
            if r['sqft']: t['sqft'].add(r['sqft'])
            if r['position']: t['positions'].add(r['position'])
        tl = [dict(t, sqft=sorted(t['sqft']), positions=sorted(t['positions'])) for t in types.values()]
        tl.sort(key=lambda t: (str(t['design']), int(str(t['page']).split('-')[0])))
        out[pid] = {'pdf': os.path.basename(fp['src']) if fp else None, 'pdfSrc': fp['src'] if fp else None, 'homes': len(recs), 'counts': cnt,
                    'note': NO_PDF.get(pid), 'types': tl, 'units': recs}
        print(f"{pid:30s} homes {len(recs):4d}  " + '  '.join(f'{k} {v}' for k, v in cnt.items()))
        for r in recs:
            if r['status'] == 'check':
                print('   CHECK', r['no'], r['position'], r['design'], r['beds'], r['plan'], 'p', r['page'], r['checks'], r['why'])
    json.dump({'_about': 'Floor plan per home checked against the floor-plan PDF pages (scripts/siteplan/audit_unit_plans.py)', 'properties': out},
              open(os.path.join(APP, 'data', 'unit_plan_audit.json'), 'w'), separators=(',', ':'))


if __name__ == '__main__':
    main()

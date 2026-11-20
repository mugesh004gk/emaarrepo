#!/usr/bin/env python3
"""Step 3 - unit-data audit of every built Valley property, against the developer documents.

  python3 scripts/siteplan/audit_unit_data.py    (after audit_unit_plans.py and floorplan_rooms.py)
      -> data/unit_data_audit.json  (+ summary printed)

Per home:
  number    how the number is known: read on the cluster map (PDF text / OCR / by eye) or inferred
            (interpolated in a terrace's sequence, grey end cell, terrace numbered from the plan by hand)
  order     the row's numbers run the same way in 3D as on the map (check_order.py)
  beds      bedrooms from the floor-plan sheet; the maid's room is NOT a bedroom
  maid      maid's room printed on the home's own floor-plan sheet page (data/floorplan_rooms.json):
            true / false / null (sheet not readable - unresolved)
  design    design name (cluster-map legend colour / floor-plan sheet)
  bua       built-up area from the floor-plan sheet (checked against the sheet's table where it has one)
  plot      plot area - only where a source gives it per home (Nara unit list); fact sheets give min / max only
  plan      floor-plan page mapping (audit_unit_plans.py: verified / type-match / check / no-plan)
Status per home (worst applies):
  client    client confirmation required: documents disagree, or the number / bedrooms cannot be read
  missing   source missing: the sheet for this home was not received or cannot be read
  provisional  data agree but one item is inferred (number interpolated, plan chosen by design because the
            PDF does not list positions, mirrored twin sheet not stated)
  verified  every item read from a developer document and cross-checked
Per property: totals against the official count, bedroom mix against the fact sheet.
"""
import json, os, subprocess, sys
from collections import Counter

APP = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(APP, 'scripts', 'siteplan'))
import audit_unit_plans as aup  # noqa: E402

FS = 'media/research/the-valley/properties/{}/factsheet/{}'
FACT = {  # bedroom mix printed on the developer fact sheet
    'nima': ({3: 362, 4: 158}, FS.format('nima', 'NIMA_THE_VALLEY_FACTSHEET.pdf')),
    'vindera-at-the-valley': ({3: 352, 4: 226}, FS.format('vindera-at-the-valley', 'VINDERA_THE_VALLEY_FACT_SHEET.pdf')),
    'elva-at-the-valley': ({3: 122, 4: 122}, FS.format('elva-at-the-valley', 'ELVA_THE_VALLEY_FACTSHEET.pdf')),
    'velora-2-at-the-valley-phase-2': ({3: 156, 4: 156}, FS.format('velora-2-at-the-valley-phase-2', 'VELORA2_TV_FACT_SHEET.pdf')),
    'kaia-at-the-valley': ({3: 112, 4: 44}, FS.format('kaia-at-the-valley', 'KAIA_THE_VALLEY_FACTSHEET.pdf')),
    'elea-at-the-valley': ({3: 64, 4: 64}, FS.format('elea-at-the-valley', 'ELEA_THE_VALLEY_FACTSHEET.pdf') + ' (3 BR 64 printed; total 128)'),
    'lillia': ({3: 278, 4: 128}, FS.format('lillia', 'LILLIA_TV_FACT_SHEET.pdf')),
    'rivera-at-the-valley-phase-2': ({4: 378}, FS.format('rivera-at-the-valley-phase-2', 'RIVERA_THE_VALLEY_FACT_SHEET.pdf')),
    'the-farm-gardens': ({4: 79, 5: 67}, FS.format('the-farm-gardens', 'FARM GARDENS_FACT_SHEET.pdf')),
    'farm-grove-at-the-valley': ({4: 91 + 68 + 275, 5: 48}, FS.format('farm-grove-at-the-valley', 'FARMGROVE_THE_VALLEY_FACTSHEET.pdf') + ' (4 BR: 91 stand-alone + 68 semi-detached + 275 detached; 5 BR 48 stand-alone)'),
}
INFERRED = {'interpolated': 'interpolated in the terrace sequence', 'grey end cell': 'grey end cell (label not printed)'}
NUMBER_SOURCE = {  # how the numbers of properties without a per-home 'number' field were read
    'nara': 'official unit list (Nara site data)', 'eden': 'OCR of the cluster map (EDEN_floorplan.pdf p.2)',
    'alana': 'OCR of the cluster map (brochure p.16)', 'rivana': 'OCR of the cluster map (brochure p.8)',
    'the-farm-gardens': 'OCR of the cluster map (brochure p.24)', 'farm-gardens-2': 'OCR of the cluster map (brochure p.25)',
    'rivera-at-the-valley-phase-2': 'OCR of the cluster map (RIVERA_TV_CLUSTER_MAP.pdf)',
    'farm-grove-at-the-valley': 'read by eye on the cluster map (all 482 labels, OCR cross-check)',
    'avena-at-the-valley': 'PDF text layer of the cluster map (all 322 labels)',
    'nima': 'read by eye on the cluster map (79 terrace number runs, OCR cross-check)',
}


def order_check(pid):
    if pid == 'nara':
        return 'official unit list: rows from the Nara survey'
    if pid == 'eden':
        return ('not machine-checked (Eden built by build_eden.py): numbers from OCR of the cluster map along each terrace; '
                '7 terraces numbered by hand from the plan (manual_fixes)')
    r = subprocess.run([sys.executable, os.path.join(APP, 'scripts', 'siteplan', 'clustermap', 'check_order.py'), pid],
                       capture_output=True, text=True)
    line = (r.stdout.strip().splitlines() or [r.stderr.strip()[-200:]])[-1]
    if 'same way as the map 0, mirrored 0' in line:
        return 'single villas: no row order to check'
    return line.split(': ', 1)[-1]


def main():
    subprocess.run([sys.executable, os.path.join(APP, 'scripts', 'siteplan', 'audit_unit_plans.py')], check=True, capture_output=True)
    plan_audit = json.load(open(os.path.join(APP, 'data', 'unit_plan_audit.json')))['properties']
    rooms = json.load(open(os.path.join(APP, 'data', 'floorplan_rooms.json')))
    counts = json.load(open(os.path.join(APP, 'data', 'unit_counts.json')))['projects']
    nara = {u['unit']: u for u in json.load(open(os.path.join(APP, 'data', 'nara_data.json')))['units']}
    out = {}
    for pid in aup.ORDER:
        pa = plan_audit[pid]
        rp = (rooms.get(pid) or {}).get('pages', {})
        # per-home source fields from the site plan
        src, low_design, mism, unread_colour, checks = {}, set(), {}, set(), {}
        if pid != 'nara':
            sp = json.load(open(os.path.join(APP, 'data', 'siteplans', f'{pid}.json')))
            checks = sp.get('checks') or {}
            for r in sp['rows']:
                for u in r.get('unitPlans') or []:
                    if u.get('no') is not None:
                        src[u['no']] = u
            low_design = {x if isinstance(x, int) else x.get('no') for x in checks.get('design_low_confidence') or []}
            mism = {m['no']: m for m in checks.get('type_mismatches') or []}
            unread_colour = set(checks.get('map_colour_unread') or [])
        manual = set()
        for f in (checks.get('manual_fixes') or {}).values():
            if f.get('first') is not None:
                manual |= {f['first'] + f['dir'] * i for i in range(f['n'])}
        recs = []
        for pu in pa['units']:
            n = pu['no']; s = src.get(n, {}); flags = {'client': [], 'missing': [], 'provisional': []}
            # number
            how = s.get('number')
            if how in INFERRED:
                num = INFERRED[how]; flags['provisional'].append('number ' + num)
            elif n in manual:
                num = 'terrace numbered from the plan by hand (OCR read no digits)'; flags['provisional'].append('number from the terrace sequence')
            else:
                num = 'read' + (f' ({how})' if how and how != 'read' else '') if how else NUMBER_SOURCE.get(pid, 'read')
            # maid, from the home's own sheet page(s)
            pages = []
            if pu['page']:
                a, _, b = str(pu['page']).partition('-'); pages = list(range(int(a), int(b or a) + 1))
            mv = [rp.get(str(p), {}).get('maid') for p in pages]
            maid = True if any(v is True for v in mv) else (False if mv and all(v is False for v in mv) else None)
            hows = [rp.get(str(p), {}).get('how', '') for p in pages]
            if pages and maid is None:
                eye = [h for h in hows if h.startswith('read by eye')]
                if eye:
                    flags['client'].append("maid's room: " + eye[0].split(' - ', 1)[-1])
                else:
                    flags['missing'].append("maid's room: floor-plan sheet not readable")
            # plan mapping
            st = pu['status']
            if st == 'check':
                flags['client'].append(pu['why'] or 'floor plan disagrees with the PDF')
            elif st == 'no-plan':
                (flags['client'] if n in mism else flags['missing']).append(pu['why'] or 'no floor-plan sheet')
            elif st == 'type-match':
                flags['provisional'].append('plan chosen by design / bedrooms (PDF sheet does not list unit numbers)'
                                            + (f"; {pu['why']}" if pu.get('why') and 'mirrored is not stated' not in pu['why'] else ''))
            if n in mism and st != 'no-plan':
                flags['client'].append(f"cluster-map colour {mism[n]['map_beds']} BR vs sheet {mism[n]['plan_beds']} BR")
            if not pu['beds']:
                flags['client'].append('bedrooms not readable on the cluster map')
            if n in unread_colour and pu['beds']:
                flags['provisional'].append('cluster-map colour unread; bedrooms from the terrace position sheet')
            if n in low_design:
                flags['provisional'].append('design colour reading unsure')
            if not pu['sqft'] and st not in ('no-plan',):
                if 'mirrored is not stated' in (pu.get('why') or ''):
                    flags['client'].append('built-up area: ' + pu['why'].replace('which side of the pair is mirrored is not stated', 'which home of the twin is the mirrored sheet - client to confirm'))
                else:
                    flags['missing'].append('built-up area not readable on the sheet')
            plot = nara[n]['plotSqft'] if pid == 'nara' and n in nara else None
            status = 'client' if flags['client'] else 'missing' if flags['missing'] else 'provisional' if flags['provisional'] else 'verified'
            recs.append({'no': n, 'number': num, 'design': pu['design'], 'beds': pu['beds'], 'maid': maid,
                         'config': (f"{pu['beds']} Bedroom" + (' + Maid' if maid else '')) if pu['beds'] else None,
                         'position': pu['position'], 'plan': pu['plan'], 'page': pu['page'], 'bua_sqft': pu['sqft'],
                         'bua_checked': pu['checks'].get('area'), 'plot_sqft': plot, 'plan_status': st,
                         'status': status, 'issues': [x for k in ('client', 'missing', 'provisional') for x in flags[k]]})
        # property level
        off = counts.get(pid, {})
        nos = [r['no'] for r in recs]
        dup = sorted(k for k, v in Counter(nos).items() if v > 1)
        total = off.get('total')
        missing_nos = sorted(set(range(1, total + 1)) - set(nos)) if total else []
        beds = Counter(r['beds'] for r in recs)
        fact = FACT.get(pid)
        mix = None
        if fact:
            mix = {'fact_sheet': fact[0], 'app': {k: beds.get(k, 0) for k in fact[0]}, 'source': fact[1],
                   'agrees': all(beds.get(k, 0) == v for k, v in fact[0].items())}
        placed = (checks.get('units') or len(recs)) if pid != 'nara' else len(nara)
        out[pid] = {
            'official_total': total, 'official_source': off.get('source'), 'placed': placed, 'numbered': len(recs),
            'numbers_unique': len(set(nos)) == len(nos), 'duplicates': dup, 'numbers_missing': missing_nos,
            'order': order_check(pid), 'bed_mix': mix, 'beds': {str(k): v for k, v in sorted(beds.items(), key=lambda x: str(x[0]))},
            'maid': {str(k): v for k, v in Counter(r['maid'] for r in recs).items()},
            'designs': dict(Counter(r['design'] for r in recs)), 'floorplan_pdf': pa['pdfSrc'], 'cluster_map': (checks and sp['source'].get('document')) or 'nara_data.json',
            'plan_counts': pa['counts'], 'note': pa.get('note'),
            'status': dict(Counter(r['status'] for r in recs)), 'units': recs}
        o = out[pid]
        print(f"{pid[:28]:28s} {o['numbered']:4d}/{total}  " + ' '.join(f'{k} {v}' for k, v in o['status'].items())
              + f"  maid {o['maid']}  mix {'ok' if mix and mix['agrees'] else (mix and mix['app']) or '-'} vs {mix and mix['fact_sheet']}  dup {dup} miss {len(missing_nos)}")
    json.dump({'_about': 'Step 3 unit-data audit (scripts/siteplan/audit_unit_data.py): every home checked against the developer documents',
               'properties': out}, open(os.path.join(APP, 'data', 'unit_data_audit.json'), 'w'), separators=(',', ':'))


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Unit numbers from a cluster map's text layer when the labels are set at many angles (Vindera): pdftotext
splits turned labels into separate glyphs, so the numbers are read with PyMuPDF (each text span with its own
direction), and each label's position is the centre of its characters. Exact, no OCR.
  python extract_text_rotated.py <project> <map.pdf> [page]   -> data/siteplans/<project>/units_raw.json"""
import json, math, os, re, sys
from collections import Counter
import fitz
import numpy as np
APP = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
proj, pdf = sys.argv[1], sys.argv[2]; page = int(sys.argv[3]) if len(sys.argv) > 3 else 1
d = os.path.join(APP, 'data', 'siteplans', proj); cfg = json.load(open(os.path.join(d, 'config.json')))
N = cfg['count']
pg = fitz.open(pdf)[page - 1]
U, angles = {}, {}
for b in pg.get_text('rawdict')['blocks']:
    for ln in b.get('lines', []):
        for sp in ln['spans']:
            t = ''.join(c['c'] for c in sp['chars']).strip()
            if re.fullmatch(r'\d{1,3}', t) and 1 <= int(t) <= N:
                cs = [((c['bbox'][0] + c['bbox'][2]) / 2, (c['bbox'][1] + c['bbox'][3]) / 2) for c in sp['chars'] if c['c'].strip()]
                n = int(t)
                if n in U:
                    print('duplicate label', n)
                U[n] = [round(float(np.mean([p[0] for p in cs])), 2), round(float(np.mean([p[1] for p in cs])), 2)]
                angles[n] = round(math.degrees(math.atan2(ln['dir'][1], ln['dir'][0])))
dd = sorted(math.dist(U[n], U[n + 1]) for n in U if n + 1 in U)
pitch = float(np.median([x for x in dd if x < 3 * dd[len(dd) // 2]]))
out = {'project': proj, 'source': {'document': os.path.basename(pdf), 'page': page}, 'frame': 'pdf-points',
       'size': [pg.rect.width, pg.rect.height], 'image_index': None, 'pitch': pitch, 'count': N, 'read': len(U),
       'missing': [n for n in range(1, N + 1) if n not in U], 'units': {str(k): v for k, v in sorted(U.items())},
       'label_angles': {str(k): v for k, v in sorted(angles.items())}, 'method': 'PDF text layer (PyMuPDF spans with direction)'}
json.dump(out, open(os.path.join(d, 'units_raw.json'), 'w'))
print(f'{proj}: {len(U)} of {N} labels from the text layer; missing {out["missing"]}; pitch {pitch:.2f} pt; angles {Counter(angles.values()).most_common(4)}')

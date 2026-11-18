#!/usr/bin/env python3
"""Where the map picture's own labels are, relative to the PDF's text layer.

  python scripts/siteplan/clustermap/text_raster.py <project> <brochure.pdf> <page>

Some brochures (Elora) carry the unit numbers twice: drawn in the map picture and as a text layer that is
not drawn exactly over it (a different scale / offset). Positions are read from the text (exact), the
colours from the picture. The picture's labels are read with the OCR (extract_units.from_image), matched
to the text by number, and an affine transform text -> picture is fitted (robust: 3 rounds, outliers over
3 pt dropped). Written to data/siteplans/<project>/text_to_raster.json; the unit positions in
units_raw.json are then given in the picture's frame (text positions kept as 'units_text'), so the layout,
the placement and the colour sampling all use the picture's geometry.
"""
import json, os, sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from extract_units import from_image  # noqa: E402

APP = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))


def main():
    proj, pdf, page = sys.argv[1], sys.argv[2], int(sys.argv[3])
    d = os.path.join(APP, 'data', 'siteplans', proj)
    rpath = os.path.join(d, 'units_raw.json')
    raw = json.load(open(rpath))
    T = {int(k): np.array(v) for k, v in raw.get('units_text', raw['units']).items()}
    hits, _ = from_image(pdf, page, None, passes=((400, (0,)),))
    # each OCR number: the reading nearest to where most readings of it agree
    by = {}
    for n, x, y in hits:
        if n in T:
            by.setdefault(n, []).append((x, y))
    src, dst = [], []
    for n, ps in by.items():
        ps = np.array(ps)
        med = np.median(ps, 0)
        src.append(T[n]); dst.append(ps[np.argmin(np.hypot(*(ps - med).T))])
    src, dst = np.array(src), np.array(dst)
    keep = np.ones(len(src), bool)
    for _ in range(3):
        X = np.column_stack([src[keep], np.ones(keep.sum())])
        A, *_ = np.linalg.lstsq(X, dst[keep], rcond=None)
        res = np.hypot(*(np.column_stack([src, np.ones(len(src))]) @ A - dst).T)
        keep = res < max(3.0, np.percentile(res[keep], 80))
    out = {'A': A.T.round(6).tolist(), 'matched': int(keep.sum()), 'read': len(src), 'residual_median_pt': round(float(np.median(res[keep])), 2),
           'note': 'picture = A @ [x_text, y_text, 1] (page points)'}
    json.dump(out, open(os.path.join(d, 'text_to_raster.json'), 'w'), indent=1)
    # the picture is what the map shows (its labels sit in their homes): unit positions are moved into the
    # picture's frame; the text-layer positions are kept as 'units_text'
    raw['units_text'] = {str(n): [round(float(v[0]), 2), round(float(v[1]), 2)] for n, v in sorted(T.items())}
    raw['units'] = {str(n): [round(float(q), 2) for q in (np.array([*v, 1.0]) @ A)] for n, v in sorted(T.items())}
    raw['frame'] = 'map picture (page points); text layer mapped by text_to_raster.json'
    raw.setdefault('pitch_text', raw['pitch'])
    raw['pitch'] = float(raw['pitch_text'] * (abs(A[0, 0]) + abs(A[1, 1])) / 2)
    json.dump(raw, open(rpath, 'w'))
    print(f"{proj}: text -> picture affine from {out['matched']}/{len(src)} labels, median residual {out['residual_median_pt']} pt; A = {out['A']}")


if __name__ == '__main__':
    main()

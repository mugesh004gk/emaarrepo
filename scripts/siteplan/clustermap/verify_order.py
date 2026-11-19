#!/usr/bin/env python3
"""Check (and correct) the direction of every terrace's numbering by reading its labels again, terrace by
terrace: the map is cut around the terrace and turned so the terrace lies level (and turned the other way, and
upright / sideways for labels set upright in a turned terrace); the number labels read in each crop are mapped
back onto the terrace's line, and the order of the numbers along it decides which end holds the first home.

  python verify_order.py <project> <map.pdf> [page] [--apply]

Only numbers belonging to that terrace count. A terrace is confirmed when at least two of its own numbers are
read in increasing order along its line (or reversed: then it is flipped with --apply). Terraces with fewer than
two readable numbers are reported as unconfirmed (never guessed). Writes 'order_check' into layout.json.
"""
import json, math, os, subprocess, sys, tempfile
import numpy as np
import cv2
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from extract_units import ocr_tile  # noqa: E402

APP = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
DPI = 400


def main():
    proj, pdf = sys.argv[1], sys.argv[2]
    page = int(sys.argv[3]) if len(sys.argv) > 3 and not sys.argv[3].startswith('--') else 1
    apply = '--apply' in sys.argv
    d = os.path.join(APP, 'data', 'siteplans', proj)
    L = json.load(open(os.path.join(d, 'layout.json')))
    U = L['units']; pitch = L['pitch']; k = DPI / 72.0
    td = tempfile.mkdtemp()
    subprocess.run(['pdftoppm', '-q', '-r', str(DPI), '-png', '-f', str(page), '-l', str(page), pdf, os.path.join(td, 'p')], check=True)
    Image.MAX_IMAGE_PIXELS = None
    im = cv2.imread(os.path.join(td, [f for f in os.listdir(td) if f.endswith('.png')][0]))
    res = {}
    for ri, r in enumerate(L['rows']):
        P = np.array([U[str(n)]['p'] for n in r]); ax = np.array(U[str(r[0])]['axis'])
        c = P.mean(0) * k
        half_l = (len(r) / 2 + 0.8) * pitch * k; half_d = 1.3 * pitch * k
        t = math.degrees(math.atan2(ax[1], ax[0]))
        votes = []
        seen = set()
        for rot in (t, t + 180, 0, 90, -90, 180):
            M = cv2.getRotationMatrix2D((float(c[0]), float(c[1])), rot, 1.0)
            W = int(2 * max(half_l, half_d) + 20)
            M[0, 2] += W / 2 - c[0]; M[1, 2] += W / 2 - c[1]
            crop = cv2.warpAffine(im, M, (W, W), flags=cv2.INTER_CUBIC, borderValue=(255, 255, 255))
            Mi = cv2.invertAffineTransform(M)
            img = Image.fromarray(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB))
            img = img.resize((img.width * 2, img.height * 2), Image.LANCZOS)
            hits = [(n, px / 2, py / 2) for n, px, py in ocr_tile(td, img, f'{ri}_{int(rot)}', single_only=False) if n in r]
            pts = []
            for n, x, y in hits:
                q = Mi @ np.array([x, y, 1.0])
                along = (q / k - P.mean(0)) @ ax
                across = (q / k - P.mean(0)) @ np.array([-ax[1], ax[0]])
                if abs(along) < (len(r) / 2 + 0.5) * pitch and abs(across) < 1.2 * pitch:
                    pts.append((n, along))
            ns = sorted({n for n, _ in pts})
            if len(ns) >= 2:
                xs = {}
                for n, a in pts:
                    xs.setdefault(n, []).append(a)
                arr = [(n, float(np.median(v))) for n, v in xs.items()]
                rk = np.corrcoef([a for a, _ in sorted(arr)], [b for _, b in sorted(arr)])[0, 1]
                if not np.isnan(rk) and abs(rk) > 0.8:
                    votes.append((1 if rk > 0 else -1, len(ns)))
                    seen |= set(ns)
        if not votes:
            res[r[0]] = 'unconfirmed'
            continue
        s = sum(v * w for v, w in votes)
        if s == 0:
            res[r[0]] = 'conflicting'
            continue
        res[r[0]] = 'ok' if s > 0 else 'reversed'
        if s < 0 and apply:
            pos = [U[str(n)]['p'] for n in r]
            for n, p in zip(r, reversed(pos)):
                U[str(n)]['p'] = p
                U[str(n)]['axis'] = [-ax[0], -ax[1]]
    L['order_check'] = {str(k_): v for k_, v in res.items()}
    if apply:
        json.dump(L, open(os.path.join(d, 'layout.json'), 'w'))
    from collections import Counter
    print(f'{proj}: {Counter(res.values())}; reversed {[k_ for k_, v in res.items() if v == "reversed"]}; '
          f'unconfirmed {[k_ for k_, v in res.items() if v in ("unconfirmed", "conflicting")]}' + (' (applied)' if apply else ''))


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Read a cluster map's unit labels one building at a time (maps where tile OCR merges neighbouring labels).

  python label_per_building.py <project> <map.png> <x0,y0,x1,y1> [label_digits=3]

1. buildings: grey roof blocks (unsaturated, mid-light) of house size inside the box;
2. each roof is cut out with a small margin, enlarged 6x and read at 0 / 90 / -90 / +-30 / +-60 deg;
   only tokens of exactly <label_digits> digits count; the most frequent token wins (ties -> unread);
3. output data/siteplans/<project>/labels_by_building.json: [{c: [x, y], box, read, votes}] in map pixels,
   plus a review picture per map tile in /tmp/lpb_<project>_<i>.jpg (number drawn on each roof) for checking
   by eye. Nothing is accepted without that check (see units_from_labels in config).
"""
import json, math, os, re, sys, tempfile
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import numpy as np
import cv2
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from extract_units import ocr_tile  # noqa: E402
APP = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))


def main():
    proj, png = sys.argv[1], sys.argv[2]
    x0, y0, x1, y1 = map(int, sys.argv[3].split(','))
    nd = int(sys.argv[4]) if len(sys.argv) > 4 else 3
    im = cv2.imread(png); hsv = cv2.cvtColor(im, cv2.COLOR_BGR2HSV).astype(int)
    roof = ((hsv[..., 1] < 22) & (hsv[..., 2] > 170)).astype(np.uint8)
    m = np.zeros_like(roof); m[y0:y1, x0:x1] = 1; roof &= m
    roof = cv2.morphologyEx(roof, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n, cc, st, cen = cv2.connectedComponentsWithStats(roof, 4)
    B = []
    for i in range(1, n):
        x, y, w, h, a = st[i]
        if 150 <= a <= 2500 and 0.25 < w / max(h, 1) < 4:
            B.append((int(x), int(y), int(w), int(h), [float(cen[i][0]), float(cen[i][1])]))
    td = tempfile.mkdtemp()
    def read(j):
        x, y, w, h, c = B[j]
        pad = 4
        crop = im[max(0, y - pad):y + h + pad, max(0, x - pad):x + w + pad]
        tile = Image.fromarray(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)); tile = tile.resize((tile.width * 6, tile.height * 6), Image.LANCZOS)
        votes = Counter()
        for ang in (0, 90, -90, 30, -30, 60, -60):
            img = tile.rotate(ang, expand=True, resample=Image.BICUBIC, fillcolor=(255, 255, 255)) if ang else tile
            for t, _, _ in ocr_tile(td, img, f'{j}_{ang}'):
                pass
            res = os.popen(f"'{os.path.join(HERE, 'ocr')}' '{os.path.join(td, f't{j}_{ang}.png')}'").read()
            for line in res.splitlines():
                for tok in re.findall(r'\d+', line.split('\t')[0].replace('O', '0').replace('o', '0')):
                    if len(tok) == nd:
                        votes[int(tok)] += 1
        # a roof holds one label (villa) or two (semi-detached pair): tokens read at least twice, best two
        rd = sorted(t for t, v in votes.most_common(2) if v >= 2)
        return {'c': [round(c[0], 1), round(c[1], 1)], 'box': [x, y, w, h], 'read': rd, 'votes': dict(votes)}
    with ThreadPoolExecutor(6) as ex:
        out = list(ex.map(read, range(len(B))))
    d = os.path.join(APP, 'data', 'siteplans', proj)
    json.dump(out, open(os.path.join(d, 'labels_by_building.json'), 'w'))
    cnt = Counter(t for o in out for t in o['read'])
    dup = sorted(k for k, v in cnt.items() if v > 1)
    print(f'{proj}: {len(B)} roofs, {sum(1 for o in out if o["read"])} with a label, labels {sum(cnt.values())}, distinct {len(cnt)}, duplicates {dup}, roofs unread {sum(1 for o in out if not o["read"])}')


if __name__ == '__main__':
    main()

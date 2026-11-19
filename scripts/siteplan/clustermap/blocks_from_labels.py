#!/usr/bin/env python3
"""Villa blocks of a cluster map from labels read by eye (labels_by_eye.json), for maps whose numbers the
reader cannot place reliably (Farm Grove).

  python blocks_from_labels.py <project> <map.png>

config.json:
  "swatches": {design: [x, y]}         legend swatch centres (map pixels) - plot colours per style
  "kinds": {design: "villa"|"detached"|"semi"}, "beds": {design: n}
For every label:
  design   = the plot colour around its house (saturated pixels within 1.1 home widths, trees left out),
             nearest legend swatch (CIELAB);
  pairing  = a semi-detached home pairs with the consecutive number (n-1 or n+1) of the same kind that sits
             within 1.3 home widths: one block of two;
  axis     = along the row, from the neighbouring numbers' labels (n-1, n+1 within 1.7 home widths);
  front    = the long side with more road (the connected light-grey street network, roofs left out);
  size     = L along the row from the spacing to the neighbours, D = 0.8 L (villa roofs on this map).
Writes data/siteplans/<project>/blocks.json in the format place_blocks.py reads, plus counts per kind.
"""
import json, math, os, sys
from collections import Counter
import numpy as np
import cv2

APP = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))


def main():
    proj, png = sys.argv[1], sys.argv[2]
    d = os.path.join(APP, 'data', 'siteplans', proj)
    cfg = json.load(open(os.path.join(d, 'config.json')))
    E = {int(k): np.array(v, float) for k, v in json.load(open(os.path.join(d, 'labels_by_eye.json')))['labels'].items()}
    im = cv2.imread(png)
    lab = cv2.cvtColor(cv2.GaussianBlur(im, (3, 3), 0), cv2.COLOR_BGR2LAB).astype(np.float32)
    hsv = cv2.cvtColor(im, cv2.COLOR_BGR2HSV).astype(int)
    H, S, V = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    sw = {k: np.median(lab[y - 6:y + 7, x - 6:x + 7].reshape(-1, 3), 0) for k, (x, y) in cfg['swatches'].items()}
    names = list(sw); L = np.array([sw[k] for k in names])
    # home width: median distance between consecutive labels
    dd = sorted(np.hypot(*(E[n + 1] - E[n])) for n in E if n + 1 in E)
    pw = float(np.median([x for x in dd if x < 2 * dd[len(dd) // 2]]))
    # street network: light grey, unsaturated, big connected pieces only (roofs are small)
    grey = ((S < 20) & (V > 170) & (V < 240)).astype(np.uint8)
    n_, cc, st, _ = cv2.connectedComponentsWithStats(grey, 4)
    big = np.zeros(n_, bool); big[1:] = st[1:, cv2.CC_STAT_AREA] > 40 * pw * pw
    road = big[cc]
    HH, WW = road.shape
    # design per home: the plot pixels around the house (radius 0.65 home widths, trees and grey roofs left out),
    # classified by hue family first (red/orange = detached, purple = 5 BR villa, blue = semi-detached, pale pink =
    # 4 BR villa), then within the family by saturation / value against the legend swatches
    design, share = {}, {}
    swh = {k: np.median(hsv[y - 5:y + 6, x - 5:x + 6].reshape(-1, 3), 0) for k, (x, y) in cfg['swatches'].items()}
    for n, p in E.items():
        r = int(0.65 * pw); x, y = int(p[0]), int(p[1])
        h = hsv[max(0, y - r):y + r, max(0, x - r):x + r].reshape(-1, 3)
        h = h[(h[:, 1] > 15) & ~((h[:, 0] > 30) & (h[:, 0] < 95))]
        if len(h) < 30:
            design[n] = None; continue
        hue, sat, val = h[:, 0], h[:, 1], h[:, 2]
        warm_strong = ((hue <= 25) | (hue >= 172)) & (sat > 95)
        purple = (hue >= 150) & (hue <= 175) & (sat > 40)
        blue = (hue >= 95) & (hue <= 120) & (sat > 40)
        pink = ((hue <= 15) | (hue >= 172)) & (sat <= 95)
        fam = {'warm': warm_strong.mean(), 'purple': purple.mean(), 'blue': blue.mean(), 'pink': pink.mean()}
        f = max(fam, key=fam.get); share[n] = round(float(fam[f]), 2)
        if f == 'warm':
            hh = hue[warm_strong]; hh = np.where(hh >= 172, hh - 180, hh)
            design[n] = 'Lotus' if np.median(hh) >= 10 else 'Gardenia'
        elif f == 'purple':
            s_ = np.median(sat[purple]); design[n] = 'Ivy' if abs(s_ - swh['Ivy'][1]) < abs(s_ - swh['Orchid'][1]) else 'Orchid'
        elif f == 'blue':
            s_ = np.median(sat[blue]); design[n] = 'Lily' if abs(s_ - swh['Lily'][1]) < abs(s_ - swh['Marigold'][1]) else 'Marigold'
        else:
            s_ = np.median(sat[pink]); design[n] = 'Lavender' if abs(s_ - swh['Lavender'][1]) < abs(s_ - swh['Willow'][1]) else 'Willow'
    kinds = cfg['kinds']
    for fx in cfg.get('design_fixes', []):  # plot colours looked at by eye where the reading was wrong
        for u in fx['units']:
            design[u] = fx['design']; share[u] = 1.0
    # pairs
    used, blocks = set(), []
    def axis_of(n):
        nb = [E[m] for m in (n - 1, n + 1) if m in E and np.hypot(*(E[m] - E[n])) < 1.7 * pw]
        if len(nb) == 2: a = nb[1] - nb[0]
        elif len(nb) == 1: a = (nb[0] - E[n]) * (1 if (n + 1 in E and np.allclose(nb[0], E[n + 1])) else -1)
        else: a = np.array([1.0, 0.0])
        return a / (np.hypot(*a) or 1)
    for n in sorted(E):
        if n in used:
            continue
        mates = [m for m in (n + 1, n - 1) if m in E and m not in used and kinds.get(design.get(m)) == 'semi' and kinds.get(design.get(n)) == 'semi'
                 and np.hypot(*(E[m] - E[n])) < 1.3 * pw]
        units = sorted([n] + mates[:1]); used |= set(units)
        c = np.mean([E[u] for u in units], 0)
        ax = (E[units[1]] - E[units[0]]) if len(units) == 2 else axis_of(n)
        ax = ax / (np.hypot(*ax) or 1); nrm = np.array([-ax[1], ax[0]])
        gaps = [np.hypot(*(E[m] - E[u])) for u in units for m in (u - 1, u + 1) if m in E and m not in units and np.hypot(*(E[m] - E[u])) < 2 * pw]
        Lb = (len(units) * float(np.median(gaps)) if gaps else len(units) * pw) * 0.82
        Db = 0.8 * Lb / len(units)
        def side(sv):
            cnt = tot = 0
            for t in np.linspace(-0.35, 0.35, 5) * Lb:
                for o in np.linspace(0.6, 1.6, 6) * pw:
                    q = c + ax * t + nrm * sv * o; xq, yq = int(q[0]), int(q[1])
                    if 0 <= xq < WW and 0 <= yq < HH:
                        tot += 1; cnt += road[yq, xq]
            return cnt / tot if tot else 0
        s1, s2 = side(1), side(-1)
        fr = nrm if s1 >= s2 else -nrm
        dz = design.get(units[0])
        blocks.append({'units': units, 'c': c.round(2).tolist(), 'axis': ax.round(4).tolist(), 'front': fr.round(4).tolist(),
                       'L': round(Lb, 2), 'D': round(Db, 2), 'design': dz, 'beds': cfg['beds'].get(dz) if dz else None,
                       'type_share': share.get(units[0]), 'front_conf': round(abs(s1 - s2), 3), 'traced': False, 'dab': round(pw, 2)})
    out = {'project': proj, 'source': {'document': os.path.basename(png), 'page': 1}, 'pitch': pw, 'blocks': blocks,
           'method': 'blocks_from_labels: labels read by eye; design from the plot colour; semi-detached pairs by consecutive numbers side by side; front toward the street network'}
    json.dump(out, open(os.path.join(d, 'blocks.json'), 'w'))
    per = Counter(design.get(n) for n in E); kind = Counter(kinds.get(design.get(n)) for n in E)
    mixed = [b['units'] for b in blocks if len(b['units']) == 2 and design.get(b['units'][0]) != design.get(b['units'][1])]
    lone_semi = [b['units'][0] for b in blocks if len(b['units']) == 1 and kinds.get(b['design']) == 'semi']
    print(f'{proj}: pitch {pw:.1f}; {len(blocks)} blocks; designs {dict(per)}; kinds {dict(kind)}; pairs with two designs {mixed}; semi-detached without a partner {lone_semi}; low-confidence {sorted((v, k) for k, v in share.items() if v < 0.55)[:15]}')


if __name__ == '__main__':
    main()

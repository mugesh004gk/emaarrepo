#!/usr/bin/env python3
"""Where Esri's z19 imagery is an OLDER capture than z18 (e.g. bare dunes under Avelia / Ovelle while z16-z18 show
the current earthworks and roads): the app would swap the current photo for the old one when zooming in, with
hard tile edges. Each z19 tile is compared with the matching quarter of its z18 parent (both reduced to 32 px,
grey + colour): a z19 tile that does not look like its own parent is a different capture.

  python3 scripts/satellite/stale_z19.py <latS,lngW,latN,lngE> [...]   -> data/stale_z19.json

data/stale_z19.json: {"z18": ["x/y", ...]} - z18 tiles whose z19 children are (partly) a different capture; the
ground (js/ground.js) stops the satellite layer at z18 there. Review pictures: /tmp/stale_z19_*.jpg
"""
import json, math, os, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor
import numpy as np
import cv2

APP = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'


def get(z, x, y):
    d = urllib.request.urlopen(urllib.request.Request(URL.format(z=z, x=x, y=y), headers={'User-Agent': 'Mozilla/5.0'}), timeout=30).read()
    return cv2.imdecode(np.frombuffer(d, np.uint8), 1)


def txy(z, lat, lng):
    n = 2 ** z
    return int((lng + 180) / 360 * n), int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)


def score(a, b):
    """similarity of two tiles: correlation of 32 px grey images and mean colour distance (Lab)"""
    A = cv2.resize(a, (32, 32), interpolation=cv2.INTER_AREA); B = cv2.resize(b, (32, 32), interpolation=cv2.INTER_AREA)
    ga = cv2.cvtColor(A, cv2.COLOR_BGR2GRAY).astype(float).ravel(); gb = cv2.cvtColor(B, cv2.COLOR_BGR2GRAY).astype(float).ravel()
    ga -= ga.mean(); gb -= gb.mean()
    corr = float((ga * gb).sum() / (np.sqrt((ga * ga).sum() * (gb * gb).sum()) + 1e-9))
    la = cv2.cvtColor(A, cv2.COLOR_BGR2LAB).reshape(-1, 3).mean(0); lb = cv2.cvtColor(B, cv2.COLOR_BGR2LAB).reshape(-1, 3).mean(0)
    return corr, float(np.linalg.norm(la - lb))


def main():
    path = os.path.join(APP, 'data', 'stale_z19.json')
    out = json.load(open(path)) if os.path.exists(path) else {'z18': []}
    stale = set(out['z18'])
    for box in sys.argv[1:]:
        latS, lngW, latN, lngE = map(float, box.split(','))
        x0, y1 = txy(18, latS, lngW); x1, y0 = txy(18, latN, lngE)
        P = [(x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]
        def check(p):
            x, y = p
            try:
                par = cv2.resize(get(18, x, y), (512, 512), interpolation=cv2.INTER_CUBIC)
                res = []
                for dx in (0, 1):
                    for dy in (0, 1):
                        c = get(19, 2 * x + dx, 2 * y + dy)
                        res.append(score(c, par[dy * 256:(dy + 1) * 256, dx * 256:(dx + 1) * 256]))
                return p, res
            except Exception as e:  # noqa: BLE001
                return p, None
        with ThreadPoolExecutor(8) as ex:
            R = list(ex.map(check, P))
        bad = []
        for (x, y), res in R:
            if res is None:
                continue
            # a different capture: shapes do not line up (low correlation) or the colour is far off
            if any(c < 0.45 or d > 18 for c, d in res):
                bad.append((x, y)); stale.add(f'{x}/{y}')
            elif f'{x}/{y}' in stale:
                stale.discard(f'{x}/{y}')
        # review picture: z18 mosaic with stale tiles outlined
        cols, rows = x1 - x0 + 1, y1 - y0 + 1
        if cols * rows <= 400:
            M = np.zeros((rows * 128, cols * 128, 3), np.uint8)
            for x, y in P:
                try:
                    M[(y - y0) * 128:(y - y0 + 1) * 128, (x - x0) * 128:(x - x0 + 1) * 128] = cv2.resize(get(18, x, y), (128, 128))
                except Exception:  # noqa: BLE001
                    pass
            for x, y in bad:
                cv2.rectangle(M, ((x - x0) * 128 + 2, (y - y0) * 128 + 2), ((x - x0 + 1) * 128 - 3, (y - y0 + 1) * 128 - 3), (0, 0, 255), 3)
            cv2.imwrite(f'/tmp/stale_z19_{box.replace(",", "_")}.jpg', M)
        print(f'{box}: {len(P)} z18 tiles, z19 older capture under {len(bad)}; scores sample {[r for _, r in R[:2]]}')
    out = {'_about': 'z18 tiles whose z19 imagery is a different (older) capture - scripts/satellite/stale_z19.py; the satellite ground stops at z18 there',
           'z18': sorted(stale)}
    json.dump(out, open(path, 'w'), indent=0)


if __name__ == '__main__':
    main()

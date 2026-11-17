#!/usr/bin/env python3
"""Detect built homes from current satellite imagery for one community and merge them into
data/homes_detected.json.

Needs numpy + opencv (a venv is fine):
  python3 -m venv .venv && .venv/bin/pip install numpy==1.26.4 opencv-python-headless==4.10.0.84
  .venv/bin/python scripts/satellite/run.py the-valley

Steps: download Esri World Imagery zoom-18 tiles over the community, find rows of light roofs,
fit rectangles, split back-to-back rows, pick the street side (asphalt), clip to the community
(OSM boundary for The Valley; 600 m around Emaar's reliable project pins otherwise), drop
isolated detections, and assign each row to its nearest project pin. Emaar South blocks that are
large and next to apartment projects are kept as apartment buildings.
"""
import json, math, os, subprocess, sys
import numpy as np, cv2

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(os.path.dirname(HERE))
CACHE = os.path.join(HERE, '.cache')
Z = 18
MPP = 40075016.686 * math.cos(math.radians(25.0)) / (256 * 2 ** Z)


def tile_xy(lat, lon):
    n = 2 ** Z
    return int((lon + 180) / 360 * n), int((1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n)


class Mosaic:
    def __init__(self, cid, south, west, north, east):
        self.dir = os.path.join(CACHE, cid)
        os.makedirs(os.path.join(self.dir, 'tiles'), exist_ok=True)
        self.x0, self.y0 = tile_xy(north, west)
        self.x1, self.y1 = tile_xy(south, east)
        urls = []
        for x in range(self.x0, self.x1 + 1):
            for y in range(self.y0, self.y1 + 1):
                f = os.path.join(self.dir, 'tiles', f'{x}_{y}.jpg')
                if not os.path.exists(f) or os.path.getsize(f) == 0:
                    urls.append(f'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{Z}/{y}/{x} {f}')
        if urls:
            print(f'downloading {len(urls)} tiles')
            p = subprocess.run(['xargs', '-P', '16', '-n', '2', 'sh', '-c', 'curl -s -m 60 -o "$1" "$0"'], input='\n'.join(urls), text=True)
        W, H = (self.x1 - self.x0 + 1) * 256, (self.y1 - self.y0 + 1) * 256
        self.img = np.zeros((H, W, 3), np.uint8)
        for x in range(self.x0, self.x1 + 1):
            for y in range(self.y0, self.y1 + 1):
                t = cv2.imread(os.path.join(self.dir, 'tiles', f'{x}_{y}.jpg'))
                if t is not None and t.shape[:2] == (256, 256):
                    self.img[(y - self.y0) * 256:(y - self.y0 + 1) * 256, (x - self.x0) * 256:(x - self.x0 + 1) * 256] = t

    def ll2px(self, lat, lon):
        n = 2 ** Z
        fx = (lon + 180) / 360 * n
        fy = (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n
        return (fx - self.x0) * 256, (fy - self.y0) * 256

    def px2ll(self, px, py):
        n = 2 ** Z
        fx, fy = px / 256 + self.x0, py / 256 + self.y0
        return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * fy / n)))), fx / n * 360 - 180


def detect_blocks(img, roi, vmin=170, smax=40, close_m=2.2, open_m=1.1):
    x0, y0, x1, y1 = roi
    hsv = cv2.cvtColor(np.ascontiguousarray(img[y0:y1, x0:x1]), cv2.COLOR_BGR2HSV)
    _, s, v = cv2.split(hsv)
    mask = ((v >= vmin) & (s <= smax)).astype(np.uint8) * 255
    k = lambda m: cv2.getStructuringElement(cv2.MORPH_RECT, (max(1, round(m / MPP)),) * 2)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, k(open_m))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k(close_m))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    out = []
    for i in range(1, n):
        area = stats[i, cv2.CC_STAT_AREA] * MPP * MPP
        if area < 70 or area > 12000:
            continue
        sl = lab[stats[i, 1]:stats[i, 1] + stats[i, 3], stats[i, 0]:stats[i, 0] + stats[i, 2]] == i
        ys, xs = np.nonzero(sl)
        pts = np.stack([xs + stats[i, 0], ys + stats[i, 1]], 1).astype(np.float32)
        (cx, cy), (w, h), ang = cv2.minAreaRect(pts)
        L, D = max(w, h) * MPP, min(w, h) * MPP
        if D < 6 or area / max(1e-6, L * D) < 0.55:
            continue
        out.append({'cx': cx + x0, 'cy': cy + y0, 'w': w, 'h': h, 'ang': ang, 'L': L, 'D': D, 'area': area})
    return out


def asphalt_ratio(img, p, u, dirv, L):
    tot = hit = 0
    for t in np.linspace(-0.4, 0.4, 9):
        for off in (3.5, 5.5, 7.5):
            q = p + u * t * L / MPP + dirv * (off / MPP)
            x, y = int(q[0]), int(q[1])
            if 0 <= y < img.shape[0] and 0 <= x < img.shape[1]:
                b, g, r = [int(c) for c in img[y, x]]
                mx, mn = max(r, g, b), min(r, g, b)
                s = 0 if mx == 0 else (mx - mn) * 255 // mx
                tot += 1
                hit += (s < 45 and 55 < mx < 150)
    return hit / max(1, tot)


def rows_from_block(M, d, apartment_ok):
    img = M.img
    box = cv2.boxPoints(((d['cx'], d['cy']), (d['w'], d['h']), d['ang']))
    e = [box[1] - box[0], box[2] - box[1]]
    u = e[0] if np.linalg.norm(e[0]) >= np.linalg.norm(e[1]) else e[1]
    u = u / np.linalg.norm(u)
    n = np.array([-u[1], u[0]])
    c = np.array([d['cx'], d['cy']])
    L, D = d['L'], d['D']
    if L < 9:
        return []
    if apartment_ok and d['area'] >= 900 and D >= 14:
        lat, lon = M.px2ll(*c)
        f = n if asphalt_ratio(img, c + n * (D / 2) / MPP, u, n, L) >= asphalt_ratio(img, c - n * (D / 2) / MPP, u, -n, L) else -n
        return [{'lat': lat, 'lng': lon, 'L': round(L, 2), 'D': round(D, 2), 'frontBearing': round((math.degrees(math.atan2(f[0], -f[1])) + 360) % 360, 2), 'kind': 'apartment'}]
    if D > 34:
        return []
    parts = []
    if D > 19:
        hh = min(12.5, D / 2 - 1.5)
        for sg in (1, -1):
            parts.append((c + n * sg * (D / 2 - hh / 2) / MPP, n * sg, hh))
    else:
        f = n if asphalt_ratio(img, c + n * (D / 2) / MPP, u, n, L) >= asphalt_ratio(img, c - n * (D / 2) / MPP, u, -n, L) else -n
        parts.append((c, f, D))
    rows = []
    for cc, ff, dd in parts:
        lat, lon = M.px2ll(*cc)
        rows.append({'lat': lat, 'lng': lon, 'L': round(L, 2), 'D': round(dd, 2), 'frontBearing': round((math.degrees(math.atan2(ff[0], -ff[1])) + 360) % 360, 2), 'kind': 'townhouse'})
    return rows


def rounded_hull_px(M, pts_ll, buffer_m):
    pts = []
    for lat, lon in pts_ll:
        x, y = M.ll2px(lat, lon)
        for k in range(24):
            a = k / 24 * math.tau
            pts.append([x + math.cos(a) * buffer_m / MPP, y + math.sin(a) * buffer_m / MPP])
    return cv2.convexHull(np.array(pts, np.float32))


def main(cid):
    projects = json.load(open(os.path.join(APP, 'data', 'projects.json')))
    districts = json.load(open(os.path.join(APP, 'data', 'districts.json')))
    nara = json.load(open(os.path.join(APP, 'data', 'nara_data.json')))
    c = next(x for x in projects['communities'] if x['id'] == cid)
    good = [p for p in c['projects'] if not p.get('pinFlag')]
    osm = next((d for d in districts if d['layer'] == 'districts' and d['name'] == c.get('osmName')), None) if c.get('osmName') else None
    if osm:
        ring = osm['rings'][0]
        lats = [p[1] for p in ring]; lons = [p[0] for p in ring]
    else:
        lats = [p['lat'] for p in good]; lons = [p['lng'] for p in good]
    pad = 0.008
    M = Mosaic(cid, min(lats) - pad, min(lons) - pad, max(lats) + pad, max(lons) + pad)
    H, W = M.img.shape[:2]
    clip = np.array([M.ll2px(la, lo) for lo, la in osm['rings'][0]], np.float32) if osm else rounded_hull_px(M, [(p['lat'], p['lng']) for p in good], 600)
    clip_margin = 40 if osm else 0
    nara_hull = cv2.convexHull(np.array([M.ll2px(u['lat'], u['lon']) for u in nara['units']], np.float32))
    apt_projects = [p for p in good if 'Apartment' in (p.get('types') or [])]
    rows = []
    step = 2048
    for y0 in range(0, H, step):
        for x0 in range(0, W, step):
            roi = (max(0, x0 - 80), max(0, y0 - 80), min(W, x0 + step + 80), min(H, y0 + step + 80))
            for d in detect_blocks(M.img, roi):
                if not (x0 <= d['cx'] < x0 + step and y0 <= d['cy'] < y0 + step):
                    continue
                if cv2.pointPolygonTest(clip, (float(d['cx']), float(d['cy'])), True) < -clip_margin / MPP:
                    continue
                if cid == 'the-valley' and cv2.pointPolygonTest(nara_hull, (float(d['cx']), float(d['cy'])), True) > -10 / MPP:
                    continue
                lat, lon = M.px2ll(d['cx'], d['cy'])
                near_apt = any(math.hypot((p['lat'] - lat) * 110574, (p['lng'] - lon) * 101000) < 450 for p in apt_projects)
                rows += rows_from_block(M, d, near_apt)
    rows = [r for r in rows if r['kind'] == 'apartment' or (r['L'] >= 12 and 7 <= r['D'] <= 19)]
    P = np.array([M.ll2px(r['lat'], r['lng']) for r in rows]) if rows else np.zeros((0, 2))
    rows = [r for i, r in enumerate(rows) if (np.hypot(*(P - P[i]).T) * MPP < 70).sum() - 1 >= 3]
    pins = [(p['id'], p['lat'], p['lng']) for p in good if p['id'] != 'nara']
    out = []
    for r in rows:
        pid = min(pins, key=lambda q: (q[1] - r['lat']) ** 2 + ((q[2] - r['lng']) * math.cos(math.radians(r['lat']))) ** 2)[0]
        units = 1 if r['kind'] == 'apartment' else max(1, round(r['L'] / 7.8))
        out.append({**{k: (round(v, 7) if k in ('lat', 'lng') else v) for k, v in r.items()}, 'units': units, 'project': pid})
    path = os.path.join(APP, 'data', 'homes_detected.json')
    data = json.load(open(path)) if os.path.exists(path) else {'communities': {}}
    data['source'] = 'Esri World Imagery zoom 18 (~0.54 m/px); roof detection by scripts/satellite/run.py'
    data['method'] = ('Rows of light roofs detected and fitted with rectangles; blocks deeper than 19 m are back-to-back rows facing outward; '
                      'homes per row = row length / 7.8 m; large blocks next to apartment projects are apartment buildings; project = nearest '
                      'Emaar project pin. Positions, row outlines and street sides are from the imagery; the split into homes, building heights '
                      'and the design are representative until each project cluster map is traced.')
    data['communities'][cid] = out
    json.dump(data, open(path, 'w'), separators=(',', ':'))
    th = sum(r['units'] for r in out if r['kind'] == 'townhouse')
    ap = sum(1 for r in out if r['kind'] == 'apartment')
    print(f'{cid}: {len(out)} rows, {th} townhouse/villa homes, {ap} apartment buildings')


if __name__ == '__main__':
    main(sys.argv[1])

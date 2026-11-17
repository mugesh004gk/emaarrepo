#!/usr/bin/env python3
"""Building-level home detection from zoom-19 satellite imagery (~0.27 m/px) for one community.

  .venv/bin/python scripts/satellite/run_v2.py the-valley

1. Download Esri World Imagery z19 tiles over the built part of the community (cached).
2. Mask "building" pixels = not sand, not vegetation, not asphalt, not shadow (works for white
   townhouse roofs and for grey concrete villa roofs alike); fill roof holes; split touching
   buildings at shadows.
3. Each building blob -> minimum-area rectangle. Deep blocks are split into back-to-back rows at
   the dip in roof cover across their depth. Rows are split into homes at the gaps along their
   length (detached / semi-detached villas); continuous rows (townhouses) are split by the nominal
   unit width.
4. Street side = the long side with asphalt 3-8 m outside it.
5. Rejects: site cabins (narrow, uniform white), blobs inside Nara (surveyed model), blobs outside
   the community.

Output: data/homes_detected.json -> communities[cid] = rows with per-home widths and a kind
('townhouse' | 'villa'), plus data/homes_detected_check/<cid>_*.jpg overlays for review.
"""
import json, math, os, subprocess, sys
import numpy as np, cv2

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(os.path.dirname(HERE))
Z = 19
TILE = 256


def mpp_at(lat):
    return 40075016.686 * math.cos(math.radians(lat)) / (TILE * 2 ** Z)


def fxy(lat, lon):
    n = 2 ** Z
    return (lon + 180) / 360 * n, (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n


def lonlat(fx, fy):
    n = 2 ** Z
    return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * fy / n)))), fx / n * 360 - 180


class Tiles:
    def __init__(self, cid):
        self.dir = os.path.join(HERE, '.cache', f'{cid}_z{Z}')
        os.makedirs(self.dir, exist_ok=True)

    def path(self, x, y):
        return os.path.join(self.dir, f'{x}_{y}.jpg')

    def ensure(self, xs, ys):
        todo = [f'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{Z}/{y}/{x} {self.path(x, y)}'
                for x in xs for y in ys if not os.path.exists(self.path(x, y)) or os.path.getsize(self.path(x, y)) == 0]
        if todo:
            print(f'  downloading {len(todo)} z{Z} tiles', flush=True)
            subprocess.run(['xargs', '-P', '24', '-n', '2', 'sh', '-c', 'curl -s -m 60 -o "$1" "$0"'], input='\n'.join(todo), text=True)

    def mosaic(self, x0, y0, x1, y1):
        img = np.zeros(((y1 - y0) * TILE, (x1 - x0) * TILE, 3), np.uint8)
        for x in range(x0, x1):
            for y in range(y0, y1):
                t = cv2.imread(self.path(x, y))
                if t is not None and t.shape[:2] == (TILE, TILE):
                    img[(y - y0) * TILE:(y - y0 + 1) * TILE, (x - x0) * TILE:(x - x0 + 1) * TILE] = t
        return img


def building_mask(img, mpp):
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    h, s, v = cv2.split(hsv)
    sand = (h >= 5) & (h <= 28) & (s >= 38)
    veg = (h >= 30) & (h <= 95) & (s >= 40)
    water = (h >= 95) & (h <= 130) & (s >= 60)
    dark = v < 70
    asph = (s < 40) & (v >= 70) & (v < 115)
    nodata = (v < 8)
    m = (~(sand | veg | water | dark | asph | nodata)).astype(np.uint8) * 255
    k = lambda x: cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (max(1, round(x / mpp)),) * 2)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, k(1.4))
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, k(1.0))
    cnts, hier = cv2.findContours(m, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    if hier is not None:
        for i, c in enumerate(cnts):
            if hier[0][i][3] >= 0 and cv2.contourArea(c) * mpp * mpp < 30:
                cv2.drawContours(m, [c], -1, 255, -1)
    return m, hsv


def split_buildings(mask, mpp, core_m=3.0):
    """Label image: one label per building. Cores = pixels more than core_m from the mask edge
    (walls, paving strips and other thin links between buildings have none), grown back over the
    mask by watershed so touching villas separate along their narrowest link."""
    dist = cv2.distanceTransform(mask, cv2.DIST_L2, 5)
    cores = (dist > core_m / mpp).astype(np.uint8)
    nc, markers = cv2.connectedComponents(cores, 8)
    markers = markers + 1
    markers[(mask > 0) & (cores == 0)] = 0  # unknown: to be flooded
    norm = cv2.normalize(-dist, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)
    lab = cv2.watershed(cv2.merge([norm, norm, norm]), markers)
    lab[lab <= 1] = 0
    lab[mask == 0] = 0
    return lab


def detect_buildings(img, mpp, roads=None):
    """Two complementary passes, both validated by a cast shadow:
       A. light roofs (finished white townhouse / villa roofs) with watershed splitting;
       B. 'not sand' shapes standing in sand (concrete villas, villas under construction).
    Returns a label image (0 = background) of accepted buildings."""
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    h, s, v = cv2.split(hsv)
    sand = (h >= 5) & (h <= 28) & (s >= 38)
    veg = (h >= 30) & (h <= 95) & (s >= 40)
    dark = (v < 70).astype(np.uint8)
    k = lambda x: cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (max(1, round(x / mpp)),) * 2)
    out = np.zeros(img.shape[:2], np.int32)
    src = {}
    reasons = {}
    def rej(r):
        reasons[r] = reasons.get(r, 0) + 1
    nxt = 1

    def accept(lab, require_sand_ring, max_area=6000, tag=None, max_len=260, need_shadow=True, min_fill=None, max_aspect=None, trim_dark=False):
        nonlocal nxt
        ids = np.unique(lab)
        for lid in ids[ids > 0]:
            bm = lab == lid
            ys, xs = np.nonzero(bm)
            area = len(xs) * mpp * mpp
            if area < 60 or area > max_area:
                rej('area'); continue
            (cx, cy), (w, hh), ang = cv2.minAreaRect(np.stack([xs, ys], 1).astype(np.float32))
            L, D = max(w, hh) * mpp, min(w, hh) * mpp
            if D < 6 or L > max_len or area / max(1e-6, L * D) < (min_fill or (0.45 if require_sand_ring else 0.5)) or (max_aspect and L / D > max_aspect):
                rej('shape'); continue
            y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
            pad = int(5 / mpp) + 1
            Y0, Y1, X0, X1 = max(0, y0 - pad), min(bm.shape[0], y1 + pad), max(0, x0 - pad), min(bm.shape[1], x1 + pad)
            sub = bm[Y0:Y1, X0:X1].astype(np.uint8)
            if (out[Y0:Y1, X0:X1][sub > 0] > 0).mean() > 0.3:
                rej('overlap'); continue  # already found by the other pass
            ring = cv2.dilate(sub, k(2.5)) - sub
            if require_sand_ring:
                # roads and paved yards: mostly asphalt-coloured pixels; buildings are not
                hs, ss, vs = h[Y0:Y1, X0:X1][sub > 0], s[Y0:Y1, X0:X1][sub > 0], v[Y0:Y1, X0:X1][sub > 0]
                if (((ss < 40) & (vs < 115)).mean() > 0.55 and L / D > 5) or sand[Y0:Y1, X0:X1][ring > 0].mean() < 0.12:
                    rej('road/ring'); continue
            if tag in ('C', 'E') and veg[Y0:Y1, X0:X1][ring > 0].mean() > 0.55:
                rej('in-grass'); continue  # golf bunkers, cart paths and greens are not homes
            vv = v[Y0:Y1, X0:X1][sub > 0]
            if D < 9 and vv.std() < 16 and vv.mean() > 185:
                rej('cabin'); continue  # site cabin / shed roof
            if need_shadow and _shadow_score_at(bm, dark, mpp, Y0, Y1, X0, X1) < (0.22 if require_sand_ring else 0.3):
                rej('shadow'); continue
            if trim_dark:
                # the blob is building + its own cast shadow: keep the lit part as the footprint
                if veg[Y0:Y1, X0:X1][ring > 0].mean() > 0.2:
                    rej('in-grass'); continue
                lit = bm & (v >= 70)
                if np.median(s[lit]) > 48 if lit.any() else True:
                    rej('scrub'); continue  # desert scrub is olive and saturated; concrete is grey
                if lit.sum() < 0.35 * bm.sum():
                    rej('mostly-shadow'); continue
                dfrac = 1 - lit.sum() / bm.sum()
                if dfrac < 0.08:
                    rej('flat'); continue  # no shadow at all: a slab or a yard, not a building
                bm = lit
            out[bm] = nxt
            src[nxt] = tag or ('B' if require_sand_ring else 'A')
            nxt += 1

    # B first (villa rows standing in sand), then A (light roofs) fills in everything else
    # B. not-sand shapes in sand: drop cast shadow, fill roof holes, split touching villas
    mB = ((~sand) & (v >= 70)).astype(np.uint8) * 255
    mB = cv2.morphologyEx(mB, cv2.MORPH_CLOSE, k(0.8))
    mB = cv2.morphologyEx(mB, cv2.MORPH_OPEN, k(1.6))
    # (no hole filling here: plot walls enclose small sand pockets, and filling them would glue
    # each villa to its walls)
    accept(split_buildings(mB, mpp, core_m=2.6), True)
    # F. rows standing in sand streets (construction phases): everything that is not sand or planting,
    #    shadows included so a row is one solid block; the shadow is trimmed off afterwards.
    lit_sand = sand & (v >= 120)  # shadow on sand keeps the sand hue but is dark: it joins the row
    mF = (~lit_sand & ~veg).astype(np.uint8) * 255
    mF = cv2.morphologyEx(mF, cv2.MORPH_CLOSE, k(1.6))
    mF = cv2.morphologyEx(mF, cv2.MORPH_OPEN, k(2.2))
    accept(split_buildings(mF, mpp, core_m=3.0), True, max_area=5500, tag='F', max_len=160, need_shadow=False, min_fill=0.4, trim_dark=True)
    # A. light roofs
    mA, _ = building_mask(img, mpp)
    accept(split_buildings(mA, mpp), False)
    # C. textured built-up surfaces: grey concrete villas and villas under construction, which are
    #    neither light roofs (A) nor clearly standing in sand (B). Villa-sized only.
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)
    w = max(3, int(1.6 / mpp) | 1)
    mu = cv2.blur(g, (w, w))
    sd = np.sqrt(np.maximum(cv2.blur(g * g, (w, w)) - mu * mu, 0))
    veg = (h >= 30) & (h <= 95) & (s >= 40)
    mC = ((sd > 14) & ~veg & ~(sand & (sd < 24))).astype(np.uint8) * 255
    mC = cv2.morphologyEx(mC, cv2.MORPH_CLOSE, k(1.2))
    mC = cv2.morphologyEx(mC, cv2.MORPH_OPEN, k(2.4))
    accept(split_buildings(mC, mpp, core_m=2.8), False, max_area=1200, tag='C', max_len=40)
    # D. sand-dusted villa shells (construction): nearly sand-coloured but much less saturated than
    #    the sand around them; accepted only as clean villa-sized rectangles (no shadow needed).
    s32 = s.astype(np.float32)
    win = max(3, int(25 / mpp) | 1)
    local_s = cv2.blur(cv2.GaussianBlur(s32, (0, 0), 3), (win, win))
    mD = ((s32 < 0.62 * local_s) & (local_s > 45) & (v >= 150) & ~veg).astype(np.uint8) * 255
    mD = cv2.morphologyEx(mD, cv2.MORPH_CLOSE, k(0.8))
    mD = cv2.morphologyEx(mD, cv2.MORPH_OPEN, k(2.6))
    accept(split_buildings(mD, mpp, core_m=2.6), False, max_area=600, tag='C', max_len=30, need_shadow=False, min_fill=0.68, max_aspect=2.6)
    # E. grey roofs (concrete, solar, membrane): the colour of asphalt, so the mapped streets are
    #    erased first (OpenStreetMap centre lines drawn at road width + verge) and only compact,
    #    rectangular, shadow-casting blobs are kept.
    if roads is not None:
        mE = ((s < 48) & (v >= 72) & (v < 175) & ~veg & (roads == 0)).astype(np.uint8) * 255
        mE = cv2.morphologyEx(mE, cv2.MORPH_OPEN, k(1.8))
        mE = cv2.morphologyEx(mE, cv2.MORPH_CLOSE, k(0.8))
        accept(split_buildings(mE, mpp, core_m=2.6), False, max_area=2500, tag='E', max_len=120, min_fill=0.6, max_aspect=8)
    # roof-only mask used to split villa rows at their side yards
    strict = ((~sand) & (v >= 125) & (s <= 60)).astype(np.uint8) * 255
    detect_buildings.reasons = reasons
    return out, hsv, src, strict


def _shadow_score_at(bm, dark, mpp, Y0, Y1, X0, X1, near_m=0.5, far_m=4.0):
    """Cast-shadow evidence on the building's shadow side. The sun direction differs between image
    dates, so every one of 8 directions is tried and the best side counts."""
    sub = bm[Y0:Y1, X0:X1].astype(np.uint8)
    if not sub.any():
        return 0.0
    dk = dark[Y0:Y1, X0:X1]
    hgt, wid = sub.shape
    best = 0.0
    for ang in range(0, 360, 45):
        dx, dy = math.cos(math.radians(ang)), math.sin(math.radians(ang))
        band = np.zeros_like(sub)
        for d in np.arange(near_m, far_m, 0.8):
            M = np.float32([[1, 0, dx * d / mpp], [0, 1, dy * d / mpp]])
            band |= cv2.warpAffine(sub, M, (wid, hgt), flags=cv2.INTER_NEAREST)
        band &= (1 - sub)
        n = int(band.sum())
        if n < 10:
            continue
        best = max(best, float(dk[band > 0].mean()))
    return best


def asphalt_side(hsv, c, u, n, L, D, mpp):
    def ratio(sign):
        tot = hit = 0
        for t in np.linspace(-0.4, 0.4, 9):
            for off in (3.5, 5.5, 7.5):
                q = c + u * t * L / mpp + n * sign * (D / 2 + off) / mpp
                x, y = int(q[0]), int(q[1])
                if 0 <= y < hsv.shape[0] and 0 <= x < hsv.shape[1]:
                    _, s, v = hsv[y, x]
                    tot += 1
                    hit += (s < 45 and 55 < v < 150)
        return hit / max(1, tot)
    a, b = ratio(1), ratio(-1)
    return (1 if a >= b else -1), max(a, b)


def runs(profile, thr, min_len):
    out, i = [], 0
    on = profile > thr
    while i < len(on):
        if on[i]:
            j = i
            while j < len(on) and on[j]:
                j += 1
            if j - i >= min_len:
                out.append((i, j))
            i = j
        else:
            i += 1
    return out


def analyse(mask, hsv, mpp, comp_pts, x_off, y_off, villa_hint=False):
    """One building blob -> list of rows {c(px), u, f, L, D, units:[widths m], kind}."""
    (cx, cy), (w, h), ang = cv2.minAreaRect(comp_pts)
    box = cv2.boxPoints(((cx, cy), (w, h), ang))
    e0, e1 = box[1] - box[0], box[2] - box[1]
    u = e0 if np.linalg.norm(e0) >= np.linalg.norm(e1) else e1
    u = u / np.linalg.norm(u)
    n = np.array([-u[1], u[0]])
    L, D = max(w, h) * mpp, min(w, h) * mpp
    c = np.array([cx, cy])
    # resample the blob in its own frame (along u, across n)
    W, H = int(L / mpp) + 2, int(D / mpp) + 2
    M = np.float32([[u[0], n[0], c[0] - u[0] * W / 2 - n[0] * H / 2], [u[1], n[1], c[1] - u[1] * W / 2 - n[1] * H / 2]])
    local = cv2.warpAffine(mask, M, (W, H), flags=cv2.WARP_INVERSE_MAP | cv2.INTER_NEAREST)
    occ = local > 0
    rows = []
    # back-to-back split across the depth
    bands = [(0, H)]
    if D > 21:
        prof = occ.mean(1)
        mid = slice(int(H * 0.3), int(H * 0.7))
        k = int(np.argmin(prof[mid])) + int(H * 0.3)
        bands = [(0, k), (k, H)]
    for (b0, b1) in bands:
        band = occ[b0:b1]
        bd = (b1 - b0) * mpp
        if bd < 5.5:
            continue
        col = band.mean(0)
        col = np.convolve(col, np.ones(5) / 5, 'same')
        segs = runs(col, 0.25 if villa_hint else 0.35, int((6.0 if villa_hint else 4.5) / mpp))
        if not segs:
            continue
        a0, a1 = segs[0][0], segs[-1][1]
        rl = (a1 - a0) * mpp
        if rl < 6:
            continue
        widths = [(s1 - s0) * mpp for s0, s1 in segs]
        gapw = [(segs[j + 1][0] - segs[j][1]) * mpp for j in range(len(segs) - 1)]
        # villas stand apart (side yards >= ~2 m); townhouse units touch along party walls
        gaps = bool(gapw) and np.median(gapw) >= 2.0
        # kind: villas when there are real gaps between buildings or each building is wide
        villa_geom = (gaps and 9.0 <= np.median(widths) <= 32) or (villa_hint and rl <= 32 and bd >= 12 and len(segs) <= 2)
        if villa_geom:
            kind = 'villa'
            units = []
            for wdt in widths:
                # a wide piece without a gap is a semi-detached pair
                k = max(1, round(wdt / 15.5)) if wdt > 22 else 1
                units += [wdt / k] * k
        else:
            kind = 'townhouse'
            k = max(1, round(rl / 7.6))
            units = [rl / k] * k
        bc = c + u * ((a0 + a1) / 2 - W / 2) + n * ((b0 + b1) / 2 - H / 2)  # pixels
        sign, conf = asphalt_side(hsv, bc, u, n, rl, bd, mpp)
        if len(bands) == 2:
            sign = -1 if b0 == 0 else 1  # outer side of a back-to-back block faces the street
        rows.append({'c': bc, 'u': u, 'f': n * sign, 'L': rl, 'D': bd, 'units': units, 'kind': kind, 'streetConf': round(conf, 2),
                     'segWidths': widths, 'gapWidths': gapw,
                     'gaps': [((s0 - a0) * mpp, (s1 - a0) * mpp) for s0, s1 in segs]})
    return rows


def villa_chains(img, mpp, lab, hsv):
    """Villas whose photo shows only a small bright core (upper floor, roof terrace): small light blobs
    repeated at villa spacing along a line. Each becomes a 13 x 13 m villa facing the road side."""
    mA, _ = building_mask(img, mpp)
    n, cl, st, cen = cv2.connectedComponentsWithStats(mA, 8)
    cand = []
    for i in range(1, n):
        a = st[i, 4] * mpp * mpp
        if 12 <= a <= 200:
            x, y = cen[i]
            yi, xi = int(y), int(x)
            if 0 <= yi < lab.shape[0] and 0 <= xi < lab.shape[1] and lab[max(0, yi - 8):yi + 9, max(0, xi - 8):xi + 9].any():
                continue  # already part of an accepted building
            cand.append((x, y, a))
    if len(cand) < 3:
        return []
    P = np.array([[c[0], c[1]] for c in cand])
    A = np.array([c[2] for c in cand])
    rows = []
    for i, (x, y, a) in enumerate(cand):
        d = np.hypot(*(P - P[i]).T) * mpp
        nb = [j for j in np.nonzero((d >= 9) & (d <= 26))[0] if 0.4 <= A[j] / a <= 2.5]
        if len(nb) < 2:
            continue
        # collinear: two neighbours on opposite sides
        vs = [(P[j] - P[i]) / np.linalg.norm(P[j] - P[i]) for j in nb]
        pair = None
        for p1 in range(len(vs)):
            for p2 in range(p1 + 1, len(vs)):
                if np.dot(vs[p1], vs[p2]) < -0.85:
                    pair = (vs[p1], vs[p2])
        if pair is None:
            continue
        u = pair[0] - pair[1]
        u = u / np.linalg.norm(u)
        nvec = np.array([-u[1], u[0]])
        c = np.array([x, y])
        y0_, x0_ = int(max(0, y - 9 / mpp)), int(max(0, x - 9 / mpp))
        hh_, ss_ = hsv[y0_:int(y + 9 / mpp), x0_:int(x + 9 / mpp), 0], hsv[y0_:int(y + 9 / mpp), x0_:int(x + 9 / mpp), 1]
        if ((hh_ >= 30) & (hh_ <= 95) & (ss_ >= 40)).mean() > 0.45:
            continue  # bunkers in a golf fairway
        sign, conf = asphalt_side(hsv, c, u, nvec, 13, 13, mpp)
        rows.append({'c': c, 'u': u, 'f': nvec * sign, 'L': 13.0, 'D': 13.0, 'units': [13.0], 'kind': 'villa',
                     'streetConf': round(conf, 2), 'segWidths': [13.0], 'gapWidths': []})
    return rows


def shadow_buildings(img, mpp, lab, hsv, roads=None):
    """Buildings found from their cast shadows. The shadow direction is measured in the image itself
    (shadow mask shifted onto the building mask); every shadow without a building beside it gets one on
    its sunny side, as wide as the shadow and as deep as the built surface reaches (7-16 m)."""
    h, s, v = cv2.split(hsv)
    veg = (h >= 30) & (h <= 95) & (s >= 40)
    sand = (h >= 5) & (h <= 28) & (s >= 38)
    k = lambda m: cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (max(1, round(m / mpp)),) * 2)
    shadow = cv2.morphologyEx(((v < 62) & ~veg).astype(np.uint8), cv2.MORPH_OPEN, k(0.8))
    bld = ((v >= 95) & ~veg & ~sand).astype(np.uint8)
    if roads is not None:
        bld[roads > 0] = 0
    small = lambda m: cv2.resize(m, None, fx=0.5, fy=0.5, interpolation=cv2.INTER_NEAREST)
    sh2, b2 = small(shadow), small(bld)
    best = (0, 0, 0)
    for dx in range(-20, 21):
        for dy in range(-20, 21):
            if dx * dx + dy * dy < 9:
                continue
            sh = cv2.warpAffine(sh2, np.float32([[1, 0, dx], [0, 1, dy]]), (sh2.shape[1], sh2.shape[0]))
            sc = (sh & b2).sum() / max(1, sh.sum())
            if sc > best[0]:
                best = (sc, dx * 2, dy * 2)
    if best[0] < 0.25:
        return []
    d = np.array([best[1], best[2]], np.float64)
    d /= np.linalg.norm(d)
    p = np.array([-d[1], d[0]])
    n, cl, st, cen = cv2.connectedComponentsWithStats(shadow, 8)
    rows = []
    for i in range(1, n):
        area = st[i, 4] * mpp * mpp
        if area < 12 or area > 600:
            continue
        ys, xs = np.nonzero(cl[st[i, 1]:st[i, 1] + st[i, 3], st[i, 0]:st[i, 0] + st[i, 2]] == i)
        P = np.stack([xs + st[i, 0], ys + st[i, 1]], 1).astype(np.float64)
        ad, ap = P @ d, P @ p
        wid = (ap.max() - ap.min()) * mpp
        if wid < 6 or wid > 140:
            continue
        edge = ad.max()
        mid = (ap.max() + ap.min()) / 2
        # march toward the sun while the strip is built surface
        depth = 0.0
        for step in np.arange(0.5, 16.5, 1.0):
            ok = tot = 0
            for t in np.linspace(-0.4, 0.4, 9):
                q = d * (edge + step / mpp) + p * (mid + t * (ap.max() - ap.min()))
                x, y = int(q[0]), int(q[1])
                if 0 <= y < bld.shape[0] and 0 <= x < bld.shape[1]:
                    tot += 1
                    ok += bld[y, x] or lab[y, x] > 0
            if tot == 0 or ok / tot < 0.5:
                break
            depth = step
        if depth < 7:
            continue
        c = d * (edge + depth / 2 / mpp) + p * mid
        cx, cy = int(c[0]), int(c[1])
        if not (0 <= cy < lab.shape[0] and 0 <= cx < lab.shape[1]) or lab[max(0, cy - 6):cy + 7, max(0, cx - 6):cx + 7].any():
            continue  # a building is already here
        y0, x0 = int(max(0, cy - 12 / mpp)), int(max(0, cx - 12 / mpp))
        if veg[y0:int(cy + 12 / mpp), x0:int(cx + 12 / mpp)].mean() > 0.45:
            continue
        sign, conf = asphalt_side(hsv, c, p, d, wid, depth, mpp)
        rows.append({'c': c, 'u': p, 'f': d * sign, 'L': wid, 'D': depth, 'units': [wid], 'kind': 'villa' if wid < 26 else 'townhouse',
                     'streetConf': round(conf, 2), 'segWidths': [wid], 'gapWidths': []})
        # mark as taken so overlapping shadows do not add a second building
        q = np.array([c + p * wid / 2 / mpp + d * depth / 2 / mpp, c - p * wid / 2 / mpp + d * depth / 2 / mpp,
                      c - p * wid / 2 / mpp - d * depth / 2 / mpp, c + p * wid / 2 / mpp - d * depth / 2 / mpp], np.int32)
        cv2.fillPoly(lab, [q], -1)
    return rows


def process_image(img, mpp, roads=None):
    """Image -> rows (pixel coords): detection + row analysis."""
    lab, hsv, src, strict = detect_buildings(img, mpp, roads)
    ids = np.unique(lab)
    rows = []
    for i in ids[ids > 0]:
        bm = lab == i
        ys, xs = np.nonzero(bm)
        comp = np.stack([xs, ys], 1).astype(np.float32)
        if src.get(i) in ('B', 'C'):
            # villa rows: split where the roof cover drops (side yards); fall back to the shape itself
            sm = ((strict > 0) & bm).astype(np.uint8) * 255
            if sm.sum() / 255 > 0.25 * len(xs):
                rr = analyse(sm, hsv, mpp, comp, 0, 0, villa_hint=True)
                if rr:
                    rows += rr
                    continue
        rows += analyse(bm.astype(np.uint8) * 255, hsv, mpp, comp, 0, 0, villa_hint=src.get(i) in ('B', 'C'))
    rows += villa_chains(img, mpp, lab, hsv)
    rows += shadow_buildings(img, mpp, lab.copy(), hsv, roads)
    return rows


# Home type of each Valley project, read from its developer PDFs: townhouse sheets are drawn per
# "N-PLEX / TH 0x" unit; villa projects print VILLA / TWIN VILLA / SEMI-DETACHED.
PROJECT_KIND = {
    'the-valley': {
        **{k: 'townhouse' for k in ['vindera-at-the-valley', 'elva-at-the-valley', 'elea-at-the-valley', 'kaia-at-the-valley',
                                    'velora-2-at-the-valley-phase-2', 'venera-at-the-valley', 'velora-at-the-valley', 'lillia',
                                    'orania-at-the-valley', 'talia', 'nara', 'eden', 'nima', 'elora']},
        **{k: 'villa' for k in ['rivera-at-the-valley-phase-2', 'avena-at-the-valley', 'avena-2-at-the-valley', 'farm-grove-at-the-valley',
                                'farm-gardens-2', 'the-farm-gardens', 'alana', 'rivana', 'avelia-at-the-valley', 'ovelle-at-the-valley']},
    },
}


def finalize(rows, lat_lng, pins, kinds):
    """Type from the nearest project (projects are contiguous areas and their PDFs state the type);
    with no project type known, a neighbourhood vote on the geometric guess. Then units."""
    P = np.array([[la * 110574, lo * 101000] for la, lo in lat_lng]) if rows else np.zeros((0, 2))
    guess = np.array([1.0 if r['kind'] == 'villa' else 0.0 for r in rows])
    wts = np.array([max(1.0, r['L'] / 8) for r in rows])
    for i, r in enumerate(rows):
        la, lo = lat_lng[i]
        near = min(pins, key=lambda q: (q[1] - la) ** 2 + ((q[2] - lo) * math.cos(math.radians(la))) ** 2)
        if near[0] in kinds:
            r['kind'] = kinds[near[0]]
        else:
            d = np.hypot(*(P - P[i]).T) < 110
            r['kind'] = 'villa' if (guess[d] * wts[d]).sum() / max(1e-6, wts[d].sum()) >= 0.5 else 'townhouse'
        r['project'] = near[0]
        if r['kind'] == 'townhouse':
            k = max(1, round(r['L'] / 7.6))
            r['units'] = [r['L'] / k] * k
        else:
            # villas: one per roof segment when the segments are villa-sized, else by a 15.5 m plot
            sw = r['segWidths']
            segs = sw if len(sw) > 1 and all(7.5 <= w <= 34 for w in sw) else [r['L']]
            units = []
            for wdt in segs:
                k = max(1, round(wdt / 15.5)) if wdt > 21 else 1
                units += [wdt / k] * k
            r['units'] = units
    return rows


def _quad(r):
    a = math.radians(r['frontBearing'])
    f = np.array([math.sin(a), math.cos(a)])  # metric x east, y north
    u = np.array([f[1], -f[0]])
    c = np.array([r['lng'] * 101000.0, r['lat'] * 110574.0])
    L, D = r['L'] / 2, r['D'] / 2
    return np.array([c + u * L + f * D, c - u * L + f * D, c - u * L - f * D, c + u * L - f * D], np.float32)


def suppress_overlaps(rows):
    """Drop a row when more than 35 % of it lies inside a larger row already kept."""
    order = sorted(range(len(rows)), key=lambda i: -rows[i]['L'] * rows[i]['D'])
    kept, quads, cents = [], [], []
    for i in order:
        q = _quad(rows[i])
        c = q.mean(0)
        area = rows[i]['L'] * rows[i]['D']
        bad = False
        for qk, ck in zip(quads, cents):
            if np.hypot(*(c - ck)) > 150:
                continue
            inter, _ = cv2.intersectConvexConvex(q, qk)
            if inter > 0.35 * area:
                bad = True
                break
        if not bad:
            kept.append(rows[i]); quads.append(q); cents.append(c)
    return kept


def road_mask(streets, ax0, ay0, shape, mpp):
    """Raster of mapped streets (centre line at road width + 2 m) in chunk pixels; None if none."""
    if not streets:
        return None
    m = np.zeros(shape[:2], np.uint8)
    for st in streets:
        if st['cls'] == 'path':
            continue
        pts = []
        for lo, la in st['pts']:
            fx, fy = fxy(la, lo)
            pts.append([(fx - ax0) * TILE, (fy - ay0) * TILE])
        cv2.polylines(m, [np.array(pts, np.int32)], False, 255, max(1, int((st['width'] + 2) / mpp)))
    return m


def main(cid):
    projects = json.load(open(os.path.join(APP, 'data', 'projects.json')))
    districts = json.load(open(os.path.join(APP, 'data', 'districts.json')))
    nara = json.load(open(os.path.join(APP, 'data', 'nara_data.json')))
    old = json.load(open(os.path.join(APP, 'data', 'homes_detected.json')))
    c = next(x for x in projects['communities'] if x['id'] == cid)
    good = [p for p in c['projects'] if not p.get('pinFlag')]
    osm = next((d for d in districts if d['layer'] == 'districts' and d['name'] == c.get('osmName')), None)
    # built area = v1 detections + project pins, with a 300 m margin
    pts = [(r['lat'], r['lng']) for r in old['communities'].get(cid, [])] + [(p['lat'], p['lng']) for p in good]
    la0, la1 = min(p[0] for p in pts) - 0.003, max(p[0] for p in pts) + 0.003
    lo0, lo1 = min(p[1] for p in pts) - 0.003, max(p[1] for p in pts) + 0.003
    X0, Y0 = map(int, fxy(la1, lo0))
    X1, Y1 = map(int, fxy(la0, lo1))
    X1 += 1; Y1 += 1
    tiles = Tiles(cid)
    tiles.ensure(range(X0, X1), range(Y0, Y1))
    print(f'  {cid}: {(X1 - X0) * (Y1 - Y0)} tiles', flush=True)
    mpp = mpp_at((la0 + la1) / 2)

    def to_px(lat, lon):
        fx, fy = fxy(lat, lon)
        return (fx - X0) * TILE, (fy - Y0) * TILE

    clip = np.array([to_px(la, lo) for lo, la in osm['rings'][0]], np.float32) if osm else None
    nara_hull = cv2.convexHull(np.array([to_px(u['lat'], u['lon']) for u in nara['units']], np.float32))
    pins = [(p['id'], p['lat'], p['lng']) for p in good if p['id'] != 'nara']

    site_path = os.path.join(APP, 'data', 'site.json')
    streets = json.load(open(site_path))['communities'].get(cid, {}).get('streets') if os.path.exists(site_path) else None
    rows_out = []
    CH = 12  # tiles per chunk side
    seen = []
    for tx in range(X0, X1, CH):
        for ty in range(Y0, Y1, CH):
            ax0, ay0 = max(X0, tx - 1), max(Y0, ty - 1)
            ax1, ay1 = min(X1, tx + CH + 1), min(Y1, ty + CH + 1)
            img = tiles.mosaic(ax0, ay0, ax1, ay1)
            ox, oy = (ax0 - X0) * TILE, (ay0 - Y0) * TILE
            core = ((tx - ax0) * TILE, (ty - ay0) * TILE, (min(X1, tx + CH) - ax0) * TILE, (min(Y1, ty + CH) - ay0) * TILE)
            for r in process_image(img, mpp, road_mask(streets, ax0, ay0, img.shape, mpp)):
                cx_, cy_ = r['c']
                if not (core[0] <= cx_ < core[2] and core[1] <= cy_ < core[3]):
                    continue
                gx, gy = cx_ + ox, cy_ + oy
                if clip is not None and cv2.pointPolygonTest(clip, (float(gx), float(gy)), True) < -30 / mpp:
                    continue
                if cv2.pointPolygonTest(nara_hull, (float(gx), float(gy)), True) > -8 / mpp:
                    continue
                fx, fy = gx / TILE + X0, gy / TILE + Y0
                lat, lng = lonlat(fx, fy)
                bearing = (math.degrees(math.atan2(r['f'][0], -r['f'][1])) + 360) % 360
                rows_out.append({'lat': round(lat, 7), 'lng': round(lng, 7), 'L': round(r['L'], 2), 'D': round(r['D'], 2),
                                 'frontBearing': round(bearing, 2), 'kind': r['kind'], 'segWidths': r['segWidths'],
                                 'gapWidths': r['gapWidths'], 'streetConf': r['streetConf']})
            print(f'  chunk {tx},{ty}: {len(rows_out)} rows so far', flush=True)

    finalize(rows_out, [(r['lat'], r['lng']) for r in rows_out], pins, PROJECT_KIND.get(cid, {}))
    for r in rows_out:
        r['unitWidths'] = [round(x, 2) for x in r.pop('units')]
        r['units'] = len(r['unitWidths'])
        r.pop('segWidths'); r.pop('gapWidths')
    # apartment buildings from the zoom-18 pass are kept (this detector is tuned for houses)
    rows_out = [{**r, 'unitWidths': [r['L']]} for r in old['communities'].get(cid, []) if r.get('kind') == 'apartment'] + rows_out
    rows_out = suppress_overlaps(rows_out)
    # isolated detections are noise (a real neighbourhood has neighbours)
    P = np.array([[r['lat'] * 110574, r['lng'] * 101000] for r in rows_out])
    keep = [r for i, r in enumerate(rows_out) if (np.hypot(*(P - P[i]).T) < 60).sum() - 1 >= 2]
    path = os.path.join(APP, 'data', 'homes_detected.json')
    data = json.load(open(path))
    data['communities'][cid] = keep
    data.setdefault('detectors', {})[cid] = 'v2 building-level, Esri World Imagery z19 (~0.27 m/px), scripts/satellite/run_v2.py'
    json.dump(data, open(path, 'w'), separators=(',', ':'))
    th = sum(r['units'] for r in keep if r['kind'] == 'townhouse')
    vi = sum(r['units'] for r in keep if r['kind'] == 'villa')
    print(f'{cid}: {len(keep)} rows -> {th} townhouses + {vi} villas = {th + vi} homes')

    # review overlays around every project pin
    out_dir = os.path.join(APP, 'data', 'homes_detected_check')
    os.makedirs(out_dir, exist_ok=True)
    for p in good:
        if p['id'] == 'nara':
            continue
        px, py = to_px(p['lat'], p['lng'])
        half = int(160 / mpp)
        bx0, by0 = int((px - half) // TILE) + X0, int((py - half) // TILE) + Y0
        bx1, by1 = int((px + half) // TILE) + X0 + 1, int((py + half) // TILE) + Y0 + 1
        bx0, by0, bx1, by1 = max(X0, bx0), max(Y0, by0), min(X1, bx1), min(Y1, by1)
        img = tiles.mosaic(bx0, by0, bx1, by1)
        ox, oy = (bx0 - X0) * TILE, (by0 - Y0) * TILE
        for r in keep:
            gx, gy = to_px(r['lat'], r['lng'])
            if abs(gx - px) > half * 1.3 or abs(gy - py) > half * 1.3:
                continue
            a = math.radians(r['frontBearing'])
            f = np.array([math.sin(a), -math.cos(a)])
            u = np.array([-f[1], f[0]])
            cc = np.array([gx - ox, gy - oy])
            x = -r['L'] / 2
            col = (0, 255, 255) if r['kind'] == 'townhouse' else (255, 160, 0)
            for wdt in r['unitWidths']:
                p0 = cc + u * (x / mpp)
                p1 = cc + u * ((x + wdt) / mpp)
                quad = np.array([p0 + f * r['D'] / 2 / mpp, p1 + f * r['D'] / 2 / mpp, p1 - f * r['D'] / 2 / mpp, p0 - f * r['D'] / 2 / mpp], np.int32)
                cv2.polylines(img, [quad], True, col, 2)
                x += wdt
            cv2.arrowedLine(img, tuple(cc.astype(int)), tuple((cc + f * (r['D'] / 2 + 4) / mpp).astype(int)), (255, 0, 255), 2, tipLength=0.3)
        cv2.circle(img, (int(px - ox), int(py - oy)), 12, (0, 0, 255), -1)
        crop = img[max(0, int(py - oy - half)):int(py - oy + half), max(0, int(px - ox - half)):int(px - ox + half)]
        cv2.imwrite(os.path.join(out_dir, f'{cid}_{p["id"]}.jpg'), cv2.resize(crop, (1000, 1000)), [cv2.IMWRITE_JPEG_QUALITY, 82])


if __name__ == '__main__':
    main(sys.argv[1])

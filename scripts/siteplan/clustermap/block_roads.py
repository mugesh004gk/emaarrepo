#!/usr/bin/env python3
"""Street centre lines of a villa cluster from its placed homes: the street runs in front of each row.

  python scripts/siteplan/clustermap/block_roads.py <project>

On Emaar's villa cluster maps the rows face each other across their street (twins.py reads that from
the map). So, on the ground (data/siteplans/<project>.json, rows placed by place_blocks.py):
  - a home with a home facing it across the street: the centre line runs halfway between the two fronts;
  - a home with nothing opposite: at the typical half-gap of the facing pairs in front of it;
  - homes beside each other facing the same way form one run; the centre-line points of a run are
    joined in order and continued half a plot past the end homes;
  - the two runs of a street give the same line: a run lying half (50 %) within 8 m of a line already
    taken is not repeated;
  - a loose end within 22 m of another street line, straight on ahead of it (60 deg), is joined to it,
    unless the link would cross a house;
  - the carriageway (3.65 m either side) never enters a plot (house + front yard of 4 m, or less where the
    facing rows stand closer, + 8 m rear garden):
    a line is cut where it would.
Written as the project's 'roads' (source 'siteplan', note 'between facing rows of the cluster map').
Checks printed: house fronts -> centre line, roads crossing a house footprint (must be 0).
"""
import json, math, os, sys
import numpy as np

APP = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
KY = 110574.0


def seg_dist(p, a, b):
    v = b - a; l2 = float(v @ v) or 1e-9
    t = max(0.0, min(1.0, float((p - a) @ v) / l2))
    q = a + v * t
    return float(np.hypot(*(p - q))), q


def seg_cross(p1, p2, q1, q2):
    def o(a, b, c):
        return np.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]))
    return o(p1, p2, q1) != o(p1, p2, q2) and o(q1, q2, p1) != o(q1, q2, p2)


def main(proj):
    spath = os.path.join(APP, 'data', 'siteplans', f'{proj}.json')
    sp = json.load(open(spath))
    rows = sp['rows']
    lat0 = np.mean([r['lat'] for r in rows]); lng0 = np.mean([r['lng'] for r in rows])
    KX = 111320.0 * math.cos(math.radians(lat0))
    C = np.array([[(r['lng'] - lng0) * KX, (r['lat'] - lat0) * KY] for r in rows])
    F = np.array([[math.sin(math.radians(r['frontBearing'])), math.cos(math.radians(r['frontBearing']))] for r in rows])
    A = np.column_stack([F[:, 1], -F[:, 0]])
    D = np.array([r['D'] for r in rows]); L = np.array([r['L'] for r in rows])
    n = len(rows)
    # house footprints (for the crossing test)
    foot = [np.array([C[i] + A[i] * su * (L[i] / 2 * 0.8) + F[i] * sv * D[i] / 2 for su, sv in ((-1, -1), (1, -1), (1, 1), (-1, 1))]) for i in range(n)]
    # 1. facing pairs across the street
    half = [None] * n
    mate = [None] * n
    for i in range(n):
        rel = C - C[i]
        t = rel @ F[i]; lat = np.abs(rel @ A[i])
        cand = (F @ F[i] < -0.7) & (t > 0) & (lat < 0.8 * L[i]) & (t < 60)
        cand[i] = False
        if cand.any():
            j = int(np.where(cand)[0][np.argmin(t[cand])])
            gap = t[j] - D[i] / 2 - D[j] / 2
            if gap > 6:
                half[i] = gap / 2; mate[i] = j
    hs = [h for h in half if h is not None]
    h_typ = float(np.clip(np.median(hs), 6, 14)) if hs else 9.0
    Rp = np.array([C[i] + F[i] * (D[i] / 2 + (half[i] if half[i] is not None else h_typ)) for i in range(n)])
    # a facing pair shares one centre point: halfway between the two fronts (no zigzag between the runs)
    for i in range(n):
        j = mate[i]
        if j is not None and mate[j] == i:
            Rp[i] = ((C[i] + F[i] * D[i] / 2) + (C[j] + F[j] * D[j] / 2)) / 2 + A[i] * float((C[i] - C[j]) @ A[i]) / 2
    # 2. runs: neighbours beside each other, facing the same way
    nbr = [dict() for _ in range(n)]
    span = 2.6 * float(np.median(L))
    for i in range(n):
        rel = C - C[i]
        al = rel @ A[i]; ac = np.abs(rel @ F[i])
        for sgn in (1, -1):
            cand = (F @ F[i] > 0.7) & (al * sgn > 0.3 * L[i]) & (al * sgn < span) & (ac < 7)
            cand[i] = False
            if cand.any():
                j = int(np.where(cand)[0][np.argmin(np.abs(al[cand]))])
                nbr[i][sgn] = j
    link = set()
    for i in range(n):
        for sgn, j in nbr[i].items():
            if i in nbr[j].values():
                link.add((min(i, j), max(i, j)))
    adj = {i: set() for i in range(n)}
    for i, j in link:
        adj[i].add(j); adj[j].add(i)
    seen, runs = set(), []
    for s in range(n):
        if s in seen or len(adj[s]) == 2:
            continue
        run, prev, cur = [s], None, s
        seen.add(s)
        while True:
            nxt = [j for j in adj[cur] if j != prev and j not in seen]
            if not nxt:
                break
            prev, cur = cur, nxt[0]; run.append(cur); seen.add(cur)
        runs.append(run)
    for s in range(n):  # closed loops of runs
        if s not in seen:
            run, prev, cur = [s], None, s
            seen.add(s)
            while True:
                nxt = [j for j in adj[cur] if j != prev and j not in seen]
                if not nxt:
                    break
                prev, cur = cur, nxt[0]; run.append(cur); seen.add(cur)
            runs.append(run)
    # 3. a polyline per run, continued half a plot past its end homes
    lines = []
    for run in runs:
        # a street runs at a steady setback along its row: the setback of each home is the rolling median
        # (5 homes) of the run's setbacks, measured straight out from the front
        hb = np.array([float((Rp[i] - C[i]) @ F[i]) for i in run])
        hm = np.array([np.median(hb[max(0, k - 2):k + 3]) for k in range(len(run))])
        pts = [C[i] + F[i] * hm[k] for k, i in enumerate(run)]
        if len(run) == 1:
            i = run[0]
            pts = [Rp[i] - A[i] * L[i] * 0.75, Rp[i] + A[i] * L[i] * 0.75]
        else:
            a, b = run[0], run[-1]
            da = pts[0] - pts[1]; da /= np.hypot(*da) or 1
            db = pts[-1] - pts[-2]; db /= np.hypot(*db) or 1
            pts = [pts[0] + da * L[a] * 0.6] + pts + [pts[-1] + db * L[b] * 0.6]
        pts = np.array(pts)
        if len(pts) > 3:  # light smoothing of the inner points (block positions wobble by a metre or two)
            sm = pts.copy()
            sm[1:-1] = (pts[:-2] + 2 * pts[1:-1] + pts[2:]) / 4
            pts = sm
        lines.append(pts)
    # 4. one line per street: points within 4 m of a line already taken are dropped (line split there)
    lines.sort(key=lambda p: -len(p))
    taken = []
    def near_taken(p):
        for t in taken:
            for a, b in zip(t, t[1:]):
                if seg_dist(p, a, b)[0] < 8.0:
                    return True
        return False
    for ln in lines:
        # the run on the other side of a street already taken gives the same line: dropped whole when
        # most of its points lie on it (no fragments); a run that only touches it at an end is kept whole
        share = np.mean([near_taken(p) for p in ln])
        if share < 0.5:
            taken.append(ln)
    # 5. loose ends joined to the nearest other street line within 22 m (not across a house)
    def crosses_house(p, q):
        for fq in foot:
            if np.hypot(*(fq.mean(0) - (p + q) / 2)) > np.hypot(*(p - q)) / 2 + 20:
                continue
            for a, b in zip(fq, np.roll(fq, -1, axis=0)):
                if seg_cross(p, q, a, b):
                    return True
        return False
    joined = 0
    for li in range(len(taken)):
        for end in (0, -1):
            p = taken[li][end]
            best = None
            for lj, t in enumerate(taken):
                for a, b in zip(t, t[1:]):
                    if lj == li and (np.allclose(a, p) or np.allclose(b, p)):
                        continue
                    dd, q = seg_dist(p, a, b)
                    if lj == li and dd < 1:
                        continue
                    if best is None or dd < best[0]:
                        best = (dd, q)
            # a street end continues roughly straight on (within 60 deg), never sideways to a parallel line
            tg = taken[li][end] - taken[li][1 if end == 0 else -2]; tg = tg / (np.hypot(*tg) or 1)
            ahead = best is not None and float((best[1] - p) @ tg) > 0.5 * best[0]
            if best and 0.5 < best[0] <= 22 and ahead and not crosses_house(p, best[1]):
                taken[li] = np.vstack([best[1][None], taken[li]]) if end == 0 else np.vstack([taken[li], best[1][None]])
                joined += 1
    # the carriageway (half width 3.65 m) stays out of every plot: house, a 4 m front yard and an 8 m rear
    # garden over the plot width. The lines are resampled every metre and cut where they would enter one.
    Wd = np.array([sum(r.get('unitWidths') or [r['L']]) for r in rows])
    fy_ = float(np.clip(h_typ - 3.65 - 1.5, 0.5, 4.0))  # front yard: 4 m, less where facing rows stand closer
    def in_plot(q):
        rel = C - q
        al = np.abs(rel @ A.T).diagonal() if False else np.abs(np.einsum('ij,ij->i', -rel, A))
        dp = np.einsum('ij,ij->i', -rel, F)
        return bool(np.any((al < Wd / 2 - 0.5) & (dp < D / 2 + fy_ + 3.65) & (dp > -D / 2 - 8 - 3.65)))
    cut = 0
    pieces = []
    for t in taken:
        dense = [t[0]]
        for a, b in zip(t, t[1:]):
            k_ = max(1, int(np.hypot(*(b - a))))
            dense += [a + (b - a) * (j + 1) / k_ for j in range(k_)]
        cur = []
        for q in dense:
            if in_plot(q):
                if len(cur) >= 2:
                    pieces.append(np.array(cur))
                if cur:
                    cut += 1
                cur = []
            else:
                cur.append(q)
        if len(cur) >= 2:
            pieces.append(np.array(cur))
    # simplify the resampled pieces again; drop crumbs shorter than 8 m
    import cv2
    taken = []
    for pc in pieces:
        if float(np.sum(np.hypot(*np.diff(pc, axis=0).T))) < 8:
            continue
        ap = cv2.approxPolyDP(pc.astype(np.float32).reshape(-1, 1, 2), 0.4, False).reshape(-1, 2).astype(float)
        taken.append(ap)
    # checks
    crossing = sum(1 for t in taken for a, b in zip(t, t[1:]) if crosses_house(a, b))
    fd = []
    for i in range(n):
        p = C[i] + F[i] * D[i] / 2
        fd.append(min(seg_dist(p, a, b)[0] for t in taken for a, b in zip(t, t[1:])))
    roads = [{'pts': [[round(lng0 + x / KX, 7), round(lat0 + y / KY, 7)] for x, y in t], 'width': 7.3, 'source': 'siteplan',
              'note': 'between facing rows of the cluster map'} for t in taken]
    sp['roads'] = roads
    sp['keep_mapped_streets'] = True
    sp['checks']['roads'] = {'lines': len(roads), 'length_m': round(sum(float(np.sum(np.hypot(*np.diff(t, axis=0).T))) for t in taken)),
                             'method': 'centre line halfway between facing rows (typical half-gap %.1f m where a row has none opposite)' % h_typ,
                             'facing_pairs': len(hs), 'ends_joined': joined, 'segments_cut_at_a_house': cut, 'segments_crossing_a_house': crossing,
                             'front_to_centreline_median_m': round(float(np.median(fd)), 1), 'front_to_centreline_max_m': round(float(np.max(fd)), 1)}
    json.dump(sp, open(spath, 'w'), separators=(',', ':'))
    print(f"{proj}: {len(roads)} street lines, {sp['checks']['roads']['length_m']} m; facing pairs {len(hs)}/{n}, typical half-gap {h_typ:.1f} m; "
          f"ends joined {joined}; cut at a house {cut}; segments crossing a house {crossing}; front -> centre line median {np.median(fd):.1f} m, max {np.max(fd):.1f} m")
    return sp


if __name__ == '__main__':
    main(sys.argv[1])

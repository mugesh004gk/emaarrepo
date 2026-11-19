#!/usr/bin/env python3
"""From the unit numbers read on a cluster map (units_raw.json) to homes: position, row, facing.

  python scripts/siteplan/clustermap/layout_units.py <project> <brochure.pdf> <page> <terrace|villa>

 - a number missing in the reading but lying between two read numbers of the same row is placed
   on the line between them (interpolated, flagged);
 - row direction from the neighbouring numbers; a terrace = consecutive numbers at house pitch on one
   line; a villa = its own row;
 - facing: the side of the row where the map shows road (light grey, unsaturated) nearer to the
   house; a row whose neighbour across a green / water faces away from it.
Output: data/siteplans/<project>/layout.json (plan points, page units) + debug image in /tmp.
"""
import json, math, os, subprocess, sys, tempfile
import numpy as np
import cv2

APP = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
DPI = 150


def main():
    proj, pdf, page, kind = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
    d = os.path.join(APP, 'data', 'siteplans', proj)
    raw = json.load(open(os.path.join(d, 'units_raw.json')))
    P = {int(k): np.array(v, float) for k, v in raw['units'].items()}
    # numbers read by eye on the map where the reader missed or misplaced them: config 'manual_units' {no: [x, y]}
    cfgp = os.path.join(d, 'config.json')
    manual = json.load(open(cfgp)).get('manual_units', {}) if os.path.exists(cfgp) else {}
    for kk, v in manual.items():
        if not kk.startswith('_'):
            P[int(kk)] = np.array(v, float)
    # the total: the highest number with a well-read run below it (a stray high number is not a unit)
    N = max([n for n in P if sum(1 for k in range(n - 9, n + 1) if k in P) >= 6] or [raw['count']])
    P = {n: v for n, v in P.items() if n <= N}
    raw['read'] = len(P)
    pitch = raw['pitch']
    # interpolate missing numbers inside a row
    interp = []
    for n in range(1, N + 1):
        if n in P:
            continue
        lo = next((k for k in range(n - 1, max(0, n - 8), -1) if k in P), None)
        hi = next((k for k in range(n + 1, min(N + 1, n + 8)) if k in P), None)
        if lo is None or hi is None:
            continue
        dist = np.hypot(*(P[hi] - P[lo]))
        if abs(dist / ((hi - lo) * pitch) - 1) < 0.35:
            P[n] = P[lo] + (P[hi] - P[lo]) * (n - lo) / (hi - lo)
            interp.append(n)
    # page render for colours
    td = tempfile.mkdtemp()
    subprocess.run(['pdftoppm', '-q', '-r', str(DPI), '-png', '-f', str(page), '-l', str(page), pdf, os.path.join(td, 'p')], check=True)
    im = cv2.imread(os.path.join(td, [f for f in os.listdir(td) if f.endswith('.png')][0]))
    hsv = cv2.cvtColor(cv2.GaussianBlur(im, (5, 5), 0), cv2.COLOR_BGR2HSV)
    H, W = im.shape[:2]
    k = DPI / 72.0
    road = ((hsv[..., 1] < 28) & (hsv[..., 2] > 150) & (hsv[..., 2] < 238)).astype(np.uint8)
    green = ((hsv[..., 0] > 30) & (hsv[..., 0] < 90) & (hsv[..., 1] > 50)).astype(np.uint8)
    blue = ((hsv[..., 0] > 90) & (hsv[..., 0] < 130) & (hsv[..., 1] > 50)).astype(np.uint8)
    plotc = ((((hsv[..., 0] >= 78) & (hsv[..., 0] <= 102) & (hsv[..., 1] >= 45)) | ((hsv[..., 0] >= 15) & (hsv[..., 0] <= 34) & (hsv[..., 1] >= 30) & (hsv[..., 2] >= 200)))).astype(np.uint8)

    def frac(mask, x, y, ux, uy, d0, d1, half):
        cnt = tot = 0
        for t in np.linspace(d0, d1, 8):
            for s in np.linspace(-half, half, 5):
                px, py = int((x + ux * t - uy * s) * k), int((y + uy * t + ux * s) * k)
                if 0 <= px < W and 0 <= py < H:
                    tot += 1; cnt += mask[py, px]
        return cnt / tot if tot else 0

    units = {}
    for n in sorted(P):
        nb = [P[m] for m in (n - 1, n + 1) if m in P and np.hypot(*(P[m] - P[n])) < 1.6 * pitch]
        if len(nb) == 2:
            ax = nb[1] - nb[0]
        elif len(nb) == 1:
            ax = (nb[0] - P[n]) * (1 if (n + 1 in P and np.allclose(nb[0], P[n + 1])) else -1)
        else:
            far = [P[m] for m in (n - 1, n + 1) if m in P]
            ax = (far[-1] - far[0]) if len(far) == 2 else np.array([1.0, 0.0])
        ax = ax / (np.hypot(*ax) or 1)
        nx, ny = -ax[1], ax[0]
        # road on which side: road share near the house (0.6-2.2 pitch out), green/water count against
        s1 = frac(road, P[n][0], P[n][1], nx, ny, 0.6 * pitch, 2.2 * pitch, 0.3 * pitch) - 0.5 * frac(green + blue, P[n][0], P[n][1], nx, ny, 0.6 * pitch, 2.2 * pitch, 0.3 * pitch)
        s2 = frac(road, P[n][0], P[n][1], -nx, -ny, 0.6 * pitch, 2.2 * pitch, 0.3 * pitch) - 0.5 * frac(green + blue, P[n][0], P[n][1], -nx, -ny, 0.6 * pitch, 2.2 * pitch, 0.3 * pitch)
        if os.environ.get('FACE') == 'plot':
            # villas on coloured plots: the rear garden is plot colour, the front opens onto the road
            q1 = frac(plotc, P[n][0], P[n][1], nx, ny, 0.45 * pitch, 1.1 * pitch, 0.25 * pitch)
            q2 = frac(plotc, P[n][0], P[n][1], -nx, -ny, 0.45 * pitch, 1.1 * pitch, 0.25 * pitch)
            s1, s2 = q2, q1
        f = (nx, ny) if s1 >= s2 else (-nx, -ny)
        units[n] = dict(p=P[n].tolist(), axis=ax.tolist(), front=list(f), conf=round(abs(s1 - s2), 3), interp=n in interp)
    # facing agreement along a row: neighbours in a terrace face the same way
    if kind == 'terrace':
        for n in units:
            nbs = [units[m] for m in (n - 1, n + 1) if m in units and np.hypot(*(np.array(units[m]['p']) - units[n]['p'])) < 1.6 * pitch]
            if len(nbs) == 2 and all(np.dot(b['front'], units[n]['front']) < 0 for b in nbs) and units[n]['conf'] < max(b['conf'] for b in nbs):
                units[n]['front'] = [-units[n]['front'][0], -units[n]['front'][1]]
    # rows
    rows = []
    cur = []
    for n in sorted(units):
        u = units[n]
        if cur and kind == 'terrace':
            v = units[cur[-1]]
            dd = np.hypot(*(np.array(u['p']) - v['p']))
            same = n == cur[-1] + 1 and dd < 1.45 * pitch and np.dot(u['front'], v['front']) > 0.7 and np.dot(u['axis'], v['axis']) ** 2 > 0.9
            if not same:
                rows.append(cur); cur = []
        elif cur:
            rows.append(cur); cur = []
        cur.append(n)
    if cur:
        rows.append(cur)
    # GROUP=<n>: every terrace holds n homes numbered n*k+1 .. n*k+n (Venera: 4-home terraces only). The row is
    # that number run; one axis (line fitted through its read homes, in number order) and one facing (the
    # members' readings, weighted by confidence) for the whole terrace; a reading far off the run's line
    # (misread number) is dropped and, like an unread number, placed on the line at its position in the run.
    grp = int(os.environ.get('GROUP', '0') or 0)
    if kind == 'terrace' and grp:
        rows, regrouped = [], []
        for k0 in range(1, N + 1, grp):
            ns = [n for n in range(k0, min(k0 + grp, N + 1))]
            have = [n for n in ns if n in units]
            if len(have) >= 2:
                med = np.median([units[n]['p'] for n in have], 0)
                far = [n for n in have if np.hypot(*(np.array(units[n]['p']) - med)) > 0.75 * grp * pitch]
                for n in far:
                    units.pop(n); have.remove(n); regrouped.append(n)
            if len(have) < 2:
                rows.append(have) if have else None
                continue
            X = np.array([units[n]['p'] for n in have]); t = np.array(have, float)
            # position = a + b * number (least squares per coordinate): gives the axis and the spacing
            A_ = np.vstack([np.ones_like(t), t]).T
            coef, *_ = np.linalg.lstsq(A_, X, rcond=None)
            step = coef[1]; ax = step / (np.hypot(*step) or 1)
            nrm = np.array([-ax[1], ax[0]])
            vote = sum(np.sign(np.dot(units[n]['front'], nrm)) * (units[n]['conf'] + 0.02) for n in have)
            fr = nrm if vote >= 0 else -nrm
            if abs(np.hypot(*step) / pitch - 1) > 0.35:
                step = ax * pitch
            for n in ns:
                if n not in units:
                    units[n] = dict(p=(coef[0] + coef[1] * n).tolist() if len(have) >= 2 else units[have[0]]['p'], axis=ax.tolist(), front=fr.tolist(), conf=0.0, interp=True)
                    interp.append(n)
                else:
                    units[n].update(axis=ax.tolist(), front=fr.tolist())
            rows.append(ns)
        print(f'  GROUP={grp}: {len(rows)} terraces by number run; misread positions re-placed on their run: {regrouped}')
        if os.environ.get('SHAPE'):
            # direction of each terrace from its drawn building (white / grey roofs around its labels): the outline's
            # long side, when the outline has a terrace's size; the labels alone can tilt the fitted line
            roofm = ((hsv[..., 1] < 30) & (hsv[..., 2] > 165)).astype(np.uint8)
            roofm = cv2.morphologyEx(roofm, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
            nlab, lab_, st_, _ = cv2.connectedComponentsWithStats(roofm, 8)
            shaped = 0; done_rows = set()
            for r in rows:
                if len(r) != grp:
                    continue
                cen = np.mean([units[n]['p'] for n in r], 0)
                cx, cy = int(cen[0] * k), int(cen[1] * k)
                win = lab_[max(0, cy - 6):cy + 7, max(0, cx - 6):cx + 7].ravel()
                win = win[win > 0]
                if not len(win):
                    continue
                cid = np.bincount(win).argmax()
                ys, xs = np.where(lab_ == cid)
                if len(xs) > 40000:
                    continue
                (rx, ry), (rw, rh), ang = cv2.minAreaRect(np.column_stack([xs, ys]).astype(np.float32))
                L_, D_ = max(rw, rh) / k, min(rw, rh) / k
                if not (0.6 * grp * pitch < L_ < 1.6 * grp * pitch and D_ < 0.8 * L_):
                    continue
                th = np.radians(ang if rw >= rh else ang + 90)
                ax = np.array([np.cos(th), np.sin(th)])
                if np.dot(ax, np.array(units[r[-1]]['p']) - units[r[0]]['p']) < 0:
                    ax = -ax
                nrm = np.array([-ax[1], ax[0]])
                fr = nrm if np.dot(units[r[0]]['front'], nrm) >= 0 else -nrm
                c2 = np.array([rx, ry]) / k; mid = np.mean(r)
                # the outline gives the direction and the line; along it the homes are equally spaced, in number order,
                # at the place the readings give (robust fit: one misplaced label does not move the terrace)
                rd = [n for n in r if n in P and n not in regrouped]
                if len(rd) >= 2:
                    tt = np.array([np.dot(P[n] - c2, ax) for n in rd]); nn_ = np.array(rd, float)
                    b_ = float(np.median([(tt[j] - tt[i]) / (nn_[j] - nn_[i]) for i in range(len(rd)) for j in range(i + 1, len(rd))]))
                    a_ = float(np.median(tt - b_ * nn_))
                    if b_ < 0:  # numbers run the other way along the outline
                        ax = -ax; nrm = -nrm; tt = -tt; b_, a_ = -b_, -a_
                    if abs(b_ / pitch - 1) > 0.4:
                        a_, b_ = float(np.mean(tt) - pitch * np.mean(nn_)), pitch
                    pos_ = {n: c2 + ax * (a_ + b_ * n) for n in r}
                else:
                    pos_ = {n: c2 + ax * pitch * (n - mid) for n in r}
                fr = nrm if np.dot(units[r[0]]['front'], nrm) >= 0 else -nrm
                for n in r:
                    units[n].update(p=pos_[n].tolist(), axis=ax.tolist(), front=fr.tolist())
                shaped += 1; done_rows.add(r[0])
            print(f'  SHAPE: {shaped} of {len(rows)} terraces set from their drawn building outline')
            # a terrace without a clean outline: the direction of the nearest outlined terraces (3, within 8 homes'
            # length) when it is within 35 deg of its own - the streets run in a few local directions
            ref = [(np.mean([units[n]['p'] for n in r], 0), np.array(units[r[0]]['axis'])) for r in rows if r and r[0] in done_rows]
            borrowed = 0
            for r in rows:
                if len(r) != grp or r[0] in done_rows:
                    continue
                cen = np.mean([units[n]['p'] for n in r], 0)
                near = sorted(ref, key=lambda q: np.hypot(*(q[0] - cen)))[:3]
                near = [q for q in near if np.hypot(*(q[0] - cen)) < 8 * grp * pitch]
                if not near:
                    continue
                a0 = np.array(units[r[0]]['axis'])
                angs = [np.degrees(np.arctan2(q[1][1], q[1][0])) % 180 for q in near]
                m = np.degrees(np.arctan2(np.mean(np.sin(np.radians(2 * np.array(angs)))), np.mean(np.cos(np.radians(2 * np.array(angs)))))) / 2
                ax = np.array([np.cos(np.radians(m)), np.sin(np.radians(m))])
                if np.dot(ax, a0) < 0:
                    ax = -ax
                if np.degrees(np.arccos(min(1, abs(np.dot(ax, a0))))) > 35:
                    continue
                rd = [n for n in r if n in P and n not in regrouped]
                if len(rd) >= 2:
                    cen = np.mean([P[n] for n in rd], 0) + ax * pitch * (np.mean(r) - np.mean(rd))
                    tt = np.array([np.dot(P[n] - cen, ax) for n in rd]); nn_ = np.array(rd, float)
                    b_ = float(np.median([(tt[j] - tt[i]) / (nn_[j] - nn_[i]) for i in range(len(rd)) for j in range(i + 1, len(rd))]))
                    a_ = float(np.median(tt - b_ * nn_))
                    if b_ < 0:
                        ax = -ax; tt = -tt; b_, a_ = -b_, -a_
                    if abs(b_ / pitch - 1) > 0.4:
                        a_, b_ = float(np.mean(tt) - pitch * np.mean(rd)), pitch
                    pos_ = {n: cen + ax * (a_ + b_ * n) for n in r}
                else:
                    pos_ = {n: cen + ax * pitch * (n - np.mean(r)) for n in r}
                nrm = np.array([-ax[1], ax[0]]); fr = nrm if np.dot(units[r[0]]['front'], nrm) >= 0 else -nrm
                for n in r:
                    units[n].update(p=pos_[n].tolist(), axis=ax.tolist(), front=fr.tolist())
                borrowed += 1
            print(f'  SHAPE: {borrowed} terraces without an outline took the direction of their outlined neighbours')
        if os.environ.get('SNAP'):
            # terraces of a planned layout run in a few directions only: a terrace whose fitted axis is within
            # 25 deg of a direction shared by many terraces takes that direction (4 label positions with one off by
            # a little turn the fitted line); its homes are re-spaced along it from the run's centre
            angs = np.array([np.degrees(np.arctan2(units[r[0]]['axis'][1], units[r[0]]['axis'][0])) % 180 for r in rows if len(r) == grp])
            hist = np.zeros(180)
            for a_ in angs:
                for dd in range(-2, 3):
                    hist[int(round(a_ + dd)) % 180] += 1
            modes = [m for m in range(180) if hist[m] >= max(0.05 * len(angs) * 5, 5) and hist[m] == max(hist[(m + j) % 180] for j in range(-12, 13))]
            snapped = 0
            for r in rows:
                if len(r) != grp:
                    continue
                a0 = np.degrees(np.arctan2(units[r[0]]['axis'][1], units[r[0]]['axis'][0]))
                best = min(modes, key=lambda m: abs(((a0 - m + 90) % 180) - 90), default=None)
                if best is None or abs(((a0 - best + 90) % 180) - 90) > 25:
                    continue
                d0 = a0 + (((best - a0 + 90) % 180) - 90)
                ax = np.array([np.cos(np.radians(d0)), np.sin(np.radians(d0))])
                nrm = np.array([-ax[1], ax[0]])
                fr = nrm if np.dot(units[r[0]]['front'], nrm) >= 0 else -nrm
                cen = np.mean([units[n]['p'] for n in r], 0); mid = np.mean(r)
                sp = np.mean([np.hypot(*(np.array(units[r[i + 1]]['p']) - units[r[i]]['p'])) for i in range(grp - 1)])
                sp = sp if abs(sp / pitch - 1) < 0.35 else pitch
                for n in r:
                    units[n].update(p=(cen + ax * sp * (n - mid)).tolist(), axis=ax.tolist(), front=fr.tolist())
                snapped += 1
            print(f'  SNAP: directions {modes}; {snapped} terraces set to the nearest one')
    # a short run (1-2 homes) next to a terrace with consecutive numbers belongs to it (its facing was misread)
    if kind == 'terrace' and not grp:
        changed = True
        while changed:
            changed = False
            for i, r in enumerate(rows):
                if len(r) > 2:
                    continue
                for j in (i - 1, i + 1):
                    if 0 <= j < len(rows) and len(rows[j]) > 2:
                        a, b = (rows[j][-1], r[0]) if j < i else (r[-1], rows[j][0])
                        if b == a + 1 and np.hypot(*(np.array(units[a]['p']) - units[b]['p'])) < 1.6 * pitch:
                            for n in r:
                                units[n]['front'] = units[rows[j][0]]['front']
                            rows[j] = sorted(rows[j] + r); rows.pop(i); changed = True
                            break
                if changed:
                    break
    # terrace sizes on the project's floor plans (env PLEX=4,6,8): neighbouring runs with consecutive numbers
    # on one line, where either run is not a valid terrace and together they are, are one terrace whose
    # facing was misread on some homes; its facing = the confidence-weighted vote of its homes
    plex = [int(x) for x in os.environ.get('PLEX', '').split(',') if x]
    if kind == 'terrace' and plex:
        changed = True
        while changed:
            changed = False
            for i in range(len(rows) - 1):
                # a window of up to 4 neighbouring runs: consecutive numbers, adjacent, on one line
                for j in range(i + 1, min(len(rows), i + 4)):
                    win = rows[i:j + 1]
                    tot = sum(len(x) for x in win)
                    if tot > max(plex):
                        break
                    ok = all(win[q + 1][0] == win[q][-1] + 1 and np.hypot(*(np.array(units[win[q][-1]]['p']) - units[win[q + 1][0]]['p'])) <= 1.6 * pitch
                             and np.dot(units[win[q][-1]]['axis'], units[win[q + 1][0]]['axis']) ** 2 >= 0.9 for q in range(len(win) - 1))
                    if not ok:
                        break
                    if tot in plex and any(len(x) not in plex for x in win):
                        r = [n for x in win for n in x]
                        ref = np.array(units[r[0]]['front'])
                        vote = sum((units[n]['conf'] + 0.01) * (1 if np.dot(units[n]['front'], ref) > 0 else -1) for n in r)
                        f = (ref if vote >= 0 else -ref).tolist()
                        for n in r:
                            units[n]['front'] = f
                        rows[i:j + 1] = [r]; changed = True
                        break
                if changed:
                    break
    # a terrace one home short of a valid size (PLEX) whose next / previous number is missing: that home is
    # at the open end, one pitch on along the terrace (flagged as interpolated)
    if kind == 'terrace' and plex:
        for i, r in enumerate(rows):
            if len(r) in plex or len(r) + 1 not in plex or len(r) < 2:
                continue
            for n, a, b in ((r[-1] + 1, r[-1], r[-2]), (r[0] - 1, r[0], r[1])):
                if n < 1 or n > N or n in units:
                    continue
                pa, pb = np.array(units[a]['p']), np.array(units[b]['p'])
                units[n] = dict(units[a], p=(pa + (pa - pb)).tolist(), interp=True, conf=0.0)
                interp.append(n)
                rows[i] = sorted(r + [n])
                break
    # terraces checked by eye on the map (config 'rows_force': [[first, last], ...]): one terrace from first to last
    for fl in (manual_rows := (json.load(open(cfgp)).get('rows_force', []) if os.path.exists(cfgp) else [])):
        a0, a1 = fl[0], fl[1]
        rows = [r for r in rows if not (set(r) & set(range(a0, a1 + 1)))] + [list(range(a0, a1 + 1))]
        ref = units.get(a0) or units.get(a1)
        A0, A1 = np.array(units[a0]['p']), np.array(units[a1]['p']); ax = (A1 - A0) / (np.hypot(*(A1 - A0)) or 1)
        for n in range(a0, a1 + 1):
            if n in units:
                units[n]['axis'] = ax.tolist()
    rows.sort(key=lambda r: r[0])
    out = dict(project=proj, kind=kind, count=N, pitch=pitch, read=raw['read'], interpolated=interp,
               missing=[n for n in range(1, N + 1) if n not in units], units={str(k): v for k, v in units.items()}, rows=rows,
               source=raw['source'])
    json.dump(out, open(os.path.join(d, 'layout.json'), 'w'))
    # debug image
    vis = im.copy()
    for r in rows:
        pts = np.array([[units[n]['p'][0] * k, units[n]['p'][1] * k] for n in r], np.int32)
        if len(pts) > 1:
            cv2.polylines(vis, [pts], False, (255, 0, 0), 2)
    for n, u in units.items():
        x, y = int(u['p'][0] * k), int(u['p'][1] * k)
        cv2.circle(vis, (x, y), 3, (0, 0, 255) if not u['interp'] else (0, 165, 255), -1)
        cv2.line(vis, (x, y), (int(x + u['front'][0] * pitch * k), int(y + u['front'][1] * pitch * k)), (0, 200, 0), 2)
    cv2.imwrite(f'/tmp/layout_{proj}.png', vis)
    print(f"{proj}: {N} units, read {raw['read']}, interpolated {len(interp)}, still missing {len(out['missing'])}; rows {len(rows)} (sizes {sorted(set(len(r) for r in rows))})")


if __name__ == '__main__':
    main()

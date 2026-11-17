#!/usr/bin/env python3
"""Square every row of homes to its street (data/homes_detected.json).

The row directions measured from the satellite photo are often 10-30 degrees off, which made whole
rows sit at an angle to their street and run into it. For every townhouse / villa row:
 1. the mapped street in front of it (within the row depth + 30 m, the row already roughly facing it,
    within 50 degrees) sets its direction: the row runs along the street and faces it; on a curved
    street the local piece of the street counts;
 2. the row keeps the same distance from the street as its neighbours: its front edge 3.5 m behind
    the carriageway edge (kerb + footpath), moved by at most 5 m;
 3. rows with no mapped street in reach take the direction of the squared rows around them (within
    70 m, same block orientation within 35 degrees), so a block of rows is parallel;
 4. a row that would still stand on a carriageway is moved back (up to 10 m), else kept as detected.
Runs after the detection / cleaning scripts and before derive_site.py (which re-makes the derived
access streets around the squared rows).
  python3 scripts/snap_rows.py"""
import json, math, os

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KY = 110574.0
MAX_TURN = 50.0  # degrees: a row facing its street at most this far off is squared to it
SETBACK = 2.0  # m from the carriageway edge to the front of the plot (kerb + footpath)
MAX_MOVE = 9.0  # m
# The 3D homes are Nara's plans (plot 23.55 m deep): rear garden 6.15 m behind the detected back wall,
# then house, carport and driveway. Their plot front lies at 17.4 - D/2 in front of the row centre,
# well beyond the detected roof - streets and setbacks are measured to that front.
def plot_front(r):
    return max(r['D'] / 2, 17.4 - r['D'] / 2)


def seg_near(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    l2 = vx * vx + vy * vy or 1
    t = max(0, min(1, ((px - ax) * vx + (py - ay) * vy) / l2))
    qx, qy = ax + vx * t, ay + vy * t
    return math.hypot(px - qx, py - qy), qx, qy


def main():
    hd = json.load(open(os.path.join(APP, 'data', 'homes_detected.json')))
    site = json.load(open(os.path.join(APP, 'data', 'site.json')))
    for cid, rows in hd['communities'].items():
        if cid not in site['communities'] or not rows:
            continue
        KX = 111320.0 * math.cos(math.radians(rows[0]['lat']))
        segs = []  # (ax, ay, bx, by, halfWidth)
        for s in site['communities'][cid]['streets']:
            if s.get('source') == 'derived' or s['cls'] == 'path':
                continue
            p = [(lo * KX, la * KY) for lo, la in s['pts']]
            hw = (s.get('width') or 7.3) / 2
            segs += [(p[i][0], p[i][1], p[i + 1][0], p[i + 1][1], hw) for i in range(len(p) - 1)]
        grid = {}
        for sg in segs:
            for gx in range(int(min(sg[0], sg[2]) // 50) - 1, int(max(sg[0], sg[2]) // 50) + 2):
                for gy in range(int(min(sg[1], sg[3]) // 50) - 1, int(max(sg[1], sg[3]) // 50) + 2):
                    grid.setdefault((gx, gy), []).append(sg)

        def near_segs(x, y):
            return grid.get((int(x // 50), int(y // 50)), [])

        snapped, moved, consensus, pushed, dropped = 0, 0, 0, 0, 0
        original = [dict(lat=r['lat'], lng=r['lng'], frontBearing=r['frontBearing']) for r in rows]
        turned = []
        done = [False] * len(rows)
        for i, r in enumerate(rows):
            if r.get('kind') == 'apartment':
                continue
            a = math.radians(r['frontBearing'])
            f = (math.sin(a), math.cos(a))
            cx, cy = r['lng'] * KX, r['lat'] * KY
            best = None
            for (ax, ay, bx, by, hw) in near_segs(cx, cy):
                d, qx, qy = seg_near(cx, cy, ax, ay, bx, by)
                if d > plot_front(r) + 30 or d < 1:
                    continue
                L = math.hypot(bx - ax, by - ay) or 1
                dx, dy = (bx - ax) / L, (by - ay) / L
                n = (-dy, dx)  # street normal, toward the row
                if n[0] * (cx - qx) + n[1] * (cy - qy) < 0:
                    n = (dy, -dx)
                nf = (-n[0], -n[1])  # the row's front faces the street
                cosang = f[0] * nf[0] + f[1] * nf[1]
                if cosang < math.cos(math.radians(MAX_TURN)):
                    continue
                # the street must lie in front of the row (not behind or beside it)
                ahead = (qx - cx) * f[0] + (qy - cy) * f[1]
                if ahead < r['D'] / 2 - 2:
                    continue
                score = d - 8 * cosang
                if best is None or score < best[0]:
                    best = (score, d, qx, qy, nf, hw)
            if not best:
                continue
            _, d, qx, qy, nf, hw = best
            old = r['frontBearing']
            nb = (math.degrees(math.atan2(nf[0], nf[1])) + 360) % 360
            turned.append(abs(((nb - old + 540) % 360) - 180))
            r['frontBearing'] = round(nb, 2)
            # distance from the street centre line to the row centre: carriageway + setback + half depth
            want = hw + SETBACK + plot_front(r)
            cur = (cx - qx) * -nf[0] + (cy - qy) * -nf[1]
            shift = max(-MAX_MOVE, min(MAX_MOVE, want - cur))
            if abs(shift) > 0.05:
                cx -= nf[0] * shift
                cy -= nf[1] * shift
                moved += 1
            r['lng'], r['lat'] = round(cx / KX, 7), round(cy / KY, 7)
            r['squared'] = 'street'
            done[i] = True
            snapped += 1

        # rows without a street in reach: follow the squared rows around them
        cgrid = {}
        for i, r in enumerate(rows):
            if done[i]:
                cgrid.setdefault((int(r['lng'] * KX // 70), int(r['lat'] * KY // 70)), []).append(i)
        for i, r in enumerate(rows):
            if done[i] or r.get('kind') == 'apartment':
                continue
            cx, cy = r['lng'] * KX, r['lat'] * KY
            axis = math.radians(r['frontBearing']) % math.pi
            votes = []
            gx, gy = int(cx // 70), int(cy // 70)
            for a2 in (-1, 0, 1):
                for b2 in (-1, 0, 1):
                    for j in cgrid.get((gx + a2, gy + b2), []):
                        q = rows[j]
                        if math.hypot(q['lng'] * KX - cx, q['lat'] * KY - cy) > 70:
                            continue
                        qa = math.radians(q['frontBearing']) % math.pi
                        diff = (qa - axis + math.pi / 2) % math.pi - math.pi / 2
                        if abs(diff) < math.radians(35):
                            votes.append(diff)
            if len(votes) < 2:
                continue
            votes.sort()
            diff = votes[len(votes) // 2]
            r['frontBearing'] = round((r['frontBearing'] + math.degrees(diff)) % 360, 2)
            turned.append(abs(math.degrees(diff)))
            r['squared'] = 'neighbours'
            consensus += 1

        # nothing on a carriageway
        keep = []
        for i, r in enumerate(rows):
            if r.get('kind') == 'apartment':
                keep.append(r)
                continue
            ok = False
            for step in range(0, 21):
                if not on_road(r, KX, near_segs):
                    ok = True
                    break
                if step == 20:
                    break
                a = math.radians(r['frontBearing'])
                r['lng'] -= math.sin(a) * 0.5 / KX
                r['lat'] -= math.cos(a) * 0.5 / KY
            if ok:
                if step:
                    pushed += 1
            else:
                # cannot be squared off the road: keep the home where it was detected (never remove homes)
                r.update(original[i])
                r.pop('squared', None)
                dropped += 1
            keep.append(r)
        hd['communities'][cid] = keep
        turned.sort()
        med = turned[len(turned) // 2] if turned else 0
        print(f'{cid}: squared to their street {snapped}, to neighbours {consensus} (median turn {med:.1f} deg, '
              f'{sum(t > 10 for t in turned)} turned >10 deg); moved to the street line {moved}; pushed off a road {pushed}; '
              f'kept as detected (would touch a road) {dropped}')
    json.dump(hd, open(os.path.join(APP, 'data', 'homes_detected.json'), 'w'), separators=(',', ':'))


def on_road(r, KX, near_segs):
    """True when the row's house rectangle reaches into a carriageway"""
    a = math.radians(r['frontBearing'])
    f = (math.sin(a), math.cos(a)); u = (f[1], -f[0])
    cx, cy = r['lng'] * KX, r['lat'] * KY
    hl = r['L'] / 2
    front, back = plot_front(r), r['D'] / 2  # house, carport and driveway (gardens behind may meet a lane)
    pts = [(cx + u[0] * sl * hl * k + f[0] * dz, cy + u[1] * sl * hl * k + f[1] * dz)
           for sl in (-1, 1) for k in (0.25, 0.6, 1) for dz in (-back, -back / 2, 0, front / 2, front)]
    for (ax, ay, bx, by, hw) in near_segs(cx, cy):
        for (x, y) in pts:
            if seg_near(x, y, ax, ay, bx, by)[0] < hw - 0.3:
                return True
    return False


if __name__ == '__main__':
    main()

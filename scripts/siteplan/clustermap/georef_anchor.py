#!/usr/bin/env python3
"""Place a project map (page points) on the ground through the Valley masterplan from hand-read matching points:
the project map's points and the same points on the masterplan image give a similarity (scale, shift; the
rotation is fitted too, and reported); composed with the masterplan's own fit to the ground.

  python georef_anchor.py <project> "<x,y>=<mx,my>;<x,y>=<mx,my>;..." "<method text>"   -> data/siteplans/<project>/georef.json
"""
import json, os, sys
import numpy as np
APP = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
MP = os.path.join(APP, '..', 'emaarcommunity', 'research', 'the-valley', 'masterplan', 'valley_masterplan.json')
proj, pairs, why = sys.argv[1], sys.argv[2], sys.argv[3]
P, Q = [], []
for pr in pairs.split(';'):
    a, b = pr.split('=')
    P.append([float(v) for v in a.split(',')]); Q.append([float(v) for v in b.split(',')])
P, Q = np.array(P), np.array(Q)
mp, mq = P.mean(0), Q.mean(0); A_, B_ = P - mp, Q - mq
U, S, Vt = np.linalg.svd(B_.T @ A_); R = U @ Vt
if np.linalg.det(R) < 0:
    R = U @ np.diag([1, -1]) @ Vt
s = S.sum() / (A_ ** 2).sum(); t = mq - s * R @ mp
res = np.linalg.norm((s * (R @ P.T)).T + t - Q, axis=1)
m = json.load(open(MP)); A = np.array(m['A'])
T = np.vstack([np.hstack([s * R, t[:, None]]), [0, 0, 1]])
An = A @ T
rot = float(np.degrees(np.arctan2(R[1, 0], R[0, 0])))
g = {'image': proj + ' cluster map (page points)', 'lat0': m['lat0'], 'lng0': m['lng0'], 'A': [[round(float(v), 6) for v in r] for r in An],
     'scale_m_per_px': round(float(s * m['scale_m_per_px']), 4),
     'method': f"{why}; {len(P)} matching points read by eye, similarity fit (rotation {rot:.1f} deg, residual max {res.max():.1f} masterplan px = {res.max() * m['scale_m_per_px']:.0f} m); masterplan fitted to the placed homes (corr {m['corr']})",
     'accuracy': 'provisional: position from the Valley masterplan, estimated within about 30-50 m'}
json.dump(g, open(os.path.join(APP, 'data', 'siteplans', proj, 'georef.json'), 'w'), indent=1)
print(f"{proj}: scale {s:.4f} mp px/pt, rotation {rot:.1f} deg, residuals {np.round(res, 1).tolist()} mp px; {g['scale_m_per_px']} m/pt")

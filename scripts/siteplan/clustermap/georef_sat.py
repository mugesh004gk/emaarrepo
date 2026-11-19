#!/usr/bin/env python3
"""Place a project map (page points) on the ground from hand-read matching points between the map and a
satellite crop (place_cluster.sat, north up): similarity fit; writes data/siteplans/<project>/georef.json.
  python georef_sat.py <project> <crop.json {lat,lng,mpp,shape}> "<x,y>=<px,py>;..." "<method>"
"""
import json, math, os, sys
import numpy as np
APP = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
proj, cj, pairs, why = sys.argv[1], json.load(open(sys.argv[2])), sys.argv[3], sys.argv[4]
lat0, lng0, KY = 25.006, 55.447, 110574.0; KX = 111320.0 * math.cos(math.radians(lat0)); c0 = (cj['shape'][1] - 1) / 2
def en(px, py):
    lat = cj['lat'] - (py - c0) * cj['mpp'] / KY; lng = cj['lng'] + (px - c0) * cj['mpp'] / (111320.0 * math.cos(math.radians(cj['lat'])))
    return [(lng - lng0) * KX, (lat - lat0) * KY]
P, Q = [], []
for pr in pairs.split(';'):
    a, b = pr.split('='); P.append([float(v) for v in a.split(',')]); Q.append(en(*[float(v) for v in b.split(',')]))
P, Q = np.array(P) * [1, -1], np.array(Q)
mp, mq = P.mean(0), Q.mean(0); A_, B_ = P - mp, Q - mq
U, S, Vt = np.linalg.svd(B_.T @ A_); R = U @ Vt
if np.linalg.det(R) < 0: R = U @ np.diag([1, -1]) @ Vt
s = S.sum() / (A_ ** 2).sum(); t = mq - s * R @ mp
res = np.linalg.norm((s * (R @ P.T)).T + t - Q, axis=1)
M = s * R @ np.diag([1, -1])
A = [[round(float(M[0, 0]), 6), round(float(M[0, 1]), 6), round(float(t[0]), 4)], [round(float(M[1, 0]), 6), round(float(M[1, 1]), 6), round(float(t[1]), 4)]]
json.dump({'image': proj + ' cluster map (page points)', 'lat0': lat0, 'lng0': lng0, 'A': A, 'scale_m_per_px': round(float(s), 4),
           'method': f"{why}; {len(P)} matching points read by eye on the Esri satellite photo, similarity fit, residuals {np.round(res).tolist()} m",
           'accuracy': f'site boundary matched: about {max(10, int(res.max()))} m'}, open(os.path.join(APP, 'data', 'siteplans', proj, 'georef.json'), 'w'), indent=1)
print(f'{proj}: {s:.4f} m/pt, residuals {np.round(res, 1).tolist()} m')

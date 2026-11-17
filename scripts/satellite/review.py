"""Draw detected rows/units over an image (for samples): python review.py in.png out.jpg"""
import sys, cv2, numpy as np
import run_v2 as R
img = cv2.imread(sys.argv[1]); mpp = R.mpp_at(25.0)
rows = R.process_image(img, mpp)
ll = [(25.0 - r['c'][1] * mpp / 110574, 55.0 + r['c'][0] * mpp / 101000) for r in rows]
import sys as _s
R.finalize(rows, ll, [('x', 0, 0)], {'x': _s.argv[3]} if len(_s.argv) > 3 else {})
vis = img.copy()
for r in rows:
    c, u, f = r['c'], r['u'], r['f'] / np.linalg.norm(r['f'])
    x = -r['L'] / 2
    col = (0, 255, 255) if r['kind'] == 'townhouse' else (255, 160, 0)
    for wdt in r['units']:
        p0, p1 = c + u * (x / mpp), c + u * ((x + wdt) / mpp)
        q = np.array([p0 + f * r['D'] / 2 / mpp, p1 + f * r['D'] / 2 / mpp, p1 - f * r['D'] / 2 / mpp, p0 - f * r['D'] / 2 / mpp], np.int32)
        cv2.polylines(vis, [q], True, col, 2)
        x += wdt
    cv2.arrowedLine(vis, tuple(c.astype(int)), tuple((c + f * (r['D'] / 2 + 4) / mpp).astype(int)), (255, 0, 255), 2, tipLength=0.3)
cv2.imwrite(sys.argv[2], cv2.resize(vis, (900, 900)))
print(len(rows), 'rows', sum(len(r['units']) for r in rows), 'homes', {k: sum(len(r['units']) for r in rows if r['kind'] == k) for k in ('townhouse', 'villa')})

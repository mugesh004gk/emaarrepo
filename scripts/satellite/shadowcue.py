import numpy as np, cv2

def full_mask(img, mpp):
    """Everything that is not sand / vegetation / water / shadow / no-data (roofs of any colour, and roads)."""
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    h, s, v = cv2.split(hsv)
    sand = (h >= 5) & (h <= 28) & (s >= 38)
    veg = (h >= 30) & (h <= 95) & (s >= 40)
    water = (h >= 95) & (h <= 130) & (s >= 60)
    dark = v < 70
    m = (~(sand | veg | water | dark | (v < 8))).astype(np.uint8) * 255
    k = lambda x: cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (max(1, round(x / mpp)),) * 2)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, k(1.4))
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, k(0.8))
    return m, hsv, dark.astype(np.uint8)

def shadow_score(lab_mask, dark, mpp, x0, y0, near_m=0.6, far_m=4.0):
    """Share of the building's north-edge columns that have shadow just north of them."""
    ys, xs = np.nonzero(lab_mask)
    if not len(xs):
        return 0.0
    top = {}
    for x, y in zip(xs, ys):
        if x not in top or y < top[x]:
            top[x] = y
    hit = tot = 0
    a, b = int(near_m / mpp), int(far_m / mpp)
    for x, y in top.items():
        gx, gy = x + x0, y + y0
        seg = dark[max(0, gy - b):max(0, gy - a), gx]
        tot += 1
        hit += seg.size > 0 and seg.mean() > 0.5
    return hit / max(1, tot)

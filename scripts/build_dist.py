#!/usr/bin/env python3
"""Build a self-contained static copy for hosting (Vercel etc.).
  <venv-with-opencv>/python scripts/build_dist.py <out_dir>
 - app code, data, textures, Nara assets, three.js (build + examples/jsm) are copied as real files;
 - Emaar images are resized to max 1600 px (JPEG q82) and kept under the same paths;
 - brochure / floor-plan PDFs (1.4 GB) are not uploaded: they are shown as page images (media/docs, from
   scripts/render_docs.py); 'Open' links point to the original files on emaar.com (research/manifest.csv)."""
import csv, json, os, shutil, sys
import cv2

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RESEARCH = os.path.normpath(os.path.join(APP, '..', 'emaarcommunity', 'research'))
OUT = os.path.abspath(sys.argv[1])

if os.path.exists(OUT):
    shutil.rmtree(OUT)
os.makedirs(OUT)
html = open(os.path.join(APP, 'index.html')).read().replace('./node_modules/three/', './vendor/three/')
html = html.replace('<html lang="en">', '<html lang="en" data-thumbs>', 1)  # use the 400 px previews made below
open(os.path.join(OUT, 'index.html'), 'w').write(html)
for d in ['css', 'js', 'media/textures', 'media/nara', 'media/docs', 'vendor']:
    shutil.copytree(os.path.join(APP, d), os.path.join(OUT, d))
shutil.copytree(os.path.join(APP, 'media/nara'), os.path.join(OUT, 'assets'))
os.makedirs(os.path.join(OUT, 'data'))
for f in os.listdir(os.path.join(APP, 'data')):
    if f.endswith('.json') and f != 'overture_buildings.json':
        shutil.copy2(os.path.join(APP, 'data', f), os.path.join(OUT, 'data', f))
T = os.path.join(OUT, 'vendor', 'three')  # hosts skip node_modules
os.makedirs(os.path.join(T, 'build'))
for f in ['three.module.js', 'three.core.js']:
    shutil.copy2(os.path.join(APP, 'node_modules/three/build', f), os.path.join(T, 'build', f))
shutil.copytree(os.path.join(APP, 'node_modules/three/examples/jsm'), os.path.join(T, 'examples/jsm'))

# PDF links -> emaar.com originals
url_of = {}
for row in csv.DictReader(open(os.path.join(RESEARCH, 'manifest.csv'))):
    url_of['media/research/' + row['file']] = row['url']
missing = []

def remap(o):
    if isinstance(o, dict):
        return {k: remap(v) for k, v in o.items()}
    if isinstance(o, list):
        return [remap(v) for v in o]
    if isinstance(o, str) and o.startswith('media/research/') and o.lower().endswith('.pdf'):
        if o in url_of:
            return url_of[o]
        missing.append(o)
    return o

images = set()
def collect(o):
    if isinstance(o, dict):
        for v in o.values(): collect(v)
    elif isinstance(o, list):
        for v in o: collect(v)
    elif isinstance(o, str) and o.startswith('media/research/') and not o.lower().endswith('.pdf'):
        images.add(o)

for f in ['projects.json', 'floorplans.json', 'property_boundaries.json']:
    p = os.path.join(OUT, 'data', f)
    d = json.load(open(p))
    collect(d)
    json.dump(remap(d), open(p, 'w'), ensure_ascii=False, separators=(',', ':'))

n = 0
for rel in sorted(images):
    src = os.path.realpath(os.path.join(APP, rel))
    dst = os.path.join(OUT, rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    img = cv2.imread(src, cv2.IMREAD_UNCHANGED)
    if img is None:
        shutil.copy2(src, dst)
        shutil.copy2(src, os.path.splitext(dst)[0] + '.thumb.jpg')
        continue
    h, w = img.shape[:2]
    k = 1.0 if '/clustermap/' in rel else min(1.0, 1600 / max(h, w))  # cluster maps stay full size: unit numbers must be readable
    if k < 1:
        img = cv2.resize(img, (int(w * k), int(h * k)), interpolation=cv2.INTER_AREA)
    ext = os.path.splitext(dst)[1].lower()
    params = [cv2.IMWRITE_JPEG_QUALITY, 82] if ext in ('.jpg', '.jpeg') else [cv2.IMWRITE_WEBP_QUALITY, 82] if ext == '.webp' else []
    if not cv2.imwrite(dst, img, params):
        shutil.copy2(src, dst)
    n += 1
    # 400 px preview for lists and thumbnail grids (js/ui/projects-ui.js thumb())
    t = img
    if t.ndim == 3 and t.shape[2] == 4:  # transparent -> on white
        al = t[:, :, 3:4].astype('float32') / 255
        t = (t[:, :, :3] * al + 255 * (1 - al)).astype('uint8')
    h2, w2 = t.shape[:2]
    k2 = min(1.0, 400 / max(h2, w2))
    if k2 < 1:
        t = cv2.resize(t, (int(w2 * k2), int(h2 * k2)), interpolation=cv2.INTER_AREA)
    cv2.imwrite(os.path.splitext(dst)[0] + '.thumb.jpg', t, [cv2.IMWRITE_JPEG_QUALITY, 74])

# page images of every PDF (scripts/render_docs.py): the in-app viewer shows these on the live site
dp_path = os.path.join(OUT, 'data', 'doc_pages.json')
if os.path.exists(dp_path):
    dp = json.load(open(dp_path))
    for src, info in list(dp.items()):
        if src in url_of:
            info['url'] = url_of[src]
            dp[url_of[src]] = info
    json.dump(dp, open(dp_path, 'w'), separators=(',', ':'))

json.dump({'headers': [{'source': '/(.*)', 'headers': [{'key': 'Cache-Control', 'value': 'public, max-age=0, must-revalidate'}]}]},
          open(os.path.join(OUT, 'vercel.json'), 'w'), indent=1)
print(f'images: {n}, pdf links remapped (missing: {len(missing)})', missing[:5])

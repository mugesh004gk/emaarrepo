#!/usr/bin/env python3
"""Build data/projects.json (3 communities, 67 projects) from the scraped research folder,
and data/districts.json (Dubai community boundaries) from the city twin's OSM extract.

  python3 scripts/build_data.py

Inputs : ../emaarcommunity/research/**   (scraped from emaar.com, see its README)
         ../dubai-digital-twin-main/data/communities.js (OpenStreetMap admin boundaries)
Outputs: data/projects.json, data/districts.json
"""
import csv, json, os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)
RESEARCH = os.path.normpath(os.path.join(APP, "..", "emaarcommunity", "research"))
TWIN = os.path.normpath(os.path.join(APP, "..", "dubai-digital-twin-main", "data"))
MEDIA = "media/research"

COMMUNITIES = [
    {"id": "the-valley", "folder": "the-valley", "name": "The Valley", "tagline": "Dreams begin here", "osm": "The Valley"},
    {"id": "arabian-ranches-3", "folder": "arabian-ranches-3", "name": "Arabian Ranches III", "tagline": "Find your happy place", "osm": None},
    {"id": "emaar-south", "folder": "emaar-south", "name": "Emaar South", "tagline": "Local community with a global gateway", "osm": None},
]


def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()


def section(md, start_pat, stop_pats):
    m = re.search(start_pat, md, re.M)
    if not m:
        return ""
    rest = md[m.end():]
    stop = len(rest)
    for sp in stop_pats:
        s = re.search(sp, rest, re.M)
        if s and s.start() < stop:
            stop = s.start()
    return rest[:stop]


def clean_para(s):
    s = re.sub(r"\s*Read more\s*$", "", s.strip())
    return re.sub(r"\s+", " ", s).strip()


def parse_beds(label):
    nums = [int(n) for n in re.findall(r"\d+", label or "")]
    return (min(nums), max(nums)) if nums else (None, None)


def parse_property_md(md, name):
    out = {}
    about = section(md, r"^## About .*$", [r"^### Key facts", r"^Highlights", r"^## "])
    out["about"] = [clean_para(p) for p in about.strip().split("\n") if len(p.strip()) > 40]
    facts = section(md, r"^### Key facts\s*$", [r"^Highlights", r"^## ", r"^Gallery"])
    lines = [l.strip() for l in facts.strip().split("\n") if l.strip()]
    out["keyFacts"] = [l[2:].strip() for l in lines if l.startswith("- ")]
    kv = [l for l in lines if not l.startswith("- ")]
    pairs = {}
    for i in range(0, len(kv) - 1):
        k = kv[i]
        if k in ("Prices from", "Starting price", "Available", "Sizes", "Handover", "Completion", "Payment plan", "Starting from"):
            pairs[k] = kv[i + 1]
    out["figures"] = pairs
    # Highlights: "## Heading\npara" blocks between Highlights and Amenities/Location
    hl = section(md, r"^Highlights\s*$", [r"^Amenities\s*$", r"^Location\s*$", r"^More in the community"])
    hls = []
    for m in re.finditer(r"^## (.+)\n((?:(?!^## ).*\n?)*)", hl, re.M):
        body = clean_para(" ".join(l for l in m.group(2).split("\n") if l.strip() and not re.match(r"^(Gallery|Exterior|Interior)\b", l.strip())))
        if body:
            hls.append({"title": m.group(1).strip().title() if m.group(1).isupper() else m.group(1).strip(), "text": body})
    out["highlights"] = hls
    am = section(md, r"^## Amenities at .*$", [r"^Location\s*$", r"^## ", r"^More in the community"])
    am_lines = [l.strip() for l in am.split("\n") if l.strip()]
    out["amenitiesIntro"] = clean_para(" ".join(l for l in am_lines if not l.startswith("- ") and len(l) > 40))
    out["amenities"] = [l[2:].strip() for l in am_lines if l.startswith("- ")]
    loc = re.search(r"^Emaar lists (.+?) as nearby", md, re.M)
    out["nearbyNote"] = loc.group(0) if loc else ""
    return out


def classify_image(fn, slug):
    low = fn.lower()
    if low.startswith("ph-") and slug not in low:
        return None  # "recently launched" card of another project
    if "featured-communities" in low:
        return "featured"
    if "hero" in low:
        return "hero"
    if "main_image" in low:
        return "main"
    if "feature" in low:
        return "feature"
    if low.endswith("-desk.webp") or "banner" in low:
        return "banner"
    return "other"


def pdf_pages(p):
    try:
        out = subprocess.run(["pdfinfo", p], capture_output=True, text=True).stdout
        m = re.search(r"Pages:\s+(\d+)", out)
        return int(m.group(1)) if m else None
    except Exception:
        return None


def property_type(text):
    t = text.lower()
    kinds = []
    for k, pat in (("Apartment", r"apartment"),("Townhouse", r"townhouse"), ("Villa", r"villa"), ("Mansion", r"mansion")):
        if re.search(pat, t):
            kinds.append(k)
    return kinds


def parse_community_md(md):
    out = {}
    ov = section(md, r"^## Dreams begin here|^## Find your happy place|^## Local Community.*$|^The community\s*$", [r"^Prices from", r"^Projects\s*$"])
    out["overview"] = [clean_para(p) for p in ov.split("\n") if len(p.strip()) > 60]
    # figures like "47,000 sqm\nGolden Beach"
    figs = []
    block = section(md, r"^Enquire\s*$", [r"^Projects\s*$", r"^## Recently Launched"])
    lines = [l.strip() for l in block.split("\n") if l.strip()]
    i = 0
    while i < len(lines) - 1:
        if re.match(r"^[\d,\.]+\s*(sqm|km|m|ha|acres)?$|^\d+-Hole$|^[\d,\.]+$", lines[i]) and not re.match(r"^[\d,\.]", lines[i + 1]):
            figs.append({"value": lines[i], "label": lines[i + 1]})
            i += 2
        else:
            i += 1
    out["figures"] = figs
    faq = section(md, r"^## About (The Valley|Arabian Ranches III|Emaar South)\s*$", [r"^Continue exploring", r"^## Nearby"])
    qa, cur = [], None
    for l in [l.strip() for l in faq.split("\n") if l.strip()]:
        if l.endswith("?"):
            cur = {"q": l, "a": ""}
            qa.append(cur)
        elif cur is not None:
            cur["a"] = (cur["a"] + " " + l).strip()
    # trailing questions appear after "## Nearby Communities"
    tail = section(md, r"^## Nearby Communities\s*$", [r"^\Z"])
    cur = None
    for l in [l.strip() for l in tail.split("\n") if l.strip()]:
        if l.endswith("?"):
            cur = {"q": l, "a": ""}
            qa.append(cur)
        elif cur is not None and not l.startswith("- ") or (cur and l.startswith("- ")):
            if cur is not None:
                cur["a"] = (cur["a"] + " " + l.lstrip("- ")).strip()
    out["faq"] = [q for q in qa if q["a"]]
    return out


def load_districts():
    js = read(os.path.join(TWIN, "communities.js"))
    m = re.search(r"window\.DUBAI\.communities\s*=\s*(\{.*\});?\s*$", js, re.S)
    data = json.loads(m.group(1).rstrip(";"))
    feats = []
    for layer in ("admin", "districts"):
        for f in data.get(layer, {}).get("features", []):
            p = f["properties"]
            if f["geometry"]["type"] not in ("Polygon", "MultiPolygon"):
                continue
            b = p.get("bbox")
            # keep the southern half of Dubai where the three communities sit (+ context)
            if b and (b[2] < 54.95 or b[0] > 55.75 or b[3] < 24.70 or b[1] > 25.20):
                continue
            def rnd(c):
                return [[round(x, 5), round(y, 5)] for x, y in c]
            geom = f["geometry"]
            if geom["type"] == "Polygon":
                rings = [rnd(geom["coordinates"][0])]
            else:
                rings = [rnd(poly[0]) for poly in geom["coordinates"]]
            feats.append({"name": p.get("name"), "nameAr": p.get("name_ar"), "kind": p.get("kind"), "layer": layer,
                          "areaKm2": p.get("area_km2"), "rings": rings})
    return feats


LANDMARK_KEYS = ["Downtown Dubai", "Dubai International Airport (DXB)", "Al Maktoum International Airport (DWC)",
                 "Dubai Marina", "Global Village", "District 2020 (Expo City Dubai)"]


def landmark_table(community_id, projects):
    """Drive km/min from every project pin to the standard landmarks (OSRM table, cached)."""
    lm = {}
    with open(os.path.join(RESEARCH, "landmarks.csv"), encoding="utf-8") as f:
        for r in csv.DictReader(f):
            lm[r["landmark"]] = (float(r["lat"]), float(r["lng"]))
    keys = [k for k in LANDMARK_KEYS if k in lm]
    pts = [(p["lng"], p["lat"]) for p in projects] + [(lm[k][1], lm[k][0]) for k in keys]
    cache_dir = os.path.join(HERE, ".cache")
    os.makedirs(cache_dir, exist_ok=True)
    cache = os.path.join(cache_dir, f"osrm_{community_id}.json")
    sig = json.dumps(pts)
    tab = None
    if os.path.exists(cache):
        c = json.load(open(cache))
        if c.get("sig") == sig:
            tab = c["tab"]
    if tab is None:
        coords = ";".join(f"{x:.6f},{y:.6f}" for x, y in pts)
        n = len(projects)
        url = (f"https://router.project-osrm.org/table/v1/driving/{coords}?sources={';'.join(map(str, range(n)))}"
               f"&destinations={';'.join(map(str, range(n, n + len(keys))))}&annotations=duration,distance")
        raw = subprocess.run(["curl", "-s", "-m", "90", "-A", "community-research-script/1.0", url], capture_output=True, text=True).stdout
        tab = json.loads(raw)
        if tab.get("code") != "Ok":
            raise RuntimeError(f"OSRM failed: {raw[:200]}")
        json.dump({"sig": sig, "tab": tab}, open(cache, "w"))
    out = []
    for i, p in enumerate(projects):
        out.append([{"to": k, "lat": lm[k][0], "lng": lm[k][1], "driveKm": round(tab["distances"][i][j] / 1000, 1),
                     "driveMin": round(tab["durations"][i][j] / 60)} for j, k in enumerate(keys)])
    return out


def main():
    out = {"generated": "from emaarcommunity/research (scraped emaar.com 2026-11-14)",
           "notes": {"driveTimes": "Drive km/min computed with OSRM on OpenStreetMap roads (free-flow, not traffic-adjusted). "
                                   "Landmark points geocoded from OpenStreetMap; project pins as published by Emaar."},
           "communities": []}
    for c in COMMUNITIES:
        root = os.path.join(RESEARCH, c["folder"])
        cj = json.load(open(os.path.join(root, "community.json"), encoding="utf-8"))
        cmd = parse_community_md(read(os.path.join(root, "community.md")))
        dist = {}
        with open(os.path.join(root, "distances.csv"), encoding="utf-8") as f:
            for r in csv.DictReader(f):
                dist.setdefault(r["property"], []).append({
                    "to": r["nearby_place"], "lat": float(r["place_lat"]), "lng": float(r["place_lng"]),
                    "source": r["place_coords_source"], "straightKm": float(r["straight_line_km"]),
                    "driveKm": float(r["drive_km"]) if r["drive_km"] else None,
                    "driveMin": int(float(r["drive_minutes"])) if r["drive_minutes"] else None})
        cassets = os.path.join(root, "community-assets", "images")
        cimgs = sorted(os.listdir(cassets)) if os.path.isdir(cassets) else []
        community = {
            "id": c["id"], "name": c["name"], "tagline": c["tagline"], "url": cj["source_url"], "osmName": c["osm"],
            "googleMaps": cj["map"]["google_maps_link"],
            "mapImage": f"{MEDIA}/{c['folder']}/community-assets/images/{os.path.basename(cj['map']['map_image'])}" if cj["map"].get("map_image") else None,
            "banner": next((f"{MEDIA}/{c['folder']}/community-assets/images/{n}" for n in cimgs if "banner" in n.lower() or "hero" in n.lower()), None),
            "gallery": [f"{MEDIA}/{c['folder']}/community-assets/images/{n}" for n in cimgs if "gallery" in n.lower()],
            "overview": cmd["overview"], "figures": cmd["figures"], "faq": cmd["faq"], "projects": [],
        }
        lats, lngs = [], []
        for p in cj["properties"]:
            slug = p["slug"]
            pdir = os.path.join(root, "properties", slug)
            pj = json.load(open(os.path.join(pdir, "property.json"), encoding="utf-8"))["summary"]
            md = read(os.path.join(pdir, "property.md"))
            info = parse_property_md(md, p["name"])
            loc = pj.get("location") or {}
            if loc:
                lats.append(loc["lat"]); lngs.append(loc["lng"])
            bmin, bmax = parse_beds(p.get("bedsLabel"))
            imgs = []
            idir = os.path.join(pdir, "images")
            for fn in sorted(os.listdir(idir)) if os.path.isdir(idir) else []:
                kind = classify_image(fn, slug)
                if kind:
                    imgs.append({"src": f"{MEDIA}/{c['folder']}/properties/{slug}/images/{fn}", "kind": kind})
            order = {"hero": 0, "main": 1, "featured": 2, "feature": 3, "banner": 4, "other": 5}
            imgs.sort(key=lambda i: order[i["kind"]])
            def files(sub):
                d = os.path.join(pdir, sub)
                return [{"src": f"{MEDIA}/{c['folder']}/properties/{slug}/{sub}/{fn}", "pages": pdf_pages(os.path.join(d, fn)),
                         "mb": round(os.path.getsize(os.path.join(d, fn)) / 1e6, 1)} for fn in sorted(os.listdir(d))] if os.path.isdir(d) else []
            # no separate floor-plan file, but floor-plan pages inside the brochure (checked by hand)
            BROCHURE_PLANS = {"urbana-iii": 11}
            def floorplan_files():
                fl = files("floorplans")
                if not fl and slug in BROCHURE_PLANS and files("brochures"):
                    b = dict(files("brochures")[0]); b["startPage"] = BROCHURE_PLANS[slug]; b["inBrochure"] = True
                    fl = [b]
                return fl
            text = " ".join(info["keyFacts"] + info["about"] + [p.get("hallmark") or ""])
            community["projects"].append({
                "id": slug, "name": p["name"], "tagline": p.get("hallmark"), "url": pj["url"],
                "lat": loc.get("lat"), "lng": loc.get("lng"), "nearby": loc.get("nearby") or [],
                "bedsLabel": p.get("bedsLabel"), "bedsMin": bmin, "bedsMax": bmax,
                "priceFrom": p.get("priceFrom") or None, "unitsLeft": p.get("unitsLeft") or 0,
                "available": bool(p.get("isAvailable")), "isNew": bool(p.get("isNew")),
                "types": property_type(text), **info,
                "images": imgs, "brochures": files("brochures"), "floorplans": floorplan_files(),
                "distances": dist.get(p["name"], []),
                "modelled": slug == "nara",
            })
        for p, row in zip(community["projects"], landmark_table(c["id"], community["projects"])):
            p["landmarks"] = row
        # Pin check: Emaar's published pin must sit inside its community. Pins far from the
        # community median are flagged (kept for reference, not drawn on the map, and left out of
        # the community extent) until the brochure cluster map gives the real position.
        import math
        mlat, mlng = sorted(lats)[len(lats) // 2], sorted(lngs)[len(lngs) // 2]
        def km(a_lat, a_lng, b_lat, b_lng):
            dy = (a_lat - b_lat) * 110.57
            dx = (a_lng - b_lng) * 111.32 * math.cos(math.radians(mlat))
            return math.hypot(dx, dy)
        good = []
        for p in community["projects"]:
            d_km = km(p["lat"], p["lng"], mlat, mlng)
            if d_km > 2.5:
                p["pinFlag"] = {"km": round(d_km, 1), "publishedLat": p["lat"], "publishedLng": p["lng"],
                                "note": f"Emaar's published map pin is {d_km:.1f} km from the rest of {c['name']}; position to be verified from the brochure cluster map."}
                print(f"   pin flagged: {p['name']} ({d_km:.1f} km off)")
            else:
                good.append(p)
        community["center"] = {"lat": round(sum(p["lat"] for p in good) / len(good), 6), "lng": round(sum(p["lng"] for p in good) / len(good), 6)}
        out["communities"].append(community)
        print(c["name"], len(community["projects"]), "projects,", sum(len(p["images"]) for p in community["projects"]), "images")
    with open(os.path.join(APP, "data", "projects.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    d = load_districts()
    with open(os.path.join(APP, "data", "districts.json"), "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, separators=(",", ":"))
    print("districts:", len(d))


if __name__ == "__main__":
    main()

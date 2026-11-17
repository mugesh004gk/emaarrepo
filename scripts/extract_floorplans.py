#!/usr/bin/env python3
"""Extract the floor-plan types from every developer floor-plan PDF (vector text, via pdftotext).

For each page that describes a home type we keep: the plan title as printed ("3 BEDROOM I A"),
bedrooms, the home kind, the printed area lines (suite / garage / balcony / terrace / total, in
sq ft and m2), and the unit rows it applies to (e.g. "6 PLEX - TH 02", "AP02, A103 ..."), each
with its own printed area where the sheet lists one per unit. Nothing is estimated: values are
copied from the sheet text; pages that are images only are listed as such.

  python3 scripts/extract_floorplans.py   ->  data/floorplans.json
"""
import json, os, re, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)
RESEARCH = os.path.normpath(os.path.join(APP, "..", "emaarcommunity", "research"))
MEDIA = "media/research"

NUM = r"(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)"
SQFT = re.compile(NUM + r"\s*(?:-\s*" + NUM + r"\s*)?SQ\.?\s*FT", re.I)
SQM = re.compile(NUM + r"\s*(?:-\s*" + NUM + r"\s*)?SQ\.?\s*M(?![A-Z])", re.I)
AREA_LABEL = re.compile(r"\b(SUITE|GARAGE|BALCONY|TERRACE|TOTAL|BUILT[- ]?UP|COVERED|INTERNAL|PLOT|LIVING|ROOF ?TERRACE|PATIO)\s*AREA", re.I)
# rows printed without the word AREA ("PARKING 474.80 SQFT", "GARAGE", "B A L C O N Y:"): never a total
OTHER_LABEL = re.compile(r"\b(GROUND ?FLOOR|FIRST ?FLOOR|SECOND ?FLOOR|THIRD ?FLOOR|ROOF ?FLOOR|BASEMENT|ROOF ?TERRACE|CAR ?PARK(?:ING)?|PARKING|GARAGE|CAR ?PORT|BALCONY|TERRACE|ENTRANCE|PATIO|POOL|STORAGE|STORE|MAID'?S?|DRIVER'?S?|LAUNDRY)\b", re.I)
OTHER_KEY = {"PARKING": "GARAGE", "CARPORT": "GARAGE", "CAR_PORT": "GARAGE", "CARPARK": "GARAGE", "CAR_PARK": "GARAGE", "CARPARKING": "GARAGE", "CAR_PARKING": "GARAGE", "ENTRANCE": "TERRACE", "STORE": "STORAGE"}
TITLE = re.compile(r"\b(\d)\s*BEDROOM\b(.*)$", re.I)
STUDIO = re.compile(r"\bSTUDIO\b(.*)$", re.I)
UNIT_TH = re.compile(r"\b(\d+\s*PLEX(?:\s*[A-Z0-9])?\s*-\s*TH\s*-?\s*\d+|TH\d+\s*-\s*[A-Z]\d+)\b", re.I)
UNIT_APT = re.compile(r"\b([A-Z]{1,2}\s?\d{2,4})\b")
KIND = re.compile(r"\b(TOWNHOUSE|VILLA|APARTMENT|PENTHOUSE|DUPLEX|MANSION|TWIN ?VILLA|SEMI[- ]?DETACHED)\b", re.I)
NOISE = re.compile(r"dimensions|developer|illustrative|not to scale|tolerances|discretion|liability", re.I)


def despace(line):
    """'T O TA L A R E A' -> 'TOTAL AREA'; keeps multi-space column gaps as one gap."""
    cols = re.split(r"\s{2,}", line.strip())
    out = []
    for c in cols:
        toks = c.split(" ")
        if len(toks) > 2 and sum(len(t) <= 2 for t in toks) >= len(toks) * 0.6:
            c = "".join(toks)
            c = re.sub(r"(BEDROOM|TOTAL|AREA|SUITE|BALCONY|GARAGE|TERRACE|PLEX|UNIT|SQFT|SQM|FLOOR|GROUND|FIRST)", r" \1 ", c, flags=re.I)
            c = re.sub(r"\s+", " ", c).strip()
        out.append(c)
    return "   ".join(out)


def head(l):
    """the row label: text before the first number (drawing captions further right on the line are ignored)"""
    m = NUMS.search(l)
    return l[: m.start()] if m else l


def fnum(s):
    return float(s.replace(",", "")) if s else None


def page_text(pdf, n):
    return subprocess.run(["pdftotext", "-layout", "-f", str(n), "-l", str(n), pdf, "-"], capture_output=True, text=True).stdout


FT_PER_M2 = 10.7639
NUMS = re.compile(r"(?<![\dx.])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d+|\d{3,5})(?![\dx])")
TITLE_RE = [
    re.compile(r"\bNo\.? of Bedrooms\s*:?\s*(\d)()", re.I),
    re.compile(r"\b(\d)\s*BEDROOM\b\s*(?:\|\s*)?((?:TYPE\s*)?[IVX]{0,3}\s?[A-Z0-9]{0,2}\d?[A-Z]?)\b", re.I),
    re.compile(r"\b(\d)\s*BR\b\s*-?\s*(TYPE\s*[A-Z0-9]{1,3})?", re.I),
]
JUNK = re.compile(r"^(TERRACE|BALCONY|GARAGE|UNIT|TOTAL|SUITE|AREA|FLOOR|PLAN|M|X)$", re.I)


def pair_from_numbers(nums):
    """Pick (sqft, sqm) from the numbers on a line: the pair whose ratio is 10.764 (+-1.5%)."""
    vals = [float(n.replace(",", "")) for n in nums]
    best = None
    for i, a in enumerate(vals):
        for j, b in enumerate(vals):
            if i != j and b > 0 and abs(a / b / FT_PER_M2 - 1) < 0.015:
                if best is None or a > best[0]:
                    best = (a, b)
    return best


DIGIT_GAP = re.compile(r"(?<![A-Za-z]\d)(?<=\d) (?=\d)|(?<=\d) (?=\.)|(?<=\.) (?=\d)")  # not after "m2", "ft2"


def join_digits(line):
    prev = None
    while prev != line:
        prev, line = line, DIGIT_GAP.sub("", line)
    return line


def parse_page(text):
    # "1 94. 88 SQM" -> "194.88 SQM" (single spaces inside a number; columns use 2+ spaces)
    lines = [despace(join_digits(l)) for l in text.split("\n") if l.strip()]
    lines = [l for l in lines if not NOISE.search(l)]
    blob = " \n".join(lines)
    title = beds = variant = None
    raw = [join_digits(l) for l in text.split("\n") if l.strip()]
    for l in lines + raw:
        for rx in TITLE_RE:
            m = rx.search(l)
            if m:
                beds = int(m.group(1))
                v = re.sub(r"\s+", " ", (m.group(2) or "")).strip()
                variant = v if v and not JUNK.match(v) else None
                break
        if beds is not None:
            break
    if beds is None and re.search(r"\bSTUDIO\b", blob, re.I):
        beds = 0
    if beds is not None:
        title = ("Studio" if beds == 0 else f"{beds} Bedroom") + (f" · {variant.upper()}" if variant else "")
    kind = None
    km = KIND.search(blob.replace(" ", ""))
    km = km or KIND.search(blob)
    if km:
        kind = km.group(1).title().replace("Semi-Detached", "Semi-detached")
    style = re.search(r"\b([A-Z]{3,12})\s*/\s*(MIRROR|REVERSE)\b", blob)

    groups, rows = [], []
    cur = {"units": [], "areas": {}}
    def push():
        nonlocal cur
        if cur["areas"] or cur["units"]:
            groups.append(cur)
        cur = {"units": [], "areas": {}}
    for li, l in enumerate(lines):
        um = re.search(r"\bUNITS?\b\s*:?\s*((?:[A-Z]{0,2}\s?\d{2,4}\s*,\s*)+[A-Z]{0,2}\s?\d{2,4})", l)
        if um:
            if cur["areas"]:
                push()
            cur["units"] += [u.replace(" ", "") for u in re.split(r"\s*,\s*", um.group(1))]
            continue
        nums = NUMS.findall(l)
        th = UNIT_TH.search(l)
        lab = AREA_LABEL.search(l)
        pr = pair_from_numbers(nums) if len(nums) >= 2 else None
        if th and not pr and len(nums) >= 1:
            # the sheet sometimes prints a unit's sq ft on the line above its m2
            near = nums + (NUMS.findall(lines[li - 1]) if li else []) + (NUMS.findall(lines[li + 1]) if li + 1 < len(lines) else [])
            pr = pair_from_numbers(near)
        if th and pr:
            rows.append({"unit": re.sub(r"\s+", " ", th.group(1)).upper(), "sqft": pr[0], "sqm": pr[1]})
        elif lab and pr:
            key = lab.group(1).upper().replace(" ", "_").replace("-", "_")
            if "TERRACE" in l.upper() and key == "BALCONY":
                key = "BALCONY_TERRACE"
            if key in cur["areas"]:
                push()
            cur["areas"][key] = {"sqft": pr[0], "sqm": pr[1]}
        elif pr and OTHER_LABEL.search(head(l)) and not re.search(r"\bTOTAL\b", head(l), re.I):
            k = re.sub(r"'?S$", "", OTHER_LABEL.search(head(l)).group(1).upper().replace(" ", "_")).replace("'", "")
            k = OTHER_KEY.get(k, k)
            if k.endswith("FLOOR") and "_" not in k:
                k = k[:-5] + "_FLOOR"  # GROUNDFLOOR -> GROUND_FLOOR (a floor's area, not the home's total)
            if k in cur["areas"]:
                push()
            cur["areas"][k] = {"sqft": pr[0], "sqm": pr[1]}
        elif pr and re.search(r"SQ\.?\s*FT|SQFT|FT2", l, re.I) and not rows:
            cur["areas"].setdefault("TOTAL", {"sqft": pr[0], "sqm": pr[1]})
        elif lab and not pr and len(nums) == 1 and re.search(r"SQ\.?\s*FT", l, re.I):
            # only sq ft printed: m2 is derived (and marked as such)
            v = float(nums[0].replace(",", ""))
            if v > 150:
                key = lab.group(1).upper().replace(" ", "_")
                cur["areas"].setdefault(key, {"sqft": v, "sqm": round(v / FT_PER_M2, 2), "sqmDerived": True})
    push()
    units = []
    for l in lines:
        for u in UNIT_TH.findall(l):
            u = re.sub(r"\s+", " ", u).upper()
            if u not in units:
                units.append(u)
    return {"title": title, "beds": beds, "variant": variant, "kind": kind,
            "style": f"{style.group(1).title()} / {style.group(2).title()}" if style else None,
            "groups": groups, "rows": rows, "units": units}


def main():
    projects = json.load(open(os.path.join(APP, "data", "projects.json")))
    out = {}
    stats = {"pdfs": 0, "pages": 0, "planPages": 0, "imageOnly": 0}
    for c in projects["communities"]:
        for p in c["projects"]:
            for fp in p.get("floorplans", []):
                pdf = os.path.join(APP, fp["src"])
                pdf = os.path.realpath(pdf)
                n = fp.get("pages") or 0
                stats["pdfs"] += 1
                plans = []
                for i in range(1, n + 1):
                    t = page_text(pdf, i)
                    stats["pages"] += 1
                    if len(t.strip()) < 20:
                        stats["imageOnly"] += 1
                        continue
                    r = parse_page(t)
                    has_area = any(g["areas"] for g in r["groups"]) or r["rows"]
                    if r["title"] and has_area:
                        r["page"] = i
                        plans.append(r)
                        stats["planPages"] += 1
                out[p["id"]] = {"src": fp["src"], "pages": n, "plans": plans}
    json.dump(out, open(os.path.join(APP, "data", "floorplans.json"), "w"), ensure_ascii=False, separators=(",", ":"))
    print(stats)
    for pid, v in out.items():
        print(f"{pid[:30]:30} {len(v['plans']):3} plan pages of {v['pages']}")


if __name__ == "__main__":
    main()

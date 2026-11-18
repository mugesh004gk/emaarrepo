# Cluster map → homes in the 3D app

One workflow for every project that has an Emaar cluster map (a brochure page with numbered homes).
Each project keeps its own inputs and records in `data/siteplans/<project>/`; the placed result is
`data/siteplans/<project>.json` (the format of `eden.json`), which `scripts/siteplan/apply_siteplans.py`
puts into the app data. Nothing else in the app changes per project.

Run with the Python that has numpy / opencv / scipy / scikit-image (`$PY` below). `ocr` is the macOS Vision
reader compiled from `ocr.swift` (`swiftc -O ocr.swift -o ocr`).

## 1. Read the unit numbers — `extract_units.py`

```
$PY extract_units.py <project> <brochure.pdf> <page>          # numbers as PDF text, else OCR of the picture
$PY extract_units.py <project> <brochure.pdf> <page> --fill   # second look at the numbers not read
```
→ `units_raw.json` (number → position on the page). A number set in pieces (`18` `1`) is joined. `--fill`
drops a number recorded on another number's home (`misplaced_dropped`), re-reads the missing ones on a
cleaned crop (`filled`) and places an unreadable end-home number on its grey cell (`grey_end_cell`).
`OCR_PASSES="400:0;600:0"` reads upright labels only. `config.json` `count` caps stray high readings.
When the PDF's text layer is not drawn exactly over the map picture (Elora), `text_raster.py` fits the
text → picture transform and moves the positions into the picture's frame.

## 2a. Terraces (townhouses) — Orania, Elora, Eden

```
PLEX=4,6,8 $PY layout_units.py <project> <brochure.pdf> <page> terrace   # rows, facing; PLEX = terrace sizes on the floor plans
$PY place_cluster.py <project> <community> terrace [KEEP=1]              # onto the satellite roofs; KEEP=1 re-uses the placement
python3 plan_table.py <project> <floorplan.pdf> Bold=2-9 Sleek=10-17      # floor-plan sheets: plex/TH position → plan, area
$PY assign_plans.py <project> <brochure.pdf> <page>                       # style per terrace (or per home), bedrooms from the
                                                                          # cell colour, plan + area per TH position
```
`config.json`: `styles` (legend words), `swatches` (when the legend is part of the picture),
`design_per_unit`, `cell_beds`, `plex_alias`. Check printed: bedrooms read from the map colour = bedrooms of
the floor plan at that position (Orania 308/308, Elora 430/430).

## 2b. Villas — Rivana, Alana (twins), The Farm Gardens (detached), Farm Gardens 2 (detached, partly legible)

```
$PY twins.py <project> <brochure.pdf> <page>               # one block per twin (2k-1, 2k) or per villa ("pairs": "single")
$PY villa_buildings.py <project> <brochure.pdf> <page>     # instead of twins.py when most labels cannot be read:
                                                           # buildings found by their drawing, numbered where legible
$PY place_blocks.py <project> <community> [--keep]         # blocks onto the satellite roofs (coarse-to-fine)
```
`config.json`: `count`, `pairs`, `legend` (building colours → style / bedrooms), `plot_legend` (plot colour
→ bedrooms), `plans_by_beds` (floor plan per bedroom count), `facing` (`loop_inside` for U-shaped loops),
`position_fixes` (numbers read by eye, each with its reason). The printed colours are a little off the
legend swatches: they are clustered and each cluster matched to one swatch (`colour_calibration`).

## 3. Streets — `block_roads.py <project>`

Centre lines halfway between rows that face each other across their street (as the map shows), cut where
they would enter a plot. Written as the project's `roads` (source `siteplan`).

## 4. Into the app and checks

```
python3 ../apply_siteplans.py                 # all site plans; another project's plan rows are never replaced
python3 check_order.py <project>              # unit numbers run the same way in 3D as on the map
ROOT=<app> node validate_app.mjs <project> <out> 57   # in the running app: homes, numbers, overlaps, road flags,
                                              # unit panel, top / 45-degree / street screenshots
$PY overlay.py <project> out.png [half_m]     # review picture: homes, facing, streets on the satellite photo
```

## Placement provenance

All homes from a cluster map are `placement: verified-siteplan` for their **number, house type and
arrangement**. Their **position on the ground** is fitted to the satellite roofs (scale, rotation, shift
of the whole map; `georeference` in each JSON) — not surveyed. The DDA GIS boundary, when received,
replaces the hull-based boundary.

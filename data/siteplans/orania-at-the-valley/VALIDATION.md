# Orania — cluster map implementation and validation

Source: `ORANIA_brochure.pdf` page 19 (Emaar cluster map). Homes: townhouses (6/8/10-home terraces).  
Generated from `data/siteplans/orania-at-the-valley.json` and an in-app check of the local build (validate_app.mjs).

## Summary

| Check | Result |
|---|---|
| Official units (map numbers) | 308 |
| Homes placed in 3D | 308 (app renders 308) |
| Homes numbered | 308 |
| Duplicate numbers | 0  |
| Numbers not on any home | 0 |
| Floor plan per home | 308 of 308 |
| Bedrooms: map colour = floor-plan sheet | 308/308 |
| Building overlaps with another row (in app) | 0 |
| Homes still touching a road after the 4 m step-back (listed, kept) | 0 |
| Homes touching a neighbour (listed, kept) | 0 |
| Unit numbering direction = map | 36 of 36 multi-home rows checked (check_order.py) |
| Page errors in the app | 0 |

## House types (from the map legend)

| Type | Homes |
|---|---|
| Bold 3 BR | 120 |
| Bold 4 BR | 36 |
| Sleek 3 BR | 116 |
| Sleek 4 BR | 36 |

## Floor plans

ORANIA_floorplan.pdf: plan, bedrooms and built-up area per terrace position (TH01-TH10) and style; 308/308 assigned.

## Unit numbers — how each was obtained

- Numbers are drawn in the map picture and read with macOS Vision text recognition.
- read on a second, cleaned look: [1, 90, 97, 121, 131]
- end home on its grey cell (single-digit label not returned by the reader), next in its run: [1, 90]
- first reading lay on another home; dropped and read again: [90]

## Geographical placement

- Method: map homes matched to satellite roofs; kept from the earlier run (more units read); map scale 0.49143 m per page point, map-up bearing 324.3°, correlation with the satellite roofs 0.438.
- The map's internal geometry is kept: one scale, rotation and shift for the whole map; no home is moved on its own (the app may step a whole row back up to 4 m off a road).
- Boundary: homes hull + 20 m; DDA GIS boundary pending.
- Status: **provisional, satellite-fitted** — not verified against DDA GIS or surveyed plots.

## Screenshots

`valley-cluster-maps/orania-at-the-valley_verification.jpg`: cluster map, 3D top-down, 45° aerial, street level, unit selected by the unit finder and by a click.

## Known limits

- Plot boundaries per unit are not traced (house footprints and facing only).

# Rivana — cluster map implementation and validation

Source: `368091_brochure_File_bd20d234e0_prod.pdf` page 8 (Emaar cluster map). Homes: twin villas.  
Generated from `data/siteplans/rivana.json` and an in-app check of the local build (validate_app.mjs).

## Summary

| Check | Result |
|---|---|
| Official units (map numbers) | 486 |
| Homes placed in 3D | 486 (app renders 486) |
| Homes numbered | 486 |
| Duplicate numbers | 0  |
| Numbers not on any home | 0 |
| Floor plan per home | 0 of 486 |
| Building overlaps with another row (in app) | 0 |
| Homes still touching a road after the 4 m step-back (listed, kept) | 1 |
| Homes touching a neighbour (listed, kept) | 0 |
| Unit numbering direction = map | 243 of 243 multi-home rows checked (check_order.py) |
| Page errors in the app | 0 |

## House types (from the map legend)

| Type | Homes |
|---|---|
| Clara 3 BR | 36 |
| Clara 4 BR | 150 |
| Clara 5 BR | 56 |
| Kai 3 BR | 40 |
| Kai 4 BR | 146 |
| Kai 5 BR | 58 |

## Floor plans

No floor-plan PDF in the documents; none assigned. The panel opens the cluster map page.

## Unit numbers — how each was obtained

- All numbers are PDF text on the page (exact).

## Geographical placement

- Method: map building blocks matched to satellite roofs (coarse-to-fine); kept from the earlier run; map scale 0.8595 m per page point, map-up bearing 323.25°, correlation with the satellite roofs 0.387.
- The map's internal geometry is kept: one scale, rotation and shift for the whole map; no home is moved on its own (the app may step a whole row back up to 4 m off a road).
- Boundary: blocks hull + 20 m; DDA GIS boundary pending.
- Status: **provisional, satellite-fitted** — not verified against DDA GIS or surveyed plots.
- Streets: 26 centre lines, 3668 m, centre line halfway between facing rows (typical half-gap 14.0 m where a row has none opposite); segments crossing a house: 0.

## Screenshots

`valley-cluster-maps/rivana_verification.jpg`: cluster map, 3D top-down, 45° aerial, street level, unit selected by the unit finder and by a click.

## Known limits

- 9 twin(s) narrower on the map than the narrowest villa model; drawn at the model's minimum width.
- No floor plan / built-up area per unit: not in the published documents.
- Plot boundaries per unit are not traced (house footprints and facing only).

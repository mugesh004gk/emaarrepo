# Elora — cluster map implementation and validation

Source: `ELORA_brochure.pdf` page 8 (Emaar cluster map). Homes: townhouses (4/6/8-home terraces).  
Generated from `data/siteplans/elora.json` and an in-app check of the local build (validate_app.mjs).

## Summary

| Check | Result |
|---|---|
| Official units (map numbers) | 430 |
| Homes placed in 3D | 430 (app renders 430) |
| Homes numbered | 430 |
| Duplicate numbers | 0  |
| Numbers not on any home | 0 |
| Floor plan per home | 430 of 430 |
| Bedrooms: map colour = floor-plan sheet | 430/430 |
| Building overlaps with another row (in app) | 0 |
| Homes still touching a road after the 4 m step-back (listed, kept) | 0 |
| Homes touching a neighbour (listed, kept) | 0 |
| Unit numbering direction = map | 73 of 73 multi-home rows checked (check_order.py) |
| Page errors in the app | 0 |

## House types (from the map legend)

| Type | Homes |
|---|---|
| Moon 3 BR | 32 |
| Moon 4 BR | 114 |
| Mysk 3 BR | 252 |
| Mysk 4 BR | 32 |

## Floor plans

ELORA_floorplan.pdf: plan, bedrooms and built-up area per terrace position and style; 430/430 assigned.

## Unit numbers — how each was obtained

- All 430 numbers are PDF text (pieces such as `18` `1` joined). The text layer is not drawn exactly over the map picture: positions were moved into the picture frame with an affine fit to 204 labels read in the picture (median residual 0.6 pt).

## Geographical placement

- Method: map homes matched to satellite roofs; map scale 0.38144 m per page point, map-up bearing 326.1°, correlation with the satellite roofs 0.385.
- The map's internal geometry is kept: one scale, rotation and shift for the whole map; no home is moved on its own (the app may step a whole row back up to 4 m off a road).
- Boundary: homes hull + 20 m; DDA GIS boundary pending.
- Status: **provisional, satellite-fitted** — not verified against DDA GIS or surveyed plots.
- Streets: 14 centre lines, 2568 m, centre line halfway between facing rows (typical half-gap 12.9 m where a row has none opposite); segments crossing a house: 0.

## Screenshots

`valley-cluster-maps/elora_verification.jpg`: cluster map, 3D top-down, 45° aerial, street level, unit selected by the unit finder and by a click.

## Known limits

- 3 homes whose plot colour reads MOON sit at a position the floor plans give only for MYSK; the floor-plan sheet was followed: [168, 211, 398].
- Plot boundaries per unit are not traced (house footprints and facing only).

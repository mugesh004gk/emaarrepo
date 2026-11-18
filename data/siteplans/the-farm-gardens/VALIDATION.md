# The Farm Gardens — cluster map implementation and validation

Source: `FARM-GARDENS_brochure.pdf` page 24 (Emaar cluster map). Homes: detached villas.  
Generated from `data/siteplans/the-farm-gardens.json` and an in-app check of the local build (validate_app.mjs).

## Summary

| Check | Result |
|---|---|
| Official units (map numbers) | 146 |
| Homes placed in 3D | 146 (app renders 146) |
| Homes numbered | 146 |
| Duplicate numbers | 0  |
| Numbers not on any home | 0 |
| Floor plan per home | 146 of 146 |
| Building overlaps with another row (in app) | 0 |
| Homes still touching a road after the 4 m step-back (listed, kept) | 1 |
| Homes touching a neighbour (listed, kept) | 0 |
| Unit numbering direction | single villas |
| Page errors in the app | 0 |

## House types (from the map legend)

| Type | Homes |
|---|---|
| Earth 4 BR | 51 |
| Earth 5 BR | 23 |
| Horizon 4 BR | 28 |
| Horizon 5 BR | 44 |

## Floor plans

FARM-GARDENS_floorplan.pdf: one plan per bedroom count (4 BR p.2-3, 5 BR p.4-5, each with a mirrored sheet); assigned by bedroom count, 146/146. Which villas are mirrored is not published.

## Unit numbers — how each was obtained

- All numbers are PDF text on the page (exact).

## Geographical placement

- Method: map building blocks matched to satellite roofs (coarse-to-fine); map scale 0.77392 m per page point, map-up bearing 323.5°, correlation with the satellite roofs 0.252.
- The map's internal geometry is kept: one scale, rotation and shift for the whole map; no home is moved on its own (the app may step a whole row back up to 4 m off a road).
- Boundary: blocks hull + 20 m; DDA GIS boundary pending.
- Status: **provisional, satellite-fitted** — not verified against DDA GIS or surveyed plots.
- Streets: 28 centre lines, 2087 m, centre line halfway between facing rows (typical half-gap 13.6 m where a row has none opposite); segments crossing a house: 0.

## Screenshots

`valley-cluster-maps/the-farm-gardens_verification.jpg`: cluster map, 3D top-down, 45° aerial, street level, unit selected by the unit finder and by a click.

## Known limits

- Plot boundaries per unit are not traced (house footprints and facing only).

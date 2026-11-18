# Farm Gardens 2 — cluster map implementation and validation

Source: `379974_brochure_File_86ddad55b6_prod.pdf` page 25 (Emaar cluster map). Homes: detached villas.  
Generated from `data/siteplans/farm-gardens-2.json` and an in-app check of the local build (validate_app.mjs).

## Summary

| Check | Result |
|---|---|
| Official units (map numbers) | 256 |
| Homes placed in 3D | 248 (app renders 248) |
| Homes numbered | 204 |
| Duplicate numbers | 0  |
| Numbers not on any home | 52 — [8, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 33, 34, 36, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 72, 73, 89, 90, 91, 93, 107, 110, 111, 126, 133, 134, 148, 149, 150, 160, 161, 162, 168, 174, 178, 184, 188, 206, 219, 221, 222] |
| Homes placed without a number | 44 (number not legible on the map) |
| Floor plan per home | 0 of 248 |
| Building overlaps with another row (in app) | 0 |
| Homes still touching a road after the 4 m step-back (listed, kept) | 0 |
| Homes touching a neighbour (listed, kept) | 0 |
| Unit numbering direction | single villas |
| Page errors in the app | 0 |

## House types (from the map legend)

| Type | Homes |
|---|---|
| Horizon 4 BR | 48 |
| Horizon 5 BR | 78 |
| Oren 4 BR | 51 |
| Oren 5 BR | 71 |

## Floor plans

No floor-plan PDF in the documents; none assigned. The panel opens the cluster map page.

## Unit numbers — how each was obtained

- Numbers are drawn in the map picture and read with macOS Vision text recognition.
- read on a second, cleaned look: [53, 133, 144, 145, 178]
- end home on its grey cell (single-digit label not returned by the reader), next in its run: [53, 133, 144, 145, 178]
- first reading lay on another home; dropped and read again: [145]
- numbered along the row between two read numbers (only where the number of buildings between them matched exactly): [26, 27, 28, 53, 54, 55, 56, 57, 58, 59, 60, 63, 64, 75, 80, 81, 95, 96, 97, 98, 99, 100, 101, 103, 105, 119, 122, 123, 124, 128, 130, 136, 154, 155, 156, 164, 166, 171, 182, 191, 196, 208, 212, 225, 232, 241, 250, 254]

## Geographical placement

- Method: map building blocks matched to satellite roofs (coarse-to-fine); kept from the earlier run; map scale 0.74729 m per page point, map-up bearing 323.5°, correlation with the satellite roofs 0.354.
- The map's internal geometry is kept: one scale, rotation and shift for the whole map; no home is moved on its own (the app may step a whole row back up to 4 m off a road).
- Boundary: blocks hull + 20 m; DDA GIS boundary pending.
- Status: **provisional, satellite-fitted** — not verified against DDA GIS or surveyed plots.
- Streets: 49 centre lines, 2765 m, centre line halfway between facing rows (typical half-gap 7.3 m where a row has none opposite); segments crossing a house: 0.

## Screenshots

`valley-cluster-maps/farm-gardens-2_verification.jpg`: cluster map, 3D top-down, 45° aerial, street level, unit selected by the unit finder and by a click.

## Known limits

- 52 unit numbers are not legible in the brochure picture (labels about 9 × 8 pixels); their villas are placed with type and style but without a number. Needed: a higher-resolution map or unit list.
- 8 of 256 buildings were not separated on the map (touching drawings); not placed.
- No floor plan / built-up area per unit: not in the published documents.
- Plot boundaries per unit are not traced (house footprints and facing only).

# Alana — cluster map implementation and validation

Source: `375633_brochure_File_7e8a59d98f_prod.pdf` page 16 (Emaar cluster map). Homes: twin villas.  
Generated from `data/siteplans/alana.json` and an in-app check of the local build (validate_app.mjs).

## Summary

| Check | Result |
|---|---|
| Official units (map numbers) | 322 |
| Homes placed in 3D | 322 (app renders 322) |
| Homes numbered | 322 |
| Duplicate numbers | 0  |
| Numbers not on any home | 0 |
| Floor plan per home | 0 of 322 |
| Building overlaps with another row (in app) | 0 |
| Homes still touching a road after the 4 m step-back (listed, kept) | 2 |
| Homes touching a neighbour (listed, kept) | 0 |
| Unit numbering direction = map | 161 of 161 multi-home rows checked (check_order.py) |
| Page errors in the app | 0 |

## House types (from the map legend)

| Type | Homes |
|---|---|
| Lilac 3 BR | 78 |
| Lilac 4 BR | 68 |
| Lilac 5 BR | 44 |
| Sierra 3 BR | 24 |
| Sierra 4 BR | 78 |
| Sierra 5 BR | 30 |

## Floor plans

No floor-plan PDF in the documents; none assigned. The panel opens the cluster map page.

## Unit numbers — how each was obtained

- Numbers are drawn in the map picture and read with macOS Vision text recognition.
- read on a second, cleaned look: [22, 29, 30, 34, 36, 44, 52, 60, 62, 68, 71, 74, 76, 104, 118, 123, 136, 137, 154, 162, 169, 173, 176, 183, 189, 193, 194, 195, 196, 200, 204, 208, 234, 238, 247, 288, 299, 312]
- end home on its grey cell (single-digit label not returned by the reader), next in its run: [22, 44, 52, 60, 62, 68, 123, 137, 183, 204, 234, 238, 247, 288, 299]
- first reading lay on another home; dropped and read again: [54, 55, 62, 162, 195, 271, 273]
- twin partner placed beside its read half (as in the neighbouring twins): [8, 21, 43, 52, 54, 55, 60, 67, 74, 75, 111, 124, 137, 161, 196, 203, 213, 218, 233, 237, 241, 245, 247, 271, 273, 288, 299, 312]
- reading not side by side with its twin partner, dropped (partner rule above used): [21, 43, 52, 54, 60, 67, 74, 75, 124, 137, 196, 203, 213, 233, 237, 247, 271, 288, 299, 312]
- manual correction 61: label read by eye on the brochure map (p.16, 3x crop); the text reader did not read it; twin 061/062 is below 059/060
- manual correction 62: label read by eye on the brochure map (p.16, 3x crop); the text reader did not read it; twin 061/062 is below 059/060
- manual correction 183: the text reader placed '183' beside 182 (wrong twin); on the map twin 183/184 stands directly above 181/182
- manual correction 295: label read by eye on the brochure map (p.16, 3x crop); the text reader did not read it; twin 295/296 is below 293/294
- manual correction 296: label read by eye on the brochure map (p.16, 3x crop); the text reader did not read it; twin 295/296 is below 293/294
- manual correction 205: the text reader took the '295'/'296' labels for 205/206; read by eye on the map: twin 205/206 is the orange twin below the yellow utility marker, after 203/204
- manual correction 206: the text reader took the '295'/'296' labels for 205/206; read by eye on the map: twin 205/206 is the orange twin below the yellow utility marker, after 203/204

## Geographical placement

- Method: map building blocks matched to satellite roofs (coarse-to-fine); kept from the earlier run; map scale 0.67611 m per page point, map-up bearing 323.25°, correlation with the satellite roofs 0.262.
- The map's internal geometry is kept: one scale, rotation and shift for the whole map; no home is moved on its own (the app may step a whole row back up to 4 m off a road).
- Boundary: blocks hull + 20 m; DDA GIS boundary pending.
- Status: **provisional, satellite-fitted** — not verified against DDA GIS or surveyed plots.
- Streets: 60 centre lines, 2878 m, centre line halfway between facing rows (typical half-gap 14.0 m where a row has none opposite); segments crossing a house: 0.

## Screenshots

`valley-cluster-maps/alana_verification.jpg`: cluster map, 3D top-down, 45° aerial, street level, unit selected by the unit finder and by a click.

## Known limits

- 161 twin(s) narrower on the map than the narrowest villa model; drawn at the model's minimum width.
- No floor plan / built-up area per unit: not in the published documents.
- Plot boundaries per unit are not traced (house footprints and facing only).

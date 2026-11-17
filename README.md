# Emaar Communities 3D

The Valley, Arabian Ranches III and Emaar South as one interactive 3D model on the real Dubai map. It is built on the Nara reference project (github.com/AhamedShafeek/nara-3d), and uses the data scraped from emaar.com into `../emaarcommunity/research/`.

## Run

```bash
npm install          # three.js 0.186.1 (same version as the Nara reference)
npm run serve        # http://localhost:8080
```

`media/research` is a symlink to `../emaarcommunity/research` (1.7 GB of brochures, floor plans and images). Keep both folders side by side, or copy the research folder in before deploying. Map tiles stream from Esri, so the app needs an internet connection.

Add `?perf` to the URL for a live counter showing fps, draw calls, triangles, map tiles and culled rows.

## What it does

| Area | What you get |
|---|---|
| Map surface | Real Dubai satellite imagery (Esri, down to ~0.3 m per pixel), or a street map. Place names, and the 162 official Dubai community boundaries with their names from OpenStreetMap. Nothing else is modelled on the ground. |
| Three communities | Switch between them in the top bar, or use **All**. The camera flies between them. The Valley shows its OpenStreetMap boundary. Arabian Ranches III and Emaar South have no OpenStreetMap boundary, so they are outlined around Emaar's project pins. |
| 67 projects | A pin for each project, coloured by bedrooms (1–6) or by availability. Filter by bedrooms, home type, availability and budget. The project panel has images, prices, sizes, about text, highlights, amenities, brochure and floor-plan PDFs in a viewer, drive times, location and the Emaar page. |
| Floor-plan types | 620 plan pages read from 49 of the 55 developer PDFs. Each has the printed title, bedrooms, the units it applies to and its total area in sq ft and m². Select a plan to open the sheet at that page. |
| Nara at The Valley | All 372 homes from the reference, placed on their real plots in the imagery. Includes the home finder, unit details, DLD records, walking and driving at street level, furnished interiors, cut-away and show home. |
| Built homes in all three communities | 11,502 homes and 12 apartment buildings detected from current satellite imagery (`scripts/satellite/run.py`), drawn in 3D in Nara's townhouse style:<br>• The Valley: 4,509 homes<br>• Arabian Ranches III: 4,183 homes<br>• Emaar South: 2,798 homes and 12 apartment buildings<br>Row positions, outlines and street sides come from the imagery. The split into homes and the house design are representative until each project's cluster map is traced. Apartment heights use the printed massing where the sheets give it (Golf Trails and Vista Ridge G+P+10); otherwise G+P+8, marked as representative. |

### How it is used

The flow is **Dubai › community › project › home**. The bar at the bottom shows where you are, and each step is clickable to go back up.

- **Top bar:** the three communities, search (a project name or a Nara unit number), and **View**. View holds the home colours, time of day, map style and layers, and each option says what it does.
- **Point at a home:** it gets a teal box and a tooltip saying what it is.
- **Click a home:** it gets an amber outline and a tag above its roof. Its details (bedrooms, frontage, and the matching floor plans from the developer sheets) appear at the top of the right panel, above its project. If the home is under a panel, the camera glides it into view.
- **Nara homes** open Nara's full unit panel instead, with Go inside, Street, Show home and Fly to.
- **Leaving 3D modes:** at street level, inside a home and in the show home, the top bar shows **Back to map**.
- **Esc** steps back: it closes the open menu, then leaves the mode, then clears the selected home.

Picking tests one box per home (`js/home-select.js`). One hover pick takes about 0.1 ms over all 15,000 homes, so selecting a home does not block the page.

### Data checks

- **Floor-plan areas:** checked against the Nara reference team's hand-verified areas. All 36 of 36 match to the cent, in sq ft and m².
- **Nara placement:** every home's lat/lon fits the world frame with 0.00 m error.
- **Unreliable Emaar pins:** five pins sit far from their community, so they are flagged in the panel and not drawn on the map:
  - Talia: 24 km off.
  - Bliss 2: 17.7 km off.
  - Bliss: 5.8 km off.
  - Greenridge: 4.1 km off.
  - Greenville: 3.5 km off.
- **Shared Emaar pins:** some pins mark an area, not a plot. One pin covers six Emaar South projects, another covers four Expo Golf Villas phases. The panel says so.
- **Floor plans not yet read:** 6 of the 55 PDFs.
  - Anya 2, Golf Acres and Greenway are image-only scans.
  - Joy, Golf Verge and Golf Meadow use a table layout the reader does not handle yet.
- **Drive times:** computed with OSRM on OpenStreetMap roads, free-flow (not traffic-adjusted). Landmark points are geocoded from OpenStreetMap.

## Performance

| Technique | Where | Effect |
|---|---|---|
| Batching | `js/culling.js` | Nara's 49,073 exterior meshes become 37 `BatchedMesh` draws. Each home stays an instance, so entering a home still hides only that home. |
| Per-home frustum culling | three.js `BatchedMesh` | Homes outside the camera's view, or the sun's shadow view, are skipped. |
| Occlusion culling | `js/culling.js` | At street level and inside a home, each of the 57 rows gets a GPU occlusion query against its slightly enlarged box. A row is hidden only after 4 consecutive "not visible" answers, and is shown again on the first "visible" answer. |
| Map tile quadtree | `js/ground.js` | Only on-screen tiles are refined or fetched. A loading tile is covered by its parent and fades in, so there are no holes or pops. |
| Render on demand | `js/main.js` | Frames are drawn only while something moves. The sun's shadow map updates only within 3.2 km. |

Measured in headless Chrome at 1600×1000:

- **Boot:** about 0.5 s to the first frame. The Nara reference took more than 90 s in the same setup.
- **Frame rate:** 60 fps throughout.
- **Draw calls:** 130–260 aerial and street, about 780 inside a furnished home.

Checks that culling and batching do not change the picture:

- **Occlusion culling, on vs off:** 8 street poses with up to 32 of 57 rows culled. 0 pixels differ.
- **Batched vs Nara's original meshes:** 5 views, identical except 0.01–0.18% of pixels in two spots. In those spots Nara's model has two faces at exactly the same height, so they flicker in either version.

Changes to the Nara model itself:

- **Textures:** they used `Math.random()`. They now use a fixed seed, so the model looks the same on every load.
- **Plot ground layers:** they were 1 mm apart and z-fought, flickering from the air. They are now stacked 1.5–3 cm apart, in the same order.
- **Ground and context:** the plain ground planes and the stand-in context clusters are removed, because the map is the ground. Nara's roads, trees and amenities are off by default, with a toggle under **Map**.

## Layout

```
index.html            Nara's interface plus the community switcher, map popover, project explorer and project panel
css/nara.css          Nara reference styles (light frosted panels)
css/app.css           Additions for the new parts
js/main.js            Boot, renderer, two-pass render (map, then 3D), camera flights, panels, modes
js/geo.js             The single projection used by tiles, boundaries, pins and homes
js/ground.js          Dubai map surface: tile quadtree, fades, cache, shadow catcher
js/districts.js       Community boundaries and community outlines
js/projects-layer.js  Project pins, bedroom and status colours
js/labels.js          Screen-space labels with collision handling
js/home-select.js     Home hover / selection markers and the fast pick index
js/culling.js         Batching, per-home visibility, occlusion culling
js/nara-frame.js      Moves Nara's data into the world frame (least-squares fit over 372 homes)
js/ui/projects-ui.js  Explorer, project panel, floor-plan types, guide, PDF and image viewer
js/nara/*             Nara reference modules (materials, homes, interiors, walk, show home, details, filters)
scripts/build_data.py         -> data/projects.json, data/districts.json (adds OSRM drive times and pin checks)
scripts/extract_floorplans.py -> data/floorplans.json
```

### The Valley at Nara detail (`js/valley-detail.js`)

Near the camera, within about 500 m, every detected Valley row is rebuilt from the reference Nara templates. That covers 3,854 homes.

- **Rows:** end units (4BR) and alternating mid units (3BR), in the project's style (Aston, Palma or Charm).
- **Plots:** Nara's carport, car, driveway pavers, lawn, boundary walls and gate pillar. Back-to-back rows use the version without the rear garden.
- **Streets:** The Valley's OpenStreetMap streets (`data/streets.json`, 49.8 km, built by `scripts/build_streets.mjs`) get Nara's asphalt, lane marks, footpaths and verges, plus date palms on the main roads and flame and neem trees on the streets.
- **Further out:** the light homes take over. Cells of 160 m switch between the two with a 50 m buffer so nothing flickers.

### Compounds, streets and parks (all three communities)

- **Compounds** (`data/compounds.json`):
  - The Valley: its OpenStreetMap boundary.
  - Emaar South: OpenStreetMap residential area 510986232.
  - Arabian Ranches III: traced on the imagery as the residential block between the two highways, plus the south-west phase (May, Anya 2, June). OpenStreetMap only has an outdated construction outline for it.
  - `scripts/clip_compounds.py` removes detected homes outside each compound. It removed 6 rows in The Valley, 190 in Arabian Ranches III and 405 in Emaar South.
- **Streets and site data** (`scripts/build_site.mjs` → `data/site.json`): OpenStreetMap streets, street names, green areas and water inside each compound. Streets: The Valley 49.8 km, Arabian Ranches III 82.0 km, Emaar South 95.5 km. Each gets Nara's street kit with street trees, and named streets get labels.
- **Parks** (`scripts/satellite/greens.py` → `data/greens.json`): vivid irrigated green areas from the zoom-19 imagery within 120 m of homes. The Valley has 105 ha, Arabian Ranches III 188 ha, Emaar South 186 ha. They get:
  - a lawn surface;
  - trees on a jittered grid (flame, neem, olive, frangipani, ghaf);
  - palms along park edges and olives along lawn strips;
  - one of Nara's play area, picnic pergola or fitness station in parks of 1,200 m² or more.
- **Designs:** each project uses the closest of Nara's three designs, chosen from Emaar's renders:
  - Arabian Ranches III: Palma (white with timber); June is Aston, Elie Saab is Charm.
  - Emaar South: Charm (white); Urbana and Urbana III are Aston.
  - The Valley: Palma; Orania and Talia are Aston, Eden and Nima are Charm.

### Clean-up and street realism

- `scripts/merge_footprints.py data/overture_buildings.json` adds homes from mapped building outlines (Overture Maps: OpenStreetMap and Microsoft) wherever detection missed a building.
- `scripts/clean_homes.py`, run last:
  - turns each row to line up with its street (when within 20°) and faces it toward that street;
  - removes homes standing on a mapped road or on water;
  - removes any home overlapping an already-kept home by more than 12%, so no two homes intersect.
- Streets: dark asphalt with grain and tyre tracks, white edge lines, a dashed centre line, kerbs, green verges and paved footpaths.
- Planting along verges: shrubs in three greens, bougainvillea and ornamental grass, with a mix of street-tree species.
- Trees are smaller: 55% in the communities and 72% in Nara, so walkthrough views stay open.
- Cars: shaped SUV and sedan bodies with clearcoat paint, tinted glass, alloy wheels and lights, in 7 colours.

- Photo-scanned surfaces from Poly Haven (CC0, `media/textures/LICENSE.txt`):
  - asphalt with a normal map on roads;
  - grass on lawns and verges;
  - interlocking concrete pavers on footpaths;
  - stucco relief on house walls;
  - a real sky HDRI for lighting and reflections (`js/realism.js`).
- Roads stay visible when zoomed out: the lawn material no longer pulls itself in front of the road layers.
- Trees are smaller again: 40% in the communities and 55% in Nara.

Order: `run_v2.py` → `clip_compounds.py` → `merge_footprints.py` → `clean_homes.py` → `greens.py`.

### Satellite home detection

`scripts/satellite/run.py <community>` needs numpy and opencv. The script's docstring shows the venv setup. It was checked on Nara, where the surveyed homes are known: 49 of its 57 rows were each matched by one detected row.

Known limits:
- Rows still under construction are only partly found.
- Unit counts are row length ÷ 7.8 m.
- The detected homes use one level of detail (about 200 triangles each) to avoid popping, and are frustum-culled per home. They are not occlusion-culled yet.

## Next phases (agreed order)

1. Trace each project's brochure cluster map onto the satellite imagery, then replace the detected homes with exact plots, unit counts and plan types from the floor-plan footprints. Start with The Valley, then Arabian Ranches III, then Emaar South. This also fixes the projects that are still unbuilt.
2. Read the 6 floor-plan PDFs not yet covered.
3. Add furnished interiors, plan type by plan type.

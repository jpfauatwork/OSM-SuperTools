# OSM SuperTools

A Firefox extension that adds a few productivity tools to the [OpenStreetMap iD editor](https://www.openstreetmap.org/edit).

## Features

### QuickTagging
Configurable buttons in the editor sidebar, just above the Tags section. Each button applies one or several tags at once with a single click, always overwriting the existing value. Useful for tags you type over and over, like `addr:suburb` or `addr:country`.

### QuickFilters
Named, toggleable filters available from the map controls (funnel icon, next to Background/Map Data). Each filter highlights features matching a tag query — geometry type, tags that must be present, tags that must not be present — in a color you choose. Only features currently loaded in the view are highlighted.

### Overlays
Upload a GPX or GeoJSON file and show it as a passive layer drawn on top of the map, available from the map controls (stacked-layers icon, next to QuickFilters). Each upload gets a checkbox to toggle it on/off and a color swatch, just like the QuickFilters list. The layer is purely visual and never intercepts clicks, so you can trace new geometry directly over it. Uploads persist across editor reloads; use the **×** next to an entry to remove it. GPX waypoints, routes, and track segments are supported, as are all standard GeoJSON geometry types.

**Gradient view:** when a track carries elevation, a **%** button appears next to it. Toggle it and the track is recoloured by slope — blue for downhill, red for uphill, deepening as it gets steeper — with a signed percentage label on the steeper stretches (e.g. `-12%`) and a color key under the list.

### AddressFill
When you select a building that contains a point with address tags (e.g. a shop or POI mapped inside it), a **fill** button appears next to the Address field. Hovering previews the point's address in the address inputs; clicking copies all its `addr:*` tags onto the building. If that point is a **pure address node** (nothing but `addr:*` tags), it is also removed once the address has been copied — the address moves onto the building in one click. A point that carries other tags (a shop, amenity, …) is kept.

### ParkingSplit
Draw a (possibly rotated) rectangle over the map and split it into any number of equal `amenity=parking_space` areas in one step — handy for mapping whole rows of marked bays. It adds a **Parking lots** button as a fourth option next to iD's Point / Line / Area in the top toolbar.

**How to use it:**

1. Click **Parking lots** to start drawing.
2. **Click 1** and **Click 2** set the long edge of the row (its start, end, and direction — so it can sit at any angle to the street). **Click 3** sets the depth: move away from that line and click; the distance is the depth, and the side you click on is the side the rectangle extends to.
3. A toolbar appears just below the top bar. Use **−** / **+** to change how many bays the long edge is divided into (live preview, showing each bay's `width × depth` in metres), **⟲** to switch the split axis, **✓ Anlegen** to create the areas, and **✕** to cancel. Keyboard: `+` / `−` (or ↑ / ↓), `R` = flip axis, `Enter` = create, `Esc` = cancel.

The bays are created as real, editable features in one step — `Ctrl+Z` removes the whole row at once.

### PointDirection
Set a `direction` on a node by aiming with the mouse — useful for viewpoints, cameras, entrances, and anything else that faces a way. It adds a **Richtung setzen** item to iD's own right-click menu on nodes (it augments the menu, it doesn't replace it).

**How to use it:**

1. Right-click a node and choose the arrow item at the top of the edit menu.
2. A viewfield cone appears anchored on the node and follows the mouse, showing the live bearing in degrees.
3. Click to confirm — the aimed bearing is written to the node as `direction=<degrees>` (0 = north, clockwise). Hold **Shift** while aiming to snap to 5° steps; **Esc** or right-click cancels.

The tag is written in one step, so `Ctrl+Z` undoes it.

### AlkisImport
Pull an exact building outline out of the official Niedersachsen cadastre (ALKIS) instead of tracing it by hand over the raster layer. It queries the LGLN [`alkis_wfs_sf`](https://opendata.lgln.niedersachsen.de/doorman/noauth/alkis_wfs_sf) Web Feature Service for the survey geometry and drops it into iD as an editable way.

**How to use it:**

1. Select **Niedersachsen ALKIS** as the background layer. The extra menu items only appear while that layer is active (editor-imagery-index id `Niedersachsen-ALKIS`); with any other background nothing changes.
2. Right-click inside the building you want. iD's own edit menu opens with extra ALKIS items added at the front:
   - **Von ALKIS holen** — fetches the building at that point (`building=yes`) **together with all its small parts** — the dashed bits in the ALKIS map: overhangs, arcades and passages (ALKIS `AX_Bauteil`, added as `building:part=yes`). If a standalone address point sits inside the outline — or you right-clicked an address point — its `addr:*` tags are carried onto the new building and the point is removed, all in one undo step.
   - **Gebäude durch ALKIS ersetzen** (only when you right-clicked an existing building) — replaces that building with the ALKIS geometry, keeping its tags (address, name, …).
   - **Adresse kopieren** (only when the clicked object has an address) — copies the address to the clipboard.
3. `Ctrl+Z` undoes the whole action in one step.

**Connecting to neighbours:** imported outlines are glued rather than dropped as loose duplicates. Vertices that coincide (within ~0.2 m) are merged into one shared node, and a vertex that lands on a neighbouring building's wall (within ~0.3 m) is spliced into that wall — so terraced/adjoining buildings end up properly connected, and a building and its overhang share their common edge. The gluing runs in one undo step and falls back to a plain add if anything looks off.

iD's native menu items (paste, copy, delete, …) stay in place — the ALKIS items are added, not a replacement. The WFS request runs from the extension's background script (declared host permission `opendata.lgln.niedersachsen.de`) to avoid CORS.

**Attribution / licence:** ALKIS is © GeoBasis-DE/LGLN, provided under CC BY 4.0 with **explicit permission for OSM use** ([DE:Niedersachsen/Geoportal](https://wiki.openstreetmap.org/wiki/DE:Niedersachsen/Geoportal)). Attribution is satisfied via the OSM [Contributors list](https://wiki.openstreetmap.org/wiki/Contributors), so no per-object `source` tag is needed. If you want one anyway, set `SOURCE_TAG` in `modules/alkisimport.js` (e.g. `© GeoBasis-DE/LGLN 2025`).

## Install

Requires **Firefox 128 or newer**.

1. Open Firefox and go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Select `manifest.json` from this repo.
4. Go to `https://www.openstreetmap.org/edit`, log in, and select a feature.

Firefox removes temporary add-ons on restart, so you'll need to reload it from `about:debugging` each time — see [about installing extensions permanently](https://extensionworkshop.com/documentation/publish/) if you want it to persist.

## Configuration

Click the gear icon next to the language button in the osm.org header (or the gear inside the QuickTagging panel) to open Settings, where you can add, edit, and remove QuickTagging buttons and QuickFilters. AddressFill needs no configuration.

## Building a release

Run `./build.sh` to package the extension into `web-ext-artifacts/osm-supertools-<version>.zip` (and a `.xpi` copy). The version comes from `manifest.json`. Load the `.xpi` via `about:debugging` on regular Firefox, or install it permanently on Firefox Developer Edition / Nightly with `xpinstall.signatures.required` set to `false` in `about:config`.

### Publishing to GitHub Releases

The `.github/workflows/release.yml` workflow builds the package and publishes a GitHub Release automatically. To cut a release:

1. Bump `"version"` in `manifest.json` and commit.
2. Tag it to match, e.g. `git tag v0.2.0`.
3. Push the tag: `git push origin v0.2.0`.

The workflow checks that the tag matches the manifest version, then attaches the `.xpi` and `.zip` to a new Release. You can also trigger it manually from the Actions tab against an existing tag.

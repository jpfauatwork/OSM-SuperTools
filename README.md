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

### CsvImport
Add points, lines and areas — and add or overwrite tags on existing OSM objects by their ID — from a CSV list, for example one that a mapping app, another tool or an AI generated for you. Available from the map controls (table icon, next to Overlays).

**How to use it:**

1. Open the **CSV-Import** pane and either pick a `.csv` file or paste the CSV into the text box and click **Einlesen**.
2. Every row is listed with its line number. Rows with errors are shown in red with the reason and are skipped. All valid rows are drawn as a preview on iD's *Custom Map Data* layer and the map zooms to them; clicking an entry zooms to that one. Untick entries you don't want.
   Rows that change an existing object (orange **Ä**, "ändert way/123") fetch that object from OSM right away and then show what changes, e.g. `building: house → garage`. A row whose tags are already set exactly like that is greyed out as **keine Änderung** and not applied; an object that can't be loaded (deleted, doesn't exist) is flagged.
3. Click **Importieren (N)**. Existing objects that aren't loaded yet are fetched first, then all ticked rows — **new and changed** objects — are applied in **one undo step** (`Ctrl+Z` reverts all of it). Objects that can't be loaded are marked as errors and skipped, the rest still goes through. Nothing is uploaded yet.
4. Review: clicking an entry now selects that feature in iD (**Alle auswählen** selects everything that was created or changed). Fix what needs fixing, then upload with iD's normal **Save**.

The preview temporarily takes over iD's Custom Map Data layer and clears it again on import/discard (its previous on/off state is restored). Imported features are not snapped to existing geometry — check that ways connect where they should.

#### CSV format

Copy the block below and hand it to whoever (or whatever) produces the file:

```text
OSM SuperTools CSV import format

Encoding: UTF-8. One OSM feature per line. Fields are separated by a semicolon ";".
A line either CREATES a new object or UPDATES the tags of an existing one.

Line layout:
  <type>;<coordinates>;<key>=<value>;<key>=<value>;...

1. <type> — one of:
   New objects:
     node  a single point (alias: point)
     way   an open line, e.g. a path or fence (alias: line)
     area  a closed way/polygon, e.g. a building or pitch; it is closed
           automatically, do NOT repeat the first coordinate
     (A "way" whose first and last coordinate are identical is also treated as closed.)
   Existing objects (update line) — OSM type, a slash, and the object's ID:
     node/<id>, way/<id>, relation/<id>      e.g. way/459668590

2. <coordinates> — WGS84 decimal degrees, LATITUDE FIRST: "lat,lon"
   (like Google Maps), dot as decimal separator, no spaces inside a pair.
     node: exactly one pair            52.375892,9.732010
     way:  two or more pairs, separated by a single space
                                       52.37589,9.73201 52.37612,9.73255
     area: three or more pairs, in order around the outline
     update line: OPTIONAL — leave the field empty, or give exactly one pair
                  (e.g. a point on the object); it is only used for the
                  preview and to zoom there, never to move the object.
   Use at least 6 decimal places for building-level accuracy.

3. Tags — every remaining field is exactly one OSM tag "key=value"
   (split at the first "="; the value may itself contain "=").
   - An update line works like a PATCH, not a PUT: only the listed tags are
     touched — a key the object already has gets the new value, a new key is
     added, and all other tags of the object stay as they are. Tags cannot be
     removed.
   - At least one tag per line. Each key at most once per line.
   - Use normal OSM tagging (https://wiki.openstreetmap.org/wiki/Map_features).
   - Keys and values max. 255 characters, no empty values.
   - If a tag contains ";" or starts with a double quote, wrap the whole
     field in double quotes and double any quote inside it:
       "opening_hours=Mo-Fr 08:00-18:00; Sa 09:00-13:00"
       "name=Gasthaus ""Zum Anker"""

Optional: lines starting with "#" are comments; a first line starting with
"type" is treated as a header and ignored; empty lines are ignored.
Output only the CSV — no Markdown code fences, no explanations.

Example:
type;coordinates;tags
node;52.375892,9.732010;amenity=bench;backrest=yes;material=wood
node;52.376120,9.732550;amenity=waste_basket
node;52.376300,9.731800;"opening_hours=Mo-Fr 07:00-18:00; Sa 08:00-12:00";shop=bakery;name=Bäckerei Müller
way;52.375800,9.731900 52.376000,9.732300 52.376200,9.732600;highway=footway;surface=asphalt
area;52.37640,9.73300 52.37640,9.73330 52.37625,9.73330 52.37625,9.73300;leisure=pitch;sport=basketball
# update lines: existing objects by type/ID, coordinate optional
way/459668590;53.2875966,9.8616184;building=garage;capacity=2;roof:shape=flat
node/14220693625;;lamp_type=electric
```

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

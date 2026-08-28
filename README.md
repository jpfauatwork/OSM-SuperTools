# OSM SuperTools

A Firefox extension that adds a few productivity tools to the [OpenStreetMap iD editor](https://www.openstreetmap.org/edit).

## Features

### QuickTagging
Configurable buttons in the editor sidebar, just above the Tags section. Each button applies one or several tags at once with a single click, always overwriting the existing value. Useful for tags you type over and over, like `addr:suburb` or `addr:country`.

### QuickFilters
Named, toggleable filters available from the map controls (funnel icon, next to Background/Map Data). Each filter highlights currently loaded features matching a tag query — geometry type, tags that must be present, tags that must not be present — in a color you choose. Only checks features already loaded in the browser, no extra network requests.

### Overlays
Upload a GPX or GeoJSON file and show it as a passive layer drawn on top of the map, available from the map controls (stacked-layers icon, next to QuickFilters). Each upload gets a checkbox to toggle it on/off and a color swatch, just like the QuickFilters list. The layer is purely visual and never intercepts clicks, so you can trace new geometry directly over it. Uploads persist across editor reloads; use the **×** next to an entry to remove it. GPX waypoints, routes, and track segments are supported, as are all standard GeoJSON geometry types.

**Gradient view:** when a track carries elevation (GPX `<ele>` points), a **%** button appears next to it. Toggle it and the track is recoloured by slope instead of a single color: the track is split into short spans (~25 m, to smooth out GPS elevation noise) and each span is coloured by its grade in 5% steps — blue for downhill, red for uphill, deepening as it gets steeper. Spans of 5% or more also get a signed percentage label (e.g. `-12%`), and a color key appears under the list. Because each span is coloured in place, the color itself shows exactly which stretch a value refers to.

### AddressFill
When you select a building that contains a point with address tags (e.g. a shop or POI mapped inside it), a **fill** button appears next to the Address field. Hovering previews the point's address in the address inputs; clicking copies all its `addr:*` tags onto the building.

## Install

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

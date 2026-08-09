# OSM SuperTools

A Firefox extension that adds a few productivity tools to the [OpenStreetMap iD editor](https://www.openstreetmap.org/edit).

## Features

### QuickTagging
Configurable buttons in the editor sidebar, just above the Tags section. Each button applies one or several tags at once with a single click, always overwriting the existing value. Useful for tags you type over and over, like `addr:suburb` or `addr:country`.

### QuickFilters
Named, toggleable filters available from the map controls (funnel icon, next to Background/Map Data). Each filter highlights currently loaded features matching a tag query — geometry type, tags that must be present, tags that must not be present — in a color you choose. Only checks features already loaded in the browser, no extra network requests.

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

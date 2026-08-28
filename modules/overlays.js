(function () {
  "use strict";

  // Overlays — upload a GPX/GeoJSON file and show it as a passive, toggleable
  // layer drawn on top of the iD map, purely as a visual reference to trace
  // over. It never intercepts pointer events, so you draw straight through it.

  const CONTROL_ID = "ost-ov-control";
  const PANE_ID = "ost-ov-pane";
  const LAYER_CLASS = "ost-ov-layer";
  const SVGNS = "http://www.w3.org/2000/svg";
  const STORAGE_KEY = "overlays";
  const MAX_BYTES = 8 * 1024 * 1024; // guard against oversized uploads

  const PALETTE = [
    "#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4",
    "#008080", "#f032e6", "#9a6324", "#808000", "#000075"
  ];

  let overlays = [];
  let listEl = null;
  let paneEl = null;
  let controlEl = null;
  let statusEl = null;
  let layerGroup = null;
  let observer = null;
  let legendLi = null;
  // Number of storage writes we've made whose onChanged echo we should ignore —
  // rebuilding the list on our own writes would cancel the toggle animation.
  let pendingEchoes = 0;

  function log(...args) {
    console.log("[OSM SuperTools/Overlays]", ...args);
  }
  function warn(...args) {
    console.warn("[OSM SuperTools/Overlays]", ...args);
  }

  function getSurface() {
    return document.querySelector("svg.surface") || document.querySelector(".surface");
  }

  // --- projection ---------------------------------------------------------
  //
  // We draw our layer as a <g> inside iD's `.surface` SVG, in that SVG's own
  // user-space coordinates — so iD's pan/zoom transforms carry it along for
  // free, and we only need to re-project on redraw. To turn lon/lat into those
  // coordinates we build a spherical Web-Mercator projection (the one iD uses)
  // from two things we can read without touching iD internals:
  //   * the map hash `#map=zoom/lat/lon` → view centre + zoom, and
  //   * the surface's on-screen box + CTM → where that centre sits in local space.
  // Everything else is a differential offset from the centre, so the exact
  // translate/scale of iD's projection never needs to be recovered.

  function parseMapHash() {
    // Hash looks like "#map=18.00/53.1234/9.8765" possibly among other &-params.
    const h = location.hash || "";
    const m = h.match(/map=([\d.]+)\/(-?[\d.]+)\/(-?[\d.]+)/);
    if (!m) return null;
    const zoom = parseFloat(m[1]);
    const lat = parseFloat(m[2]);
    const lon = parseFloat(m[3]);
    if (!isFinite(zoom) || !isFinite(lat) || !isFinite(lon)) return null;
    return { zoom, lat, lon };
  }

  const D2R = Math.PI / 180;

  // Mercator in "earth radians": X east-positive, Y north-positive.
  function mercX(lon) {
    return lon * D2R;
  }
  function mercY(lat) {
    const phi = lat * D2R;
    return Math.log(Math.tan(Math.PI / 4 + phi / 2));
  }

  // Invert an SVG screen CTM (client px -> element user space). Mirrors the
  // approach in addressfill.js: do the matrix math by hand so we never pass
  // matrix objects across Firefox's content-script / page Xray boundary.
  function clientToLocal(m, cx, cy) {
    const { a, b, c, d, e, f } = m;
    const det = a * d - b * c;
    if (!det) return null;
    const dx = cx - e;
    const dy = cy - f;
    return { x: (d * dx - c * dy) / det, y: (a * dy - b * dx) / det };
  }

  function getEntity(el) {
    if (window.OST && OST.getEntity) return OST.getEntity(el);
    try {
      const w = el.wrappedJSObject;
      if (w && w.__data__) return w.__data__;
    } catch (e) {
      /* wrappedJSObject unavailable */
    }
    return el.__data__ || null;
  }

  // Local (surface user-space) position of a rendered node group: its transform
  // origin maps to the node's location, and getScreenCTM().{e,f} gives that in
  // client px — invert the surface CTM to bring it into local space. (Same
  // read that addressfill.js uses for node positions.)
  function nodeLocal(surfaceCtm, el) {
    const m = el.getScreenCTM();
    if (!m) return null;
    return clientToLocal(surfaceCtm, m.e, m.f);
  }

  // Preferred, assumption-free projector: iD binds each node's true [lon,lat]
  // (entity.loc) to its element, so any two loaded nodes anchor the projection
  // exactly. Scale comes from zoom; we recover only the translate from the pair,
  // so it stays correct no matter how iD centres or offsets the view.
  function buildCalibratedProjector(surface, scale) {
    const surfaceCtm = surface.getScreenCTM();
    if (!surfaceCtm) return null;

    const refs = [];
    const nodes = surface.querySelectorAll("g.vertex, g.point");
    for (const el of nodes) {
      if (el.classList.contains("target")) continue;
      const e = getEntity(el);
      const loc = e && e.loc;
      if (!loc || !isFinite(loc[0]) || !isFinite(loc[1])) continue;
      const local = nodeLocal(surfaceCtm, el);
      if (!local) continue;
      refs.push({ mx: mercX(loc[0]), my: mercY(loc[1]), lx: local.x, ly: local.y });
      if (refs.length >= 24) break;
    }
    if (refs.length < 2) return null;

    // Anchor on the first ref, offset everything by scaled mercator deltas.
    const a = refs[0];
    // Sanity check the fixed scale against the widest-separated ref pair; if it
    // disagrees badly (rotated/odd view), bail so we don't draw a skewed layer.
    let far = a, bestSep = 0;
    for (const r of refs) {
      const sep = Math.abs(r.mx - a.mx) + Math.abs(r.my - a.my);
      if (sep > bestSep) { bestSep = sep; far = r; }
    }
    if (bestSep > 0) {
      const dmx = far.mx - a.mx, dmy = far.my - a.my;
      const dlx = far.lx - a.lx, dly = far.ly - a.ly;
      const measured = Math.hypot(dlx, dly) / Math.hypot(dmx, dmy);
      if (!isFinite(measured) || measured < scale * 0.9 || measured > scale * 1.1) {
        return null;
      }
    }

    return function projectCal(lon, lat) {
      return {
        x: a.lx + scale * (mercX(lon) - a.mx),
        y: a.ly - scale * (mercY(lat) - a.my)
      };
    };
  }

  // Fallback when no nodes are loaded: assume the hash centre sits at the
  // surface's box centre (how iD frames the view).
  function buildHashProjector(surface, scale, view) {
    const rect = surface.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const ctm = surface.getScreenCTM();
    if (!ctm) return null;
    const centreLocal = clientToLocal(ctm, rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (!centreLocal) return null;

    const mcx = mercX(view.lon);
    const mcy = mercY(view.lat);
    return function projectHash(lon, lat) {
      return {
        x: centreLocal.x + scale * (mercX(lon) - mcx),
        y: centreLocal.y - scale * (mercY(lat) - mcy)
      };
    };
  }

  // Returns a function lon/lat -> {x, y} in the surface's user space, or null if
  // we can't establish the projection right now.
  function buildProjector(surface) {
    const view = parseMapHash();
    if (!view) return null;
    // Pixels per mercator-radian at this (fractional) zoom, tile size 256.
    const scale = (256 * Math.pow(2, view.zoom)) / (2 * Math.PI);

    return buildCalibratedProjector(surface, scale) || buildHashProjector(surface, scale, view);
  }

  // --- rendering ----------------------------------------------------------

  function ensureLayerGroup(surface) {
    if (layerGroup && layerGroup.parentNode === surface) return layerGroup;
    layerGroup = surface.querySelector("g." + LAYER_CLASS);
    if (!layerGroup) {
      layerGroup = document.createElementNS(SVGNS, "g");
      layerGroup.setAttribute("class", LAYER_CLASS);
    }
    // Always keep it as the last child so it sits above iD's features.
    surface.appendChild(layerGroup);
    return layerGroup;
  }

  // Push every [lon, lat] coordinate of a GeoJSON geometry into `sink`, calling
  // it with a geometry kind ("point" | "line" | "ring") and an array of
  // projected {x,y} points.
  function eachGeometry(geom, project, sink) {
    if (!geom || !geom.type) return;
    const t = geom.type;
    const c = geom.coordinates;
    const P = (pt) => project(pt[0], pt[1]);

    if (t === "Point") {
      sink("point", [P(c)]);
    } else if (t === "MultiPoint") {
      c.forEach((pt) => sink("point", [P(pt)]));
    } else if (t === "LineString") {
      sink("line", c.map(P));
    } else if (t === "MultiLineString") {
      c.forEach((line) => sink("line", line.map(P)));
    } else if (t === "Polygon") {
      c.forEach((ring) => sink("ring", ring.map(P)));
    } else if (t === "MultiPolygon") {
      c.forEach((poly) => poly.forEach((ring) => sink("ring", ring.map(P))));
    } else if (t === "GeometryCollection" && Array.isArray(geom.geometries)) {
      geom.geometries.forEach((g) => eachGeometry(g, project, sink));
    }
  }

  function eachFeatureGeometry(geojson, project, sink) {
    if (!geojson || !geojson.type) return;
    if (geojson.type === "FeatureCollection" && Array.isArray(geojson.features)) {
      geojson.features.forEach((f) => f && eachGeometry(f.geometry, project, sink));
    } else if (geojson.type === "Feature") {
      eachGeometry(geojson.geometry, project, sink);
    } else {
      eachGeometry(geojson, project, sink);
    }
  }

  function pointsToPath(points, close) {
    if (!points.length) return "";
    let d = "M" + points[0].x.toFixed(1) + " " + points[0].y.toFixed(1);
    for (let i = 1; i < points.length; i++) {
      d += "L" + points[i].x.toFixed(1) + " " + points[i].y.toFixed(1);
    }
    if (close) d += "Z";
    return d;
  }

  // --- gradient (slope) analysis -----------------------------------------
  //
  // GPS elevation is too noisy to read point-to-point, so we resample each
  // track into consecutive spans of at least SPAN_METERS horizontal length and
  // take the slope of each span: grade% = Δelevation / horizontalDistance ·100.
  // Each span is drawn as its own coloured piece of the track — so the colour IS
  // the "which stretch does this refer to" marker — with a signed % label at the
  // steeper ones. Blue = downhill, red = uphill; deeper = steeper, in 5% bands.

  const SPAN_METERS = 25; // resampling window: smooths noise, keeps short climbs
  const GRADE_STEP = 5; // percent per colour band / label threshold
  const LABEL_MIN_PX = 52; // don't crowd labels closer than this on screen
  const UP_COLORS = ["#fdd0a2", "#fdae6b", "#fd8d3c", "#e6550d", "#a63603"]; // 5..25%+
  const DOWN_COLORS = ["#c6dbef", "#9ecae1", "#6baed6", "#3182bd", "#08519c"];
  const FLAT_COLOR = "#9e9e9e"; // |grade| < 5%

  function haversine(a, b) {
    const R = 6371000;
    const lat1 = a[1] * D2R;
    const lat2 = b[1] * D2R;
    const dLat = (b[1] - a[1]) * D2R;
    const dLon = (b[0] - a[0]) * D2R;
    const s =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function gradeColor(grade) {
    const mag = Math.abs(grade);
    if (mag < GRADE_STEP) return FLAT_COLOR;
    const idx = Math.min(Math.floor(mag / GRADE_STEP) - 1, UP_COLORS.length - 1);
    return grade < 0 ? DOWN_COLORS[idx] : UP_COLORS[idx];
  }

  function gradeLabel(grade) {
    return (grade > 0 ? "+" : "-") + Math.round(Math.abs(grade)) + "%";
  }

  // Split a [lon,lat,ele?] line into spans of >= SPAN_METERS, each with its
  // start/end index, horizontal length and grade (null when elevation missing).
  function slopeSpans(coords, minMeters) {
    const spans = [];
    if (coords.length < 2) return spans;
    let startIdx = 0;
    let acc = 0;
    for (let i = 1; i < coords.length; i++) {
      acc += haversine(coords[i - 1], coords[i]);
      if (acc >= minMeters || i === coords.length - 1) {
        const ea = coords[startIdx][2];
        const eb = coords[i][2];
        let grade = null;
        if (acc > 0 && isFinite(ea) && isFinite(eb)) grade = ((eb - ea) / acc) * 100;
        spans.push({ from: startIdx, to: i, grade: grade });
        startIdx = i;
        acc = 0;
      }
    }
    return spans;
  }

  function farFromPlaced(placed, p) {
    for (const q of placed) {
      if (Math.abs(q.x - p.x) < LABEL_MIN_PX && Math.abs(q.y - p.y) < LABEL_MIN_PX) return false;
    }
    return true;
  }

  function drawGradientLine(coords, project, ctx) {
    const spans = slopeSpans(coords, SPAN_METERS);
    for (const s of spans) {
      const pts = [];
      for (let i = s.from; i <= s.to; i++) pts.push(project(coords[i][0], coords[i][1]));
      const color = s.grade == null ? FLAT_COLOR : gradeColor(s.grade);
      const band = s.grade == null ? 0 : Math.min(Math.floor(Math.abs(s.grade) / GRADE_STEP), 4);

      const pEl = document.createElementNS(SVGNS, "path");
      pEl.setAttribute("d", pointsToPath(pts, false));
      pEl.setAttribute("fill", "none");
      pEl.setAttribute("stroke", color);
      pEl.setAttribute("stroke-width", String(3 + band * 0.6));
      pEl.setAttribute("stroke-opacity", "0.95");
      pEl.setAttribute("stroke-linejoin", "round");
      pEl.setAttribute("stroke-linecap", "round");
      ctx.frag.appendChild(pEl);

      if (s.grade != null && Math.abs(s.grade) >= GRADE_STEP) {
        const mid = pts[Math.floor(pts.length / 2)];
        if (mid && farFromPlaced(ctx.placed, mid)) {
          ctx.placed.push(mid);
          const t = document.createElementNS(SVGNS, "text");
          t.setAttribute("x", mid.x.toFixed(1));
          t.setAttribute("y", (mid.y - 7).toFixed(1));
          t.setAttribute("text-anchor", "middle");
          t.setAttribute("fill", color);
          t.setAttribute("stroke", "#fff");
          t.setAttribute("stroke-width", "3");
          t.setAttribute("stroke-linejoin", "round");
          t.setAttribute("paint-order", "stroke");
          t.setAttribute("font-size", "11");
          t.setAttribute("font-weight", "700");
          t.textContent = gradeLabel(s.grade);
          ctx.frag.appendChild(t);
        }
      }
    }
  }

  // Yield each leaf geometry object, resolving Feature/FeatureCollection/
  // GeometryCollection wrappers.
  function eachGeometryObject(g, cb) {
    if (!g || !g.type) return;
    if (g.type === "FeatureCollection") {
      (g.features || []).forEach((f) => f && eachGeometryObject(f.geometry, cb));
    } else if (g.type === "Feature") {
      eachGeometryObject(g.geometry, cb);
    } else if (g.type === "GeometryCollection") {
      (g.geometries || []).forEach((x) => eachGeometryObject(x, cb));
    } else {
      cb(g);
    }
  }

  function coordsHaveEle(arr) {
    return arr.some((p) => p && p.length >= 3 && isFinite(p[2]));
  }

  function geojsonHasElevation(g) {
    let found = false;
    eachGeometryObject(g, (geom) => {
      if (found) return;
      if (geom.type === "LineString") found = coordsHaveEle(geom.coordinates);
      else if (geom.type === "MultiLineString") found = geom.coordinates.some(coordsHaveEle);
    });
    return found;
  }

  // Our own writes into the surface would otherwise retrigger the childList
  // observer, causing an endless redraw loop — pause it around the rebuild.
  function withObserverPaused(fn) {
    const wasObserving = !!observer;
    if (wasObserving) observer.disconnect();
    try {
      fn();
    } finally {
      if (wasObserving) observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  function reproject() {
    const surface = getSurface();
    if (!surface) return;

    withObserverPaused(() => {
      const group = ensureLayerGroup(surface);

      const active = overlays.filter((o) => o.enabled && o.geojson);
      if (active.length === 0) {
        group.textContent = "";
        return;
      }

      const project = buildProjector(surface);
      if (!project) return; // keep last drawing until we can project again

      drawLayer(group, active, project);
    });
  }

  function appendGeneric(kind, pts, color, frag) {
    if (kind === "point") {
      const cEl = document.createElementNS(SVGNS, "circle");
      cEl.setAttribute("cx", pts[0].x.toFixed(1));
      cEl.setAttribute("cy", pts[0].y.toFixed(1));
      cEl.setAttribute("r", "4");
      cEl.setAttribute("fill", color);
      cEl.setAttribute("fill-opacity", "0.9");
      cEl.setAttribute("stroke", "#fff");
      cEl.setAttribute("stroke-width", "1");
      frag.appendChild(cEl);
    } else {
      const pEl = document.createElementNS(SVGNS, "path");
      pEl.setAttribute("d", pointsToPath(pts, kind === "ring"));
      pEl.setAttribute("fill", kind === "ring" ? color : "none");
      if (kind === "ring") pEl.setAttribute("fill-opacity", "0.12");
      pEl.setAttribute("stroke", color);
      pEl.setAttribute("stroke-width", "3");
      pEl.setAttribute("stroke-opacity", "0.9");
      pEl.setAttribute("stroke-linejoin", "round");
      pEl.setAttribute("stroke-linecap", "round");
      frag.appendChild(pEl);
    }
  }

  // In gradient mode, lines are drawn as slope-coloured spans; any other
  // geometry (points, polygons) falls back to the overlay's base colour.
  function drawGradientOverlay(o, project, ctx) {
    const base = o.color || "#e6194b";
    eachGeometryObject(o.geojson, (geom) => {
      if (geom.type === "LineString") {
        drawGradientLine(geom.coordinates, project, ctx);
      } else if (geom.type === "MultiLineString") {
        geom.coordinates.forEach((line) => drawGradientLine(line, project, ctx));
      } else {
        eachGeometry(geom, project, (kind, pts) => appendGeneric(kind, pts, base, ctx.frag));
      }
    });
  }

  function drawLayer(group, active, project) {
    const frag = document.createDocumentFragment();
    const ctx = { frag: frag, placed: [] };

    for (const o of active) {
      if (o.gradient && o._hasEle) {
        drawGradientOverlay(o, project, ctx);
      } else {
        const color = o.color || "#e6194b";
        eachFeatureGeometry(o.geojson, project, (kind, pts) => appendGeneric(kind, pts, color, frag));
      }
    }

    group.textContent = "";
    group.appendChild(frag);
  }

  // --- parsing ------------------------------------------------------------

  function coordsFromPts(nodes) {
    const out = [];
    for (const n of nodes) {
      const lat = parseFloat(n.getAttribute("lat"));
      const lon = parseFloat(n.getAttribute("lon"));
      if (!isFinite(lat) || !isFinite(lon)) continue;
      // Keep elevation as GeoJSON's standard 3rd coordinate when present, so
      // the gradient view can use it later.
      const eleEl = n.getElementsByTagName("ele")[0];
      const ele = eleEl ? parseFloat(eleEl.textContent) : NaN;
      out.push(isFinite(ele) ? [lon, lat, ele] : [lon, lat]);
    }
    return out;
  }

  // getElementsByTagName matches by local name regardless of XML namespace,
  // which bare CSS type-selectors do not — GPX files carry a default namespace.
  function tags(root, name) {
    return Array.from(root.getElementsByTagName(name));
  }

  // Convert a GPX document into a GeoJSON FeatureCollection (waypoints as
  // Points, routes and each track segment as LineStrings).
  function gpxToGeoJSON(text) {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) throw new Error("Invalid GPX/XML");
    const features = [];

    tags(doc, "wpt").forEach((wpt) => {
      const c = coordsFromPts([wpt]);
      if (c.length) features.push({ type: "Feature", geometry: { type: "Point", coordinates: c[0] } });
    });

    tags(doc, "rte").forEach((rte) => {
      const c = coordsFromPts(tags(rte, "rtept"));
      if (c.length > 1) features.push({ type: "Feature", geometry: { type: "LineString", coordinates: c } });
    });

    tags(doc, "trk").forEach((trk) => {
      tags(trk, "trkseg").forEach((seg) => {
        const c = coordsFromPts(tags(seg, "trkpt"));
        if (c.length > 1) features.push({ type: "Feature", geometry: { type: "LineString", coordinates: c } });
      });
    });

    if (features.length === 0) throw new Error("No waypoints, routes or tracks found");
    return { type: "FeatureCollection", features };
  }

  function parseFile(name, text) {
    const lower = name.toLowerCase();
    if (lower.endsWith(".gpx")) return gpxToGeoJSON(text);
    // .geojson / .json (and anything else) → try JSON, then fall back to GPX.
    try {
      const json = JSON.parse(text);
      if (json && json.type) return json;
      throw new Error("Not a GeoJSON object");
    } catch (e) {
      if (text.indexOf("<gpx") !== -1) return gpxToGeoJSON(text);
      throw e;
    }
  }

  function setStatus(msg, isError) {
    if (!statusEl) return;
    statusEl.textContent = msg || "";
    statusEl.classList.toggle("ost-ov-error", !!isError);
  }

  function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    let pending = files.length;
    let added = 0;

    files.forEach((file) => {
      if (file.size > MAX_BYTES) {
        setStatus(`${file.name} is too large (max 8 MB)`, true);
        if (--pending === 0 && added) finishAdd();
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const geojson = parseFile(file.name, String(reader.result));
          overlays.push({
            id: (crypto.randomUUID && crypto.randomUUID()) || String(Date.now() + Math.random()),
            name: file.name.replace(/\.[^.]+$/, ""),
            color: PALETTE[overlays.length % PALETTE.length],
            enabled: true,
            gradient: false,
            geojson,
            _hasEle: geojsonHasElevation(geojson)
          });
          added++;
        } catch (e) {
          warn(e);
          setStatus(`Could not read ${file.name}: ${e.message}`, true);
        }
        if (--pending === 0 && added) finishAdd();
      };
      reader.onerror = () => {
        setStatus(`Could not read ${file.name}`, true);
        if (--pending === 0 && added) finishAdd();
      };
      reader.readAsText(file);
    });

    function finishAdd() {
      setStatus(`Loaded ${added} file${added === 1 ? "" : "s"}.`, false);
      persist();
      renderList();
      reproject();
    }
  }

  // --- UI: control button + pane -----------------------------------------

  function layersIconSvg() {
    // Simple stacked-layers glyph; `icon light` makes it white like iD controls.
    return (
      '<svg class="icon light" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path fill="currentColor" d="M12 2 2 7l10 5 10-5-10-5zm0 7.2L4.8 7 12 3.8 19.2 7 12 9.2z"/>' +
      '<path fill="currentColor" d="M2 12l10 5 10-5-1.8-.9L12 15 3.8 11.1 2 12zm0 5l10 5 10-5-1.8-.9L12 20 3.8 16.1 2 17z"/>' +
      "</svg>"
    );
  }

  // A plain polyline — the "just show the line" side of the mode toggle.
  function lineIconSvg() {
    return (
      '<svg viewBox="0 0 18 12" width="18" height="12" aria-hidden="true">' +
      '<path d="M1 10 L6 4 L11 8 L17 2" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    );
  }

  function buildControl(controlsWrap, panesWrap) {
    if (document.getElementById(CONTROL_ID)) return;

    controlEl = document.createElement("div");
    controlEl.className = "map-control ost-ov-map-control";
    controlEl.id = CONTROL_ID;
    controlEl.innerHTML =
      '<button type="button" title="Overlays — show an uploaded GPX/GeoJSON to trace over" aria-label="Overlays">' +
      layersIconSvg() +
      "</button>";
    controlsWrap.appendChild(controlEl);

    paneEl = document.createElement("div");
    paneEl.className = "fillL map-pane hide ost-ov-pane";
    paneEl.id = PANE_ID;
    paneEl.setAttribute("pane", "ost-ov");
    paneEl.innerHTML =
      '<div class="pane-heading">' +
      "<h2>Overlays</h2>" +
      '<button type="button" class="ost-ov-close" title="Close">&times;</button>' +
      "</div>" +
      '<div class="pane-content">' +
      '<ul class="layer-list ost-ov-list"></ul>' +
      '<label class="ost-ov-upload">Upload GPX / GeoJSON…' +
      '<input type="file" accept=".gpx,.geojson,.json,application/gpx+xml,application/geo+json" multiple hidden>' +
      "</label>" +
      '<p class="ost-ov-status"></p>' +
      "</div>";
    panesWrap.appendChild(paneEl);

    listEl = paneEl.querySelector(".ost-ov-list");
    statusEl = paneEl.querySelector(".ost-ov-status");

    controlEl.querySelector("button").addEventListener("click", togglePane);
    paneEl.querySelector(".ost-ov-close").addEventListener("click", () => setPaneShown(false));
    const fileInput = paneEl.querySelector('input[type="file"]');
    fileInput.addEventListener("change", () => {
      handleFiles(fileInput.files);
      fileInput.value = ""; // allow re-uploading the same filename
    });

    renderList();
    log("control ready");
  }

  function setPaneShown(shown) {
    if (!paneEl) return;
    paneEl.classList.toggle("hide", !shown);
    paneEl.classList.toggle("shown", shown);
    const btn = controlEl && controlEl.querySelector("button");
    if (btn) btn.classList.toggle("active", shown);
  }

  function togglePane() {
    if (!paneEl) return;
    setPaneShown(paneEl.classList.contains("hide"));
  }

  // Builds iD's native `.layer-list` markup (ul > li > label > input + span) so
  // the list matches the Background/Map-Data panes, plus a color swatch and a
  // per-overlay remove button.
  function renderList() {
    if (!listEl) return;
    listEl.innerHTML = "";
    if (overlays.length === 0) {
      const li = document.createElement("li");
      li.className = "ost-ov-empty";
      li.textContent = "No overlays yet. Upload a GPX or GeoJSON file below.";
      listEl.appendChild(li);
      return;
    }
    for (const o of overlays) {
      const li = document.createElement("li");

      const label = document.createElement("label");

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!o.enabled;
      cb.addEventListener("change", () => {
        o.enabled = cb.checked;
        persist();
        reproject();
      });

      const span = document.createElement("span");

      const swatch = document.createElement("span");
      swatch.className = "ost-ov-swatch";
      swatch.style.background = o.color || "#e6194b";

      const name = document.createElement("span");
      name.className = "ost-ov-name";
      name.textContent = o.name || "(unnamed)";
      name.title = o.name || "";

      span.append(swatch, name);
      label.append(cb, span);

      // Display-mode switch — a two-position segmented toggle (plain line vs.
      // slope %), shown only for tracks that carry elevation.
      let modeToggle = null;
      if (o._hasEle) {
        modeToggle = document.createElement("button");
        modeToggle.type = "button";
        modeToggle.className = "ost-ov-mode " + (o.gradient ? "gradient" : "line");
        modeToggle.setAttribute("role", "switch");
        modeToggle.setAttribute("aria-checked", o.gradient ? "true" : "false");
        modeToggle.setAttribute("aria-label", "Slope gradient view");
        modeToggle.title = modeTitle(o.gradient);

        // Sliding highlight behind the two options (animated via CSS transform).
        const thumb = document.createElement("span");
        thumb.className = "ost-ov-mode-thumb";

        const optLine = document.createElement("span");
        optLine.className = "ost-ov-mode-opt ost-ov-mode-line";
        optLine.innerHTML = lineIconSvg();

        const optPct = document.createElement("span");
        optPct.className = "ost-ov-mode-opt ost-ov-mode-pct";
        optPct.textContent = "%";

        modeToggle.append(thumb, optLine, optPct);
        modeToggle.addEventListener("click", () => {
          o.gradient = !o.gradient;
          // Update the existing button in place (don't rebuild the row) so the
          // thumb animates its slide instead of snapping to the new position.
          modeToggle.classList.toggle("gradient", o.gradient);
          modeToggle.classList.toggle("line", !o.gradient);
          modeToggle.setAttribute("aria-checked", o.gradient ? "true" : "false");
          modeToggle.title = modeTitle(o.gradient);
          persist();
          updateLegend();
          reproject();
        });
      }

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "ost-ov-remove";
      remove.title = "Remove overlay";
      remove.setAttribute("aria-label", "Remove overlay");
      remove.textContent = "×";
      remove.addEventListener("click", () => {
        overlays = overlays.filter((x) => x.id !== o.id);
        persist();
        renderList();
        reproject();
      });

      if (modeToggle) li.append(label, modeToggle, remove);
      else li.append(label, remove);
      listEl.appendChild(li);
    }

    updateLegend();
  }

  function modeTitle(isGradient) {
    return isGradient
      ? "Slope % view — click for plain line"
      : "Plain line — click for slope % view";
  }

  // Show the legend (as the list's last item) exactly when some enabled track
  // is in gradient mode. Managed separately from renderList so toggling the
  // switch doesn't rebuild the row (which would cancel the slide animation).
  function updateLegend() {
    const show = overlays.some((o) => o.enabled && o.gradient && o._hasEle);
    if (show) {
      if (!legendLi) legendLi = buildGradientLegend();
      listEl.appendChild(legendLi); // append() also re-orders it to the end
    } else if (legendLi && legendLi.parentNode) {
      legendLi.remove();
    }
  }

  // Compact colour key for the gradient view: blue = downhill, red = uphill,
  // deepening in 5% steps.
  function buildGradientLegend() {
    const li = document.createElement("li");
    li.className = "ost-ov-legend";

    const row = document.createElement("span");
    row.className = "ost-ov-legend-row";

    const ramp = document.createElement("span");
    ramp.className = "ost-ov-legend-ramp";
    // One diverging bar: dark blue (steep downhill) → grey (flat) → dark red.
    const cells = DOWN_COLORS.slice().reverse().concat([FLAT_COLOR], UP_COLORS);
    cells.forEach((c) => {
      const sw = document.createElement("span");
      sw.className = "ost-ov-legend-cell";
      sw.style.background = c;
      ramp.appendChild(sw);
    });

    row.append(labelSpan("−20%"), ramp, labelSpan("+20%"));

    li.append(row);
    return li;

    function labelSpan(text) {
      const s = document.createElement("span");
      s.className = "ost-ov-legend-end";
      s.textContent = text;
      return s;
    }
  }

  // --- persistence --------------------------------------------------------

  function persist() {
    // Strip runtime-only fields (e.g. _hasEle) before writing.
    const toStore = overlays.map((o) => ({
      id: o.id,
      name: o.name,
      color: o.color,
      enabled: !!o.enabled,
      gradient: !!o.gradient,
      geojson: o.geojson
    }));
    pendingEchoes++;
    browser.storage.local.set({ [STORAGE_KEY]: toStore });
  }

  function normalize(o) {
    const geojson = o.geojson || null;
    return {
      id: o.id,
      name: o.name || "",
      color: o.color || "#e6194b",
      enabled: !!o.enabled,
      gradient: !!o.gradient,
      geojson: geojson,
      _hasEle: geojson ? geojsonHasElevation(geojson) : false
    };
  }

  function loadOverlays() {
    return browser.storage.local.get(STORAGE_KEY).then((res) => {
      const stored = res[STORAGE_KEY];
      overlays = (Array.isArray(stored) ? stored : []).map(normalize);
      renderList();
      reproject();
    });
  }

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[STORAGE_KEY]) return;
    // Ignore the echo of our own writes — the DOM already reflects them, and a
    // full renderList would cancel an in-progress toggle animation.
    if (pendingEchoes > 0) {
      pendingEchoes--;
      return;
    }
    overlays = (changes[STORAGE_KEY].newValue || []).map(normalize);
    renderList();
    reproject();
  });

  // --- wiring -------------------------------------------------------------

  let placeScheduled = false;
  function tryPlaceControls() {
    const controlsWrap = document.querySelector(".map-controls");
    const panesWrap = document.querySelector(".map-panes");
    if (controlsWrap && panesWrap) {
      buildControl(controlsWrap, panesWrap);
      return true;
    }
    return false;
  }

  // iD rebuilds the surface on pan/zoom/edit; our <g> rides along via iD's
  // transforms during interaction, but must be re-projected (and re-attached if
  // dropped) once the redraw settles. Debounce on the surface mutations, and
  // re-project immediately on hash changes (which carry the new view centre).
  let applyScheduled = false;
  function scheduleReproject() {
    if (applyScheduled) return;
    applyScheduled = true;
    setTimeout(() => {
      applyScheduled = false;
      try {
        reproject();
      } catch (e) {
        warn(e);
      }
    }, 80);
  }

  function observe() {
    observer = new MutationObserver(() => {
      if (!placeScheduled) {
        placeScheduled = true;
        requestAnimationFrame(() => {
          placeScheduled = false;
          tryPlaceControls();
        });
      }
      scheduleReproject();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("hashchange", scheduleReproject);
  }

  function init() {
    tryPlaceControls();
    loadOverlays();
    observe();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

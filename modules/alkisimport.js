(function () {
  "use strict";

  // ALKIS Import — while the "Niedersachsen ALKIS" background is active, a
  // right-click on the map gets an extra item in iD's own edit menu that pulls
  // the cadastral building outline at that point out of the LGLN WFS and drops
  // it into iD as an editable way. No optical tracing needed: the WFS returns
  // exact survey geometry. If an address (a standalone point inside the outline,
  // or the object you right-clicked) is found, its address can be carried over
  // onto the new building; an existing building can be replaced outright.

  const D2R = Math.PI / 180;
  const WFS = "https://opendata.lgln.niedersachsen.de/doorman/noauth/alkis_wfs_sf";
  const BG_ID_RE = /niedersachsen-alkis/i; // editor-imagery-index id of the base layer
  const QUERY_RADIUS_M = 4; // half-size of the BBOX we ask the WFS around the click
  const PART_MARGIN_M = 2; // grow the building's bbox by this when fetching its parts
  const MAX_OBJECTS = 25; // safety cap on objects imported per click (building + parts)
  const CTX_TTL_MS = 4000; // how long a recorded right-click stays valid

  // Optional per-object attribution. OSM attribution for LGLN/ALKIS is handled
  // via the changeset / the OSM Contributors List (permission is explicit), so
  // this is off by default; set a string like "© GeoBasis-DE/LGLN 2025" to tag.
  const SOURCE_TAG = "";

  const TYPE_TAGS = {
    AX_Gebaeude: { building: "yes" },
    AX_Bauteil: { "building:part": "yes" }
  };

  let reqCounter = 0;
  let pageReady = false;
  const pending = new Map();
  let pendingCtx = null; // { clientX, clientY, at, src }
  let menuObserver = null;

  function log() {
    console.log.apply(console, ["[OSM SuperTools/AlkisImport]"].concat([].slice.call(arguments)));
  }
  function warn() {
    console.warn.apply(console, ["[OSM SuperTools/AlkisImport]"].concat([].slice.call(arguments)));
  }

  // ---- geometry / projection (shared approach with ParkingSplit) -------------

  function getSurface() {
    return document.querySelector("svg.surface") || document.querySelector(".surface");
  }

  function parseMapHash() {
    const m = (location.hash || "").match(/map=([\d.]+)\/(-?[\d.]+)\/(-?[\d.]+)/);
    if (!m) return null;
    const zoom = parseFloat(m[1]);
    const lat = parseFloat(m[2]);
    const lon = parseFloat(m[3]);
    if (!isFinite(zoom) || !isFinite(lat) || !isFinite(lon)) return null;
    return { zoom, lat, lon };
  }

  function mercX(lon) {
    return lon * D2R;
  }
  function mercY(lat) {
    return Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2));
  }
  function invMercY(y) {
    return (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / D2R;
  }

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

    }
    return el.__data__ || null;
  }

  function extractEntity(el) {
    if (!el) return null;
    const d = getEntity(el);
    return (d && d.properties && d.properties.entity) || d || null;
  }

  function nodeLocal(surfaceCtm, el) {
    const m = el.getScreenCTM();
    if (!m) return null;
    return clientToLocal(surfaceCtm, m.e, m.f);
  }

  function calibratedAnchor(surface, scale) {
    const surfaceCtm = surface.getScreenCTM();
    if (!surfaceCtm) return null;
    const refs = [];
    const nodes = surface.querySelectorAll("g.vertex, g.point");
    for (const el of nodes) {
      if (el.classList.contains("target")) continue;
      const e = extractEntity(el);
      const loc = e && e.loc;
      if (!loc || !isFinite(loc[0]) || !isFinite(loc[1])) continue;
      const local = nodeLocal(surfaceCtm, el);
      if (!local) continue;
      refs.push({ mx: mercX(loc[0]), my: mercY(loc[1]), lx: local.x, ly: local.y });
      if (refs.length >= 24) break;
    }
    if (refs.length < 2) return null;
    const a = refs[0];
    let far = a;
    let bestSep = 0;
    for (const r of refs) {
      const sep = Math.abs(r.mx - a.mx) + Math.abs(r.my - a.my);
      if (sep > bestSep) {
        bestSep = sep;
        far = r;
      }
    }
    if (bestSep > 0) {
      const measured =
        Math.hypot(far.lx - a.lx, far.ly - a.ly) / Math.hypot(far.mx - a.mx, far.my - a.my);
      if (!isFinite(measured) || measured < scale * 0.9 || measured > scale * 1.1) return null;
    }
    return { lx: a.lx, ly: a.ly, mx: a.mx, my: a.my };
  }

  function hashAnchor(surface, view) {
    const rect = surface.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const ctm = surface.getScreenCTM();
    if (!ctm) return null;
    const centre = clientToLocal(ctm, rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (!centre) return null;
    return { lx: centre.x, ly: centre.y, mx: mercX(view.lon), my: mercY(view.lat) };
  }

  function buildProjection(surface) {
    const view = parseMapHash();
    if (!view) return null;
    const scale = (256 * Math.pow(2, view.zoom)) / (2 * Math.PI);
    let anchor = calibratedAnchor(surface, scale);
    if (!anchor) anchor = hashAnchor(surface, view);
    if (!anchor) return null;
    const { lx, ly, mx, my } = anchor;
    return {
      unproject(x, y) {
        const m = mx + (x - lx) / scale;
        const n = my - (y - ly) / scale;
        return { lon: m / D2R, lat: invMercY(n) };
      }
    };
  }

  function clientToLL(clientX, clientY) {
    const surface = getSurface();
    const project = surface && buildProjection(surface);
    if (!project) return null;
    const ctm = surface.getScreenCTM();
    if (!ctm) return null;
    const local = clientToLocal(ctm, clientX, clientY);
    if (!local) return null;
    const ll = project.unproject(local.x, local.y);
    if (!isFinite(ll.lon) || !isFinite(ll.lat)) return null;
    return ll;
  }

  // ---- addresses -------------------------------------------------------------

  function addrTagsOf(tags) {
    const out = {};
    for (const k in tags) {
      if (k.indexOf("addr:") === 0 && tags[k] !== "" && tags[k] != null) out[k] = tags[k];
    }
    return out;
  }

  // The existing feature (if any) that was right-clicked.
  function featureAt(target) {
    let e = extractEntity(target);
    if (!e && target && target.parentNode) e = extractEntity(target.parentNode);
    if (!e || !e.tags || !e.id) return null;
    return {
      id: e.id,
      type: e.type,
      tags: e.tags,
      addr: addrTagsOf(e.tags),
      isNode: e.type === "node",
      isBuilding: !!(e.tags.building && e.tags.building !== "no")
    };
  }

  // Standalone address points whose location falls inside the given ring.
  function addressNodesInside(ring) {
    const surface = getSurface();
    if (!surface) return [];
    const out = [];
    for (const g of surface.querySelectorAll("g.point")) {
      if (g.classList.contains("target")) continue;
      const e = extractEntity(g);
      if (!e || e.type !== "node" || !e.tags) continue;
      const addr = addrTagsOf(e.tags);
      const keys = Object.keys(addr).length;
      if (!keys) continue;
      const loc = e.loc;
      if (!loc || !isFinite(loc[0]) || !isFinite(loc[1])) continue;
      if (pointInRing(loc[0], loc[1], ring)) out.push({ id: e.id, addr, keys });
    }
    out.sort((a, b) => b.keys - a.keys);
    return out;
  }

  // Rendered building ways in the viewport — passed to the bridge so a newly
  // imported outline can be glued to neighbours it shares a wall with.
  function nearbyBuildingWayIds() {
    const surface = getSurface();
    if (!surface) return [];
    const ids = new Set();
    for (const p of surface.querySelectorAll("path.area")) {
      const e = extractEntity(p);
      if (e && e.type === "way" && e.id && e.tags && e.tags.building && e.tags.building !== "no") {
        ids.add(e.id);
      }
    }
    return Array.from(ids).slice(0, 400);
  }

  function formatAddress(addr) {
    const line = [
      [addr["addr:street"] || addr["addr:place"], addr["addr:housenumber"]]
        .filter(Boolean)
        .join(" "),
      [addr["addr:postcode"], addr["addr:city"]].filter(Boolean).join(" ")
    ]
      .filter(Boolean)
      .join(", ");
    if (line) return line;
    return Object.keys(addr)
      .map((k) => k + "=" + addr[k])
      .join(", ");
  }

  function copyAddress(src) {
    const text = formatAddress(src.addr);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(text)
        .then(() => toast("📋 Adresse kopiert: " + text))
        .catch(() => toast("Kopieren nicht möglich (Zwischenablage gesperrt)", true));
    } else {
      toast("Zwischenablage nicht verfügbar", true);
    }
  }

  // ---- ALKIS WFS -------------------------------------------------------------

  function isAlkisActive() {
    const m = (location.hash || "").match(/[#&]background=([^&]+)/);
    if (!m) return false;
    let id = m[1];
    try {
      id = decodeURIComponent(id);
    } catch (e) {

    }
    return BG_ID_RE.test(id);
  }

  function bboxAround(lon, lat, meters) {
    const dLat = meters / 111320;
    const dLon = meters / (111320 * Math.max(0.05, Math.cos(lat * D2R)));
    // urn:EPSG::4326 axis order is lat,lon → miny(lat),minx(lon),maxy(lat),maxx(lon)
    return [lat - dLat, lon - dLon, lat + dLat, lon + dLon];
  }

  function wfsUrl(typeName, bbox) {
    const p = new URLSearchParams();
    p.set("SERVICE", "WFS");
    p.set("VERSION", "2.0.0");
    p.set("REQUEST", "GetFeature");
    p.set("TYPENAMES", typeName);
    p.set("SRSNAME", "urn:ogc:def:crs:EPSG::4326");
    p.set("COUNT", "200");
    p.set("BBOX", bbox.join(",") + ",urn:ogc:def:crs:EPSG::4326");
    return WFS + "?" + p.toString();
  }

  // Bounding box (lat,lon,lat,lon) around a set of lon/lat rings, grown by margin.
  function ringsBBox(rings, marginM) {
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    for (const r of rings) {
      for (const p of r) {
        if (p[0] < minLon) minLon = p[0];
        if (p[0] > maxLon) maxLon = p[0];
        if (p[1] < minLat) minLat = p[1];
        if (p[1] > maxLat) maxLat = p[1];
      }
    }
    const midLat = (minLat + maxLat) / 2;
    const dLat = marginM / 111320;
    const dLon = marginM / (111320 * Math.max(0.05, Math.cos(midLat * D2R)));
    return [minLat - dLat, minLon - dLon, maxLat + dLat, maxLon + dLon];
  }

  function wfsFetch(url) {
    // Routed through the background script so the request carries the
    // extension's host permission and is not blocked by CORS.
    return browser.runtime.sendMessage({ type: "alkis-wfs", url }).then((res) => {
      if (!res) throw new Error("keine Antwort vom Hintergrund-Skript");
      if (!res.ok) throw new Error(res.error || "HTTP " + res.status);
      return res.text;
    });
  }

  function tagName(el) {
    return el.localName || (el.tagName || "").replace(/^.*:/, "");
  }

  function ringFromRingEl(ringEl) {
    const posLists = ringEl.getElementsByTagNameNS("*", "posList");
    let nums = null;
    if (posLists.length) {
      nums = posLists[0].textContent.trim().split(/\s+/).map(Number);
    } else {
      const pos = ringEl.getElementsByTagNameNS("*", "pos");
      if (pos.length) {
        nums = [];
        for (const p of pos) nums.push.apply(nums, p.textContent.trim().split(/\s+/).map(Number));
      }
    }
    if (!nums || nums.length < 8) return null;
    const dimAttr = parseInt(
      (posLists[0] && posLists[0].getAttribute("srsDimension")) ||
        ringEl.getAttribute("srsDimension") ||
        "2",
      10
    );
    const dim = isFinite(dimAttr) && dimAttr >= 2 ? dimAttr : 2;
    const ring = [];
    for (let i = 0; i + 1 < nums.length; i += dim) {
      const lat = nums[i];
      const lon = nums[i + 1];
      if (!isFinite(lat) || !isFinite(lon)) return null;
      ring.push([lon, lat]);
    }
    return ring.length >= 4 ? ring : null;
  }

  function parseGml(text) {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) return { feats: [] };

    let members = Array.from(doc.getElementsByTagNameNS("*", "member"));
    if (!members.length) members = [doc.documentElement];

    const feats = [];
    for (const m of members) {
      let type = null;
      const walk = m.getElementsByTagName("*");
      for (const el of walk) {
        const n = tagName(el);
        if (/^AX_/.test(n)) {
          type = n;
          break;
        }
      }
      const polys = m.getElementsByTagNameNS("*", "Polygon");
      for (const poly of polys) {
        const exts = poly.getElementsByTagNameNS("*", "exterior");
        if (!exts.length) continue;
        const ring = ringFromRingEl(exts[0]);
        if (ring) feats.push({ type, ring });
      }
    }
    return { feats };
  }

  function pointInRing(lon, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0];
      const yi = ring[i][1];
      const xj = ring[j][0];
      const yj = ring[j][1];
      const intersect =
        yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function normalizeRing(ring) {
    if (ring.length > 1) {
      const a = ring[0];
      const b = ring[ring.length - 1];
      if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) {
        return ring.slice(0, -1);
      }
    }
    return ring;
  }

  function baseTagsFor(type) {
    const t = Object.assign({}, TYPE_TAGS[type] || { building: "yes" });
    if (SOURCE_TAG) t.source = SOURCE_TAG;
    return t;
  }

  function segDistM(P, A, B, refLat) {
    const mLat = 111320, mLon = 111320 * Math.cos(refLat * D2R);
    const px = P[0] * mLon, py = P[1] * mLat;
    const ax = A[0] * mLon, ay = A[1] * mLat, bx = B[0] * mLon, by = B[1] * mLat;
    const vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy;
    let t = L2 < 1e-9 ? 0 : ((px - ax) * vx + (py - ay) * vy) / L2;
    t = Math.max(0, Math.min(1, t));
    const dx = px - (ax + t * vx), dy = py - (ay + t * vy);
    return Math.sqrt(dx * dx + dy * dy);
  }
  function vertexNearRing(P, ring, refLat, epsM) {
    for (let i = 0; i < ring.length - 1; i++) {
      if (segDistM(P, ring[i], ring[i + 1], refLat) <= epsM) return true;
    }
    return false;
  }
  // Whether the part belongs to the building: a vertex of one lies inside the
  // other, or on the other's wall (overhangs sit on the wall and project out,
  // often with their base mid-wall rather than on a corner).
  function polysRelated(ra, rb) {
    const refLat = ra.length ? ra[0][1] : 52;
    const EPS = 0.5; // metres
    for (const p of ra) if (pointInRing(p[0], p[1], rb) || vertexNearRing(p, rb, refLat, EPS)) return true;
    for (const p of rb) if (pointInRing(p[0], p[1], ra) || vertexNearRing(p, ra, refLat, EPS)) return true;
    return false;
  }

  // Fetch the building at the click, then every small part (AX_Bauteil —
  // overhangs, arcades, passages) that belongs to it, so they come along too.
  async function fetchBuildingWithParts(lon, lat) {
    const gebFeats = parseGml(
      await wfsFetch(wfsUrl("adv:AX_Gebaeude", bboxAround(lon, lat, QUERY_RADIUS_M)))
    ).feats;
    const buildings = gebFeats.filter((f) => pointInRing(lon, lat, f.ring));

    if (!buildings.length) {
      // No building under the cursor — maybe a standalone part was clicked.
      const bau = parseGml(
        await wfsFetch(wfsUrl("adv:AX_Bauteil", bboxAround(lon, lat, QUERY_RADIUS_M)))
      ).feats.filter((f) => pointInRing(lon, lat, f.ring));
      return bau.slice(0, MAX_OBJECTS);
    }

    let parts = [];
    try {
      const bb = ringsBBox(buildings.map((b) => b.ring), PART_MARGIN_M);
      const allParts = parseGml(await wfsFetch(wfsUrl("adv:AX_Bauteil", bb))).feats;
      parts = allParts.filter((p) => buildings.some((b) => polysRelated(p.ring, b.ring)));
    } catch (e) {
      warn("Bauteil query failed:", e && e.message);
    }
    return buildings.concat(parts).slice(0, MAX_OBJECTS);
  }

  // ---- import flow -----------------------------------------------------------

  let busy = false;

  async function runImport(ctx, opts) {
    if (busy) return;
    opts = opts || {};
    const ll = clientToLL(ctx.clientX, ctx.clientY);
    if (!ll) {
      toast("Projektion nicht möglich — bitte hineinzoomen", true);
      return;
    }

    busy = true;
    toast("ALKIS-Objekt wird abgefragt…");
    try {
      const selected = await fetchBuildingWithParts(ll.lon, ll.lat);
      if (!selected.length) {
        toast("Kein ALKIS-Gebäude an dieser Stelle", true);
        return;
      }

      // Decide address / replacement before building the payload.
      const deleteIds = [];
      let primaryExtra = null; // tags merged onto the primary building
      const primaryRing = selected[0].ring;

      if (opts.replace && opts.replace.id) {
        primaryExtra = Object.assign({}, opts.replace.tags);
        deleteIds.push(opts.replace.id);
      } else if (opts.takeAddress) {
        let src =
          ctx.src && ctx.src.isNode && Object.keys(ctx.src.addr).length ? ctx.src : null;
        if (!src) {
          const inside = addressNodesInside(primaryRing);
          if (inside.length) src = { id: inside[0].id, addr: inside[0].addr };
        }
        if (src) {
          primaryExtra = Object.assign({}, src.addr);
          deleteIds.push(src.id);
        }
      }

      const nodes = [];
      const ways = [];
      selected.forEach((f, i) => {
        const r = normalizeRing(f.ring);
        if (r.length < 3) return;
        const start = nodes.length;
        for (const p of r) nodes.push([p[0], p[1]]);
        const idx = r.map((_, k) => start + k);
        idx.push(start); // close the way (shared first/last node)
        let tags = baseTagsFor(f.type);
        if (i === 0 && primaryExtra) tags = Object.assign(tags, primaryExtra);
        ways.push({ nodes: idx, tags });
      });
      if (!ways.length) {
        toast("Keine gültige Geometrie erhalten", true);
        return;
      }

      const what =
        deleteIds.length && opts.replace
          ? "ersetzt"
          : deleteIds.length
            ? "übernommen (Adresse übertragen)"
            : "übernommen";
      const res = await sendCommit("alkis-" + ++reqCounter, {
        nodes,
        ways,
        deleteIds,
        nearWayIds: nearbyBuildingWayIds(),
        annotation: "ALKIS: " + ways.length + " Objekt(e) " + what
      });
      toast("✓ " + (res.addedWays || ways.length) + " ALKIS-Objekt(e) " + what);
    } catch (e) {
      toast("Fehler: " + (e && e.message ? e.message : e), true);
    } finally {
      busy = false;
    }
  }

  // ---- bridge messaging (page world creates the iD entities) -----------------

  function sendCommit(reqId, payload) {
    return new Promise((resolve, reject) => {
      pending.set(reqId, { resolve, reject });
      window.postMessage({ __ost: "ost-add-features", reqId, payload }, location.origin);
      setTimeout(() => {
        if (pending.has(reqId)) {
          pending.delete(reqId);
          reject(new Error("Zeitüberschreitung (keine Antwort aus der Seitenwelt)"));
        }
      }, 8000);
    });
  }

  function onPageMessage(ev) {
    if (ev.source !== window || ev.origin !== location.origin) return;
    const d = ev.data;
    if (!d || typeof d !== "object") return;
    if (d.__ost === "ost-ready") {
      pageReady = !!d.ready;
    } else if (d.__ost === "ost-result") {
      const p = pending.get(d.reqId);
      if (!p) return;
      pending.delete(d.reqId);
      if (d.ok) p.resolve(d);
      else p.reject(new Error(d.error || "Unbekannter Fehler"));
    }
  }

  function pingBridge() {
    window.postMessage({ __ost: "ost-ping" }, location.origin);
  }

  // ---- iD edit-menu integration ----------------------------------------------

  // Never let this passive listener throw into the page's event dispatch — it
  // must not affect right-click behaviour or any other module.
  function onContextMenu(e) {
    try {
      if (!isAlkisActive()) {
        pendingCtx = null;
        return; // ALKIS not the active base layer → leave iD's menu untouched
      }
      const surface = getSurface();
      const onMap = surface && surface.contains(e.target);
      // Record the click; iD shows its own edit menu, which we then augment.
      pendingCtx = {
        clientX: e.clientX,
        clientY: e.clientY,
        at: Date.now(),
        src: onMap ? featureAt(e.target) : null
      };
    } catch (err) {
      pendingCtx = null;
      warn("contextmenu handler:", err && err.message);
    }
  }

  function watchEditMenu() {
    menuObserver = new MutationObserver(() => {
      try {
        const menu = document.querySelector(".edit-menu");
        if (!menu || menu.querySelector(".ost-alkis-item")) return;
        if (!pendingCtx || Date.now() - pendingCtx.at > CTX_TTL_MS) return;
        injectMenuItems(menu, pendingCtx);
      } catch (err) {
        warn("edit-menu observer:", err && err.message);
      }
    });
    menuObserver.observe(document.body, { childList: true, subtree: true });
  }

  function makeItem(title, iconSvg, onActivate) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "edit-menu-item ost-alkis-item";
    btn.style.height = "34px";
    btn.title = title;
    btn.setAttribute("aria-label", title);
    btn.innerHTML = '<div class="icon-wrap">' + iconSvg + "</div>";
    btn.addEventListener("pointerdown", (e) => e.stopPropagation());
    btn.addEventListener("mousedown", (e) => e.stopPropagation());
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const menu = btn.closest(".edit-menu");
      if (menu) menu.remove();
      onActivate();
    });
    return btn;
  }

  function injectMenuItems(menu, ctx) {
    const items = [];
    const src = ctx.src;

    if (src && src.isBuilding && !src.isNode) {
      // Right-clicked an existing building: replace it with the ALKIS geometry,
      // carrying ALL its tags (address, name, …) over — no re-typing, and no
      // plain "fetch" here so we never drop a duplicate on top of it.
      items.push(
        makeItem("Gebäude durch ALKIS ersetzen (Adresse bleibt)", iconReplace(), () =>
          runImport(ctx, { replace: src })
        )
      );
    } else {
      // Empty spot or an address point: fetch the ALKIS outline. If an address
      // point sits inside the outline (or was the point clicked), its addr:*
      // tags are carried onto the new building and the point is removed.
      items.push(
        makeItem("Von ALKIS holen", iconFetch(), () => runImport(ctx, { takeAddress: true }))
      );
    }

    // Quick clipboard copy of an existing object's address.
    if (src && Object.keys(src.addr).length) {
      items.push(makeItem("Adresse kopieren", iconCopy(), () => copyAddress(src)));
    }

    const first = menu.firstChild;
    for (const it of items) menu.insertBefore(it, first);
    log("added", items.length, "ALKIS item(s) to edit menu");
  }

  // ---- icons (styled like iD's operation icons) ------------------------------

  function svgWrap(inner) {
    return (
      '<svg class="icon operation" viewBox="0 0 16 16" width="20" height="20" aria-hidden="true">' +
      inner +
      "</svg>"
    );
  }
  // House outline + downward arrow → "fetch building".
  function iconFetch() {
    return svgWrap(
      '<path d="M2.5 14V7.2L8 3l5.5 4.2V14z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>' +
        '<path d="M8 7.3v3.4M6.3 9l1.7 1.8L9.7 9" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>'
    );
  }
  // Two opposing arrows → "replace".
  function iconReplace() {
    return svgWrap(
      '<path d="M3 6h8l-2.4-2.4M11 10H3l2.4 2.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>'
    );
  }
  // Overlapping sheets → "copy".
  function iconCopy() {
    return svgWrap(
      '<rect x="5.5" y="5.5" width="7.5" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
        '<path d="M3 10.5V3a.5.5 0 0 1 .5-.5H10" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>'
    );
  }

  // ---- toast -----------------------------------------------------------------

  let toastEl = null;
  let toastTimer = null;
  function mapAnchor() {
    return document.querySelector(".main-map") || document.querySelector("#map") || document.body;
  }
  function toast(msg, isError) {
    const anchor = mapAnchor();
    if (!toastEl || toastEl.parentNode !== anchor) {
      toastEl = document.createElement("div");
      toastEl.id = "ost-alkis-toast";
      anchor.appendChild(toastEl);
    }
    toastEl.textContent = msg || "";
    toastEl.classList.toggle("ost-alkis-toast-error", !!isError);
    toastEl.classList.toggle("shown", !!msg);
    if (toastTimer) clearTimeout(toastTimer);
    if (msg) {
      toastTimer = setTimeout(() => toastEl && toastEl.classList.remove("shown"), 4000);
    }
  }

  function init() {
    window.addEventListener("message", onPageMessage);
    document.addEventListener("contextmenu", onContextMenu, true);
    watchEditMenu();

    pingBridge();
    let pings = 0;
    const pingTimer = setInterval(() => {
      if (pageReady || ++pings > 6) {
        clearInterval(pingTimer);
        return;
      }
      pingBridge();
    }, 600);

    log("ready (right-click over the Niedersachsen ALKIS layer → menu item)");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

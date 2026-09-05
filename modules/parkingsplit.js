(function () {
  "use strict";

  const CONTROL_ID = "ost-ps-control";
  const TOOLBAR_ID = "ost-ps-toolbar";
  const LAYER_CLASS = "ost-ps-layer";
  const CAPTURE_ID = "ost-ps-capture";
  const SVGNS = "http://www.w3.org/2000/svg";
  const D2R = Math.PI / 180;
  const PARKING_TAGS = { amenity: "parking_space" };
  const MIN_N = 1;
  const MAX_N = 200;

  let mode = "idle";
  let clicks = [];
  let cursorLocal = null;
  let cornersLL = null;
  let divisions = 4;
  let axisFlip = false;

  let controlEl = null;
  let layerGroup = null;
  let captureEl = null;
  let toolbarEl = null;
  let observer = null;
  let pageReady = false;
  let reqCounter = 0;
  const pending = new Map();

  function log() {
    console.log.apply(console, ["[OSM SuperTools/ParkingSplit]"].concat([].slice.call(arguments)));
  }
  function warn() {
    console.warn.apply(console, ["[OSM SuperTools/ParkingSplit]"].concat([].slice.call(arguments)));
  }

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

  function nodeLocal(surfaceCtm, el) {
    const m = el.getScreenCTM();
    if (!m) return null;
    return clientToLocal(surfaceCtm, m.e, m.f);
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
      scale,
      project(lon, lat) {
        return { x: lx + scale * (mercX(lon) - mx), y: ly - scale * (mercY(lat) - my) };
      },
      unproject(x, y) {
        const m = mx + (x - lx) / scale;
        const n = my - (y - ly) / scale;
        return { lon: m / D2R, lat: invMercY(n) };
      }
    };
  }

  function calibratedAnchor(surface, scale) {
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

  function clientToLocalOnSurface(cx, cy) {
    const surface = getSurface();
    if (!surface) return null;
    const ctm = surface.getScreenCTM();
    if (!ctm) return null;
    return clientToLocal(ctm, cx, cy);
  }

  function sub(p, q) {
    return { x: p.x - q.x, y: p.y - q.y };
  }
  function add(p, q) {
    return { x: p.x + q.x, y: p.y + q.y };
  }
  function scaleVec(p, s) {
    return { x: p.x * s, y: p.y * s };
  }
  function lerp(p, q, t) {
    return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
  }
  function len(v) {
    return Math.hypot(v.x, v.y);
  }

  function rectFromBaselineWidth(p0, p1, pw) {
    const v = sub(p1, p0);
    const L = len(v);
    if (L < 1e-6) return null;
    const n = { x: -v.y / L, y: v.x / L };
    const w = (pw.x - p0.x) * n.x + (pw.y - p0.y) * n.y;
    const off = scaleVec(n, w);
    return [p0, p1, add(p1, off), add(p0, off)];
  }

  function haversine(aLon, aLat, bLon, bLat) {
    const R = 6371000;
    const dLat = (bLat - aLat) * D2R;
    const dLon = (bLon - aLon) * D2R;
    const s =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(aLat * D2R) * Math.cos(bLat * D2R) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function splitAxis(cornersLocal) {
    const [A, B, , D] = cornersLocal;
    const alongAB = len(sub(B, A)) >= len(sub(D, A));
    const useAB = axisFlip ? !alongAB : alongAB;
    return useAB ? "AB" : "AD";
  }

  function cornersLocalFromLL(project) {
    return cornersLL.map((c) => project(c.lon, c.lat));
  }

  function buildGrid(cornersLocal, n) {
    const [A, B, C, D] = cornersLocal;
    const axis = splitAxis(cornersLocal);
    const nodes = [];
    const rings = [];
    const lines = [];

    if (axis === "AB") {

      const top = [];
      const bot = [];
      for (let i = 0; i <= n; i++) {
        top.push(nodes.push(lerp(A, B, i / n)) - 1);
        bot.push(nodes.push(lerp(D, C, i / n)) - 1);
      }
      for (let i = 0; i < n; i++) {
        rings.push([top[i], top[i + 1], bot[i + 1], bot[i], top[i]]);
      }
      for (let i = 1; i < n; i++) lines.push([nodes[top[i]], nodes[bot[i]]]);
    } else {

      const left = [];
      const right = [];
      for (let i = 0; i <= n; i++) {
        left.push(nodes.push(lerp(A, D, i / n)) - 1);
        right.push(nodes.push(lerp(B, C, i / n)) - 1);
      }
      for (let i = 0; i < n; i++) {
        rings.push([left[i], right[i], right[i + 1], left[i + 1], left[i]]);
      }
      for (let i = 1; i < n; i++) lines.push([nodes[left[i]], nodes[right[i]]]);
    }
    return { nodes, rings, lines, axis };
  }

  function bayDims() {
    if (!cornersLL) return null;
    const [A, B, C, D] = cornersLL;
    const abM = haversine(A.lon, A.lat, B.lon, B.lat);
    const adM = haversine(A.lon, A.lat, D.lon, D.lat);

    const alongAB = abM >= adM;
    const useAB = axisFlip ? !alongAB : alongAB;
    const longM = useAB ? abM : adM;
    const shortM = useAB ? adM : abM;
    return { bayWidth: longM / divisions, bayDepth: shortM };
  }

  function ensureLayerGroup(surface) {
    if (layerGroup && layerGroup.parentNode === surface) return layerGroup;
    layerGroup = surface.querySelector("g." + LAYER_CLASS);
    if (!layerGroup) {
      layerGroup = document.createElementNS(SVGNS, "g");
      layerGroup.setAttribute("class", LAYER_CLASS);
    }
    surface.appendChild(layerGroup);
    return layerGroup;
  }

  function clearLayer() {
    if (layerGroup) layerGroup.textContent = "";
  }

  function polyPath(pts, close) {
    if (!pts.length) return "";
    let d = "M" + pts[0].x.toFixed(1) + " " + pts[0].y.toFixed(1);
    for (let i = 1; i < pts.length; i++) d += "L" + pts[i].x.toFixed(1) + " " + pts[i].y.toFixed(1);
    if (close) d += "Z";
    return d;
  }

  function makePath(d, opts) {
    const p = document.createElementNS(SVGNS, "path");
    p.setAttribute("d", d);
    p.setAttribute("fill", opts.fill || "none");
    if (opts.fillOpacity != null) p.setAttribute("fill-opacity", String(opts.fillOpacity));
    p.setAttribute("stroke", opts.stroke || "none");
    if (opts.strokeWidth != null) p.setAttribute("stroke-width", String(opts.strokeWidth));
    if (opts.dash) p.setAttribute("stroke-dasharray", opts.dash);
    p.setAttribute("stroke-linejoin", "round");
    p.setAttribute("stroke-linecap", "round");
    return p;
  }

  const COLOR = "#2b6cff";

  function renderDrawing() {
    const surface = getSurface();
    if (!surface) return;
    const group = ensureLayerGroup(surface);
    group.textContent = "";
    const frag = document.createDocumentFragment();

    if (clicks.length === 1 && cursorLocal) {
      frag.appendChild(
        makePath(polyPath([clicks[0], cursorLocal], false), {
          stroke: COLOR,
          strokeWidth: 2,
          dash: "6 4"
        })
      );
    } else if (clicks.length === 2) {
      const pw = cursorLocal || clicks[1];
      const rect = rectFromBaselineWidth(clicks[0], clicks[1], pw);
      if (rect) {
        frag.appendChild(
          makePath(polyPath(rect, true), {
            stroke: COLOR,
            strokeWidth: 2,
            fill: COLOR,
            fillOpacity: 0.14
          })
        );
      } else {
        frag.appendChild(
          makePath(polyPath([clicks[0], clicks[1]], false), { stroke: COLOR, strokeWidth: 2 })
        );
      }
    }

    clicks.forEach((p) => frag.appendChild(dot(p)));
    group.appendChild(frag);
  }

  function dot(p) {
    const c = document.createElementNS(SVGNS, "circle");
    c.setAttribute("cx", p.x.toFixed(1));
    c.setAttribute("cy", p.y.toFixed(1));
    c.setAttribute("r", "3.5");
    c.setAttribute("fill", "#fff");
    c.setAttribute("stroke", COLOR);
    c.setAttribute("stroke-width", "2");
    return c;
  }

  function renderAdjusting() {
    const surface = getSurface();
    if (!surface || !cornersLL) return;
    const project = buildProjection(surface);
    if (!project) return;

    const group = ensureLayerGroup(surface);
    const cl = cornersLocalFromLL(project.project);
    const grid = buildGrid(cl, divisions);

    group.textContent = "";
    const frag = document.createDocumentFragment();

    frag.appendChild(
      makePath(polyPath(cl, true), {
        stroke: COLOR,
        strokeWidth: 2.5,
        fill: COLOR,
        fillOpacity: 0.1
      })
    );

    grid.lines.forEach((seg) =>
      frag.appendChild(makePath(polyPath(seg, false), { stroke: COLOR, strokeWidth: 1.5 }))
    );

    cl.forEach((p) => frag.appendChild(dot(p)));

    group.appendChild(frag);
  }

  function render() {
    if (mode === "drawing") renderDrawing();
    else if (mode === "adjusting") renderAdjusting();
    else clearLayer();
  }

  function enterDrawing() {
    resetShape();
    mode = "drawing";
    clicks = [];
    cursorLocal = null;
    showCapture(true);
    setControlActive(true);
    bindKeys(true);
    render();
    setStatusToast("Klick 1: Startpunkt der Längskante · Esc bricht ab");
  }

  function showCapture(on) {
    if (on) {
      if (captureEl) return;
      captureEl = document.createElement("div");
      captureEl.id = CAPTURE_ID;
      captureEl.addEventListener("pointerdown", onCaptureDown, true);
      captureEl.addEventListener("pointermove", onCaptureMove, true);
      captureEl.addEventListener("contextmenu", (e) => e.preventDefault(), true);
      document.body.appendChild(captureEl);
    } else if (captureEl) {
      captureEl.remove();
      captureEl = null;
    }
  }

  function onCaptureMove(e) {
    const local = clientToLocalOnSurface(e.clientX, e.clientY);
    if (!local) return;
    cursorLocal = local;
    if (clicks.length >= 1) render();
  }

  function onCaptureDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const local = clientToLocalOnSurface(e.clientX, e.clientY);
    if (!local) return;

    clicks.push(local);
    cursorLocal = local;

    if (clicks.length === 1) {
      setStatusToast("Klick 2: Endpunkt der Längskante");
    } else if (clicks.length === 2) {
      setStatusToast("Klick 3: Breite festlegen");
    } else if (clicks.length === 3) {
      finalizeRectangle();
      return;
    }
    render();
  }

  function finalizeRectangle() {
    const rect = rectFromBaselineWidth(clicks[0], clicks[1], clicks[2]);
    showCapture(false);
    if (!rect) {
      warn("degenerate rectangle");
      cancelAll();
      return;
    }
    const surface = getSurface();
    const project = buildProjection(surface);
    if (!project) {
      setStatusToast("Projektion nicht möglich — abgebrochen", true);
      cancelAll();
      return;
    }
    cornersLL = rect.map((p) => project.unproject(p.x, p.y));
    mode = "adjusting";
    clicks = [];
    cursorLocal = null;
    render();
    buildToolbar();
  }

  function setDivisions(n) {
    divisions = Math.max(MIN_N, Math.min(MAX_N, n | 0));
    updateToolbar();
    render();
  }

  function flipAxis() {
    axisFlip = !axisFlip;
    updateToolbar();
    render();
  }

  function mapAnchor() {
    return document.querySelector(".main-map") || document.querySelector("#map") || document.body;
  }

  function buildToolbar() {
    removeToolbar();
    const anchor = mapAnchor();

    toolbarEl = document.createElement("div");
    toolbarEl.id = TOOLBAR_ID;
    toolbarEl.innerHTML =
      '<button type="button" class="ost-ps-tb-btn" data-act="dec" title="Weniger Flächen (−)">−</button>' +
      '<span class="ost-ps-tb-n" title="Anzahl Flächen"></span>' +
      '<button type="button" class="ost-ps-tb-btn" data-act="inc" title="Mehr Flächen (+)">+</button>' +
      '<span class="ost-ps-tb-sep"></span>' +
      '<span class="ost-ps-tb-dims"></span>' +
      '<span class="ost-ps-tb-sep"></span>' +
      '<button type="button" class="ost-ps-tb-btn" data-act="flip" title="Teilungs-Achse wechseln (R)">⟲</button>' +
      '<button type="button" class="ost-ps-tb-btn ost-ps-tb-ok" data-act="apply" title="Flächen anlegen (Enter)">✓ Anlegen</button>' +
      '<button type="button" class="ost-ps-tb-btn ost-ps-tb-cancel" data-act="cancel" title="Abbrechen (Esc)">✕</button>';
    anchor.appendChild(toolbarEl);

    toolbarEl.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === "dec") setDivisions(divisions - 1);
      else if (act === "inc") setDivisions(divisions + 1);
      else if (act === "flip") flipAxis();
      else if (act === "apply") commit();
      else if (act === "cancel") cancelAll();
    });
    positionToolbar();
    updateToolbar();
  }

  function positionToolbar() {
    if (!toolbarEl) return;
    const bar = document.querySelector(".top-toolbar") || document.querySelector("#bar");
    const aRect = mapAnchor().getBoundingClientRect();
    let top = 56;
    if (bar) {
      const bRect = bar.getBoundingClientRect();
      top = bRect.bottom - aRect.top + 8;
    }
    if (!isFinite(top) || top < 8) top = 8;
    toolbarEl.style.top = top + "px";
  }

  function updateToolbar() {
    if (!toolbarEl) return;
    const nEl = toolbarEl.querySelector(".ost-ps-tb-n");
    if (nEl) nEl.textContent = String(divisions);
    const dimsEl = toolbarEl.querySelector(".ost-ps-tb-dims");
    const dims = bayDims();
    if (dimsEl && dims) {
      dimsEl.textContent =
        "je " + dims.bayWidth.toFixed(1) + " × " + dims.bayDepth.toFixed(1) + " m";
    }
    const okBtn = toolbarEl.querySelector(".ost-ps-tb-ok");
    if (okBtn) {
      okBtn.disabled = !pageReady;
      okBtn.title = pageReady
        ? "Flächen anlegen (Enter)"
        : "iD-Kontext (noch) nicht erreichbar — siehe Konsole/Diagnose";
    }
  }

  function removeToolbar() {
    if (toolbarEl) {
      toolbarEl.remove();
      toolbarEl = null;
    }
  }

  function onKey(e) {

    if (e.key === "Escape") {
      if (mode !== "idle") {
        cancelAll();
        e.preventDefault();
      }
      return;
    }
    if (mode !== "adjusting") return;
    if (e.key === "+" || e.key === "=" || e.key === "ArrowUp") {
      setDivisions(divisions + 1);
      e.preventDefault();
    } else if (e.key === "-" || e.key === "ArrowDown") {
      setDivisions(divisions - 1);
      e.preventDefault();
    } else if (e.key === "r" || e.key === "R") {
      flipAxis();
      e.preventDefault();
    } else if (e.key === "Enter") {
      commit();
      e.preventDefault();
    }
  }

  let keysBound = false;
  function bindKeys(on) {
    if (on && !keysBound) {
      document.addEventListener("keydown", onKey, true);
      keysBound = true;
    } else if (!on && keysBound) {
      document.removeEventListener("keydown", onKey, true);
      keysBound = false;
    }
  }

  function commit() {
    if (mode !== "adjusting" || !cornersLL) return;
    if (!pageReady) {
      setStatusToast("iD-Kontext nicht erreichbar — kann nicht anlegen", true);
      return;
    }
    const surface = getSurface();
    const project = buildProjection(surface);
    if (!project) {
      setStatusToast("Projektion nicht möglich", true);
      return;
    }
    const cl = cornersLocalFromLL(project.project);
    const grid = buildGrid(cl, divisions);

    const nodes = grid.nodes.map((p) => {
      const ll = project.unproject(p.x, p.y);
      return [ll.lon, ll.lat];
    });
    const ways = grid.rings.map((ring) => ({ nodes: ring, tags: Object.assign({}, PARKING_TAGS) }));

    const reqId = "ps-" + ++reqCounter;
    setStatusToast("Lege " + ways.length + " Parkflächen an…");
    sendCommit(reqId, { nodes, ways, annotation: "ParkingSplit: " + ways.length + " parking spaces" })
      .then((res) => {
        const added = res.addedWays || ways.length;
        cancelAll();
        setStatusToast("✓ " + added + " Parkflächen angelegt");
      })
      .catch((err) => {
        setStatusToast("Fehler beim Anlegen: " + (err && err.message ? err.message : err), true);
      });
  }

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
      const was = pageReady;
      pageReady = !!d.ready;
      if (pageReady !== was) log("iD context " + (pageReady ? "reachable" : "not reachable"));
      updateToolbar();
    } else if (d.__ost === "ost-result") {
      const p = pending.get(d.reqId);
      if (!p) return;
      pending.delete(d.reqId);
      if (d.ok) p.resolve(d);
      else p.reject(new Error(d.error || "Unbekannter Fehler"));
    }
  }

  function resetShape() {
    cornersLL = null;
    clicks = [];
    cursorLocal = null;
    axisFlip = false;
  }

  function cancelAll() {
    mode = "idle";
    resetShape();
    showCapture(false);
    removeToolbar();
    bindKeys(false);
    setControlActive(false);
    clearLayer();
    if (toastEl) toastEl.classList.remove("shown");
  }

  function setControlActive(on) {
    if (controlEl) controlEl.classList.toggle("active", on);
  }

  let toastEl = null;
  let toastTimer = null;
  function setStatusToast(msg, isError) {
    const anchor = mapAnchor();
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.id = "ost-ps-toast";
      anchor.appendChild(toastEl);
    }
    toastEl.textContent = msg || "";
    toastEl.classList.toggle("ost-ps-toast-error", !!isError);
    toastEl.classList.toggle("shown", !!msg);
    if (toastTimer) clearTimeout(toastTimer);
    if (msg && mode === "idle") {
      toastTimer = setTimeout(() => toastEl && toastEl.classList.remove("shown"), 4000);
    }
  }

  function iconSvg() {

    return (
      '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">' +
      '<rect x="3" y="6" width="18" height="12" fill="none" stroke="currentColor" stroke-width="2"/>' +
      '<line x1="9" y1="6" x2="9" y2="18" stroke="currentColor" stroke-width="2"/>' +
      '<line x1="15" y1="6" x2="15" y2="18" stroke="currentColor" stroke-width="2"/>' +
      "</svg>"
    );
  }

  function buildModeButton(joined) {
    if (document.getElementById(CONTROL_ID)) return;
    controlEl = document.createElement("button");
    controlEl.type = "button";
    controlEl.id = CONTROL_ID;
    controlEl.className = "bar-button ost-ps-mode-button";
    controlEl.setAttribute("tabindex", "-1");
    controlEl.title = "ParkingSplit — Rechteck aufziehen und in gleiche Parkflächen teilen";
    controlEl.innerHTML = iconSvg() + '<span class="label">Parking lots</span>';
    joined.appendChild(controlEl);
    controlEl.addEventListener("click", () => {
      if (mode === "idle") enterDrawing();
      else cancelAll();
    });
    log("mode button ready");
  }

  function findModesJoined() {
    return (
      document.querySelector(".top-toolbar .old-modes .joined") ||
      document.querySelector(".top-toolbar .modes .joined") ||
      document.querySelector(".top-toolbar .old-modes .item-content") ||
      document.querySelector("#bar .old-modes .joined") ||
      null
    );
  }

  function tryPlaceControls() {
    const joined = findModesJoined();
    if (joined) {
      buildModeButton(joined);
      return true;
    }
    return false;
  }

  let reprojectScheduled = false;
  function scheduleReproject() {
    if (reprojectScheduled) return;
    reprojectScheduled = true;
    setTimeout(() => {
      reprojectScheduled = false;
      try {
        if (mode === "adjusting") {
          render();
          positionToolbar();
        }
      } catch (e) {
        warn(e);
      }
    }, 80);
  }

  let placeScheduled = false;
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
    window.addEventListener("resize", () => {
      if (mode === "adjusting") positionToolbar();
    });
  }

  function pingBridge() {
    window.postMessage({ __ost: "ost-ping" }, location.origin);
  }

  function init() {
    window.addEventListener("message", onPageMessage);

    pingBridge();
    let pings = 0;
    const pingTimer = setInterval(() => {
      if (pageReady || ++pings > 6) {
        clearInterval(pingTimer);
        return;
      }
      pingBridge();
    }, 600);
    tryPlaceControls();
    observe();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

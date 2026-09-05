(function () {
  "use strict";

  const CAPTURE_ID = "ost-dir-capture";
  const TOAST_ID = "ost-dir-toast";
  const SVGNS = "http://www.w3.org/2000/svg";
  const COLOR = "#2b6cff";
  const RADIUS = 64;
  const HALF_ANGLE = 30;

  let aiming = false;
  let target = null;
  let bearing = 0;
  let lastNode = null;
  let lastNodeAt = 0;
  let menuObserver = null;
  let captureEl = null;
  let svgEl = null;
  let toastEl = null;
  let toastTimer = null;
  let pageReady = false;
  let reqCounter = 0;
  const pending = new Map();

  function log() {
    console.log.apply(console, ["[OSM SuperTools/PointDirection]"].concat([].slice.call(arguments)));
  }

  function getSurface() {
    return document.querySelector("svg.surface") || document.querySelector(".surface");
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

  function nodeFromTarget(targetEl) {
    let e = extractEntity(targetEl);
    if (!e && targetEl && targetEl.parentNode) e = extractEntity(targetEl.parentNode);
    if (e && e.type === "node" && e.id) return { id: e.id };
    return null;
  }

  function nodeClientCenter(id) {
    const surface = getSurface();
    if (!surface) return null;
    const els = surface.querySelectorAll("g.vertex, g.point");
    for (const el of els) {
      if (el.classList && el.classList.contains("target")) continue;
      const ent = extractEntity(el);
      if (ent && ent.id === id) {
        const m = el.getScreenCTM();
        if (m) return { x: m.e, y: m.f };
      }
    }
    return null;
  }

  function onContextMenu(e) {
    if (aiming) {

      closeAiming();
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const surface = getSurface();
    const found = surface && surface.contains(e.target) ? nodeFromTarget(e.target) : null;
    if (found) {
      lastNode = { id: found.id, apex: { x: e.clientX, y: e.clientY } };
      lastNodeAt = Date.now();
    } else {
      lastNode = null;
    }

  }

  function watchEditMenu() {
    menuObserver = new MutationObserver(() => {
      const menu = document.querySelector(".edit-menu");
      if (!menu || menu.querySelector(".ost-dir-item")) return;

      if (!lastNode || Date.now() - lastNodeAt > 3000) return;
      injectMenuItem(menu, lastNode);
    });
    menuObserver.observe(document.body, { childList: true, subtree: true });
  }

  function injectMenuItem(menu, node) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "edit-menu-item ost-dir-item";
    btn.style.height = "34px";
    btn.title = "Richtung setzen";
    btn.innerHTML = '<div class="icon-wrap">' + arrowIcon() + "</div>";
    menu.insertBefore(btn, menu.firstChild);

    btn.addEventListener("pointerdown", (e) => e.stopPropagation());
    btn.addEventListener("mousedown", (e) => e.stopPropagation());
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      menu.remove();
      const n = node;
      lastNode = null;
      startAiming({ id: n.id, apex: n.apex });
    });
    log("added direction item to edit menu for", node.id);
    lastNode = null;
  }

  function startAiming(found) {

    const apex = nodeClientCenter(found.id) || found.apex;
    target = { id: found.id, apex };
    aiming = true;
    bearing = 0;

    captureEl = document.createElement("div");
    captureEl.id = CAPTURE_ID;
    svgEl = document.createElementNS(SVGNS, "svg");
    svgEl.setAttribute("width", "100%");
    svgEl.setAttribute("height", "100%");
    captureEl.appendChild(svgEl);
    document.body.appendChild(captureEl);

    captureEl.addEventListener("pointermove", onAimMove, true);
    captureEl.addEventListener("pointerdown", onAimDown, true);
    captureEl.addEventListener("contextmenu", onContextMenu, true);
    document.addEventListener("keydown", onAimKey, true);

    setToast("Maus bewegen zum Anpeilen · Klick bestätigt · Umschalt = 5°-Raster · Esc bricht ab");
    drawCone(apex);
  }

  function computeBearing(apex, cx, cy, snap) {
    const dx = cx - apex.x;
    const dy = cy - apex.y;
    let b = (Math.atan2(dx, -dy) * 180) / Math.PI;
    b = (b + 360) % 360;
    if (snap) b = Math.round(b / 5) * 5;
    else b = Math.round(b);
    return b % 360;
  }

  function onAimMove(e) {
    if (!aiming || !target) return;
    bearing = computeBearing(target.apex, e.clientX, e.clientY, e.shiftKey);
    drawCone(target.apex, { x: e.clientX, y: e.clientY });
  }

  function onAimDown(e) {
    if (!aiming || !target) return;
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    bearing = computeBearing(target.apex, e.clientX, e.clientY, e.shiftKey);
    confirmDirection();
  }

  function onAimKey(e) {
    if (!aiming) return;
    if (e.key === "Escape") {
      closeAiming();
      e.preventDefault();
    }
  }

  function confirmDirection() {
    const id = target.id;
    const value = String(bearing);
    closeAiming();
    if (!pageReady) {
      setToast("iD-Kontext nicht erreichbar — Richtung nicht gesetzt", true);
      return;
    }
    setDirection(id, value)
      .then(() => setToast("✓ Richtung " + value + "° gesetzt"))
      .catch((err) => setToast("Fehler: " + (err && err.message ? err.message : err), true));
  }

  function closeAiming() {
    aiming = false;
    target = null;
    document.removeEventListener("keydown", onAimKey, true);
    if (captureEl) {
      captureEl.remove();
      captureEl = null;
      svgEl = null;
    }
  }

  function pointAt(c, r, b) {
    const rad = (b * Math.PI) / 180;
    return { x: c.x + r * Math.sin(rad), y: c.y - r * Math.cos(rad) };
  }

  function drawCone(apex, cursor) {
    if (!svgEl) return;
    while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);

    const p1 = pointAt(apex, RADIUS, bearing - HALF_ANGLE);
    const p2 = pointAt(apex, RADIUS, bearing + HALF_ANGLE);
    const sector =
      "M" + apex.x.toFixed(1) + " " + apex.y.toFixed(1) +
      "L" + p1.x.toFixed(1) + " " + p1.y.toFixed(1) +
      "A" + RADIUS + " " + RADIUS + " 0 0 1 " + p2.x.toFixed(1) + " " + p2.y.toFixed(1) +
      "Z";

    const sec = document.createElementNS(SVGNS, "path");
    sec.setAttribute("d", sector);
    sec.setAttribute("fill", COLOR);
    sec.setAttribute("fill-opacity", "0.25");
    sec.setAttribute("stroke", COLOR);
    sec.setAttribute("stroke-width", "2");
    sec.setAttribute("stroke-linejoin", "round");
    svgEl.appendChild(sec);

    const tip = cursor || pointAt(apex, RADIUS, bearing);
    const line = document.createElementNS(SVGNS, "line");
    line.setAttribute("x1", apex.x.toFixed(1));
    line.setAttribute("y1", apex.y.toFixed(1));
    line.setAttribute("x2", tip.x.toFixed(1));
    line.setAttribute("y2", tip.y.toFixed(1));
    line.setAttribute("stroke", COLOR);
    line.setAttribute("stroke-width", "2");
    line.setAttribute("stroke-dasharray", "5 4");
    svgEl.appendChild(line);

    const dot = document.createElementNS(SVGNS, "circle");
    dot.setAttribute("cx", apex.x.toFixed(1));
    dot.setAttribute("cy", apex.y.toFixed(1));
    dot.setAttribute("r", "4");
    dot.setAttribute("fill", "#fff");
    dot.setAttribute("stroke", COLOR);
    dot.setAttribute("stroke-width", "2");
    svgEl.appendChild(dot);

    const lp = pointAt(apex, RADIUS + 16, bearing);
    const text = document.createElementNS(SVGNS, "text");
    text.setAttribute("x", lp.x.toFixed(1));
    text.setAttribute("y", lp.y.toFixed(1));
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("dominant-baseline", "middle");
    text.setAttribute("fill", COLOR);
    text.setAttribute("stroke", "#fff");
    text.setAttribute("stroke-width", "3");
    text.setAttribute("paint-order", "stroke");
    text.setAttribute("font-size", "14");
    text.setAttribute("font-weight", "700");
    text.textContent = bearing + "°";
    svgEl.appendChild(text);
  }

  function setDirection(entityId, value) {
    const reqId = "dir-" + ++reqCounter;
    return new Promise((resolve, reject) => {
      pending.set(reqId, { resolve, reject });
      window.postMessage(
        {
          __ost: "ost-set-tags",
          reqId,
          payload: { entityId, tags: { direction: value }, annotation: "Set direction" }
        },
        location.origin
      );
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

  function setToast(msg, isError) {
    const anchor = document.querySelector(".main-map") || document.querySelector("#map") || document.body;
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.id = TOAST_ID;
      anchor.appendChild(toastEl);
    }
    toastEl.textContent = msg || "";
    toastEl.classList.toggle("ost-dir-toast-error", !!isError);
    toastEl.classList.toggle("shown", !!msg);
    if (toastTimer) clearTimeout(toastTimer);

    if (msg && !aiming) {
      toastTimer = setTimeout(() => toastEl && toastEl.classList.remove("shown"), 4000);
    }
  }

  function arrowIcon() {
    return (
      '<svg class="icon operation" viewBox="0 0 16 16" width="20" height="20" aria-hidden="true">' +
      '<path d="M8 1 L13 14 L8 11 L3 14 Z" fill="currentColor"/></svg>'
    );
  }

  function init() {
    window.addEventListener("message", onPageMessage);
    window.postMessage({ __ost: "ost-ping" }, location.origin);

    document.addEventListener("contextmenu", onContextMenu, true);
    watchEditMenu();
    log("ready");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

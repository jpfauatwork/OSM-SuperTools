(function () {
  "use strict";

  const CONTROL_ID = "ost-qf-control";
  const PANE_ID = "ost-qf-pane";
  const MATCH_CLASS = "ost-qf-match";

  let filters = [];
  let listEl = null;
  let paneEl = null;
  let controlEl = null;

  function log(...args) {
    console.log("[OSM SuperTools/QuickFilters]", ...args);
  }
  function warn(...args) {
    console.warn("[OSM SuperTools/QuickFilters]", ...args);
  }

  // --- entity access ------------------------------------------------------
  // iD binds each rendered feature's entity ({id, type, tags, …}) to the DOM
  // element via d3's `__data__`. In Firefox a content script sees the page DOM
  // through an Xray wrapper that hides page-set expandos, so we reach through
  // `wrappedJSObject` to read `__data__`. Falls back to direct access (e.g. in
  // a same-world test harness).
  function getEntity(el) {
    try {
      const w = el.wrappedJSObject;
      if (w && w.__data__) return w.__data__;
    } catch (e) {
      /* wrappedJSObject not available (non-Firefox / test) */
    }
    return el.__data__ || null;
  }

  function getSurface() {
    return document.querySelector(".surface") || document.querySelector("svg.surface");
  }

  // Determine point/line/area from the element's iD render classes.
  function geometryOf(el) {
    const c = el.classList;
    if (c.contains("area")) return "area";
    if (c.contains("line")) return "line";
    if (c.contains("point") || c.contains("vertex")) return "point";
    return null;
  }

  function featureElements(surface) {
    return surface.querySelectorAll(
      "path.line, path.area, g.point, g.vertex, path.point, path.vertex"
    );
  }

  // --- matching -----------------------------------------------------------

  function condMatches(tags, cond) {
    if (!cond.key) return true; // empty condition is ignored
    if (!(cond.key in tags)) return false;
    if (cond.value === "" || cond.value == null) return true; // key present, any value
    return tags[cond.key] === cond.value;
  }

  function entityMatchesFilter(entity, geom, filter) {
    if (filter.geometry && filter.geometry !== "any" && filter.geometry !== geom) {
      return false;
    }
    const tags = entity.tags || {};
    for (const c of filter.present || []) {
      if (c.key && !condMatches(tags, c)) return false;
    }
    for (const c of filter.absent || []) {
      if (c.key && condMatches(tags, c)) return false;
    }
    return true;
  }

  // --- highlighting -------------------------------------------------------

  function clearHighlights(surface) {
    surface.querySelectorAll("." + MATCH_CLASS).forEach((el) => {
      el.classList.remove(MATCH_CLASS);
      el.style.removeProperty("--ost-qf-color");
    });
  }

  function applyHighlights() {
    const surface = getSurface();
    if (!surface) return;

    clearHighlights(surface);

    const active = filters.filter((f) => f.enabled && hasCriteria(f));
    const counts = {};
    active.forEach((f) => (counts[f.id] = new Set()));
    if (active.length === 0) {
      renderList();
      return;
    }

    for (const el of featureElements(surface)) {
      if (el.classList.contains("target")) continue;
      const entity = getEntity(el);
      if (!entity || !entity.tags) continue;
      const geom = geometryOf(el);
      if (!geom) continue;

      for (const f of active) {
        if (entityMatchesFilter(entity, geom, f)) {
          el.classList.add(MATCH_CLASS);
          el.style.setProperty("--ost-qf-color", f.color || "#ff2d95");
          if (entity.id) counts[f.id].add(entity.id);
        }
      }
    }

    for (const f of active) f._count = counts[f.id] ? counts[f.id].size : 0;
    renderList();
  }

  function hasCriteria(f) {
    const present = (f.present || []).some((c) => c.key);
    const absent = (f.absent || []).some((c) => c.key);
    const geom = f.geometry && f.geometry !== "any";
    return present || absent || geom;
  }

  // --- UI: control button + pane -----------------------------------------

  function funnelIconSvg() {
    // Reuse iD's own icon classes so it renders white like the other map
    // controls and adapts to the editor theme.
    return (
      '<svg class="icon light" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path fill="currentColor" d="M3 4h18l-7 8v6l-4 2v-8L3 4z"/></svg>'
    );
  }

  function buildControl(controlsWrap, panesWrap) {
    if (document.getElementById(CONTROL_ID)) return;

    controlEl = document.createElement("div");
    controlEl.className = "map-control ost-qf-map-control";
    controlEl.id = CONTROL_ID;
    controlEl.innerHTML =
      '<button type="button" title="QuickFilters — highlight loaded features" aria-label="QuickFilters">' +
      funnelIconSvg() +
      "</button>";
    controlsWrap.appendChild(controlEl);

    paneEl = document.createElement("div");
    paneEl.className = "fillL map-pane hide ost-qf-pane";
    paneEl.id = PANE_ID;
    paneEl.setAttribute("pane", "ost-qf");
    paneEl.innerHTML =
      '<div class="pane-heading">' +
      "<h2>QuickFilters</h2>" +
      '<button type="button" class="ost-qf-close" title="Close">&times;</button>' +
      "</div>" +
      '<div class="pane-content">' +
      '<ul class="layer-list ost-qf-list"></ul>' +
      '<button type="button" class="ost-qf-manage">Manage filters…</button>' +
      "</div>";
    panesWrap.appendChild(paneEl);

    listEl = paneEl.querySelector(".ost-qf-list");

    controlEl.querySelector("button").addEventListener("click", togglePane);
    paneEl.querySelector(".ost-qf-close").addEventListener("click", () => setPaneShown(false));
    paneEl.querySelector(".ost-qf-manage").addEventListener("click", () => {
      browser.runtime.sendMessage({ type: "open-options", focus: "quickfilters" });
    });

    renderList();
    log("control ready");
  }

  function setPaneShown(shown) {
    if (!paneEl) return;
    paneEl.classList.toggle("hide", !shown);
    paneEl.classList.toggle("shown", shown);
    // Toggle `active` on the button so iD's own `.map-control > button.active`
    // rule (link-colored background) applies, matching the native controls.
    const btn = controlEl && controlEl.querySelector("button");
    if (btn) btn.classList.toggle("active", shown);
  }

  function togglePane() {
    if (!paneEl) return;
    setPaneShown(paneEl.classList.contains("hide"));
  }

  // Builds iD's native `.layer-list` markup (ul > li > label > input + span) so
  // the list is styled identically to the Background pane, plus a per-filter
  // color swatch and a live match count.
  function renderList() {
    if (!listEl) return;
    listEl.innerHTML = "";
    if (filters.length === 0) {
      const li = document.createElement("li");
      li.className = "ost-qf-empty";
      li.textContent = "No filters yet. Click “Manage filters…” to add one.";
      listEl.appendChild(li);
      return;
    }
    for (const f of filters) {
      const li = document.createElement("li");

      const label = document.createElement("label");

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!f.enabled;
      cb.addEventListener("change", () => {
        f.enabled = cb.checked;
        persistEnabledState();
        applyHighlights();
      });

      const span = document.createElement("span");

      const swatch = document.createElement("span");
      swatch.className = "ost-qf-swatch";
      swatch.style.background = f.color || "#ff2d95";

      const name = document.createElement("span");
      name.className = "ost-qf-name";
      name.textContent = f.name || "(unnamed filter)";

      span.append(swatch, name);
      label.append(cb, span);

      const count = document.createElement("span");
      count.className = "ost-qf-count";
      count.textContent = f.enabled && typeof f._count === "number" ? String(f._count) : "";

      li.append(label, count);
      listEl.appendChild(li);
    }
  }

  // Persist the current filter set (only `enabled` ever changes here). We write
  // the whole in-memory array — which is kept in sync with storage via
  // loadFilters + onChanged — so there's no get-modify-set race, and the
  // resulting self-fired onChanged simply re-applies the same state.
  function persistEnabledState() {
    const toStore = filters.map((f) => ({
      id: f.id,
      name: f.name,
      color: f.color,
      geometry: f.geometry,
      enabled: !!f.enabled,
      present: f.present,
      absent: f.absent
    }));
    browser.storage.local.set({ filters: toStore });
  }

  // --- wiring -------------------------------------------------------------

  function normalizeFilter(f) {
    return {
      id: f.id,
      name: f.name || "",
      enabled: !!f.enabled,
      geometry: f.geometry || "any",
      present: Array.isArray(f.present) ? f.present : [],
      absent: Array.isArray(f.absent) ? f.absent : [],
      color: f.color || "#ff2d95"
    };
  }

  function loadFilters() {
    return browser.storage.local.get("filters").then(({ filters: stored }) => {
      filters = (Array.isArray(stored) ? stored : []).map(normalizeFilter);
      renderList();
      applyHighlights();
    });
  }

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.filters) return;
    // Storage is the source of truth (updated by our own toggles and by the
    // options page). Adopt it directly; applyHighlights recomputes match counts.
    filters = (changes.filters.newValue || []).map(normalizeFilter);
    renderList();
    applyHighlights();
  });

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

  // iD rebuilds the surface on pan/zoom/edit, dropping our highlight classes on
  // newly entered elements — reapply (debounced) whenever the surface mutates.
  let applyScheduled = false;
  function observe() {
    const observer = new MutationObserver(() => {
      if (!placeScheduled) {
        placeScheduled = true;
        requestAnimationFrame(() => {
          placeScheduled = false;
          tryPlaceControls();
        });
      }
      if (!applyScheduled) {
        applyScheduled = true;
        setTimeout(() => {
          applyScheduled = false;
          applyHighlights();
        }, 150);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function init() {
    tryPlaceControls();
    loadFilters();
    observe();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

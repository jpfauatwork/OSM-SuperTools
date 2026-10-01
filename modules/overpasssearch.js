(function () {
  "use strict";

  // OverpassSearch: a slim bar at the bottom of the map. Type an Overpass query,
  // run it against the Overpass instance configured in the settings (there is
  // deliberately no default instance), then step through the results like a
  // search: ◀ / ▶ (or F3 / Shift+F3) loads, zooms to and selects each object.
  // The query runs in the background script; loading/selecting goes through the
  // page bridge (ost-map-extent, ost-goto-entity).

  const CONTROL_ID = "ost-ovp-control";
  const BAR_ID = "ost-ovp-bar";
  const STATE_KEY = "overpassSearch";
  const MAX_RESULTS = 10000;

  let controlEl = null;
  let barEl = null;
  let queryEl = null;
  let runBtn = null;
  let prevBtn = null;
  let nextBtn = null;
  let counterEl = null;
  let labelEl = null;
  let statusEl = null;
  let settingsBtn = null;

  // results: [{ id: "w123", label }]
  let results = [];
  let index = -1;
  let running = false;
  let pageReady = false;
  const pending = new Map();
  let reqSeq = 0;

  function log(...args) {
    console.log("[OSM SuperTools/OverpassSearch]", ...args);
  }

  // ---- page bridge -----------------------------------------------------------

  function request(type, payload, timeoutMs) {
    const reqId = "ovp-" + ++reqSeq + "-" + Date.now();
    return new Promise((resolve, reject) => {
      pending.set(reqId, { resolve, reject });
      window.postMessage({ __ost: type, reqId, payload }, location.origin);
      setTimeout(() => {
        if (pending.has(reqId)) {
          pending.delete(reqId);
          reject(new Error("Zeitüberschreitung (keine Antwort aus der Seitenwelt)"));
        }
      }, timeoutMs || 8000);
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

  // ---- query -----------------------------------------------------------------

  // Make a bare query usable: {{bbox}} → current map view, JSON output forced,
  // and an output statement appended when the query has none.
  async function prepareQuery(raw) {
    let q = raw.trim();
    if (/\{\{\s*bbox\s*\}\}/.test(q)) {
      const res = await request("ost-map-extent", {});
      const [w, s, e, n] = res.bbox;
      const bbox = [s, w, n, e].map((v) => v.toFixed(6)).join(",");
      q = q.replace(/\{\{\s*bbox\s*\}\}/g, bbox);
    }
    if (/\[out:\w+\]/.test(q)) q = q.replace(/\[out:\w+\]/, "[out:json]");
    else q = "[out:json][timeout:90];\n" + q;
    if (!/(^|[;\s)])out(\s[^;]*)?;/.test(q)) q += "\nout tags center;";
    return q;
  }

  const MAIN_KEYS = [
    "amenity", "shop", "building", "highway", "leisure", "tourism", "craft", "office",
    "natural", "man_made", "landuse", "emergency", "barrier", "railway", "waterway"
  ];
  const TYPE_PREFIX = { node: "n", way: "w", relation: "r" };

  function elementLabel(el) {
    const t = el.tags || {};
    const main = MAIN_KEYS.filter((k) => k in t).map((k) => `${k}=${t[k]}`)[0] ||
      Object.keys(t).map((k) => `${k}=${t[k]}`)[0] || "";
    const ref = `${el.type}/${el.id}`;
    const name = t.name || (t["addr:street"] ? `${t["addr:street"]} ${t["addr:housenumber"] || ""}`.trim() : "");
    return [name, main, ref].filter(Boolean).join(" · ");
  }

  function overpassError(res) {
    if (res.error === "no-instance") return null;
    if (res.error) return res.error;
    if (res.status === 429) return "Instanz ausgelastet (429 Too Many Requests) — später erneut versuchen.";
    if (res.status === 504) return "Zeitüberschreitung der Instanz (504).";
    if (res.status === 404) {
      return `Endpunkt nicht gefunden (404): ${res.url || "?"} — die URL muss auf /api/interpreter zeigen (Einstellungen).`;
    }
    const msgs = [];
    const re = /<strong[^>]*>\s*Error\s*<\/strong>\s*:?\s*([\s\S]*?)<\/p>/gi;
    let m;
    while ((m = re.exec(res.text || "")) && msgs.length < 3) {
      msgs.push(m[1].replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim());
    }
    return `Overpass-Fehler (HTTP ${res.status || "?"})` + (msgs.length ? ": " + msgs.join(" | ") : "");
  }

  async function runQuery() {
    const raw = queryEl.value;
    if (!raw.trim() || running) return;
    running = true;
    updateUi();
    setStatus("Abfrage läuft…", false);
    try {
      const query = await prepareQuery(raw);
      const res = await browser.runtime.sendMessage({ type: "overpass-query", query });
      if (!res || !res.ok) {
        if (res && res.error === "no-instance") {
          showNoInstance();
          return;
        }
        throw new Error(overpassError(res || {}) || "Keine Antwort");
      }
      let data;
      try {
        data = JSON.parse(res.text);
      } catch (e) {
        throw new Error("Antwort ist kein JSON — gibt die Instanz [out:json] zurück?");
      }
      const seen = new Set();
      const list = [];
      for (const el of data.elements || []) {
        const p = TYPE_PREFIX[el.type];
        if (!p) continue;
        const id = p + el.id;
        if (seen.has(id)) continue;
        seen.add(id);
        list.push({ id, label: elementLabel(el) });
        if (list.length >= MAX_RESULTS) break;
      }
      results = list;
      index = -1;
      const remark = data.remark ? ` Hinweis der Instanz: ${data.remark}` : "";
      if (!list.length) {
        setStatus("Keine Treffer." + remark, !!remark);
        saveState();
        updateUi();
        return;
      }
      setStatus(
        `${list.length}${list.length >= MAX_RESULTS ? "+ (gekürzt)" : ""} Treffer.` + remark,
        !!remark
      );
      goTo(0);
    } catch (e) {
      setStatus(e.message, true);
    } finally {
      running = false;
      updateUi();
    }
  }

  // ---- navigation ------------------------------------------------------------

  function goTo(i) {
    if (!results.length) return;
    index = (i + results.length) % results.length;
    saveState();
    updateUi();
    if (!pageReady) {
      setStatus("iD-Editor noch nicht bereit — kurz warten und erneut versuchen.", true);
      return;
    }
    const r = results[index];
    const shown = index;
    labelEl.classList.add("ost-ovp-loading");
    request("ost-goto-entity", { id: r.id }, 20000)
      .then((res) => {
        if (shown !== index || res.stale) return;
        setStatus("", false);
      })
      .catch((e) => {
        if (shown !== index) return;
        setStatus(`${r.label}: ${e.message}`, true);
      })
      .finally(() => {
        if (shown === index) labelEl.classList.remove("ost-ovp-loading");
      });
  }

  function step(delta) {
    if (!results.length) return;
    goTo(index < 0 ? 0 : index + delta);
  }

  // ---- state -----------------------------------------------------------------

  function saveState() {
    const state = { query: queryEl ? queryEl.value : "", results, index };
    browser.storage.local.set({ [STATE_KEY]: state }).catch(() => {});
  }

  async function restoreState() {
    try {
      const { [STATE_KEY]: s } = await browser.storage.local.get(STATE_KEY);
      if (!s) return;
      if (typeof s.query === "string") queryEl.value = s.query;
      if (Array.isArray(s.results)) results = s.results.filter((r) => r && typeof r.id === "string");
      index = Number.isInteger(s.index) && s.index < results.length ? s.index : -1;
      autoGrow();
      updateUi();
    } catch (e) {
      log("restore failed", e);
    }
  }

  // ---- UI --------------------------------------------------------------------

  function setStatus(msg, isError) {
    if (!statusEl) return;
    statusEl.textContent = msg || "";
    statusEl.hidden = !msg;
    statusEl.classList.toggle("ost-ovp-error", !!isError);
    settingsBtn.hidden = true;
  }

  function showNoInstance() {
    setStatus("Keine Overpass-Instanz eingestellt. Bitte bewusst eine in den Einstellungen eintragen.", true);
    settingsBtn.hidden = false;
  }

  function updateUi() {
    if (!barEl) return;
    const has = results.length > 0;
    runBtn.disabled = running;
    runBtn.textContent = running ? "…" : "Suchen";
    prevBtn.disabled = !has;
    nextBtn.disabled = !has;
    counterEl.textContent = has ? `${index < 0 ? "–" : index + 1} / ${results.length}` : "0 / 0";
    const cur = has && index >= 0 ? results[index] : null;
    labelEl.textContent = cur ? cur.label : "";
    labelEl.title = cur ? cur.label + "\nKlick: erneut hinspringen" : "";
  }

  function autoGrow() {
    if (!queryEl) return;
    // An empty field would grow to fit its (wrapping) placeholder.
    queryEl.style.height = "auto";
    queryEl.style.height = queryEl.value ? Math.min(queryEl.scrollHeight + 2, 180) + "px" : "";
  }

  function isOpen() {
    return !!barEl && !barEl.hidden;
  }

  function setOpen(open) {
    if (!barEl) return;
    barEl.hidden = !open;
    controlEl.querySelector("button").classList.toggle("active", open);
    if (open) {
      autoGrow();
      queryEl.focus();
    }
  }

  function iconSvg() {
    return (
      '<svg class="icon light" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path fill="currentColor" d="M10 3a7 7 0 0 1 5.6 11.2l5.1 5.1-1.4 1.4-5.1-5.1A7 7 0 1 1 10 3zm0 2a5 5 0 1 0 0 10 5 5 0 0 0 0-10z"/>' +
      '<path fill="currentColor" d="M7 8h6v1.5H7zM7 10.75h4v1.5H7z"/>' +
      "</svg>"
    );
  }

  function build(controlsWrap, barParent) {
    if (!OST.claimControl([CONTROL_ID, BAR_ID], controlEl)) return;

    controlEl = document.createElement("div");
    controlEl.className = "map-control ost-ovp-map-control";
    controlEl.id = CONTROL_ID;
    controlEl.innerHTML =
      '<button type="button" title="Overpass-Suche — Treffer einer Overpass-Abfrage nacheinander abarbeiten" aria-label="Overpass-Suche">' +
      iconSvg() +
      "</button>";
    controlsWrap.appendChild(controlEl);

    barEl = document.createElement("div");
    barEl.id = BAR_ID;
    barEl.className = "ost-ovp-bar";
    barEl.hidden = true;
    barEl.innerHTML =
      '<div class="ost-ovp-row">' +
      '<textarea class="ost-ovp-query" rows="1" spellcheck="false" ' +
      'title="Enter = Suchen, Shift+Enter = neue Zeile. {{bbox}} = aktueller Kartenausschnitt. ' +
      '[out:json] und eine out-Anweisung werden ergänzt, falls sie fehlen." ' +
      'placeholder="z.B. nwr[building][!&quot;addr:housenumber&quot;]({{bbox}});"></textarea>' +
      '<button type="button" class="ost-ovp-btn ost-ovp-run">Suchen</button>' +
      '<button type="button" class="ost-ovp-close" title="Schließen (Ergebnisse bleiben erhalten)">&times;</button>' +
      "</div>" +
      '<div class="ost-ovp-row ost-ovp-nav">' +
      '<button type="button" class="ost-ovp-btn ost-ovp-prev" title="Vorheriger Treffer (Shift+F3)">&#9664;</button>' +
      '<span class="ost-ovp-counter">0 / 0</span>' +
      '<button type="button" class="ost-ovp-btn ost-ovp-next" title="Nächster Treffer (F3)">&#9654;</button>' +
      '<button type="button" class="ost-ovp-label"></button>' +
      "</div>" +
      '<div class="ost-ovp-row ost-ovp-status-row">' +
      '<span class="ost-ovp-status" hidden></span>' +
      '<button type="button" class="ost-ovp-btn ost-ovp-settings" hidden>Einstellungen öffnen</button>' +
      "</div>";
    barParent.appendChild(barEl);

    queryEl = barEl.querySelector(".ost-ovp-query");
    runBtn = barEl.querySelector(".ost-ovp-run");
    prevBtn = barEl.querySelector(".ost-ovp-prev");
    nextBtn = barEl.querySelector(".ost-ovp-next");
    counterEl = barEl.querySelector(".ost-ovp-counter");
    labelEl = barEl.querySelector(".ost-ovp-label");
    statusEl = barEl.querySelector(".ost-ovp-status");
    settingsBtn = barEl.querySelector(".ost-ovp-settings");

    controlEl.querySelector("button").addEventListener("click", () => setOpen(!isOpen()));
    barEl.querySelector(".ost-ovp-close").addEventListener("click", () => setOpen(false));
    runBtn.addEventListener("click", runQuery);
    prevBtn.addEventListener("click", () => step(-1));
    nextBtn.addEventListener("click", () => step(1));
    labelEl.addEventListener("click", () => {
      if (index >= 0) goTo(index);
    });
    settingsBtn.addEventListener("click", () =>
      browser.runtime.sendMessage({ type: "open-options", focus: "overpasssearch" })
    );

    queryEl.addEventListener("input", () => {
      autoGrow();
      saveState();
    });
    // Keep iD's keyboard shortcuts (W, A, 1, 2, …) out of the query field.
    queryEl.addEventListener("keydown", (e) => {
      if (e.key === "F3") return; // handled by the global listener
      e.stopPropagation();
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        runQuery();
      } else if (e.key === "Escape") {
        queryEl.blur();
      }
    });

    updateUi();
    restoreState();
    log("control ready");
  }

  // F3 / Shift+F3 step through the results while the bar is open — also while
  // typing in iD's tag editor, so you can fill in a tag and move on.
  function onKeyDown(e) {
    if (e.key !== "F3" || !isOpen() || !results.length) return;
    e.preventDefault();
    e.stopPropagation();
    // Let iD commit a field that is being edited before the selection changes.
    const active = document.activeElement;
    if (active && active !== queryEl && typeof active.blur === "function") active.blur();
    step(e.shiftKey ? -1 : 1);
  }

  function tryPlace() {
    const controlsWrap = document.querySelector(".map-controls");
    const barParent = document.querySelector(".main-content");
    if (controlsWrap && barParent) {
      build(controlsWrap, barParent);
      return true;
    }
    return false;
  }

  function init() {
    window.addEventListener("message", onPageMessage);
    window.addEventListener("keydown", onKeyDown, true);
    window.postMessage({ __ost: "ost-ping" }, location.origin);
    let pings = 0;
    const pingTimer = setInterval(() => {
      if (pageReady || ++pings > 6) {
        clearInterval(pingTimer);
        return;
      }
      window.postMessage({ __ost: "ost-ping" }, location.origin);
    }, 600);

    tryPlace();
    let placeScheduled = false;
    const observer = new MutationObserver(() => {
      if (placeScheduled) return;
      placeScheduled = true;
      requestAnimationFrame(() => {
        placeScheduled = false;
        tryPlace();
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

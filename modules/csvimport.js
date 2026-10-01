(function () {
  "use strict";

  // CsvImport: read a semicolon-separated list of nodes/ways (format in the
  // README), preview it on iD's Custom Map Data layer, then create the selected
  // rows as new, editable features in one undo step and let the user step
  // through them for review before uploading. A row can also name an existing
  // object (way/123, node/5, relation/9) and patch its tags: the given tags are
  // set/overwritten, all others stay.

  const CONTROL_ID = "ost-csv-control";
  const PANE_ID = "ost-csv-pane";
  const MAX_BYTES = 4 * 1024 * 1024;

  let paneEl = null;
  let controlEl = null;
  let paneCtl = null;
  let listEl = null;
  let statusEl = null;
  let textEl = null;
  let importBtn = null;
  let discardBtn = null;
  let selectAllBtn = null;

  // parsed rows: { line, type, coords, closed, tags, error, checked, id }
  // plus for type "modify": osmId (iD id, e.g. "w123"), current (loaded tags or
  // null), loadError, status (after import: changed|unchanged|missing)
  let rows = [];
  let imported = false;
  let pageReady = false;
  const pending = new Map();
  let reqSeq = 0;

  function log(...args) {
    console.log("[OSM SuperTools/CsvImport]", ...args);
  }

  // ---- parsing ---------------------------------------------------------------

  // RFC 4180-style splitter with ';' as delimiter. Quoted fields may contain ';'
  // and doubled quotes. Returns [{ line, fields }] for every physical line.
  function splitCsv(text) {
    const out = [];
    let fields = [];
    let field = "";
    let quoted = false;
    let line = 1;
    let startLine = 1;
    text = text.replace(/^﻿/, "");
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            quoted = false;
          }
        } else {
          if (ch === "\n") line++;
          field += ch;
        }
        continue;
      }
      if (ch === '"' && field.trim() === "") {
        field = "";
        quoted = true;
      } else if (ch === ";") {
        fields.push(field);
        field = "";
      } else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        fields.push(field);
        out.push({ line: startLine, fields });
        fields = [];
        field = "";
        line++;
        startLine = line;
      } else {
        field += ch;
      }
    }
    fields.push(field);
    out.push({ line: startLine, fields });
    return out;
  }

  const TYPE_ALIASES = {
    node: "node",
    point: "node",
    way: "way",
    line: "way",
    area: "area"
  };

  function parseCoords(raw) {
    const parts = raw.trim().split(/[\s|]+/).filter(Boolean);
    const coords = [];
    for (const p of parts) {
      const m = p.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
      if (!m) throw new Error(`Koordinate „${p}“ ist nicht im Format lat,lon`);
      const lat = parseFloat(m[1]);
      const lon = parseFloat(m[2]);
      if (lat < -90 || lat > 90) throw new Error(`Breite ${lat} außerhalb von -90…90`);
      if (lon < -180 || lon > 180) throw new Error(`Länge ${lon} außerhalb von -180…180`);
      coords.push([lon, lat]);
    }
    return coords;
  }

  const OSM_TYPES = { node: "n", way: "w", relation: "r" };
  const OSM_NAMES = { n: "node", w: "way", r: "relation" };

  // "way/123", "node/42", "relation/9" → iD id ("w123", "n42", "r9"), else null.
  function parseOsmRef(raw) {
    const m = raw.match(/^(node|way|relation)\/(\d+)$/);
    return m ? OSM_TYPES[m[1]] + m[2] : null;
  }

  function osmRefLabel(osmId) {
    return OSM_NAMES[osmId[0]] + "/" + osmId.slice(1);
  }

  function sameLoc(a, b) {
    return a[0] === b[0] && a[1] === b[1];
  }

  function parseRow(line, fields) {
    const row = { line, type: null, coords: [], closed: false, tags: {}, error: null, checked: true, id: null };
    try {
      const rawType = (fields[0] || "").trim().toLowerCase();
      const osmId = parseOsmRef(rawType);
      const type = osmId ? "modify" : TYPE_ALIASES[rawType];
      if (!type) {
        throw new Error(
          `Unbekannter Typ „${fields[0].trim()}“ (erlaubt: node, way, area oder node/<id>, way/<id>, relation/<id>)`
        );
      }

      let coords;
      if (type === "modify") {
        // The object is identified by its ID alone; anything in the
        // coordinate field is ignored (no preview point, no zoom target).
        row.type = "modify";
        row.osmId = osmId;
        row.current = null;
        row.loadError = null;
        row.status = null;
        coords = [];
      } else {
        if (fields.length < 2 || !fields[1].trim()) throw new Error("Koordinaten fehlen");
        coords = parseCoords(fields[1]);
        if (type === "node") {
          if (coords.length !== 1) throw new Error(`node braucht genau 1 Koordinate, hat ${coords.length}`);
          row.type = "node";
        } else {
          const closedByCoords = coords.length > 2 && sameLoc(coords[0], coords[coords.length - 1]);
          if (closedByCoords) coords = coords.slice(0, -1);
          row.closed = type === "area" || closedByCoords;
          const min = row.closed ? 3 : 2;
          if (coords.length < min) {
            throw new Error(`${type} braucht mindestens ${min} verschiedene Koordinaten`);
          }
          row.type = "way";
        }
      }
      row.coords = coords;

      for (const rawTag of fields.slice(2)) {
        const t = rawTag.trim();
        if (!t) continue;
        const eq = t.indexOf("=");
        if (eq <= 0) throw new Error(`Tag „${t}“ ist nicht im Format key=value`);
        const key = t.slice(0, eq).trim();
        const value = t.slice(eq + 1).trim();
        if (!value) throw new Error(`Tag „${key}“ hat keinen Wert`);
        if (key in row.tags) throw new Error(`Tag „${key}“ doppelt`);
        if (key.length > 255 || value.length > 255) throw new Error(`Tag „${key}“ ist länger als 255 Zeichen`);
        row.tags[key] = value;
      }
      if (!Object.keys(row.tags).length) throw new Error("Keine Tags angegeben");
    } catch (e) {
      row.error = e.message;
      row.checked = false;
    }
    return row;
  }

  function parseCsv(text) {
    const out = [];
    for (const { line, fields } of splitCsv(text)) {
      const first = (fields[0] || "").trim();
      if (fields.every((f) => !f.trim())) continue;
      if (first.startsWith("#") || first.startsWith("```")) continue;
      if (first.toLowerCase() === "type" && out.length === 0) continue; // header row
      out.push(parseRow(line, fields));
    }
    return out;
  }

  // ---- page bridge -----------------------------------------------------------

  function request(type, payload, timeoutMs) {
    const reqId = "csv-" + ++reqSeq + "-" + Date.now();
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

  // ---- preview / import ------------------------------------------------------

  function rowGeometry(r) {
    const ll = r.coords.map((c) => [c[0], c[1]]);
    if (r.type === "node") return { type: "Point", coordinates: ll[0] };
    if (r.closed) return { type: "Polygon", coordinates: [ll.concat([ll[0]])] };
    return { type: "LineString", coordinates: ll };
  }

  function bboxOf(list) {
    let b = null;
    for (const r of list) {
      for (const [lon, lat] of r.coords) {
        if (!b) b = [lon, lat, lon, lat];
        else {
          b[0] = Math.min(b[0], lon);
          b[1] = Math.min(b[1], lat);
          b[2] = Math.max(b[2], lon);
          b[3] = Math.max(b[3], lat);
        }
      }
    }
    return b;
  }

  function checkedRows() {
    return rows.filter((r) => !r.error && r.checked && !isNoChange(r));
  }

  // Tag keys of a modify row whose value differs from the loaded object.
  function changedKeys(r) {
    if (!r.current) return Object.keys(r.tags);
    return Object.keys(r.tags).filter((k) => r.current[k] !== r.tags[k]);
  }

  function isNoChange(r) {
    if (r.type !== "modify") return false;
    if (r.status) return r.status === "unchanged";
    return !!r.current && changedKeys(r).length === 0;
  }

  // Fetch the existing objects of all modify rows (in the page world, via iD)
  // and remember their current tags for the old → new display.
  function loadExisting(list) {
    const ids = Array.from(new Set(list.map((r) => r.osmId)));
    if (!ids.length) return Promise.resolve();
    return request("ost-load-entities", { ids }, 30000).then((res) => {
      for (const r of list) {
        const x = res.results[r.osmId];
        r.current = x && x.ok ? x.tags : null;
        r.loadError = x && !x.ok ? x.error : null;
      }
    });
  }

  function modifyRows(list) {
    return list.filter((r) => !r.error && r.type === "modify");
  }

  function updatePreview(zoom) {
    if (imported) return Promise.resolve();
    const list = checkedRows();
    const geojson = {
      type: "FeatureCollection",
      features: list.filter((r) => r.coords.length).map((r) => ({
        type: "Feature",
        id: "csv-line-" + r.line,
        properties: Object.assign({}, r.tags),
        geometry: rowGeometry(r)
      }))
    };
    return request("ost-preview", { geojson, bbox: zoom ? bboxOf(list) : null }).catch((e) =>
      setStatus("Vorschau fehlgeschlagen: " + e.message, true)
    );
  }

  function clearPreview() {
    return request("ost-preview", { geojson: null }).catch(() => {});
  }

  function loadText(text) {
    rows = parseCsv(text);
    imported = false;
    const ok = rows.filter((r) => !r.error).length;
    const bad = rows.length - ok;
    if (!rows.length) {
      setStatus("Keine Einträge gefunden.", true);
    } else {
      setStatus(
        `${ok} Eintrag${ok === 1 ? "" : "e"} gelesen` +
          (bad ? `, ${bad} mit Fehler (werden übersprungen)` : "") +
          ". Vorschau auf der Karte — prüfen, dann importieren.",
        bad > 0
      );
    }
    renderList();
    if (ok) updatePreview(true);
    else clearPreview();

    const mods = modifyRows(rows);
    if (mods.length) {
      const loadedFor = rows;
      loadExisting(mods)
        .then(() => {
          if (rows === loadedFor && !imported) renderList();
        })
        .catch((e) => setStatus("Bestehende Objekte konnten nicht geladen werden: " + e.message, true));
    }
  }

  function doImport() {
    const list = checkedRows();
    if (!list.length || imported) return;
    if (!pageReady) {
      setStatus("iD-Editor noch nicht bereit — kurz warten und erneut versuchen.", true);
      return;
    }
    importBtn.disabled = true;
    const items = list.map((r) =>
      r.type === "modify"
        ? { type: "modify", id: r.osmId, tags: r.tags }
        : { type: r.type, coords: r.coords, closed: r.closed, tags: r.tags }
    );
    const mods = modifyRows(list);
    if (mods.length) setStatus(`Lade ${mods.length} bestehende${mods.length === 1 ? "s" : ""} Objekt(e)…`, false);
    loadExisting(mods)
      .then(clearPreview)
      .then(() =>
        request("ost-import-entities", { items })
      )
      .then((res) => {
        const count = { created: 0, changed: 0, unchanged: 0, missing: 0 };
        list.forEach((r, i) => {
          const x = res.results[i];
          count[x.status]++;
          if (r.type === "modify") {
            r.status = x.status;
            if (x.status === "missing") {
              r.error = `${osmRefLabel(r.osmId)} ${r.loadError || "nicht ladbar"} — übersprungen`;
            } else {
              r.id = x.id;
            }
          } else {
            r.id = x.id;
          }
        });
        imported = true;
        const parts = [];
        if (count.created) parts.push(`${count.created} angelegt`);
        if (count.changed) parts.push(`${count.changed} geändert`);
        if (count.unchanged) parts.push(`${count.unchanged} ohne Änderung`);
        if (count.missing) parts.push(`${count.missing} nicht ladbar`);
        const applied = count.created + count.changed;
        setStatus(
          (parts.join(", ") || "Nichts zu tun") +
            "." +
            (applied
              ? " Strg+Z macht alles rückgängig. Klick auf einen Eintrag wählt ihn zur Prüfung aus; " +
                "hochladen wie gewohnt über „Speichern“."
              : ""),
          count.missing > 0
        );
        renderList();
        const reviewIds = reviewableIds();
        if (reviewIds.length) request("ost-focus", { ids: reviewIds }).catch(() => {});
      })
      .catch((e) => {
        setStatus("Import fehlgeschlagen: " + e.message, true);
        renderList();
        updatePreview(false);
      });
  }

  function discard() {
    rows = [];
    imported = false;
    if (textEl) textEl.value = "";
    setStatus("", false);
    renderList();
    clearPreview();
  }

  // Ids of everything this import created or changed.
  function reviewableIds() {
    return rows.filter((r) => r.id && r.status !== "unchanged").map((r) => r.id);
  }

  function focusRow(r) {
    let payload;
    if (r.id) payload = { ids: [r.id] };
    else if (r.type === "modify" && r.current) payload = { ids: [r.osmId], select: false };
    else if (r.coords.length) payload = { bbox: bboxOf([r]) };
    else {
      setStatus(`${osmRefLabel(r.osmId)} ist noch nicht geladen.`, true);
      return;
    }
    request("ost-focus", payload).catch((e) => setStatus(e.message, true));
  }

  // ---- UI --------------------------------------------------------------------

  function setStatus(msg, isError) {
    if (!statusEl) return;
    statusEl.textContent = msg || "";
    statusEl.classList.toggle("ost-csv-error", !!isError);
  }

  function rowLabel(r) {
    const t = r.tags;
    const main =
      ["amenity", "shop", "highway", "building", "leisure", "tourism", "natural", "man_made", "emergency", "barrier"]
        .filter((k) => k in t)
        .map((k) => `${k}=${t[k]}`)[0] || Object.keys(t).map((k) => `${k}=${t[k]}`)[0] || "";
    return t.name ? `${t.name} (${main})` : main;
  }

  function modifyLabel(r) {
    const ref = osmRefLabel(r.osmId);
    if (r.status === "unchanged" || (!r.status && isNoChange(r))) return `${ref}: keine Änderung`;
    const keys = changedKeys(r);
    const parts = keys.map((k) => {
      const old = r.current && r.current[k];
      return old ? `${k}: ${old} → ${r.tags[k]}` : `${k}=${r.tags[k]}`;
    });
    return `ändert ${ref}: ${parts.join(", ")}`;
  }

  function modifyTitle(r) {
    const lines = Object.keys(r.tags).map((k) => {
      const old = r.current ? r.current[k] : undefined;
      if (!r.current) return `${k}=${r.tags[k]}`;
      if (old === r.tags[k]) return `${k}=${old} (unverändert)`;
      return old ? `${k}: ${old} → ${r.tags[k]}` : `${k}=${r.tags[k]} (neu)`;
    });
    let state;
    if (r.current) state = "geladen";
    else if (r.loadError) state = `nicht ladbar: ${r.loadError}`;
    else state = "noch nicht geladen";
    return `Zeile ${r.line} · ändert ${osmRefLabel(r.osmId)} (${state})\n` + lines.join("\n");
  }

  function renderList() {
    if (!listEl) return;
    listEl.textContent = "";
    for (const r of rows) {
      const li = document.createElement("li");
      const noChange = isNoChange(r);
      li.className =
        "ost-csv-row" +
        (r.error ? " ost-csv-row-error" : "") +
        (r.id && !noChange ? " ost-csv-row-done" : "") +
        (r.type === "modify" ? " ost-csv-row-modify" : "") +
        (noChange ? " ost-csv-row-same" : "") +
        (r.loadError && !r.error ? " ost-csv-row-warn" : "");

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = r.checked && !noChange && !r.error;
      cb.disabled = !!r.error || imported || noChange;
      cb.title = "In den Import aufnehmen";
      cb.addEventListener("change", () => {
        r.checked = cb.checked;
        updateButtons();
        updatePreview(false);
      });

      const kind = document.createElement("span");
      kind.className = "ost-csv-kind";
      kind.textContent =
        r.type === "modify" ? "Ä" : r.type === "node" ? "N" : r.closed ? "A" : r.type === "way" ? "W" : "?";
      if (r.type === "modify") kind.title = "Ändert ein bestehendes Objekt";

      const text = document.createElement("button");
      text.type = "button";
      text.className = "ost-csv-text";
      if (r.error) {
        text.textContent = `Zeile ${r.line}: ${r.error}`;
        text.disabled = true;
      } else if (r.type === "modify") {
        text.textContent = modifyLabel(r) + (r.loadError ? ` (${r.loadError})` : "");
        text.title =
          modifyTitle(r) +
          (imported && !r.id ? "\n(nicht angewendet)" : "\n\nKlick: dorthin zoomen" + (r.id ? " und auswählen" : ""));
        text.addEventListener("click", () => focusRow(r));
      } else {
        text.textContent = rowLabel(r);
        text.title =
          `Zeile ${r.line} · ${r.type === "node" ? "Punkt" : r.closed ? "Fläche" : "Linie"}\n` +
          Object.keys(r.tags)
            .map((k) => `${k}=${r.tags[k]}`)
            .join("\n") +
          (imported && !r.id ? "\n(nicht importiert)" : "\n\nKlick: dorthin zoomen" + (r.id ? " und auswählen" : ""));
        text.addEventListener("click", () => focusRow(r));
      }

      li.append(cb, kind, text);
      listEl.appendChild(li);
    }
    updateButtons();
  }

  function updateButtons() {
    if (!importBtn) return;
    const n = checkedRows().length;
    importBtn.textContent = imported ? "Importiert" : `Importieren (${n})`;
    importBtn.disabled = imported || n === 0;
    discardBtn.hidden = rows.length === 0;
    discardBtn.textContent = imported ? "Liste leeren" : "Verwerfen";
    selectAllBtn.hidden = !imported;
  }

  function readFile(file) {
    if (file.size > MAX_BYTES) {
      setStatus(`${file.name} ist zu groß (max. 4 MB).`, true);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (textEl) textEl.value = String(reader.result || "");
      loadText(String(reader.result || ""));
    };
    reader.onerror = () => setStatus(`${file.name} konnte nicht gelesen werden.`, true);
    reader.readAsText(file, "utf-8");
  }

  function tableIconSvg() {
    return (
      '<svg class="icon light" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path fill="currentColor" d="M3 4h18v16H3V4zm2 2v3h4V6H5zm6 0v3h8V6h-8zM5 11v3h4v-3H5zm6 0v3h8v-3h-8zM5 16v2h4v-2H5zm6 0v2h8v-2h-8z"/>' +
      "</svg>"
    );
  }

  function buildControl(controlsWrap, panesWrap) {
    if (!OST.claimControl([CONTROL_ID, PANE_ID], controlEl)) return;

    controlEl = document.createElement("div");
    controlEl.className = "map-control ost-csv-map-control";
    controlEl.id = CONTROL_ID;
    controlEl.innerHTML =
      '<button type="button" title="CSV-Import — Objekte aus einer CSV anlegen oder ändern" aria-label="CSV-Import">' +
      tableIconSvg() +
      "</button>";
    controlsWrap.appendChild(controlEl);

    paneEl = document.createElement("div");
    paneEl.className = "fillL map-pane hide ost-csv-pane";
    paneEl.id = PANE_ID;
    paneEl.setAttribute("pane", "ost-csv");
    paneEl.innerHTML =
      '<div class="pane-heading">' +
      "<h2>CSV-Import</h2>" +
      '<button type="button" class="ost-csv-close" title="Schließen">&times;</button>' +
      "</div>" +
      '<div class="pane-content">' +
      '<label class="ost-csv-upload">CSV-Datei wählen…' +
      '<input type="file" accept=".csv,.txt,text/csv,text/plain" hidden>' +
      "</label>" +
      '<textarea class="ost-csv-text-input" rows="4" spellcheck="false" ' +
      'placeholder="…oder CSV hier einfügen, z.B.&#10;node;52.3759,9.7320;amenity=bench"></textarea>' +
      '<button type="button" class="ost-csv-btn ost-csv-parse">Einlesen</button>' +
      '<p class="ost-csv-status"></p>' +
      '<ul class="ost-csv-list"></ul>' +
      '<div class="ost-csv-actions">' +
      '<button type="button" class="ost-csv-btn ost-csv-import" disabled>Importieren (0)</button>' +
      '<button type="button" class="ost-csv-btn ost-csv-selectall" hidden>Alle auswählen</button>' +
      '<button type="button" class="ost-csv-btn ost-csv-discard" hidden>Verwerfen</button>' +
      "</div>" +
      "</div>";
    panesWrap.appendChild(paneEl);

    listEl = paneEl.querySelector(".ost-csv-list");
    statusEl = paneEl.querySelector(".ost-csv-status");
    textEl = paneEl.querySelector(".ost-csv-text-input");
    importBtn = paneEl.querySelector(".ost-csv-import");
    discardBtn = paneEl.querySelector(".ost-csv-discard");
    selectAllBtn = paneEl.querySelector(".ost-csv-selectall");

    paneCtl = OST.registerMapPane(paneEl, controlEl.querySelector("button"));
    controlEl.querySelector("button").addEventListener("click", () => paneCtl.toggle());
    paneEl.querySelector(".ost-csv-close").addEventListener("click", () => paneCtl.setShown(false));

    const fileInput = paneEl.querySelector('input[type="file"]');
    fileInput.addEventListener("change", () => {
      if (fileInput.files && fileInput.files[0]) readFile(fileInput.files[0]);
      fileInput.value = "";
    });
    paneEl.querySelector(".ost-csv-parse").addEventListener("click", () => loadText(textEl.value));
    // Keep iD's keyboard shortcuts (W, A, 1, 2, …) out of the textarea.
    textEl.addEventListener("keydown", (e) => e.stopPropagation());
    importBtn.addEventListener("click", doImport);
    discardBtn.addEventListener("click", discard);
    selectAllBtn.addEventListener("click", () => {
      const ids = reviewableIds();
      if (ids.length) request("ost-focus", { ids }).catch((e) => setStatus(e.message, true));
    });

    renderList();
    log("control ready");
  }

  function tryPlaceControls() {
    const controlsWrap = document.querySelector(".map-controls");
    const panesWrap = document.querySelector(".map-panes");
    if (controlsWrap && panesWrap) {
      buildControl(controlsWrap, panesWrap);
      return true;
    }
    return false;
  }

  function init() {
    window.addEventListener("message", onPageMessage);
    window.postMessage({ __ost: "ost-ping" }, location.origin);
    let pings = 0;
    const pingTimer = setInterval(() => {
      if (pageReady || ++pings > 6) {
        clearInterval(pingTimer);
        return;
      }
      window.postMessage({ __ost: "ost-ping" }, location.origin);
    }, 600);

    tryPlaceControls();
    let placeScheduled = false;
    const observer = new MutationObserver(() => {
      if (placeScheduled) return;
      placeScheduled = true;
      requestAnimationFrame(() => {
        placeScheduled = false;
        tryPlaceControls();
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

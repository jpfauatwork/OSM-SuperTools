(function () {
  "use strict";

  function getEntity(el) {
    try {
      const w = el.wrappedJSObject;
      if (w && w.__data__) return w.__data__;
    } catch (e) {

    }
    return el.__data__ || null;
  }

  function getSurface() {
    return document.querySelector(".surface") || document.querySelector("svg.surface");
  }

  function getRawTagContainer() {
    return (
      document.querySelector(".entity-editor-pane .raw-tag-editor") ||
      document.querySelector(".raw-tag-editor")
    );
  }

  function ensureTagsExpanded(container) {
    const details = container.querySelector("details.disclosure-wrap");
    if (details && !details.open) {
      const summary = details.querySelector("summary.hide-toggle");
      if (summary) summary.click();
    }
  }

  function getRows(container) {
    return Array.from(container.querySelectorAll(".tag-row"));
  }

  function getKeyInput(row) {
    return row.querySelector(".key-wrap input.key") || row.querySelector("input.key");
  }

  function getValueInput(row) {
    return row.querySelector(".value-wrap input.value") || row.querySelector("input.value");
  }

  function setRawValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, value);
  }

  function setValueAndCommit(input, value) {
    setRawValue(input, value);
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function findRowByKey(container, key) {
    for (const row of getRows(container)) {
      const keyInput = getKeyInput(row);
      if (keyInput && keyInput.value === key) return row;
    }
    return null;
  }

  function findBlankRow(container) {
    const rows = getRows(container);
    return rows.find((r) => r.classList.contains("add-tag")) || rows[rows.length - 1] || null;
  }

  function applyOneTag(key, value) {
    const container = getRawTagContainer();
    if (!container) return false;

    ensureTagsExpanded(container);

    const existingRow = findRowByKey(container, key);
    if (existingRow) {
      const valueInput = getValueInput(existingRow);
      if (!valueInput) return false;
      setValueAndCommit(valueInput, value);
      return true;
    }

    const blankRow = findBlankRow(container);
    if (!blankRow) return false;
    const keyInput = getKeyInput(blankRow);
    const valueInput = getValueInput(blankRow);
    if (!keyInput || !valueInput) return false;
    setRawValue(valueInput, value);
    setValueAndCommit(keyInput, key);
    return true;
  }

  // Custom map panes (QuickFilters, Overlays, CSV import) live next to iD's own
  // panes in .map-panes. iD's ui.togglePanes() only flips classes on the panes
  // it hides, but also leaves an inline `right: -500px` on them — so a custom
  // pane that iD once closed stays off-screen when we simply flip it back to
  // .shown. Showing a pane therefore resets the inline offset and closes every
  // other pane (native ones included) the same way iD does.
  const registeredPanes = [];

  function paneSide() {
    const dir = document.documentElement.getAttribute("dir") || document.body.getAttribute("dir");
    return dir === "rtl" ? "left" : "right";
  }

  function syncPaneButtons() {
    for (const p of registeredPanes) {
      p.button.classList.toggle("active", p.pane.classList.contains("shown"));
    }
  }

  function setMapPaneShown(pane, shown) {
    const side = paneSide();
    if (shown) {
      document.querySelectorAll(".map-pane.shown").forEach((other) => {
        if (other === pane) return;
        other.classList.remove("shown");
        other.classList.add("hide");
        other.style[side] = "-500px";
      });
      document
        .querySelectorAll(".map-pane-control button.active")
        .forEach((b) => b.classList.remove("active"));
      pane.style[side] = "0px";
      pane.classList.remove("hide");
      pane.classList.add("shown");
    } else {
      pane.classList.remove("shown");
      pane.classList.add("hide");
    }
    syncPaneButtons();
  }

  function registerMapPane(pane, button) {
    registeredPanes.push({ pane: pane, button: button });
    // iD hides our pane via class changes when one of its own panes opens —
    // keep our button's active state in step with that.
    new MutationObserver(syncPaneButtons).observe(pane, {
      attributes: true,
      attributeFilter: ["class"]
    });
    return {
      setShown: (shown) => setMapPaneShown(pane, shown),
      toggle: () => setMapPaneShown(pane, !pane.classList.contains("shown"))
    };
  }

  // Firefox re-injects content scripts into open tabs when the extension is
  // reloaded/updated. The old instance's controls stay in the DOM, but their
  // listeners belong to a dead script — so a plain "already exists, skip" guard
  // leaves dead buttons behind. Returns true when the caller should (re)build:
  // nothing there yet, or only stale elements (which are removed here).
  function claimControl(ids, current) {
    const existing = document.getElementById(ids[0]);
    if (!existing) return true;
    if (existing === current) return false;
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.remove();
    });
    return true;
  }

  window.OST = {
    getEntity: getEntity,
    getSurface: getSurface,
    getRawTagContainer: getRawTagContainer,
    ensureTagsExpanded: ensureTagsExpanded,
    applyOneTag: applyOneTag,
    registerMapPane: registerMapPane,
    claimControl: claimControl
  };
})();

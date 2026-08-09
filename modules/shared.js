// OSM SuperTools — shared iD DOM helpers.
// Loaded before the feature modules; exposes `window.OST`.
//
// Based on openstreetmap/iD: modules/ui/sections/raw_tag_editor.js,
// modules/ui/entity_editor.js, modules/ui/inspector.js, modules/ui/disclosure.js
(function () {
  "use strict";

  // iD binds each rendered feature's entity ({id, type, tags, loc, …}) to its
  // DOM element via d3's `__data__`. In Firefox a content script sees the page
  // DOM through an Xray wrapper that hides page-set expandos, so reach through
  // `wrappedJSObject`. Falls back to direct access (same-world test harness).
  function getEntity(el) {
    try {
      const w = el.wrappedJSObject;
      if (w && w.__data__) return w.__data__;
    } catch (e) {
      /* wrappedJSObject unavailable (non-Firefox / test) */
    }
    return el.__data__ || null;
  }

  function getSurface() {
    return document.querySelector(".surface") || document.querySelector("svg.surface");
  }

  // --- raw ("Tags") tag editor access -----------------------------------
  //
  //   .entity-editor-pane .section-raw-tag-editor.raw-tag-editor   <- container
  //     details.disclosure-wrap
  //       summary.hide-toggle                                       <- expand toggle
  //       .disclosure-content > ul.tag-list
  //         li.tag-row  ( .key-wrap input.key , .value-wrap input.value )
  //         li.tag-row.add-tag                                      <- blank "add" row

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
      if (summary) summary.click(); // synchronously expands + renders .tag-list
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

  // Sets the DOM value only, no events — used for the sibling value input which
  // must already hold the right text before the key input's change event fires
  // (iD's keyChange reads the sibling value synchronously when committing a key).
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

  // Applies one key/value onto the currently selected feature (overwrites an
  // existing key, otherwise fills the blank trailing row). Re-queries the DOM
  // every call because iD synchronously rebuilds the tag list after each commit.
  // Returns true on success.
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

  window.OST = {
    getEntity: getEntity,
    getSurface: getSurface,
    getRawTagContainer: getRawTagContainer,
    ensureTagsExpanded: ensureTagsExpanded,
    applyOneTag: applyOneTag
  };
})();

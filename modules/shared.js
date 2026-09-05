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

  window.OST = {
    getEntity: getEntity,
    getSurface: getSurface,
    getRawTagContainer: getRawTagContainer,
    ensureTagsExpanded: ensureTagsExpanded,
    applyOneTag: applyOneTag
  };
})();

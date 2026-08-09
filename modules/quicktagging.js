(function () {
  const PANEL_ID = "ost-panel";
  let currentButtons = [];
  let panelBody = null;
  let statusEl = null;
  let panel = null;

  function log(...args) {
    console.log("[OSM SuperTools/QuickTagging]", ...args);
  }

  // Raw ("Tags") tag-editor access lives in the shared module (window.OST);
  // see modules/shared.js. Applies a whole set of tags (one button may carry
  // several), overwriting each key's value on the selected feature.
  function applyTagSet(tags) {
    if (!OST.getRawTagContainer()) {
      setStatus("Select a feature first.", true);
      return;
    }
    let applied = 0;
    let failed = 0;
    for (const { key, value } of tags) {
      if (!key) continue;
      if (OST.applyOneTag(key, value)) applied++;
      else failed++;
    }
    if (failed) {
      setStatus(`Set ${applied} tag(s), ${failed} failed — see console.`, true);
    } else {
      setStatus(`Set ${applied} tag${applied === 1 ? "" : "s"}`);
    }
  }

  // --- Panel UI ------------------------------------------------------------

  function setStatus(text, isError = false) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.classList.toggle("ost-error", !!isError);
    clearTimeout(setStatus._t);
    setStatus._t = setTimeout(() => {
      statusEl.textContent = "";
    }, 4000);
  }

  function hexToRgba(hex, alpha) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || "");
    if (!m) return `rgba(43, 108, 255, ${alpha})`;
    const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h, 16));
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  // Normalizes a stored button into { label, color, tags: [{key,value}] }.
  // Backward-compatible with the old single-tag shape ({ key, value }).
  function normalizeButton(btn) {
    let tags;
    if (Array.isArray(btn.tags)) {
      tags = btn.tags.filter((t) => t && t.key);
    } else if (btn.key) {
      tags = [{ key: btn.key, value: btn.value || "" }];
    } else {
      tags = [];
    }
    return { label: btn.label || "", color: btn.color || "#2b6cff", tags };
  }

  function renderButtons() {
    if (!panelBody) return;
    panelBody.innerHTML = "";
    if (currentButtons.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ost-empty";
      empty.textContent = "No buttons configured yet.";
      panelBody.appendChild(empty);
      return;
    }
    for (const raw of currentButtons) {
      const btn = normalizeButton(raw);
      const el = document.createElement("button");
      el.type = "button";
      el.className = "ost-tag-btn";
      const color = btn.color;
      el.style.setProperty("--ost-color", color);
      el.style.setProperty("--ost-bg", hexToRgba(color, 0.18));
      el.style.setProperty("--ost-bg-hover", hexToRgba(color, 0.32));
      const tagSummary = btn.tags.map((t) => `${t.key}=${t.value}`).join("\n");
      el.textContent = btn.label || btn.tags.map((t) => `${t.key}=${t.value}`).join(", ") || "(empty)";
      el.title = tagSummary || "No tags configured";
      el.disabled = btn.tags.length === 0;
      el.addEventListener("click", () => applyTagSet(btn.tags));
      panelBody.appendChild(el);
    }
  }

  function createPanel() {
    if (document.getElementById(PANEL_ID)) return;
    panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="ost-header">
        <span class="ost-title">QuickTagging</span>
        <div class="ost-header-actions">
          <button type="button" class="ost-icon-btn ost-settings" title="Configure QuickTagging buttons">&#9881;</button>
          <button type="button" class="ost-icon-btn ost-collapse" title="Collapse">&minus;</button>
        </div>
      </div>
      <div class="ost-body"></div>
      <div class="ost-status"></div>
    `;
    // Parked in body until we find the sidebar anchor; kept invisible so it
    // doesn't flash in the wrong place before being moved inline.
    panel.classList.add("ost-unplaced");
    document.body.appendChild(panel);

    panelBody = panel.querySelector(".ost-body");
    statusEl = panel.querySelector(".ost-status");

    panel.querySelector(".ost-settings").addEventListener("click", () => {
      browser.runtime.sendMessage({ type: "open-options" });
    });

    const collapseBtn = panel.querySelector(".ost-collapse");
    collapseBtn.addEventListener("click", () => {
      const collapsed = panel.classList.toggle("ost-collapsed");
      collapseBtn.innerHTML = collapsed ? "&#43;" : "&minus;";
    });

    renderButtons();
  }

  // Moves the panel to sit immediately before the "Tags" section in the
  // entity editor sidebar. Runs on every relevant DOM mutation because iD
  // may (re)build the entity editor pane as the user selects/deselects
  // features; cheap no-op if already correctly placed.
  function placePanel() {
    if (!panel) return;
    const container = OST.getRawTagContainer();
    if (!container || !container.parentNode) return;
    if (panel.nextSibling === container && panel.parentNode === container.parentNode) return;
    container.parentNode.insertBefore(panel, container);
    panel.classList.remove("ost-unplaced");
  }

  function loadButtons() {
    browser.storage.local.get("buttons").then(({ buttons }) => {
      currentButtons = Array.isArray(buttons) ? buttons : [];
      renderButtons();
    });
  }

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.buttons) {
      currentButtons = changes.buttons.newValue || [];
      renderButtons();
    }
  });

  function observeSidebar() {
    let scheduled = false;
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        placePanel();
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function init() {
    createPanel();
    loadButtons();
    placePanel();
    observeSidebar();
    log("panel ready");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

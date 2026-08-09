const buttonsEl = document.getElementById("ost-buttons");
const filtersEl = document.getElementById("ost-filters");
const addButtonBtn = document.getElementById("ost-add-button");
const addFilterBtn = document.getElementById("ost-add-filter");
const saveBtn = document.getElementById("ost-save");
const savedEl = document.getElementById("ost-saved");

let buttons = [];
let filters = [];

function uid() {
  return crypto.randomUUID();
}

function escapeAttr(str) {
  return String(str ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/* ============================ QuickTagging ============================ */

function normalizeButton(btn) {
  let tags;
  if (Array.isArray(btn.tags)) {
    tags = btn.tags.map((t) => ({ key: t.key || "", value: t.value || "" }));
  } else if (btn.key) {
    tags = [{ key: btn.key, value: btn.value || "" }];
  } else {
    tags = [];
  }
  if (tags.length === 0) tags = [{ key: "", value: "" }];
  return { id: btn.id || uid(), label: btn.label || "", color: btn.color || "#2b6cff", tags };
}

function tagRowHtml(tag, keyPh, valPh) {
  return `
    <div class="ost-tag-row">
      <input type="text" class="f-key" value="${escapeAttr(tag.key)}" placeholder="${keyPh}" />
      <input type="text" class="f-value" value="${escapeAttr(tag.value)}" placeholder="${valPh}" />
      <button type="button" class="ost-remove-tag" title="Remove tag">&times;</button>
    </div>`;
}

function renderButtons() {
  buttonsEl.innerHTML = "";
  for (const btn of buttons) {
    const card = document.createElement("div");
    card.className = "ost-card";
    card.dataset.id = btn.id;
    card.innerHTML = `
      <div class="ost-card-head">
        <input type="color" class="f-color" value="${escapeAttr(btn.color)}" title="Button color" />
        <input type="text" class="f-label" value="${escapeAttr(btn.label)}" placeholder="Button label" />
        <button type="button" class="ost-remove-card" title="Remove button">Remove</button>
      </div>
      <div class="ost-tags-head">Tags applied by this button</div>
      <div class="ost-tags">${btn.tags.map((t) => tagRowHtml(t, "addr:suburb", "Altstadt")).join("")}</div>
      <button type="button" class="ost-add-tag">+ Add tag</button>
    `;

    card.querySelector(".ost-remove-card").addEventListener("click", () => {
      buttons = buttons.filter((b) => b.id !== btn.id);
      renderButtons();
    });
    card.querySelector(".ost-add-tag").addEventListener("click", () => {
      syncButtonsFromDom();
      buttons.find((b) => b.id === btn.id).tags.push({ key: "", value: "" });
      renderButtons();
    });
    card.querySelectorAll(".ost-remove-tag").forEach((rm, i) => {
      rm.addEventListener("click", () => {
        syncButtonsFromDom();
        const target = buttons.find((b) => b.id === btn.id);
        target.tags.splice(i, 1);
        if (target.tags.length === 0) target.tags.push({ key: "", value: "" });
        renderButtons();
      });
    });

    buttonsEl.appendChild(card);
  }
}

function syncButtonsFromDom() {
  buttons = Array.from(buttonsEl.querySelectorAll(".ost-card")).map((card) => ({
    id: card.dataset.id,
    label: card.querySelector(".f-label").value.trim(),
    color: card.querySelector(".f-color").value,
    tags: Array.from(card.querySelectorAll(".ost-tag-row")).map((row) => ({
      key: row.querySelector(".f-key").value.trim(),
      value: row.querySelector(".f-value").value.trim()
    }))
  }));
}

addButtonBtn.addEventListener("click", () => {
  syncButtonsFromDom();
  buttons.push({ id: uid(), label: "", color: "#2b6cff", tags: [{ key: "", value: "" }] });
  renderButtons();
});

/* ============================ QuickFilters ============================ */

const GEOMS = [
  ["any", "Any geometry"],
  ["point", "Point"],
  ["line", "Line"],
  ["area", "Area"]
];

function normalizeFilter(f) {
  const present = Array.isArray(f.present) ? f.present.map((t) => ({ key: t.key || "", value: t.value || "" })) : [];
  const absent = Array.isArray(f.absent) ? f.absent.map((t) => ({ key: t.key || "", value: t.value || "" })) : [];
  if (present.length === 0) present.push({ key: "", value: "" });
  if (absent.length === 0) absent.push({ key: "", value: "" });
  return {
    id: f.id || uid(),
    name: f.name || "",
    enabled: !!f.enabled,
    geometry: f.geometry || "any",
    present,
    absent,
    color: f.color || "#ff2d95"
  };
}

function geomSelectHtml(selected) {
  const opts = GEOMS.map(
    ([v, label]) => `<option value="${v}"${v === selected ? " selected" : ""}>${label}</option>`
  ).join("");
  return `<select class="f-geometry">${opts}</select>`;
}

function renderFilters() {
  filtersEl.innerHTML = "";
  for (const flt of filters) {
    const card = document.createElement("div");
    card.className = "ost-card";
    card.dataset.id = flt.id;
    card.innerHTML = `
      <div class="ost-card-head">
        <input type="color" class="f-color" value="${escapeAttr(flt.color)}" title="Highlight color" />
        <input type="text" class="f-name" value="${escapeAttr(flt.name)}" placeholder="Filter name" />
        <button type="button" class="ost-remove-card" title="Remove filter">Remove</button>
      </div>

      <div class="ost-field-row">
        <label class="ost-field-label">Geometry</label>
        ${geomSelectHtml(flt.geometry)}
      </div>

      <div class="ost-tags-head">Tags that must be present</div>
      <div class="ost-tags ost-present">${flt.present.map((t) => tagRowHtml(t, "building", "(any value)")).join("")}</div>
      <button type="button" class="ost-add-tag ost-add-present">+ Add required tag</button>

      <div class="ost-tags-head">Tags that must NOT be present</div>
      <div class="ost-tags ost-absent">${flt.absent.map((t) => tagRowHtml(t, "addr:suburb", "(any value)")).join("")}</div>
      <button type="button" class="ost-add-tag ost-add-absent">+ Add excluded tag</button>
    `;

    card.querySelector(".ost-remove-card").addEventListener("click", () => {
      filters = filters.filter((f) => f.id !== flt.id);
      renderFilters();
    });

    const addTo = (which) => {
      syncFiltersFromDom();
      filters.find((f) => f.id === flt.id)[which].push({ key: "", value: "" });
      renderFilters();
    };
    card.querySelector(".ost-add-present").addEventListener("click", () => addTo("present"));
    card.querySelector(".ost-add-absent").addEventListener("click", () => addTo("absent"));

    const wireRemoves = (containerSel, which) => {
      card.querySelectorAll(`${containerSel} .ost-remove-tag`).forEach((rm, i) => {
        rm.addEventListener("click", () => {
          syncFiltersFromDom();
          const target = filters.find((f) => f.id === flt.id);
          target[which].splice(i, 1);
          if (target[which].length === 0) target[which].push({ key: "", value: "" });
          renderFilters();
        });
      });
    };
    wireRemoves(".ost-present", "present");
    wireRemoves(".ost-absent", "absent");

    filtersEl.appendChild(card);
  }
}

function collectTagRows(container) {
  return Array.from(container.querySelectorAll(".ost-tag-row")).map((row) => ({
    key: row.querySelector(".f-key").value.trim(),
    value: row.querySelector(".f-value").value.trim()
  }));
}

function syncFiltersFromDom() {
  const byId = {};
  filters.forEach((f) => (byId[f.id] = f));
  filters = Array.from(filtersEl.querySelectorAll(".ost-card")).map((card) => {
    const id = card.dataset.id;
    return {
      id,
      name: card.querySelector(".f-name").value.trim(),
      color: card.querySelector(".f-color").value,
      geometry: card.querySelector(".f-geometry").value,
      // `enabled` is owned by the in-editor toggle; preserve it here.
      enabled: byId[id] ? !!byId[id].enabled : false,
      present: collectTagRows(card.querySelector(".ost-present")),
      absent: collectTagRows(card.querySelector(".ost-absent"))
    };
  });
}

addFilterBtn.addEventListener("click", () => {
  syncFiltersFromDom();
  filters.push({
    id: uid(),
    name: "",
    color: "#ff2d95",
    geometry: "any",
    enabled: false,
    present: [{ key: "", value: "" }],
    absent: [{ key: "", value: "" }]
  });
  renderFilters();
});

/* ============================ Save / load ============================ */

saveBtn.addEventListener("click", async () => {
  syncButtonsFromDom();
  syncFiltersFromDom();

  const buttonsToStore = buttons.map((b) => ({
    id: b.id,
    label: b.label,
    color: b.color,
    tags: b.tags.filter((t) => t.key)
  }));

  const filtersToStore = filters.map((f) => ({
    id: f.id,
    name: f.name,
    color: f.color,
    geometry: f.geometry,
    enabled: !!f.enabled,
    present: f.present.filter((t) => t.key),
    absent: f.absent.filter((t) => t.key)
  }));

  await browser.storage.local.set({ buttons: buttonsToStore, filters: filtersToStore });
  savedEl.textContent = "Saved";
  setTimeout(() => (savedEl.textContent = ""), 2000);
});

(async function init() {
  const stored = await browser.storage.local.get(["buttons", "filters"]);
  buttons = (Array.isArray(stored.buttons) ? stored.buttons : []).map(normalizeButton);
  filters = (Array.isArray(stored.filters) ? stored.filters : []).map(normalizeFilter);
  renderButtons();
  renderFilters();
})();

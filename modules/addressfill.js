(function () {
  "use strict";

  const BTN_CLASS = "ost-addr-fill";
  let hintRestore = []; // [ [inputEl, originalPlaceholderOrNull], … ]

  function log(...args) {
    console.log("[OSM SuperTools/AddressFill]", ...args);
  }

  // --- geometry -----------------------------------------------------------

  // Screen-space position of a rendered node group (g.point). Its transform's
  // origin (0,0) maps to the node's location; getScreenCTM().{e,f} gives that
  // in client pixels.
  function screenOriginOf(el) {
    const m = el.getScreenCTM();
    return m ? { x: m.e, y: m.f } : null;
  }

  // Convert a client-pixel point into the local user space of a path element,
  // by inverting the path's screen CTM manually (avoids passing matrix objects
  // across the Firefox content-script / page Xray boundary).
  function screenToLocal(pathEl, sp) {
    const m = pathEl.getScreenCTM();
    if (!m) return null;
    const { a, b, c, d, e, f } = m;
    const det = a * d - b * c;
    if (!det) return null;
    const dx = sp.x - e;
    const dy = sp.y - f;
    return { x: (d * dx - c * dy) / det, y: (a * dy - b * dx) / det };
  }

  function pointInPath(pathEl, sp) {
    const local = screenToLocal(pathEl, sp);
    if (!local) return false;
    try {
      if (typeof pathEl.isPointInFill === "function") {
        return pathEl.isPointInFill({ x: local.x, y: local.y });
      }
    } catch (e) {
      /* fall through to bbox */
    }
    try {
      const bb = pathEl.getBBox();
      return local.x >= bb.x && local.x <= bb.x + bb.width && local.y >= bb.y && local.y <= bb.y + bb.height;
    } catch (e) {
      return false;
    }
  }

  // --- feature detection --------------------------------------------------

  function addrTagsOf(tags) {
    const out = {};
    for (const k in tags) {
      if (k.indexOf("addr:") === 0 && tags[k] !== "" && tags[k] != null) out[k] = tags[k];
    }
    return out;
  }

  // The selected building: a selected area path tagged building=yes.
  function selectedBuilding() {
    const surface = OST.getSurface();
    if (!surface) return null;
    for (const p of surface.querySelectorAll("path.area.selected")) {
      const e = OST.getEntity(p);
      if (e && e.tags && e.tags.building === "yes") return { pathEl: p, entity: e };
    }
    return null;
  }

  // A rendered point (standalone node) inside the building that carries at least
  // one addr:* tag. If several, prefer the one with the most addr tags.
  function findAddressPointInside(pathEl) {
    const surface = OST.getSurface();
    if (!surface) return null;
    let best = null;
    let bestCount = 0;
    for (const g of surface.querySelectorAll("g.point")) {
      if (g.classList.contains("target")) continue;
      const e = OST.getEntity(g);
      if (!e || !e.tags) continue;
      const addr = addrTagsOf(e.tags);
      const n = Object.keys(addr).length;
      if (n === 0) continue;
      const sp = screenOriginOf(g);
      if (!sp || !pointInPath(pathEl, sp)) continue;
      if (n > bestCount) {
        best = { entity: e, addr: addr };
        bestCount = n;
      }
    }
    return best;
  }

  // --- Address field access ----------------------------------------------

  function addressField() {
    const byClass = document.querySelector(".entity-editor-pane .form-field-address");
    if (byClass) return byClass;
    // Fallback: locate the field wrapping the addr-* inputs.
    const inp = document.querySelector('.entity-editor-pane input[class*="addr-"]');
    return inp ? inp.closest(".form-field") : null;
  }

  // Map subfield id -> input element, e.g. { housenumber: <input.addr-housenumber> }.
  // Some locales (e.g. Germany) use a combined "street+place" field whose input
  // is classed `addr-street+place`; it is keyed under "street+place" here.
  function addrInputs(field) {
    const map = {};
    field.querySelectorAll('input[class*="addr-"]').forEach((inp) => {
      inp.classList.forEach((cls) => {
        if (cls.indexOf("addr-") === 0) map[cls.slice(5)] = inp;
      });
    });
    return map;
  }

  // Resolves the input for an addr subfield, falling back to the combined
  // "street+place" field for the `street`/`place` subfields.
  function inputForSubfield(inputs, sub) {
    if (inputs[sub]) return inputs[sub];
    if ((sub === "street" || sub === "place") && inputs["street+place"]) {
      return inputs["street+place"];
    }
    return null;
  }

  // --- hover hint + insert -----------------------------------------------

  function showHints(field, addr) {
    clearHints();
    const inputs = addrInputs(field);
    for (const key in addr) {
      const sub = key.slice(5); // strip "addr:"
      const inp = inputForSubfield(inputs, sub);
      if (!inp) continue;
      hintRestore.push([inp, inp.getAttribute("placeholder")]);
      inp.setAttribute("placeholder", addr[key]);
      inp.classList.add("ost-addr-hint");
    }
  }

  function clearHints() {
    for (const [inp, ph] of hintRestore) {
      if (ph === null) inp.removeAttribute("placeholder");
      else inp.setAttribute("placeholder", ph);
      inp.classList.remove("ost-addr-hint");
    }
    hintRestore = [];
  }

  function insertAddress(addr) {
    clearHints();
    if (!OST.getRawTagContainer()) return;
    let applied = 0;
    for (const key in addr) {
      if (OST.applyOneTag(key, addr[key])) applied++;
    }
    log(`inserted ${applied} addr tag(s)`);
  }

  // --- button lifecycle ---------------------------------------------------

  function removeButton() {
    const existing = document.querySelector("." + BTN_CLASS);
    if (existing) existing.remove();
    clearHints();
  }

  function makeButton(field, addr) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = BTN_CLASS;
    btn.textContent = "fill";
    btn.title = "Fill address from a point inside this building";
    btn.addEventListener("mouseenter", () => showHints(field, addr));
    btn.addEventListener("mouseleave", () => clearHints());
    btn.addEventListener("focus", () => showHints(field, addr));
    btn.addEventListener("blur", () => clearHints());
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      insertAddress(addr);
    });
    return btn;
  }

  function evaluate() {
    const building = selectedBuilding();
    const field = building && addressField();
    const source = field && findAddressPointInside(building.pathEl);
    if (!building || !field || !source) {
      removeButton();
      return;
    }

    // Identity of what the button represents. If an up-to-date button is
    // already present we do NOT rebuild it: this runs on a debounced observer
    // and iD redraws often, so recreating the element mid-click would cancel a
    // slow click (mousedown and mouseup would land on different elements).
    const key =
      (building.entity.id || "") + "|" + (source.entity.id || "") + "|" + JSON.stringify(source.addr);

    const existing = document.querySelector("." + BTN_CLASS);
    if (existing && existing.dataset.ostKey === key && field.contains(existing)) {
      return; // already correct — leave it alone
    }

    if (existing) existing.remove();
    const btn = makeButton(field, source.addr);
    btn.dataset.ostKey = key;
    const label = field.querySelector(".field-label");
    // Place between the "Address" text and the trailing icons (info button):
    // iD appends the info/reference button last, so insert right after the
    // flex:1 `.label-text`, which pushes us flush to the info button's left.
    const labelText = label && label.querySelector(".label-text");
    if (labelText) labelText.insertAdjacentElement("afterend", btn);
    else if (label) label.appendChild(btn);
    else (field.firstElementChild || field).appendChild(btn);
  }

  // --- wiring -------------------------------------------------------------

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      try {
        evaluate();
      } catch (e) {
        console.warn("[OSM SuperTools/AddressFill]", e);
      }
    }, 200);
  }

  function init() {
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    schedule();
    log("ready");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

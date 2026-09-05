(function () {
  "use strict";

  const BTN_CLASS = "ost-addr-fill";
  let hintRestore = [];

  function log(...args) {
    console.log("[OSM SuperTools/AddressFill]", ...args);
  }

  function screenOriginOf(el) {
    const m = el.getScreenCTM();
    return m ? { x: m.e, y: m.f } : null;
  }

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

    }
    try {
      const bb = pathEl.getBBox();
      return local.x >= bb.x && local.x <= bb.x + bb.width && local.y >= bb.y && local.y <= bb.y + bb.height;
    } catch (e) {
      return false;
    }
  }

  function addrTagsOf(tags) {
    const out = {};
    for (const k in tags) {
      if (k.indexOf("addr:") === 0 && tags[k] !== "" && tags[k] != null) out[k] = tags[k];
    }
    return out;
  }

  function selectedBuilding() {
    const surface = OST.getSurface();
    if (!surface) return null;
    for (const p of surface.querySelectorAll("path.area.selected")) {
      const e = OST.getEntity(p);
      if (e && e.tags && e.tags.building && e.tags.building !== "no") return { pathEl: p, entity: e };
    }
    return null;
  }

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

  function addressField() {
    const byClass = document.querySelector(".entity-editor-pane .form-field-address");
    if (byClass) return byClass;

    const inp = document.querySelector('.entity-editor-pane input[class*="addr-"]');
    return inp ? inp.closest(".form-field") : null;
  }

  function addrInputs(field) {
    const map = {};
    field.querySelectorAll('input[class*="addr-"]').forEach((inp) => {
      inp.classList.forEach((cls) => {
        if (cls.indexOf("addr-") === 0) map[cls.slice(5)] = inp;
      });
    });
    return map;
  }

  function inputForSubfield(inputs, sub) {
    if (inputs[sub]) return inputs[sub];
    if ((sub === "street" || sub === "place") && inputs["street+place"]) {
      return inputs["street+place"];
    }
    return null;
  }

  function showHints(field, addr) {
    clearHints();
    const inputs = addrInputs(field);
    for (const key in addr) {
      const sub = key.slice(5);
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

    const key =
      (building.entity.id || "") + "|" + (source.entity.id || "") + "|" + JSON.stringify(source.addr);

    const existing = document.querySelector("." + BTN_CLASS);
    if (existing && existing.dataset.ostKey === key && field.contains(existing)) {
      return;
    }

    if (existing) existing.remove();
    const btn = makeButton(field, source.addr);
    btn.dataset.ostKey = key;
    const label = field.querySelector(".field-label");

    const labelText = label && label.querySelector(".label-text");
    if (labelText) labelText.insertAdjacentElement("afterend", btn);
    else if (label) label.appendChild(btn);
    else (field.firstElementChild || field).appendChild(btn);
  }

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

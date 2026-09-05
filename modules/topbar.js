(function () {
  "use strict";

  const BTN_ID = "ost-topbar-btn";

  function gearIconSvg() {

    return (
      '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">' +
      '<path d="M9.405 1.05c-.413-1.4-2.397-1.4-2.81 0l-.1.34a1.464 1.464 0 0 1-2.105.872l-.31-.17c-1.283-.698-2.686.705-1.987 1.987l.169.311c.446.82.023 1.841-.872 2.105l-.34.1c-1.4.413-1.4 2.397 0 2.81l.34.1a1.464 1.464 0 0 1 .872 2.105l-.17.31c-.698 1.283.705 2.686 1.987 1.987l.311-.169a1.464 1.464 0 0 1 2.105.872l.1.34c.413 1.4 2.397 1.4 2.81 0l.1-.34a1.464 1.464 0 0 1 2.105-.872l.31.17c1.283.698 2.686-.705 1.987-1.987l-.169-.311a1.464 1.464 0 0 1 .872-2.105l.34-.1c1.4-.413 1.4-2.397 0-2.81l-.34-.1a1.464 1.464 0 0 1-.872-2.105l.17-.31c.698-1.283-.705-2.686-1.987-1.987l-.311.169a1.464 1.464 0 0 1-2.105-.872l-.1-.34zM8 10.93a2.929 2.929 0 1 1 0-5.86 2.929 2.929 0 0 1 0 5.858z"/></svg>'
    );
  }

  function makeButton() {
    const btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.type = "button";

    btn.className =
      "btn btn-outline-secondary align-self-stretch px-2 border-secondary-subtle d-flex align-items-center gap-1";
    btn.title = "OSM SuperTools settings";
    btn.setAttribute("aria-label", "OSM SuperTools settings");
    btn.innerHTML = gearIconSvg() + '<span class="ost-topbar-label">OSM SuperTools</span>';
    btn.addEventListener("click", () => {
      browser.runtime.sendMessage({ type: "open-options" });
    });
    return btn;
  }

  function findDesktopTranslateButton() {
    const candidates = Array.from(document.querySelectorAll("button i.bi-translate"))
      .map((i) => i.closest("button"))
      .filter(Boolean);
    if (candidates.length === 0) return null;
    return (
      candidates.find((b) => !b.classList.contains("d-md-none") && b.offsetParent !== null) ||
      candidates.find((b) => !b.classList.contains("d-md-none")) ||
      candidates[0]
    );
  }

  function place() {
    const existing = document.getElementById(BTN_ID);
    const translateBtn = findDesktopTranslateButton();
    if (!translateBtn || !translateBtn.parentNode) return false;

    if (existing) {
      if (existing.nextElementSibling !== translateBtn) {
        translateBtn.parentNode.insertBefore(existing, translateBtn);
      }
      return true;
    }
    translateBtn.parentNode.insertBefore(makeButton(), translateBtn);
    return true;
  }

  function init() {
    if (place()) return;

    const observer = new MutationObserver(() => {
      if (place()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => observer.disconnect(), 15000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

const DEFAULT_BUTTONS = [
  {
    id: crypto.randomUUID(),
    label: "Suburb + Country",
    color: "#2b6cff",
    tags: [
      { key: "addr:suburb", value: "" },
      { key: "addr:country", value: "DE" }
    ]
  }
];

const DEFAULT_FILTERS = [
  {
    id: crypto.randomUUID(),
    name: "Addresses missing suburb",
    enabled: false,
    geometry: "any",
    present: [{ key: "addr:housenumber", value: "" }],
    absent: [{ key: "addr:suburb", value: "" }],
    color: "#ff2d95"
  },
  {
    id: crypto.randomUUID(),
    name: "Buildings",
    enabled: false,
    geometry: "area",
    present: [{ key: "building", value: "" }],
    absent: [],
    color: "#00c2a8"
  }
];

browser.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== "install") return;
  const { buttons, filters } = await browser.storage.local.get(["buttons", "filters"]);
  const toSet = {};
  if (!buttons) toSet.buttons = DEFAULT_BUTTONS;
  if (!filters) toSet.filters = DEFAULT_FILTERS;
  if (Object.keys(toSet).length) await browser.storage.local.set(toSet);
});

browser.runtime.onMessage.addListener((message) => {
  if (message && message.type === "open-options") {
    browser.runtime.openOptionsPage();
  }
});

// AlkisImport fetches the LGLN WFS here so the request carries the extension's
// host permission and is not subject to page-origin CORS. Returns the raw GML.
browser.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== "alkis-wfs" || typeof message.url !== "string") return;
  if (!message.url.startsWith("https://opendata.lgln.niedersachsen.de/")) {
    return Promise.resolve({ ok: false, error: "URL nicht erlaubt" });
  }
  return fetch(message.url, { credentials: "omit" })
    .then(async (r) => ({ ok: r.ok, status: r.status, text: await r.text() }))
    .catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
});

// "https://host/api/" → "https://host/api/interpreter": the bare API root
// answers 404, queries go to the interpreter endpoint.
function overpassEndpoint(url) {
  return url.replace(/\/api\/?$/, "/api/interpreter");
}

// OverpassSearch runs its query here against the instance the user entered in
// the settings. There is intentionally no default instance: nobody's public
// server gets load unless the user picked it on purpose.
browser.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== "overpass-query" || typeof message.query !== "string") return;
  return browser.storage.local
    .get("overpassUrl")
    .then(async ({ overpassUrl }) => {
      const url = overpassEndpoint(String(overpassUrl || "").trim());
      if (!url) return { ok: false, error: "no-instance" };
      if (!/^https?:\/\//i.test(url)) return { ok: false, error: "Overpass-URL muss mit http(s):// beginnen" };
      const r = await fetch(url, {
        method: "POST",
        body: new URLSearchParams({ data: message.query }),
        credentials: "omit"
      });
      return { ok: r.ok, status: r.status, text: await r.text(), url };
    })
    .catch((e) => ({ ok: false, error: "Anfrage fehlgeschlagen: " + String((e && e.message) || e) }));
});

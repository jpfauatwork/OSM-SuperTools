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

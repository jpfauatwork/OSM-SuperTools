(function () {
  "use strict";

  var ORIGIN = location.origin;
  var ctx = null;
  var realID = undefined;
  var proxyID = undefined;
  var sawID = false;

  function log() {
    try {
      console.log.apply(console, ["[OSM SuperTools/Bridge]"].concat([].slice.call(arguments)));
    } catch (e) {

    }
  }

  window.__ostBridgeDiag = function () {
    var id = realID;
    return {
      sawID: sawID,
      proxied: proxyID !== realID && !!realID,
      contextCaptured: !!ctx,
      iD_present: typeof id,
      coreContext: id ? typeof id.coreContext : "n/a",
      osmNode: id ? typeof id.osmNode : "n/a",
      osmWay: id ? typeof id.osmWay : "n/a",
      contextPerform: ctx ? typeof ctx.perform : "n/a"
    };
  };

  function announceReady() {
    try {
      window.postMessage({ __ost: "ost-ready", ready: !!ctx }, ORIGIN);
    } catch (e) {

    }
  }

  function buildProxy(real) {
    if (!real || (typeof real !== "object" && typeof real !== "function")) return real;
    try {
      return new Proxy(real, {
        get: function (target, prop) {
          if (prop === "coreContext") {
            var orig = target.coreContext;
            if (typeof orig !== "function") return orig;
            return function () {
              var c = orig.apply(target, arguments);
              ctx = c;
              log("iD context captured", { perform: typeof (c && c.perform) });
              announceReady();
              return c;
            };
          }
          return Reflect.get(target, prop, target);
        }
      });
    } catch (e) {
      log("proxy build failed (editor left intact, no capture):", e && e.message);
      return real;
    }
  }

  function onIDSet(v) {
    sawID = true;
    realID = v;
    proxyID = buildProxy(v);
    log(
      "window.iD assigned:",
      typeof v,
      "coreContext:",
      v ? typeof v.coreContext : "n/a",
      "proxied:",
      proxyID !== v
    );
  }

  (function installAccessor() {
    try {
      var desc = Object.getOwnPropertyDescriptor(window, "iD");
      if (desc && "value" in desc && desc.value !== undefined) {
        onIDSet(desc.value);
      }
      Object.defineProperty(window, "iD", {
        configurable: true,
        enumerable: true,
        get: function () {
          return proxyID;
        },
        set: function (v) {
          onIDSet(v);
        }
      });
      log("accessor installed on window.iD");
    } catch (e) {
      log("could not install window.iD accessor:", e && e.message);

      var ticks = 0;
      var iv = setInterval(function () {
        ticks++;
        if (!sawID && window.iD) {
          try {
            var real = window.iD;
            delete window.iD;
            onIDSet(real);
            Object.defineProperty(window, "iD", {
              configurable: true,
              enumerable: true,
              get: function () {
                return proxyID;
              },
              set: function (v) {
                onIDSet(v);
              }
            });
          } catch (e2) {
            log("backup accessor swap failed:", e2 && e2.message);
          }
        }
        if (ctx || ticks > 1200) clearInterval(iv);
      }, 15);
    }
  })();

  setTimeout(function () {
    if (!ctx) {
      log(
        "NO context captured after 12s. sawID=" +
          sawID +
          " iD=" +
          typeof realID +
          ". Run __ostBridgeDiag() here for detail."
      );
    }
  }, 12000);

  function reply(reqId, ok, extra) {
    var msg = { __ost: "ost-result", reqId: reqId, ok: ok };
    if (extra) {
      for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) msg[k] = extra[k];
    }
    try {
      window.postMessage(msg, ORIGIN);
    } catch (e) {

    }
  }

  function handleAddFeatures(reqId, payload) {
    try {
      if (!ctx) throw new Error("iD-Kontext nicht verfügbar");
      var iD = realID;
      if (!iD || typeof iD.osmNode !== "function" || typeof iD.osmWay !== "function") {
        throw new Error("iD-Entity-Konstruktoren fehlen");
      }
      if (!payload || !Array.isArray(payload.nodes) || !Array.isArray(payload.ways)) {
        throw new Error("Ungültige Nutzdaten");
      }

      var nodeEnts = payload.nodes.map(function (ll) {
        return new iD.osmNode({ loc: [ll[0], ll[1]] });
      });
      var wayEnts = payload.ways.map(function (w) {
        var ids = w.nodes.map(function (i) {
          return nodeEnts[i].id;
        });
        return new iD.osmWay({ nodes: ids, tags: w.tags || {} });
      });
      var ents = nodeEnts.concat(wayEnts);

      ctx.perform(function (graph) {
        for (var i = 0; i < ents.length; i++) graph = graph.replace(ents[i]);
        return graph;
      }, payload.annotation || "Add features");

      log("added", wayEnts.length, "ways,", nodeEnts.length, "nodes");
      reply(reqId, true, { addedWays: wayEnts.length });
    } catch (e) {
      log("add-features failed:", e && e.message);
      reply(reqId, false, { error: (e && e.message) || String(e) });
    }
  }

  function handleSetTags(reqId, payload) {
    try {
      if (!ctx) throw new Error("iD-Kontext nicht verfügbar");
      if (!payload || !payload.entityId || !payload.tags || typeof payload.tags !== "object") {
        throw new Error("Ungültige Nutzdaten");
      }
      var id = payload.entityId;
      var g = typeof ctx.graph === "function" ? ctx.graph() : null;
      if (!g || !g.hasEntity(id)) throw new Error("Objekt nicht gefunden: " + id);
      var newTags = payload.tags;
      ctx.perform(function (graph) {
        var e = graph.entity(id);
        var merged = Object.assign({}, e.tags, newTags);
        for (var k in newTags) {
          if (newTags[k] === null || newTags[k] === "") delete merged[k];
        }
        return graph.replace(e.update({ tags: merged }));
      }, payload.annotation || "Change tags");
      log("set tags on", id, newTags);
      reply(reqId, true, {});
    } catch (e) {
      log("set-tags failed:", e && e.message);
      reply(reqId, false, { error: (e && e.message) || String(e) });
    }
  }

  window.addEventListener("message", function (ev) {
    if (ev.source !== window || ev.origin !== ORIGIN) return;
    var d = ev.data;
    if (!d || typeof d !== "object") return;
    if (d.__ost === "ost-ping") {
      announceReady();
    } else if (d.__ost === "ost-add-features") {
      handleAddFeatures(d.reqId, d.payload);
    } else if (d.__ost === "ost-set-tags") {
      handleSetTags(d.reqId, d.payload);
    }
  });

  log("bridge loaded (page world)");
})();

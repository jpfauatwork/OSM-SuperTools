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

  var SNAP_VERT_M = 0.2; // treat vertices this close (metres) as the same node
  var SNAP_EDGE_M = 0.3; // treat a vertex this close to an edge as "on the line"

  // Pure planner: decides how the incoming geometry should be glued to itself
  // and to existing building outlines (candWays). Shared/coincident vertices are
  // merged; a vertex lying on an existing edge is spliced into it. No iD access —
  // unit-tested in isolation.
  function planConflation(coords, ways, candWays, refLat, opts) {
    var VERT = opts.vert, EDGE = opts.edge;
    var mLat = 111320, mLon = 111320 * Math.cos((refLat * Math.PI) / 180);
    function XY(ll) { return [ll[0] * mLon, ll[1] * mLat]; }
    function d2(a, b) { var dx = a[0] - b[0], dy = a[1] - b[1]; return dx * dx + dy * dy; }
    function seg(P, A, B) {
      var vx = B[0] - A[0], vy = B[1] - A[1], L2 = vx * vx + vy * vy;
      if (L2 < 1e-9) return { t: 0, d2: d2(P, A), L: 0 };
      var t = ((P[0] - A[0]) * vx + (P[1] - A[1]) * vy) / L2;
      var tc = Math.max(0, Math.min(1, t));
      var f = [A[0] + tc * vx, A[1] + tc * vy];
      return { t: t, d2: d2(P, f), L: Math.sqrt(L2) };
    }

    var uniq = [];
    var mapIdx = coords.map(function (c) {
      var xy = XY(c);
      for (var u = 0; u < uniq.length; u++) if (d2(uniq[u].xy, xy) <= VERT * VERT) return u;
      uniq.push({ ll: c, xy: xy });
      return uniq.length - 1;
    });

    var existNodes = [], existSegs = [];
    candWays.forEach(function (w) {
      var pts = w.nodes.map(function (n) { return { id: n.id, ll: n.loc, xy: XY(n.loc) }; });
      pts.forEach(function (p) { existNodes.push(p); });
      for (var i = 0; i < pts.length - 1; i++)
        existSegs.push({ wayId: w.id, aId: pts[i].id, bId: pts[i + 1].id, A: pts[i].xy, B: pts[i + 1].xy });
    });

    var res = uniq.map(function (p) {
      var best = null;
      existNodes.forEach(function (n) {
        var dd = d2(n.xy, p.xy);
        if (dd <= VERT * VERT && (!best || dd < best.dd)) best = { dd: dd, id: n.id, ll: n.ll };
      });
      if (best) return { role: "reuse", id: best.id, ll: best.ll };
      var be = null;
      existSegs.forEach(function (s) {
        var r = seg(p.xy, s.A, s.B);
        if (r.d2 <= EDGE * EDGE) {
          var along = r.t * r.L;
          if (along > VERT && along < r.L - VERT && (!be || r.d2 < be.d2))
            be = { d2: r.d2, edge: [s.aId, s.bId], wayId: s.wayId };
        }
      });
      if (be) return { role: "newOnEdge", ll: p.ll, edge: be.edge, wayId: be.wayId };
      return { role: "new", ll: p.ll };
    });

    var reusedIds = {};
    res.forEach(function (r) { if (r.role === "reuse") reusedIds[r.id] = true; });

    var wayPlans = ways.map(function (w) {
      var seqU = w.nodes.map(function (ci) { return mapIdx[ci]; });
      var cleaned = [];
      seqU.forEach(function (u) { if (!cleaned.length || cleaned[cleaned.length - 1] !== u) cleaned.push(u); });
      if (cleaned.length > 1 && cleaned[0] !== cleaned[cleaned.length - 1]) cleaned.push(cleaned[0]);
      var slots = [];
      for (var i = 0; i < cleaned.length; i++) {
        slots.push({ uniq: cleaned[i] });
        if (i < cleaned.length - 1) {
          var A = uniq[cleaned[i]].xy, B = uniq[cleaned[i + 1]].xy;
          var ins = [];
          existNodes.forEach(function (n) {
            if (reusedIds[n.id]) return;
            var r = seg(n.xy, A, B);
            if (r.d2 <= EDGE * EDGE) {
              var along = r.t * r.L;
              if (along > VERT && along < r.L - VERT) ins.push({ t: r.t, id: n.id });
            }
          });
          ins.sort(function (a, b) { return a.t - b.t; });
          var seen = {};
          ins.forEach(function (x) { if (!seen[x.id]) { seen[x.id] = true; slots.push({ existId: x.id }); } });
        }
      }
      return { tags: w.tags, slots: slots };
    });

    return { uniq: uniq, res: res, wayPlans: wayPlans };
  }

  function buildCandWays(graph, ids, excludeIds) {
    var ex = {};
    (excludeIds || []).forEach(function (id) { ex[id] = true; });
    var out = [];
    (ids || []).forEach(function (id) {
      if (ex[id] || !graph.hasEntity(id)) return;
      var w = graph.entity(id);
      if (w.type !== "way" || !w.nodes || w.nodes.length < 2) return;
      if (!(w.tags && w.tags.building && w.tags.building !== "no")) return;
      var nodes = [];
      for (var i = 0; i < w.nodes.length; i++) {
        if (!graph.hasEntity(w.nodes[i])) { nodes = null; break; }
        var nd = graph.entity(w.nodes[i]);
        if (!nd.loc) { nodes = null; break; }
        nodes.push({ id: w.nodes[i], loc: nd.loc });
      }
      if (nodes && nodes.length >= 2) out.push({ id: id, nodes: nodes });
    });
    return out;
  }

  // Current [aId,bId] edge of a way that the given point sits on — recomputed on
  // the evolving graph so several splices onto one way stay correct.
  function currentEdgeFor(graph, wayId, loc, refLat) {
    if (!graph.hasEntity(wayId)) return null;
    var w = graph.entity(wayId);
    var mLat = 111320, mLon = 111320 * Math.cos((refLat * Math.PI) / 180);
    function xy(ll) { return [ll[0] * mLon, ll[1] * mLat]; }
    var P = xy(loc);
    for (var i = 0; i < w.nodes.length - 1; i++) {
      if (!graph.hasEntity(w.nodes[i]) || !graph.hasEntity(w.nodes[i + 1])) continue;
      var A = xy(graph.entity(w.nodes[i]).loc), B = xy(graph.entity(w.nodes[i + 1]).loc);
      var vx = B[0] - A[0], vy = B[1] - A[1], L2 = vx * vx + vy * vy;
      if (L2 < 1e-9) continue;
      var t = ((P[0] - A[0]) * vx + (P[1] - A[1]) * vy) / L2;
      var tc = Math.max(0, Math.min(1, t));
      var fx = A[0] + tc * vx, fy = A[1] + tc * vy;
      var dd = (P[0] - fx) * (P[0] - fx) + (P[1] - fy) * (P[1] - fy);
      var L = Math.sqrt(L2), along = t * L;
      if (dd <= SNAP_EDGE_M * SNAP_EDGE_M && along > SNAP_VERT_M && along < L - SNAP_VERT_M) {
        return [w.nodes[i], w.nodes[i + 1]];
      }
    }
    return null;
  }

  function meanLat(nodes) {
    var s = 0, n = 0;
    for (var i = 0; i < nodes.length; i++) {
      if (isFinite(nodes[i][1])) { s += nodes[i][1]; n++; }
    }
    return n ? s / n : 0;
  }

  function addSimple(iD, payload, deleteIds) {
    var nodeEnts = payload.nodes.map(function (ll) {
      return new iD.osmNode({ loc: [ll[0], ll[1]] });
    });
    var wayEnts = payload.ways.map(function (w) {
      var ids = w.nodes.map(function (i) { return nodeEnts[i].id; });
      return new iD.osmWay({ nodes: ids, tags: w.tags || {} });
    });
    var ents = nodeEnts.concat(wayEnts);
    ctx.perform(function (graph) {
      for (var i = 0; i < ents.length; i++) graph = graph.replace(ents[i]);
      graph = applyDeletes(iD, graph, deleteIds);
      return graph;
    }, payload.annotation || "Add features");
    return { addedWays: wayEnts.length, glued: 0 };
  }

  function applyDeletes(iD, graph, deleteIds) {
    if (deleteIds.length && typeof iD.actionDeleteMultiple === "function") {
      var present = deleteIds.filter(function (id) { return graph.hasEntity(id); });
      if (present.length) graph = iD.actionDeleteMultiple(present)(graph);
    }
    return graph;
  }

  // Add features, gluing shared/collinear vertices to each other and to nearby
  // existing buildings. Throws on trouble so the caller can fall back to a plain
  // add; the whole thing is one undo step.
  function addWithConflation(iD, payload, deleteIds) {
    var refLat = meanLat(payload.nodes);
    var candWays = buildCandWays(ctx.graph(), payload.nearWayIds, deleteIds);
    var plan = planConflation(payload.nodes, payload.ways, candWays, refLat, {
      vert: SNAP_VERT_M,
      edge: SNAP_EDGE_M
    });
    var glued = 0;

    ctx.perform(function (graph) {
      var uniqNodeId = new Array(plan.uniq.length);
      var newList = [];
      plan.res.forEach(function (r, u) {
        if (r.role === "reuse") {
          uniqNodeId[u] = r.id;
          glued++;
        } else {
          var n = new iD.osmNode({ loc: [r.ll[0], r.ll[1]] });
          uniqNodeId[u] = n.id;
          newList.push({ ent: n, res: r });
        }
      });

      newList.forEach(function (x) { graph = graph.replace(x.ent); });

      newList.forEach(function (x) {
        if (x.res.role !== "newOnEdge" || typeof iD.actionAddMidpoint !== "function") return;
        var edge = currentEdgeFor(graph, x.res.wayId, x.ent.loc, refLat);
        if (!edge) return;
        try {
          graph = iD.actionAddMidpoint({ loc: x.ent.loc, edge: edge }, x.ent)(graph);
          glued++;
        } catch (e) {

        }
      });

      plan.wayPlans.forEach(function (wp) {
        var ids = wp.slots.map(function (s) {
          return s.uniq != null ? uniqNodeId[s.uniq] : s.existId;
        });
        ids = ids.filter(function (id) { return !!id; });
        if (ids.length >= 2) graph = graph.replace(new iD.osmWay({ nodes: ids, tags: wp.tags || {} }));
      });

      graph = applyDeletes(iD, graph, deleteIds);
      return graph;
    }, payload.annotation || "Add features");

    return { addedWays: payload.ways.length, glued: glued };
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

      var deleteIds = Array.isArray(payload.deleteIds) ? payload.deleteIds : [];
      var result;
      if (Array.isArray(payload.nearWayIds)) {
        try {
          result = addWithConflation(iD, payload, deleteIds);
        } catch (err) {
          log("conflation failed, plain add:", err && err.message);
          result = addSimple(iD, payload, deleteIds);
        }
      } else {
        result = addSimple(iD, payload, deleteIds);
      }

      log("added", result.addedWays, "ways; glued", result.glued, "node(s); deleted", deleteIds.length);
      reply(reqId, true, { addedWays: result.addedWays, glued: result.glued });
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

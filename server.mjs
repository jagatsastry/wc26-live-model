#!/usr/bin/env node
/* WC26 live server — replaces GitHub Pages with a dynamic local server.
   Proxies Kalshi market prices and ESPN live scores server-side (no CORS),
   runs the Monte Carlo model engine, and pushes updates to clients via SSE.

   Usage:  npm start          (production)
           npm run dev        (auto-restart on file changes)

   Open:  http://localhost:3000 */

import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE   = path.dirname(fileURLToPath(import.meta.url));
const PORT   = process.env.PORT || 3000;
const KALSHI = "https://api.elections.kalshi.com/trade-api/v2";
const ESPN   = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
const RESULTS_FILE = path.join(HERE, "tools", "data", "results.json");

/* ---------- load model engine from index.html ---------- */
function loadEngine() {
  const html = fs.readFileSync(path.join(HERE, "index.html"), "utf8");
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const engineSrc = blocks.find(b => b.includes("function createEngine"));
  const dataSrc   = blocks.find(b => b.includes("const DATA ="));
  const DATA = JSON.parse(dataSrc.slice(dataSrc.indexOf("{"), dataSrc.lastIndexOf("}") + 1));
  const mod = { exports: {} };
  new Function("module", "exports", engineSrc)(mod, mod.exports);
  return { E: mod.exports.createEngine(DATA), DATA };
}
let { E, DATA } = loadEngine();

/* ---------- team name normalisation (same as edge_finder) ---------- */
const ALIAS = {
  "usa": "United States", "united states": "United States", "turkiye": "Türkiye", "turkey": "Türkiye",
  "congo dr": "DR Congo", "dr congo": "DR Congo", "czech republic": "Czechia", "korea republic": "South Korea",
  "south korea": "South Korea", "cote d'ivoire": "Ivory Coast", "côte d'ivoire": "Ivory Coast",
  "ivory coast": "Ivory Coast", "cabo verde": "Cape Verde", "bosnia": "Bosnia and Herzegovina",
  "bosnia and herzegovina": "Bosnia and Herzegovina", "saudi arabia": "Saudi Arabia", "ir iran": "Iran",
  "czechia": "Czechia",
};
const TEAMS = new Set(E.teams);
function normTeam(n) {
  if (!n) return null;
  const k = String(n).trim();
  if (TEAMS.has(k)) return k;
  const low = k.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  for (const t of TEAMS) if (t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "") === low) return t;
  return ALIAS[k.toLowerCase()] || ALIAS[low] || null;
}

/* ---------- Kalshi helpers ---------- */
async function kget(p) {
  const r = await fetch(KALSHI + p, { headers: { "User-Agent": "wc26-server" } });
  if (!r.ok) throw new Error(`Kalshi ${r.status} ${p}`);
  return r.json();
}
async function allMarkets(series, status) {
  const out = []; let cursor = "";
  do {
    const d = await kget(`/markets?series_ticker=${series}&status=${status}&limit=200${cursor ? "&cursor=" + cursor : ""}`);
    out.push(...(d.markets || []));
    cursor = d.cursor || "";
  } while (cursor);
  return out;
}
const mid = m => {
  const b = m.yes_bid_dollars != null ? +m.yes_bid_dollars : null;
  const a = m.yes_ask_dollars != null ? +m.yes_ask_dollars : null;
  if (b != null && a != null) return (b + a) / 2;
  return m.last_price_dollars != null ? +m.last_price_dollars : null;
};

async function buildCodeMap() {
  const map = {};
  for (const m of await allMarkets("KXWCGROUPWIN", "open").catch(() => [])) {
    const code = m.ticker.split("-").pop();
    const t = /Will (.+?) finish first/.exec(m.title || "");
    const team = t && normTeam(t[1]);
    if (team) map[code] = team;
  }
  for (const m of await allMarkets("KXMENWORLDCUP", "open").catch(() => [])) {
    const code = m.ticker.split("-").pop();
    if (!map[code]) {
      const team = normTeam((m.yes_sub_title || m.subtitle || "").trim());
      if (team) map[code] = team;
    }
  }
  return map;
}

/* ---------- fetch Kalshi market snapshot ---------- */
async function fetchMarket(codeMap) {
  const snap = { ts: new Date().toISOString(), matches: {}, groups: {}, champ: {} };
  const game = await allMarkets("KXWCGAME", "open");
  const byEvent = {};
  for (const m of game) (byEvent[m.event_ticker] ??= []).push(m);
  for (const [ev, ms] of Object.entries(byEvent)) {
    const tk = /KXWCGAME-(\d{2})([A-Z]{3})(\d{2})([A-Z]{3})([A-Z]{3})$/.exec(ev);
    if (!tk) continue;
    const a = codeMap[tk[4]], b = codeMap[tk[5]];
    const f = E.fixtures.find(x => (x.a === a && x.b === b) || (x.a === b && x.b === a));
    if (!f) continue;
    const imp = {};
    for (const m of ms) {
      const code = m.ticker.split("-").pop();
      const v = mid(m);
      if (v == null) continue;
      if (code === "TIE") imp.D = v;
      else if (codeMap[code] === f.a) imp.W = v;
      else if (codeMap[code] === f.b) imp.L = v;
    }
    if (Object.keys(imp).length) snap.matches[f.key] = imp;
  }
  for (const m of await allMarkets("KXWCGROUPWIN", "open")) {
    const seg = m.ticker.split("-");
    const team = codeMap[seg.pop()];
    const v = mid(m);
    if (team && v != null) snap.groups[team] = v;
  }
  for (const m of await allMarkets("KXMENWORLDCUP", "open")) {
    const team = codeMap[m.ticker.split("-").pop()];
    const v = mid(m);
    if (team && v != null) snap.champ[team] = v;
  }
  return snap;
}

/* ---------- ESPN live scores ---------- */
const ESPN_STATUS = {
  STATUS_SCHEDULED:    "pre",
  STATUS_IN_PROGRESS:  "live",
  STATUS_HALFTIME:     "ht",
  STATUS_FULL_TIME:    "ft",
  STATUS_FINAL:        "ft",
  STATUS_FINAL_AET:    "ft",
  STATUS_FINAL_PEN:    "ft",
  STATUS_POSTPONED:    "postponed",
  STATUS_CANCELED:     "canceled",
  STATUS_SUSPENDED:    "suspended",
};

async function fetchScores() {
  const scores = {};
  // fetch last 4 days so we always have recent results
  const dates = [];
  const now = new Date();
  for (let i = -1; i <= 3; i++) {
    const d = new Date(now); d.setDate(d.getDate() + i);
    dates.push(d.toISOString().slice(0, 10).replace(/-/g, ""));
  }
  const pages = await Promise.all(dates.map(d =>
    fetch(`${ESPN}?dates=${d}`, { headers: { "User-Agent": "wc26-server" } })
      .then(r => r.ok ? r.json() : { events: [] })
      .catch(() => ({ events: [] }))
  ));
  for (const page of pages) {
    for (const ev of (page.events || [])) {
      const comp = ev.competitions?.[0]; if (!comp) continue;
      const home = comp.competitors?.find(c => c.homeAway === "home");
      const away = comp.competitors?.find(c => c.homeAway === "away");
      if (!home || !away) continue;
      const a = normTeam(home.team.displayName), b = normTeam(away.team.displayName);
      if (!a || !b) continue;
      const f = E.fixtures.find(x => (x.a === a && x.b === b) || (x.a === b && x.b === a));
      if (!f) continue;
      const st = comp.status?.type?.name || "";
      const status = ESPN_STATUS[st] || (comp.status?.type?.completed ? "ft" : "pre");
      const clock = comp.status?.displayClock || "";
      const ga = a === f.a ? +(home.score || 0) : +(away.score || 0);
      const gb = b === f.b ? +(away.score || 0) : +(home.score || 0);
      scores[f.key] = { ga, gb, status, clock, espnId: ev.id };
    }
  }
  return scores;
}

/* ---------- model analysis ---------- */
async function runAnalysis(results) {
  E.setResults(results);
  E.setOptions({ nsim: 20000, eloUpdate: true });
  const an = E.computeAnalytic();
  const out = await E.run(() => {});
  // opening line (no results)
  E.setResults({ group: {}, ko: [] });
  E.setOptions({ nsim: 20000, eloUpdate: false });
  const anOpen = Object.fromEntries(E.computeAnalytic().map(f => [f.key, { W: f.W, D: f.D, L: f.L }]));
  // restore
  E.setResults(results);
  return { an, out, anOpen };
}

/* ---------- auto-sync settled Kalshi results ---------- */
async function syncResults(codeMap, results) {
  const settled = await allMarkets("KXWCGAME", "settled").catch(() => []);
  const byEvent = {};
  for (const m of settled) (byEvent[m.event_ticker] ??= []).push(m);
  let changed = false;
  for (const [ev, ms] of Object.entries(byEvent)) {
    const codes = /KXWCGAME-(\d{2})([A-Z]{3})(\d{2})([A-Z]{3})([A-Z]{3})$/.exec(ev);
    if (!codes) continue;
    const a = codeMap[codes[4]], b = codeMap[codes[5]];
    const f = E.fixtures.find(x => (x.a === a && x.b === b) || (x.a === b && x.b === a));
    if (!f || results.group[f.key]) continue;
    const winSide = ms.find(m => m.result === "yes");
    if (!winSide) continue;
    const code = winSide.ticker.split("-").pop();
    let score;
    if (code === "TIE") score = [1, 1];
    else if (codeMap[code] === f.a) score = [1, 0];
    else if (codeMap[code] === f.b) score = [0, 1];
    else continue;
    results.group[f.key] = score;
    changed = true;
    console.log(`  synced ${f.key} -> ${score} (placeholder — edit results.json for real score)`);
  }
  if (changed) {
    fs.mkdirSync(path.dirname(RESULTS_FILE), { recursive: true });
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  }
  return changed;
}

/* ---------- server state & refresh loop ---------- */
let state = {
  market:   null,
  scores:   {},
  analysis: null,
  results:  null,
  codeMap:  null,
  ts:       null,
  error:    null,
};
let sseClients = new Set();

function broadcast(partial) {
  const data = JSON.stringify(partial ?? statePayload());
  const msg = `data: ${data}\n\n`;
  for (const res of sseClients) res.write(msg);
}

function statePayload() {
  return { ts: state.ts, scores: state.scores, market: state.market, analysis: state.analysis ? {
    an: state.analysis.an, anOpen: state.analysis.anOpen,
    champ: state.analysis.out?.champ, group: state.analysis.out?.group,
  } : null };
}

function loadResults() {
  try { return JSON.parse(fs.readFileSync(RESULTS_FILE, "utf8")); }
  catch { return { group: { ...DATA.fixedResults }, ko: [] }; }
}

let analysisTimer = null;
async function scheduleAnalysis(results) {
  clearTimeout(analysisTimer);
  analysisTimer = setTimeout(async () => {
    console.log("Running model analysis…");
    try {
      state.analysis = await runAnalysis(results);
      state.ts = new Date().toISOString();
      broadcast();
      console.log("Analysis done.");
    } catch (e) { console.error("Analysis error:", e.message); }
  }, 200);
}

let refreshing = null;
function refresh() {
  if (refreshing) return refreshing;
  refreshing = doRefreshCycle().finally(() => { refreshing = null; });
  return refreshing;
}
async function doRefreshCycle() {
  try {
    const results = loadResults();
    const resultsChanged = JSON.stringify(results) !== JSON.stringify(state.results);
    state.results = results;

    if (!state.codeMap) {
      console.log("Building Kalshi code map…");
      state.codeMap = await buildCodeMap();
    }

    // Sync newly settled markets (fills in winner, placeholder score)
    const synced = await syncResults(state.codeMap, results);
    if (synced) { state.results = loadResults(); }

    const [scores, market] = await Promise.all([
      fetchScores().catch(e => { console.error("Scores error:", e.message); return state.scores; }),
      fetchMarket(state.codeMap).catch(e => { console.error("Market error:", e.message); return state.market; }),
    ]);

    const scoresChanged = JSON.stringify(scores) !== JSON.stringify(state.scores);
    state.scores  = scores;
    state.market  = market;
    state.ts      = new Date().toISOString();

    // Rebuild market.json so existing index.html fallback still works
    if (market) fs.writeFileSync(path.join(HERE, "market.json"), JSON.stringify(market, null, 1));

    broadcast({ ts: state.ts, scores: state.scores, market: state.market });

    if (resultsChanged || synced || !state.analysis) await scheduleAnalysis(state.results);

    const liveCount = Object.values(scores).filter(s => s.status === "live" || s.status === "ht").length;
    console.log(`[${new Date().toLocaleTimeString()}] refresh — ${Object.keys(scores).length} fixtures, ${liveCount} live, ${Object.keys(market?.matches || {}).length} market lines`);
  } catch (e) {
    console.error("Refresh error:", e.message);
  }
}

// Live matches get 30s ticks; otherwise 90s
function nextInterval() {
  const hasLive = Object.values(state.scores).some(s => s.status === "live" || s.status === "ht");
  return hasLive ? 30_000 : 90_000;
}
function scheduleRefresh() {
  setTimeout(async () => { await refresh(); scheduleRefresh(); }, nextInterval());
}

/* ---------- Express app ---------- */
const app = express();

app.use((req, res, next) => {
  // Don't cache API responses
  if (req.path.startsWith("/api/") || req.path === "/sse") {
    res.set("Cache-Control", "no-store");
  }
  next();
});

// Static files (index.html, market.json, etc.)
app.use(express.static(HERE));

app.get("/api/scores",   (_, res) => res.json(state.scores));
app.get("/api/market",   (_, res) => res.json(state.market));
app.get("/api/analysis", (_, res) => res.json(state.analysis ? {
  an: state.analysis.an, anOpen: state.analysis.anOpen,
  champ: state.analysis.out?.champ, group: state.analysis.out?.group,
} : null));

app.get("/api/status", (_, res) => res.json({
  ts: state.ts,
  liveMatches: Object.entries(state.scores).filter(([,s]) => s.status === "live" || s.status === "ht").map(([k,s]) => ({ key: k, ...s })),
  marketLines: Object.keys(state.market?.matches || {}).length,
  resultsIn: Object.keys(state.results?.group || {}).length,
}));

// Force a refresh (useful for testing or after manually editing results.json)
app.post("/api/refresh", async (_, res) => {
  res.json({ ok: true, message: "Refresh triggered" });
  await refresh();
});

// SSE — clients subscribe here for live push updates
app.get("/sse", (req, res) => {
  res.writeHead(200, {
    "Content-Type":  "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection":    "keep-alive",
    "X-Accel-Buffering": "no", // disable nginx buffering if proxied
  });
  res.write(":ok\n\n"); // initial ping
  sseClients.add(res);
  // Send current state immediately
  if (state.ts) res.write(`data: ${JSON.stringify(statePayload())}\n\n`);
  // Keepalive ping every 20s so the connection doesn't drop
  const ping = setInterval(() => res.write(":ping\n\n"), 20_000);
  req.on("close", () => { sseClients.delete(res); clearInterval(ping); });
});

/* ---------- boot ---------- */
console.log("WC26 live server starting…");
console.log(`  Loading model from index.html… ${E.teams.length} teams, ${E.fixtures.length} fixtures`);

await refresh();             // initial data load
scheduleAnalysis(state.results); // kick off first model run
scheduleRefresh();           // start polling loop

app.listen(PORT, () => {
  console.log(`\n  Server ready: http://localhost:${PORT}`);
  console.log(`  API: /api/scores  /api/market  /api/analysis  /api/status`);
  console.log(`  SSE: /sse  (live push — scores refresh every 30s during matches, 90s otherwise)\n`);
});

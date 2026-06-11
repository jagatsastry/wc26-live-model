#!/usr/bin/env node
/* WC26 edge finder — compares the index.html Monte Carlo model against Kalshi
   prices (Robinhood prediction markets route to Kalshi) and recommends plays.

   Usage:  node tools/edge_finder.mjs [--nsim 20000] [--days 4] [--sync] [--top 8]
     --sync  pull winners of settled Kalshi match markets into data/results.json
             (scores default to 1-0 / 1-1; edit data/results.json with real
             scores — the Elo nudge is margin-weighted, so scores matter)

   State:  tools/data/results.json  match results fed to the model
           tools/data/track.jsonl   one record per market per run (model p,
                                    market bid/ask, edge, recommendation)

   Per the owner's instruction this ASSUMES THE MODEL IS BETTER THAN THE
   MARKET. That assumption is doing all the work. Not financial advice. */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(HERE, "data");
const RESULTS_FILE = path.join(DATA_DIR, "results.json");
const TRACK_FILE = path.join(DATA_DIR, "track.jsonl");
const API = "https://api.elections.kalshi.com/trade-api/v2";
const FEE = 0.01; // Robinhood commission per contract, charged on entry

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 ? +args[i + 1] : d; };
const NSIM = flag("nsim", 20000);
const DAYS = flag("days", 4);
const TOP = flag("top", 8);
const SYNC = args.includes("--sync");

/* ---------- load model from index.html ---------- */
const html = fs.readFileSync(path.join(HERE, "..", "index.html"), "utf8");
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const engineSrc = blocks.find(b => b.includes("function createEngine"));
const dataSrc = blocks.find(b => b.includes("const DATA ="));
const DATA = JSON.parse(dataSrc.slice(dataSrc.indexOf("{"), dataSrc.lastIndexOf("}") + 1));
const mod = { exports: {} };
new Function("module", "exports", engineSrc)(mod, mod.exports);
const E = mod.exports.createEngine(DATA);

/* ---------- results state ---------- */
fs.mkdirSync(DATA_DIR, { recursive: true });
let results = fs.existsSync(RESULTS_FILE)
  ? JSON.parse(fs.readFileSync(RESULTS_FILE, "utf8"))
  : { group: { ...DATA.fixedResults }, ko: [] };

/* ---------- Kalshi helpers ---------- */
async function kget(p) {
  const r = await fetch(API + p, { headers: { "User-Agent": "wc26-edge-finder" } });
  if (!r.ok) throw new Error(`Kalshi ${r.status} on ${p}`);
  return r.json();
}
async function allMarkets(series, status) {
  const out = [];
  let cursor = "";
  do {
    const d = await kget(`/markets?series_ticker=${series}&status=${status}&limit=200${cursor ? "&cursor=" + cursor : ""}`);
    out.push(...(d.markets || []));
    cursor = d.cursor || "";
  } while (cursor);
  return out;
}
const $$ = m => ({
  ask: m.yes_ask_dollars != null ? +m.yes_ask_dollars : null,
  bid: m.yes_bid_dollars != null ? +m.yes_bid_dollars : null,
  noAsk: m.no_ask_dollars != null ? +m.no_ask_dollars : null,
  last: m.last_price_dollars != null ? +m.last_price_dollars : null,
  vol: m.volume_fp != null ? +m.volume_fp : 0,
});

/* ---------- team name resolution ---------- */
const ALIAS = {
  "usa": "United States", "united states": "United States", "turkiye": "Türkiye", "turkey": "Türkiye",
  "congo dr": "DR Congo", "dr congo": "DR Congo", "czech republic": "Czechia", "korea republic": "South Korea",
  "south korea": "South Korea", "cote d'ivoire": "Ivory Coast", "côte d'ivoire": "Ivory Coast",
  "ivory coast": "Ivory Coast", "cabo verde": "Cape Verde", "bosnia": "Bosnia and Herzegovina",
  "bosnia and herzegovina": "Bosnia and Herzegovina", "saudi arabia": "Saudi Arabia", "ir iran": "Iran",
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
// Kalshi ticker code -> model team name, learned from group-winner market titles
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

/* ---------- optional: sync winners from settled match markets ---------- */
async function syncResults(codeMap) {
  const settled = await allMarkets("KXWCGAME", "settled");
  const byEvent = {};
  for (const m of settled) (byEvent[m.event_ticker] ??= []).push(m);
  const added = [];
  for (const [ev, ms] of Object.entries(byEvent)) {
    const codes = /KXWCGAME-\d+[A-Z]+?([A-Z]{3})([A-Z]{3})$/.exec(ev);
    if (!codes) continue;
    const a = codeMap[codes[1]], b = codeMap[codes[2]];
    if (!a || !b) continue;
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
    added.push(`${f.key} -> ${score.join("-")} (winner from Kalshi; PLACEHOLDER SCORE — edit ${path.relative(process.cwd(), RESULTS_FILE)})`);
  }
  if (added.length) {
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
    console.log("Synced results:\n  " + added.join("\n  "));
  } else console.log("Sync: no new settled matches.");
}

/* ---------- edge math (buy-side, fee included) ---------- */
function evalSide(p, price) {
  if (price == null || price <= 0.005 || price >= 0.995) return null;
  const edge = p - price - FEE;
  return { price, edge, roi: edge / price, kelly: Math.max(0, (p - price - FEE) / (1 - price)) };
}

/* ---------- main ---------- */
const codeMap = await buildCodeMap();
if (SYNC) await syncResults(codeMap);
if (!fs.existsSync(RESULTS_FILE)) fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));

console.log(`Model: ${NSIM / 1000}k sims, ${Object.keys(results.group).length} group results in, Elo nudge on`);
E.setResults(results);
E.setOptions({ nsim: NSIM, eloUpdate: true });
const an = E.computeAnalytic();
const out = await E.run(() => {});

const today = new Date();
const candidates = [];
const mid = q => (q.bid != null && q.ask != null) ? (q.bid + q.ask) / 2 : q.last;
const market = { ts: new Date().toISOString(), source: "Kalshi (Robinhood prediction markets)", matches: {}, groups: {}, champ: {} };

/* match-winner markets */
const game = await allMarkets("KXWCGAME", "open");
const byEvent = {};
for (const m of game) (byEvent[m.event_ticker] ??= []).push(m);
for (const [ev, ms] of Object.entries(byEvent)) {
  const tk = /KXWCGAME-(\d{2})([A-Z]{3})(\d{2})([A-Z]{3})([A-Z]{3})$/.exec(ev);
  if (!tk) continue;
  const a = codeMap[tk[4]], b = codeMap[tk[5]];
  const fAny = E.fixtures.find(x => (x.a === a && x.b === b) || (x.a === b && x.b === a));
  if (fAny) { // snapshot implied probs for the website, regardless of horizon
    const imp = {};
    for (const m of ms) {
      const code = m.ticker.split("-").pop();
      const v = mid($$(m));
      if (v == null) continue;
      if (code === "TIE") imp.D = v;
      else if (codeMap[code] === fAny.a) imp.W = v;
      else if (codeMap[code] === fAny.b) imp.L = v;
    }
    if (imp.W != null || imp.D != null || imp.L != null) market.matches[fAny.key] = imp;
  }
  const date = new Date(`20${tk[1]} ${tk[2]} ${tk[3]} 12:00 UTC`);
  const daysOut = (date - today) / 864e5;
  if (daysOut < -0.7 || daysOut > DAYS) continue;
  const f = an.find(x => !x.played && ((x.a === a && x.b === b) || (x.a === b && x.b === a)));
  if (!f) continue;
  for (const m of ms) {
    const code = m.ticker.split("-").pop();
    const team = code === "TIE" ? null : codeMap[code];
    const p = code === "TIE" ? f.D : team === f.a ? f.W : team === f.b ? f.L : null;
    if (p == null) continue;
    const q = $$(m);
    candidates.push({
      kind: "MATCH", horizon: `${tk[2]} ${tk[3]}`, ticker: m.ticker,
      label: `${f.a} v ${f.b}: ${code === "TIE" ? "Draw" : team} (90 min)`,
      model_p: p, ...q, yes: evalSide(p, q.ask), no: evalSide(1 - p, q.noAsk),
    });
  }
}

/* group-winner markets */
for (const m of await allMarkets("KXWCGROUPWIN", "open")) {
  const seg = m.ticker.split("-");
  const team = codeMap[seg.pop()];
  const grp = seg.pop().replace(/^26/, "");
  if (!team || !out.group[team]) continue;
  const p = out.group[team].p1;
  const q = $$(m);
  if (mid(q) != null) market.groups[team] = mid(q);
  candidates.push({
    kind: "GROUP", horizon: "by Jun 27", ticker: m.ticker,
    label: `${team} wins Group ${grp}`,
    model_p: p, ...q, yes: evalSide(p, q.ask), no: evalSide(1 - p, q.noAsk),
  });
}

/* tournament winner (long-term, reported separately) */
for (const m of await allMarkets("KXMENWORLDCUP", "open")) {
  const team = codeMap[m.ticker.split("-").pop()];
  if (!team || out.champ[team] == null) continue;
  const p = out.champ[team];
  const q = $$(m);
  if (mid(q) != null) market.champ[team] = mid(q);
  candidates.push({
    kind: "CHAMP", horizon: "Jul 19", ticker: m.ticker,
    label: `${team} win World Cup`,
    model_p: p, ...q, yes: evalSide(p, q.ask), no: evalSide(1 - p, q.noAsk),
  });
}

/* best side per market, rank, log, report */
const plays = [];
for (const c of candidates) {
  for (const [side, e] of [["YES", c.yes], ["NO", c.no]]) {
    if (!e || e.edge <= 0) continue;
    plays.push({ ...c, side, ...e,
      desc: side === "YES" ? c.label : `AGAINST ${c.label}`,
      model_side_p: side === "YES" ? c.model_p : 1 - c.model_p });
  }
}
plays.sort((x, y) => y.kelly * y.edge - x.kelly * x.edge); // weight: edge × kelly ≈ EV growth

const MARKET_FILE = path.join(HERE, "..", "market.json");
fs.writeFileSync(MARKET_FILE, JSON.stringify(market, null, 1));
console.log(`Wrote market snapshot (${Object.keys(market.matches).length} matches, ${Object.keys(market.groups).length} group, ${Object.keys(market.champ).length} champ) to market.json`);

const ts = new Date().toISOString();
const log = candidates.map(c => ({
  ts, kind: c.kind, ticker: c.ticker, label: c.label, model_p: +c.model_p.toFixed(4),
  yes_bid: c.bid, yes_ask: c.ask, no_ask: c.noAsk, last: c.last, vol: Math.round(c.vol || 0),
  edge_yes: c.yes ? +c.yes.edge.toFixed(4) : null, edge_no: c.no ? +c.no.edge.toFixed(4) : null,
}));
fs.appendFileSync(TRACK_FILE, log.map(r => JSON.stringify(r)).join("\n") + "\n");
console.log(`Logged ${log.length} markets to ${path.relative(process.cwd(), TRACK_FILE)}\n`);

const fmt = p => (p * 100).toFixed(1).padStart(5) + "%";
function show(list, n) {
  for (const p of list.slice(0, n)) {
    console.log(`  ${p.side.padEnd(3)} ${p.desc}`);
    console.log(`      ${p.kind} · resolves ${p.horizon} · buy @ $${p.price.toFixed(2)} · model ${fmt(p.model_side_p)} vs market ${fmt(p.price)}`);
    console.log(`      edge ${fmt(p.edge)} after $0.01 fee · ROI ${(p.roi * 100).toFixed(0)}% · kelly ${(p.kelly * 100).toFixed(0)}% of bankroll · ticker ${p.ticker}`);
  }
}
const shortTerm = plays.filter(p => p.kind !== "CHAMP");
console.log("=== TOP 2 SHORT-TERM PLAYS (model assumed right) ===");
show(shortTerm, 2);
console.log("\n--- next best short-term ---");
show(shortTerm.slice(2), TOP - 2);
const lt = plays.filter(p => p.kind === "CHAMP");
if (lt.length) { console.log("\n--- long-term (tournament winner, resolves Jul 19) ---"); show(lt, 3); }
console.log("\nCaveats: assumes the model beats the market (your call, not evidence);");
console.log("90-min markets exclude ET/pens; prices move; check data/results.json has real scores.");

# WC26 Live Model

Monte Carlo simulator and live tracker for the 2026 FIFA World Cup — match odds, group and champion probabilities, betting-market comparison, and live scores, all in a single self-contained page.

**Live deployment:** the dynamic server (`server.mjs`) behind Google sign-in — see [`deploy/README.md`](deploy/README.md). There is no longer a public static GitHub Pages build: without a server it can't proxy Kalshi/ESPN or push live updates, so it went stale. Run it locally (below) or deploy the server.

## What it does

- **Monte Carlo engine** — simulates the full 48-team tournament (group stage through final) from Elo-style ratings, with ratings updated as real results come in. Everything lives in `index.html`: the engine, the team/fixture data, and the UI.
- **Live scores** — pulls the ESPN scoreboard API; live matches get a score ticker bar and in-table badges.
- **Betting market comparison** — pulls Kalshi (Robinhood prediction markets) prices for match winners, group winners, and the championship. Market lines that diverge ≥8pp from the model on a win side are highlighted green/red.
- **Model vs market scorecard** — every upcoming fixture's model line and market line are logged and frozen at kickoff; once the result is in, both are Brier-scored to track which forecaster is closer over time.
- **Prediction retention** — pre-game lines are snapshotted (or reconstructed exactly via deterministic Elo replay) so finished matches always show what the model said *before* kickoff, with ✓/✗ verdicts.

## How the model works

One pre-tournament **Elo-style strength rating** per team is the only thing seeded (in `DATA.ratings` in `index.html`) — e.g. Spain 2185, USA 1785, … Haiti 1510, on the standard Elo scale (a 400-point gap ≈ 10:1 odds). Everything else is derived from pairwise rating differences:

1. **Gap compression** (κ = 0.62 around 1800): `r' = 1800 + 0.62·(r − 1800)`, so favorites don't get absurd blowout odds.
2. **Match rating diff `d`** = compressed-rating gap + host bonus (+75 group / +40 knockout for USA/Mexico/Canada at home venues) + per-tournament form noise (σ = 70).
3. **Goals (Poisson):** `λ_home = (μ/2)·e^( C·d/400)`, `λ_away = (μ/2)·e^(−C·d/400)` with μ = 2.6 total goals, clamped to [0.15, 4.6]. `C ≈ 0.87` is auto-calibrated at startup so the model's `W + ½D` matches the Elo logistic `1/(1+10^(−d/400))`. Each side's goals are drawn as independent Poissons → a scoreline.
4. **Tournament Monte Carlo:** 20–40k simulations of the full 48-team bracket (groups → Annex C third-place allocation, all 495 combos → knockouts with extra time and Elo-skewed penalties), using a counter-based RNG seeded at 2026 so identical inputs give identical odds (every Δ is caused by a result, not noise).

**Live updating:** played matches are locked at their real score; a margin-weighted Elo nudge (K = 40) re-rates teams from those results in chronological order — using the model's own pre-match line as the expectation — then the remaining tournament is re-simulated. So a result bumps a team's raw rating, which is recompressed and re-flows into every downstream group/advancement/champion probability.

## Running locally (full dynamic version)

```bash
npm install
npm start          # http://localhost:3000
```

The local Express server (`server.mjs`) is what makes the model live:

- Server-side proxying of Kalshi (which blocks browser CORS) and ESPN
- Server-sent events (`/sse`) pushing scores/market/model updates to the page — 30s cadence during live matches, 90s otherwise
- Automatic result syncing from settled markets, and the pre-game prediction log

### API

| Endpoint | Description |
|---|---|
| `GET /api/scores` | Live/recent scores keyed by fixture |
| `GET /api/market` | Kalshi match / group / champion prices |
| `GET /api/analysis` | Current + opening model lines for all 72 group fixtures |
| `GET /api/scorecard` | Brier-scored model-vs-market comparison |
| `GET /api/status` | Quick health: live matches, market lines, results in |
| `POST /api/refresh` | Force a refresh cycle |
| `GET /sse` | Event stream for live page updates |

## Tools

- `tools/edge_finder.mjs` — compares model probabilities against Kalshi prices, applies a fee-adjusted Kelly criterion, and prints the top short-term plays. Appends every observation to `tools/data/track.jsonl`.

  ```bash
  node tools/edge_finder.mjs --days 3 --top 2
  ```

## Data files

| File | Purpose |
|---|---|
| `tools/data/results.json` | Ground-truth match results (edit manually or auto-synced) |
| `tools/data/predlog.json` | Pre-game model + market lines, frozen at kickoff |
| `tools/data/track.jsonl` | Per-market odds observations from edge_finder |
| `market.json` / `scorecard.json` | Latest snapshots the server writes each refresh; also the in-page fallback if `/api/*` is unreachable |

## Notes

- Market probabilities are de-vigged (normalized to sum to 1) before Brier scoring so the comparison with the model is fair.

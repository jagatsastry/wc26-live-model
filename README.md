# WC26 Live Model

Monte Carlo simulator and live tracker for the 2026 FIFA World Cup — match odds, group and champion probabilities, betting-market comparison, and live scores, all in a single self-contained page.

**Live (static) version:** https://jagatsastry.github.io/wc26-live-model/

## What it does

- **Monte Carlo engine** — simulates the full 48-team tournament (group stage through final) from Elo-style ratings, with ratings updated as real results come in. Everything lives in `index.html`: the engine, the team/fixture data, and the UI.
- **Live scores** — pulls the ESPN scoreboard API; live matches get a score ticker bar and in-table badges.
- **Betting market comparison** — pulls Kalshi (Robinhood prediction markets) prices for match winners, group winners, and the championship. Market lines that diverge ≥8pp from the model on a win side are highlighted green/red.
- **Model vs market scorecard** — every upcoming fixture's model line and market line are logged and frozen at kickoff; once the result is in, both are Brier-scored to track which forecaster is closer over time.
- **Prediction retention** — pre-game lines are snapshotted (or reconstructed exactly via deterministic Elo replay) so finished matches always show what the model said *before* kickoff, with ✓/✗ verdicts.

## Running locally (full dynamic version)

```bash
npm install
npm start          # http://localhost:3000
```

The local Express server (`server.mjs`) adds what GitHub Pages can't:

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
| `market.json` / `scorecard.json` | Latest snapshots, used as static fallbacks by the Pages version |

## Notes

- The static GitHub Pages build is fully functional but reads market/scorecard data from the committed JSON snapshots; the local server keeps those fresh.
- Market probabilities are de-vigged (normalized to sum to 1) before Brier scoring so the comparison with the model is fair.

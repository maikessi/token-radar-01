# Token Radar — radar-2

Pre-token DeFi protocols ranked by implied value, with a farm plan for each. A make.fun
bounty entry for `token-radar-01` (Build the best token launch radar).

## What it does

`main.ts` (Node 22, standard library only) reads the sealed snapshot at
`/input/snapshot.json`, scores every rankable pre-token protocol, and writes:

- `board.json` — the ranked board (198 rows: all 40 watchlist protocols plus every other
  pre-token protocol that passes the watchlist's own rule)
- `data.js` — the same board, compact, for the dashboard
- `dashboard/` — the page: sortable and filterable board, per-protocol detail with the
  model's factor breakdown and a 7-step farm plan, live-token view
- `screenshots/` — the board, a detail view and a filtered view
- `dossier.json` — the judge's dossier, built with the vendored make.fun library

## The model (radar-2)

Implied value is **calibrated, not asserted**: each category's multiple is the median
market-cap-to-TVL ratio of that category's live-token protocols in the same snapshot
(five or more of them, else the global median of 0.22×). Then three snapshot-only
factors apply: growth (the week's TVL move, weighted by age, rewarded at 0.6 and
charged at 0.9 when it falls), maturity (0.5 + min(age, 1460d) / 1460d × 0.7 — running
for years with no token on record is itself the signal; an unknown listing date is
scored at 516 days, the snapshot's own median pre-token age), and chains (+0.03 per
chain past the first, up to five). Wrapped, staked and bridged products of tokens
that already trade are never ranked: they are not launches of their own.

The dashboard recomputes every row from the same figures, so the page and
`board.json` agree, and shows the calibration table the multiples were read from.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|directory>
```

The run is fully deterministic: same snapshot, same bytes, every time.

## License

MIT — see `LICENSE`.

# Bayn hybrid HF v5 — stop-compatible crash∩VWAP

**Promote: NO** (live `jev` unchanged; `strategy.ts` / GitOps not flipped)

**Blunt:** Under **hard stop=50**, bounce-confirmed crash∩VWAP **clears dual OOS @10bp ≥$3k**.
Best cell ≈ **+$10.7k** on $100k×20%, tps≈1.17, all 4 chron. quartiles >0, survives 15bp.
Edge is **semi/high-beta concentrated** (CRDO/SNDK/MRVL). Mega-only ≈ noise.

## Corpus

- Bars: `/tmp/bayn-research/v3/alpaca_iex_2026.tsv` (191 RTH sessions 2026-01-02→2026-10-06, Alpaca IEX 1m)
- Cost stress: 5 / 10 / 15 bp RT
- Notional: $20k (100k×20%)

## What changed vs v4

| | v4 | v5 |
|---|---|---|
| Best stop=50 | **−$4.6k** (crash100/thr80, no bounce) | **+$10.7k** (crash80/thr60, **bounce+1m**) |
| Unlock | longer hold alone | **bounce confirmation** before entry under hard50 |
| Mandate | wider stop or none | hard50 viable **with entry filter** |

v4’s no-stop winner (~+$12k) still reproduces. Delayed-arm stop=50 prints even larger (~+$22k) but is a **mandate change** (unprotected first 15m) — secondary path.

## Winner (RESEARCH) — stop=50 hard, no mandate change

```
family:     crash ∩ VWAP
crash:      1m return ≤ −80 bp
vwap_dist:  close vs session VWAP ≤ −60 bp
age:        ≥30m after RTH open
bounce:     wait +1m; require close[t+1] > close[signal]
entry:      next bar after bounce confirm
hold:       90m (flatten 15:55 ET)
stop:       hard −50 bp (Bayn current)
cost:       10 bp RT (stress OK at 15)
```

| Metric | Value |
|--------|-------|
| n / tps | 223 / 1.17 |
| pnl @10bp | **+$10,693** |
| mean_net / hit | +24.0 bp / 26.5% |
| train / test | +14.0 / +36.4 bp |
| q1–q4 | +20.5 / +6.2 / +38.6 / +29.8 (all >0) |
| stop_frac / mean_hold | 72.6% / 37.1m |
| max DD | −$2,263 |
| @15bp | +$8,463 dual still |

### Symbol concentration (critical)

| Symbol | ~PnL |
|--------|------|
| CRDO | +$6.1k |
| SNDK | +$2.5k |
| MRVL | +$1.7k |
| AMD | +$0.9k |
| LITE | −$1.4k |

- Drop CRDO alone: still **+$6.3k dual**
- Drop CRDO+SNDK: dual **fails** (train <0)
- Mega-only / skip_high_vol: n≈6, unusable

This is a **fat-tail rebound harvest on semis**, not a broad mega-cap edge.

## Stop-variant ranking (dual ≥$3k @10bp)

1. **Delayed arm 15m + stop50** — best pnl ~+$22k; **mandate change** (no protection first 15m)
2. **Hard50 + bounce1** — ~+$10.7k; **current Bayn stop compatible**
3. Soft50 (30% exit at −50) — ~+$10.8k; mandate soft-stop change
4. Wider hard 75/100/150 — clear; mandate wider stop
5. No-stop / time-only — clear (v4 path); mandate remove stop

## Invalid / weak

- Full-session quantile (v4a) — still INVALID
- Mega-only bounce filter — no edge
- Hit rate ~26% under hard50 — expected; winners must be large

## Files

- `ranked_v5.csv` — 11,520 eval grid
- `summary_v5.json` — survivors + blunt
- `validate_winner.json` — cost stress + reason breakdown
- `loo_symbol.json` — leave-one-symbol-out
- Screener: `/tmp/bayn-research/v5/screen_stop_compat.py`

## Promote gates still unmet

- In-sample / dual-half on same 191d used for search → **RESEARCH_ONLY**
- Need prospective pre-registered freeze (≥20 sessions) before acceptance v2
- Concentration risk must be accepted or universe constrained in protocol
- Do **not** flip `strategy.ts` / GitOps on this pack alone

## Shadow wire

`services/bayn/src/jev/hybrid-crash-vwap-gate.ts` — `BAYN_HYBRID_CRASH_VWAP=off|shadow` (default off).
`on` coerced to shadow. Live fills unchanged.

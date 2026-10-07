# RESEARCH candidate: crash∩VWAP + bounce confirm (v1)

**Status:** `RESEARCH_ONLY` — not promoted. Live strategy remains `jev`.

**Schema:** `bayn.research-candidate.crash-vwap-bounce.v1`

## Intent

High-frequency hybrid producer: **bars emit candidates**; **Jev (or a future decision layer) only decides** size/enter/exit within Bayn envelope. This document freezes the **signal definition** that cleared stop=50 dual OOS on the 191d IEX research corpus (evidence `2026-10-07-hybrid-hf-v5`).

## Signal definition (frozen for shadow)

| Field | Value |
|-------|-------|
| Family | `crash_vwap_bounce` |
| Crash | 1-minute close-to-close return ≤ **−80 bp** |
| VWAP distance | `(close / session_vwap − 1) × 1e4 ≤ −60` |
| Session age | ≥ **30** minutes after RTH open (09:30 ET) |
| Bounce confirm | Wait **+1** minute; require `close[t+1] > close[signal]` |
| Entry | Close of bounce bar (or next open in live wiring) |
| Max hold | **90** minutes |
| Stop | **Hard −50 bp** (current Bayn mandate — no change) |
| Flatten | 15:55 ET |
| Position | ≤1, ≤20% equity (Bayn envelope) |
| Cost stress | Research scored at **10 bp** RT; winner also dual-positive at 15 bp |

## What this is not

- Not acceptance v2 completion
- Not a claim of live profitability
- Not a mega-cap / SPY-relative strategy — edge is **semi/high-beta** (CRDO/SNDK/MRVL heavy)
- Not a license to remove or widen the 50 bp stop

## Evidence summary (191d IEX, research)

- PnL ≈ **+$10.7k** on $100k×20% @10bp; dual train/test +14 / +36 bp; all quartiles >0
- tps ≈ 1.17; hit ≈ 26.5%; stop_frac ≈ 73%; max DD ≈ −$2.3k
- Drop CRDO: still dual ≥$6k; drop CRDO+SNDK: dual fails
- Full table: `docs/bayn/evidence/2026-10-07-hybrid-hf-v5/`

## Mandate note (alternate paths, not this candidate)

These **also** cleared dual ≥$3k but require explicit protocol change before any promote attempt:

1. Delayed stop arm 5–15m with stop=50 (~+$20k cells) — unprotected window
2. Soft stop (partial exit at −50) 
3. Wider hard stops 75 / 100 / 150
4. No stop / time-stop only (v4 path)

**This candidate uses hard stop=50** so it does not require a mandate change.

## Shadow mode

Env: `BAYN_HYBRID_CRASH_VWAP`

| Value | Behavior |
|-------|----------|
| `off` (default) | No-op |
| `shadow` | Evaluate producer; log compare record `bayn.hybrid-crash-vwap.shadow.v1`; **no fill change** |
| `on` | Coerced to `shadow` until a separate promotion RFC |

## Prospective freeze checklist (before any promote RFC)

1. Pre-register params above (no retune mid-window)
2. ≥20 session calendar, held out from this 191d search
3. Paired control (e.g. same opportunities without bounce, or buy&hold sleeve)
4. Document universe: either accept semi concentration or constrain symbols in protocol
5. Quote spread ≤5 bp gate if acceptance v2 requires it
6. Only then consider flipping live path — **not done here**

## Blunt recommendation

**Best path under real Bayn constraints:** shadow this hard50+bounce definition now; collect prospective sessions; do **not** chase delayed-arm/$22k prints without a written stop-mandate change. If prospective fails, the honest fallback is mandate wider/delayed stop on crash-reversion only — still not a silent `strategy.ts` flip.

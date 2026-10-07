# Momentum-first Jev candidate

Status: implemented research candidate, inactive by default. No qualification, broker order, capital grant, or active
mandate follows from these changes. The retained control has not established positive net economics.

## Exact entry policy

`bayn.positive-relative-momentum-entry.v1` admits a flat-portfolio candidate only when its verified current midpoint
is strictly above its 30-minute reference and its exact return minus SPY's exact return is strictly positive. Comparisons
use integer price micros and exact rational arithmetic; rounded displayed basis points never decide admission. A positive
stock return can qualify while SPY is declining. There is no restored 15 bp absolute threshold, 10 bp excess threshold,
breakout threshold, range-location threshold, new technical indicator, or calibrated profit claim.

Existing source identity, complete window, freshness, two-sided displayed-size and maximum 5 bp entry-spread checks
remain. The complete recorded candidate universe survives as requested candidates or explicit exclusions. Missing,
future, malformed or stale evidence cannot become a valid non-signal. If every candidate is positively verified but
fails an entry gate, the batch makes zero model calls and produces zero targets. A fully non-requested batch containing
unknown source candidates remains unusable.

Jev receives only admitted signals. It retains the existing `enter`/`wait`/`avoid` question and 0.65 chosen-enter
probability boundary. Among accepted signals, selection retains descending Jev enter probability, then symbol for ties.
This is a momentum eligibility gate before Jev, not a new momentum-ranked portfolio. Choosing the highest exact
relative-return candidate among accepted signals is a separate research hypothesis: it changed 5 of 26 selections in
an exposed retained-state projection. Gate-only admitted all 26 old projected selections, but that does not establish
unchanged future decisions, timing, orders, fills, or P&L.

Sizing remains one position and the existing 0.2 gross/symbol target weight, subject to all lower execution/account
limits. Jev cannot create an ineligible signal or override risk. Management retains the current held-position Jev
hold/exit evaluation, threshold, 50 bp protective stop, 15-minute maximum hold, and session-close liquidation. Entry
momentum and spread filters never suppress required management or protective exits. The separate management-horizon
prompt ambiguity is not changed here.

## Bounded runtime and immutable evidence

- Protocol `bayn.jev.protocol.v2` requires the explicit entry policy; v1 forbids it. Its different parameter and strategy
  identity prevents the changed admission rule from inheriting a retained protocol or capital grant
- Batch `bayn.jev-batch-plan.v4` requires protocol v2 and permits explicit `momentum` exclusions. Old v1–v3 batches keep
  their original admission, request and replay identities. Policy identity stays outside the model prompt: an identical
  surviving snapshot and portfolio produces byte-identical state, questions and model. The new cycle/authority,
  observation, protocol and batch identities bind the changed admission rule; management question payloads stay unchanged
- The candidate behavior hash is `sha256('bayn.jev.momentum-first.behavior.v1')`. Execution-decision validation accepts
  only the exact source-controlled candidate protocol paired with that behavior and batch v4. This is evidence
  compatibility, not authority. Default strategy composition continues the existing protocol v1 and behavior v3
- Native evaluation and control-management replay select the matching batch version from the supplied protocol. New
  entry pricing keeps the existing v3 separate fresh-quote lifetime, with unchanged final spread/size and risk checks
- Keep one durable observation per completed signal minute/purpose/cycle, the existing minute-plus-two-second window,
  pending-batch recovery, ten-second original deadline, at most fifteen eligible concurrent requests, and no queued
  historical catch-up. Every requested result must finish validly before selection. No top-K cutoff is introduced
- Preserve polling budgets and protective/reconciliation checks. This candidate does not shorten controller or broker
  polling intervals, add model retries, add quote subscriptions, or activate the separate turnover-cap change

The exposed workload projection retained 132 of 300 entry requests; 127 belonged to usable batches. These are
same-state workload counts, not a causal forecast of saved money or activity. Smaller batches can change execution
latency and later portfolio state. Count every attempted, rejected, failed and late call in evaluation costs.

## Review and bounded PAPER activation

This change does not select the candidate in `strategy.ts` or alter deployment configuration, default strategy,
mandates, grants or broker risk limits. Activation is a separate reviewed source/mandate pairing, not an environment
toggle or generic strategy registry.

The existing backtest CLI deliberately remains bound to the active source protocol. It does not silently select this
inactive candidate. Tests exercise the native candidate evaluator and PostgreSQL persistence directly; an empirical
research run still requires the separately reviewed source/mandate pairing below. Migration 0090 permits v2/v4 evidence
and preserves all existing payload, strategy-pair and append-only constraints; it does not modify any retained row.

Before activating an authorized PAPER research attempt:

1. Review the exact merged source and passing unit, type, lint, build, native persistence and CI evidence. Verify old
   decision replay and new source/behavior/protocol/mandate hashes end to end. Drain/reconcile existing cycles through
   the established activation path; never rebind an existing grant to a changed selection policy
2. Freeze candidate, all mandatory controls, source, parameters, unchanged questions/input representation plus the
   admission policy, timing, costs, universe, execution assumptions and registered calendar before the first untouched open.
   Preserve the [frozen acceptance contract](jev-migration-acceptance-v2.json), including every failed attempt, the
   $100,000 PAPER allocation, its activity/risk criteria and all twenty consecutive prospective sessions. An unresolved
   larger turnover-cap authorization is separate and supplies no authority here
3. Compare both delay-matched same-opportunity selection and native-clock independent-portfolio all-in results. Include
   submitted-but-unfilled attempts, partial fills, failed/late model charges, allocated data costs, adverse execution
   stress, full batch completion plus persistence/routing time and reconciled flat closes. Do not present retained-state
   call filtering as an untouched backtest or profitability result
4. Use the existing reviewed main/image/Kargo/GitOps/native activation path only after approval of that exact PAPER
   scope. Verify the running image, selected protocol and account mandate agree. Stop research admission on evidence,
   accounting, loss/drawdown or authority failure while preserving risk-reducing management. Do not tune during the
   registered window; a material revision needs another immutable attempt and untouched evaluation

No higher trading frequency or volume is forced. This candidate reduces irrelevant model evaluation; any economic
improvement remains an empirical question under the unchanged risk and cost constraints.

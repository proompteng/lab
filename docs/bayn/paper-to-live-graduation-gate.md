# Bayn Paper-to-live graduation gate

Run this read-only gate before proposing live capital for B0 (intraday), F4 (macro core), or O1 (macro canary).
`READY_FOR_REVIEW` means the retained evidence passed these checks. It does **not** grant trading authority, verify
the intended live broker account, activate a policy or feed, or replace the account-specific review in the
[three-account capital plan](three-account-capital-plan.md#graduation-gates).

## Run the gate

Use the pinned checkout and locked dependencies. Keep the inputs and reports in approved private evidence storage.
Repeat each input flag for each file; give the gate the complete set of registered, closed sessions, not a sample
selected after observing returns.

```sh
: "${EVIDENCE:?set the private evidence directory}"
umask 077
set -o noclobber
bun services/bayn/tools/evaluate-live-graduation.ts \
  --audit "$EVIDENCE/b0-audit.json" \
  --sleeve-receipts "$EVIDENCE/portfolio-2026-11-27.json" \
  --sleeve-receipts "$EVIDENCE/settlement.json" \
  --sip-evidence "$EVIDENCE/sip-2026-11-27.json" \
  --policy "$EVIDENCE/graduation-policy.json" \
  --format json > "$EVIDENCE/graduation-verdict.json"
```

The paths illustrate the flags, not a complete evidence set. JSON is the default. Use `--format markdown` with the
same inputs for the operator summary. Compare the evidence digest before attaching both reports to a review. The CLI
reads local files only; it needs no credentials and does not write to a database, call Alpaca, issue orders, grant
capital, or write any files. Shell redirection above retains stdout even for a nonzero verdict.

| Result                             | Meaning                                                                                                                                 |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `READY_FOR_REVIEW` (exit 0)        | Every sleeve and shared portfolio gate passed. Read `minimumMode` as well.                                                              |
| `BLOCKED` (nonzero)                | A known breach or lack of SIP proof vetoed review. A known breach takes precedence over gaps.                                           |
| `INSUFFICIENT_EVIDENCE` (nonzero)  | Evidence is missing, incomplete, stale, or outside the completed window.                                                                |
| Input error (nonzero, stderr only) | Unreadable file, invalid JSON/schema, overlapping dates, or failed integrity check. The diagnostic does not echo input values or paths. |

JSON uses `bayn.live-graduation-verdict.v1`. Automation should require exit 0 **and** the top-level verdict, not a
single sleeve result. Findings identify the affected session where available. `evidenceDigestSha256` is the Bayn
canonical SHA-256 of `{schemaVersion: "bayn.live-graduation-evidence-digest.v1", files: fileHashes}`: each file is
hashed byte-for-byte and the hashes are sorted by input role. Filenames and flag order are not part of the digest.
Changing whitespace in a file changes its hash. The CLI uses the current clock to determine which closes have
elapsed; a digest stays stable while the readiness of the same input can expire.

## Collect the evidence

1. **B0 audit (`--audit`).** Supply current `bayn.live-profitability-audit.v1` reports with individual
   `slippageGate.roundTripBps` samples. Use retained **Paper** observations and the auditor's
   [offline mode](live-profitability-audit-runbook.md#offline-replay-and-optional-market-data) if the live audit
   connection is live-account-only. A report by itself does not identify the account or prove the session used SIP.
   Do not substitute live-account evidence, a weekend placeholder, a screenshot, or a rounded daily mean/median.
2. **F4 and O1 plans (`--sleeve-receipts`).** Supply the
   [daily multi-account runner](multi-account-sleeve-architecture.md) `bayn.multi-account-daily-sleeves-receipt.v1`
   for each macro execution session. Keep both sleeve outcomes, including legitimate no-order days. The gate checks
   receipt and plan digests, separate $10k Paper accounts, profile, disposition, and previous-close/next-open
   alignment. A submitted plan acknowledges dispatch, not fills, P&L or reconciliation.
3. **Settled account evidence (`--sleeve-receipts`).** Supply one or more
   `bayn.live-graduation-settlement.v1` files with a `sessions` array. Normalize each row from independently retained
   post-close Paper broker, ledger and fee records. There is no synthetic fallback or live collection in this CLI.
   If the source cannot establish a fact, leave the row unavailable or set `settled: false`; never substitute zero.
4. **SIP parity (`--sip-evidence`).** Supply one [SIP shadow verifier](consolidated-sip-shadow-rollout.md#verify-five-consecutive-completed-trading-sessions)
   `bayn.sip-shadow-parity-report.v1` file per session for at least the latest five consecutive completed sessions.
   The gate verifies their calendar, coverage, universe, spread and latency checks. Passing shadow receipts alone do
   not establish which feed B0 actually used. The B0 settlement rows must establish real-time SIP consumption
   throughout its registered window. IEX use or entirely absent SIP reports result in `IEX_ONLY_BLOCKED` in the
   `sip` field; that status means SIP is not proven, not that the CLI probed the active feed.

### Settlement file rows

Provide one row per sleeve and registered completed session, with no duplicates:

| Fields                                                                                                   | Required evidence                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sleeve`, `date`, `accountId`, `broker`                                                                  | `B0`, `F4`, or `O1`; New York trade date; corresponding verified Paper UUID; literal `alpaca-paper`.                                                                                                                                                             |
| `observedAt`, `sourceSha256`, `settled`                                                                  | Canonical UTC timestamp with milliseconds at or after the provider close (and for B0 at or after the audit cut), SHA-256 of the independently retained source bundle, and whether the full session's orders, inventory, ledger and fees are settled.             |
| `reconciliationMismatches`, `unmatchedFeeExceptions`, `unresolvedOrders`, `unresolvedFills`, `incidents` | Explicit nonnegative counts from the source, plus an array of observed `NON_FLAT_EOD` / `REGULAR_CLOSE_BREACH` codes. Expected overnight macro inventory is **not** a non-flat incident.                                                                         |
| `openingEquityMicros`, `netRealizedMicros`                                                               | Positive opening equity and signed realized P&L net of finalized fees, as decimal integer strings in USD micros. Exclude deposits, withdrawals and unrealized marks from realized P&L. B0 must match the audit's opening equity and receipt-bound net economics. |
| B0: `auditSessionSha256`, `feed`                                                                         | Bayn canonical SHA-256 of the exact decoded **session object**, not the file hash; actual observed feed (`sip` or `iex`). See the [scorecard's audit digest](profitability-master-playbook.md#daily-scorecard-and-the-promotion-boundary).                       |
| F4/O1: `portfolioSha256`                                                                                 | Exact digest from that execution session's daily portfolio receipt. Both rows bind the same digest, with different verified Paper account IDs.                                                                                                                   |

### Registered policy

Supply `bayn.live-graduation-policy.v1`:

| Field                                 | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `registeredAt`                        | UTC timestamp with milliseconds before the first B0 open. Register the window, identities, limits and research references before seeing results.                                                                                                                                                                                                                                                                                                                                                                                                                |
| `firstB0Session`, `firstMacroSession` | First required date for B0 and for the F4/O1 pair. Macro may start later, never earlier. All subsequent completed calendar sessions are required.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `calendar`                            | `{ query: { start, end }, response, normalizedResponseHash }` from the retained Alpaca v2 calendar cut. Keep every provider row (including `date`, `open`, `close`, `session_open`, `session_close`). Use the digest from Bayn's `normalizeMarketCalendarResult(response, query)`. Cover the session before the macro start through at least the current New York date; refresh the calendar without changing the registered start or limits. The gate uses provider regular hours, including early closes, and rejects a latest close more than five days old. |
| `paperAccounts`                       | Object keyed by `B0`, `F4`, and `O1`, with three distinct verified Paper UUIDs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `drawdown95`                          | Object keyed by `B0`, `F4`, `O1`, and `portfolio`, each with `{ fraction, researchSha256 }`. Pin reviewed, comparable 95th-percentile drawdown limits and source digests (e.g. a 2% limit is fraction `0.02`). A historical maximum or an unrelated strategy's p95 is not interchangeable with a matching research p95. Missing policy cannot pass; the gate does not invent a drawdown threshold.                                                                                                                                                              |
| `minimumSessions`, `minimumMode`      | Optional per-sleeve integer minimums. Defaults: B0 **20**, F4 and O1 **10** each. To lower one, explicitly set `minimumMode: "CUSTOM_OVERRIDE"`; this is surfaced in both formats. Unmarked reductions are input errors. No override disables the other checks.                                                                                                                                                                                                                                                                                                 |

The input contracts are unsigned. Digests bind files, joins, and the normalized calendar, not the authors' identities.
Operators must verify who collected the retained source bundles, that the registration/calendar is complete, and that
the reviewed p95 values match the same drawdown definition. Retain their references and the CLI invocation time
with the result. Do not edit hash-locked research data or drop an incident date to repair a verdict.

## How the hard gates work

- A clean completed session requires its registered close and all of its account-bound evidence. Missing interior
  or most-recent receipts, in-session observations, unresolved reconciliation or fee exceptions, and known execution
  breaches cannot be silently skipped. A later flatten cannot erase a regular-close breach.
- B0 requires zero non-flat or regular-close incidents, **positive cumulative net realized P&L**, and **both** the
  mean and median of all individual B0 round-trip slippage observations strictly below **2.5 bp**. The gate pools
  samples without using rounded daily summaries. Losing but reconciled individual days are not removed.
- Each sleeve's realized drawdown starts with the first registered opening equity and adds finalized session net
  realized P&L in order. The portfolio uses the overlapping F4/O1 window, summing the three openings at its start and
  summing net P&L by date. Compare each maximum peak-to-trough loss divided by the preceding peak with its own p95
  ceiling. This is a session-close, realized-only measure, not intraday or mark-to-market risk. Portfolio gains
  cannot offset a failed sleeve gate.

If the result is blocked or incomplete, stay in Paper and preserve the evidence. Investigate exceptions with the
[audit runbook](live-profitability-audit-runbook.md) and [small-account operations guide](small-account-10k-operations.md).
If it is ready, attach the reports and evidence digests to the independent operator/risk review. Continue to enforce
the longer [O1 prospective acceptance](macro-canary-etf-rollout.md#prospective-120-session-acceptance) and all existing
account, strategy and grant requirements.

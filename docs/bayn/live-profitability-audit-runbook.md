# Bayn live profitability and execution audit

Use this read-only audit to investigate an equity session on one live Bayn account. It is not a strategy qualification,
capital authorization, broker settlement certificate, or instruction to trade. It makes no calls to the broker.

## Connect to the standby

From the repository root, install dependencies with `bun install --frozen-lockfile`. Verify the Kubernetes context and
identity using the [cluster access runbook](../runbooks/galactic-kubernetes-access.md).

Use the CNPG-managed `bayn_audit_ro` login, not the application writer or `bayn_research`. Before rollout, provision
`bayn/bayn-audit-ro-db` through the approved secret-sync path as a `kubernetes.io/basic-auth` Secret with username
`bayn_audit_ro`, its dedicated password, and label `cnpg.io/reload: "true"`. Confirm that CNPG reconciles the role
before Bayn runs [migration 0226](../../services/bayn/migrations/0226_audit_reader_grants.ts). If the
migration was recorded before the role existed, have the database owner apply that migration's guarded SQL block on
the primary through the approved administration path. Do not edit migration history. Verify the role can read
`public.orders` but has no write privileges on Bayn tables, and wait for the standby to catch up before running the audit.

Run this in a separate terminal:

```sh
kubectl -n bayn port-forward --address 127.0.0.1 service/bayn-db-ro 55432:5432
```

Through the approved credential path, export `BAYN_POSTGRES_URL` for user `bayn_audit_ro`, database `bayn`, and
host/port `127.0.0.1:55432`. Use a PostgreSQL URI with URL-encoded credentials and no TLS query options. Do not put
the URI or password in CLI arguments, shell history, or an incident report. Export `BAYN_AUDIT_ACCOUNT_ID` for the
verified live Alpaca account. Use an approved copy of the CNPG server CA, or extract only the public `ca.crt` if
authorized to read the CA Secret:

```sh
export BAYN_POSTGRES_TLS=true
BAYN_POSTGRES_CA_PATH=$(mktemp)
export BAYN_POSTGRES_CA_PATH
kubectl -n bayn get secret bayn-db-ca -o jsonpath='{.data.ca\.crt}' | base64 --decode > "$BAYN_POSTGRES_CA_PATH"
export BAYN_POSTGRES_TLS_SERVERNAME=bayn-db-ro.bayn.svc.cluster.local
```

TLS defaults to enabled, with CA path `/var/run/secrets/bayn/postgres/ca.crt` when not set. For a direct standby
connection, leave `BAYN_POSTGRES_TLS_SERVERNAME` unset if the URL host matches the certificate's DNS SAN. With
port-forwarding, the URL still dials localhost, but the TLS name must be a DNS SAN on the CNPG certificate, not
`127.0.0.1`. An unreadable or invalid CA file, an untrusted chain, or a mismatched name fails the audit; never
disable TLS or verification to work around it. If the standby or the audit login is unavailable, stop or replay an
approved offline fixture. The command uses one repeatable-read, read-only transaction in addition to the role's
SELECT-only grants.

## Monday 2026-11-30: verify the opening cut

Shortly after 09:30 ET, after the first Monday reconciliation and before interpreting any new entries:

```sh
bun services/bayn/tools/audit-bayn-live-profitability.ts --session 2026-11-30 --format markdown
```

- Compare Monday's **opening ledger quantity** (start of the New York date) and latest ledger/broker quantities for
  GOOGL. Zero at the latest cut does not erase an opening carry. If a later flatten occurred, confirm the canonical
  fill and its accounting receipt. A missing or stale broker snapshot is not a flat snapshot.
- Check that the reconciliation is exact, the broker positions snapshot is at or after the regular open, and no later
  order/fill evidence invalidates it. The scorecard includes the reconciliation timestamp, working orders, and
  unresolved fill counts. A verified zero broker position count means there are no equity positions in that snapshot. An early or missing cut normally yields `INSUFFICIENT_EVIDENCE`, not an EOD failure.
- Rerun Friday independently to check for late fee posting or retained evidence before closing the incident:
  `bun services/bayn/tools/audit-bayn-live-profitability.ts --session 2026-11-27 --format markdown`.
  Friday's regular close was 13:00 ET (18:00Z). Check for `NON_FLAT_EOD`, `REGULAR_CLOSE_BREACH`, the GOOGL
  $275.31 stop / $275.58 limit, and the controller counts. The
  [recorded Black Friday incident](incidents/2026-11-27-black-friday-googl-unclosed-exit.md) occurred on Alpaca Paper.
  Its regression fixture models that failure for the live auditor; read back the actual paper account separately
  with the existing [paper session audit](intraday-v2-1-execution-upgrade.md#post-close-paper-promotion-separate-reviewed-change). An unmatched fee activity count of zero only describes
  retained activities; verify cash settlement with the authorized broker/accounting readback before declaring it final.
- If positions, working orders, fees, or reconciliation disagree, attach the redacted scorecard to the existing
  incident and escalate to the Bayn operator. Do not cancel, liquidate, rearm, or change authority from this tool.

## Daily after the regular close

Wait for a post-close exact reconciliation covering that day's fills and order events, and for the standby to catch up.
Set `SESSION` to the New York session date (not the invoking machine's UTC date):

```sh
bun services/bayn/tools/audit-bayn-live-profitability.ts --session "${SESSION:?set YYYY-MM-DD}" --format markdown
```

Use `--from 2026-11-27 --to 2026-11-30 --format json` for per-date machine-readable results (inclusive, up to 31
calendar dates). A date without retained calendar or execution evidence cannot pass. Future dates have no database
cut. Exit status zero means a report was produced, **not** that any session passed; automation should inspect
`sessions[].verdict` and `sessions[].slippageGate.promotion`.

| Signal                    | Interpretation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Economics                 | Realized P&L comes from receipt-bound accounting. Direct fees come from fills; posted session-dated regulatory fees are account-only, not guessed by symbol or sleeve.                                                                                                                                                                                                                                                                                                                                              |
| Stranded P&L and exposure | Unrealized P&L is the broker mark in a post-close bound reconciliation that agrees with reconstructed inventory. No valid mark is reported as unknown, not zero.                                                                                                                                                                                                                                                                                                                                                    |
| Turnover                  | Two-sided traded notional divided by opening account equity, multiplied by 252. Each row is a one-session annualized contribution, not a measured annual turnover.                                                                                                                                                                                                                                                                                                                                                  |
| Entry slippage            | Positive is adverse for either side. Quantity-weight fill prices within each intended entry leg, then report leg mean/median separately vs signal, reference, limit.                                                                                                                                                                                                                                                                                                                                                |
| Entry / collar miss       | Rates divide by verified dispatchable entry legs. A collar miss requires zero fills, cancellation or expiration, and a retained opposite IEX quote outside the limit within one second before submit. Other nonfills are not labeled collar misses.                                                                                                                                                                                                                                                                 |
| Protective stop-limit     | Full fills divided by stops with a fill or an observed executable-side crossing. An unfilled remainder when the opposite side crosses the stop and is past the limit is flagged even if the order later fills. A position mark beyond both prices is separately labeled, non-executable evidence. Neither input proves the broker's trigger state.                                                                                                                                                                  |
| Controller and close      | Counts use unique completed controller receipts. The timed-exit clock starts at first fill using its entry plan's maximum hold. Inventory and activity are checked at the provider's regular close independently of later recovery.                                                                                                                                                                                                                                                                                 |
| B0 slippage budget        | Includes flat-to-flat, uniquely attributed Noise Area QQQ/SMH trades; other sleeves do not vote. Sum signed entry and exit bps vs their own benchmarks (signal close or planned entry reference; planned exit reference or precommitted protective price). Both unrounded mean and median must be strictly below **2.5 bp**. The **11.2 bp** full-period and **15.6 bp** recent research breakevens are diagnostic comparisons, not a looser live gate or proof the live policy matches the research configuration. |
| IEX vs SIP                | On completed regular-session minutes matched by symbol and minute start: `10,000 × (IEX close − SIP close) / SIP close`. Report signed and absolute dispersion and unmatched/conflicting minute counts. This measures price drift, not fill slippage or a reconstructed SIP signal.                                                                                                                                                                                                                                 |

`PASS` requires positive net realized P&L, a passing B0 check, timely and exact position evidence, and no known
execution failures or evidence gaps that block those checks. `FAIL` identifies a measured breach or loss;
`INSUFFICIENT_EVIDENCE` is not a pass. Carry-ins/reversals are not invented into closed trips, and missing exit
benchmarks remain unmeasured. The report covers retained Bayn evidence only: a zero count is not proof that a feed,
broker trigger, cash settlement event, or code path without retained receipts was healthy.

## Offline replay and optional market data

```sh
bun services/bayn/tools/audit-bayn-live-profitability.ts --session 2026-11-27 --format json --fixture /secure/session-evidence.json
```

The input schema is `bayn.live-profitability-evidence.v1` in
[`live-profitability-audit-core.ts`](../../services/bayn/tools/live-profitability-audit-core.ts). Supply normalized
per-date session rows with fixed `asOf` cut times, canonical UTC timestamps, decimal integer strings for price,
quantity, and dollars, and explicit nulls for unknowns. Quantity/price atoms have nine decimals; money and
reference-price micros have six. The auditor never connects to Postgres in fixture mode. The report schema is
`bayn.live-profitability-audit.v1`, not an input fixture.

Postgres reads retained candidate quotes, final bars, and broker position marks. Candidate data is often sparse and
IEX-only. To enrich either mode,
add `--market-evidence /secure/market.json` with normalized rows exported from an authorized read-only archive
(e.g. ClickHouse). Supply real-time IEX/SIP records, not delayed bars or out-of-session last trades. Bar timestamps
are minute **starts**; quotes must have a non-withdrawn side with positive displayed size. Example shape:

```json
{
  "bars": [
    { "symbol": "QQQ", "at": "2026-11-27T15:00:00.000Z", "feed": "iex", "closeMicros": "600012000" },
    { "symbol": "QQQ", "at": "2026-11-27T15:00:00.000Z", "feed": "sip", "closeMicros": "600000000" }
  ],
  "quotes": []
}
```

No pairs means drift is unavailable. A live Postgres read without retained quotes or position marks at the time of a stop crossing
cannot confirm or rule out a gap-through; supply the archived quotes, rather than treating OHLC extremes as an
executable price. Stop the port-forward and remove the temporary CA file when finished. Store outputs only in
approved incident/evidence storage.

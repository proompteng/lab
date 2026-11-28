# Monday, 2026-11-30: Bayn cutover dossier

Keep the running `bayn-execution-controller` on its incumbent Alpaca **Paper** account (#1). The production
service's [#16371 recovery fix](https://github.com/proompteng/lab/pull/16371) is not evidence of a fill. Let the
existing owner recover the [Friday GOOGL −103 carry](incidents/2026-11-27-black-friday-googl-unclosed-exit.md) at
the 09:30 ET Monday open. Do not submit a manual/test order, cancel protection, change authority, or touch the
proposed [#16395 QQQ+SMH v3 cutover](https://github.com/proompteng/lab/pull/16395) to make the check pass.

The [dossier CLI](../../services/bayn/tools/monday-cutover-dossier.ts) reads one private evidence file. It does not
connect to Alpaca or Postgres, run the controller, or call GitHub. Use only evidence captured by the approved read
paths below. It checks structure, relationships, hashes and time bounds; it cannot attest who collected the files,
whether the standby has caught up, or whether the account changed after the cut.

## Before the open

From the repo root with the pinned dependencies, create a private directory for the Monday captures:

```sh
set +x
umask 077
evidence=$(mktemp -d)
stamp() { bun -e 'process.stdout.write(new Date().toISOString())'; }
```

1. **Accounts #2 and #3:** follow the [multi-account shadow runbook](multi-account-sleeve-architecture.md#shadow-verification-and-papersubmit)
   with three independently verified Alpaca Paper UUIDs (not account numbers). Set the two sleeve bindings to
   `F4` and `O1`, each with `capitalBudgetUsd: 10000` and `mode: "Shadow"`; do not enable `allowSharedAccount`.
   Use only the two dedicated Paper credentials, and supply the independent O1 market/account attestation from that
   runbook. Run `run-multi-account-daily-sleeves.ts` **without** `--confirm-paper-submit`; retain its unmodified
   portfolio receipt as `shadow.json`. A clear no-review/no-order shadow plan is valid. For this cut the signal is
   Friday `2026-11-27` (13:00 ET regular close), the planning window opens at Friday 20:15 ET, and the Monday
   09:28 ET cutoff is exclusive. Continue this read-only next-open schedule on later sessions; do not backfill
   Monday's plan if either sleeve misses the window. See [$10k sizing and operations](small-account-10k-operations.md).

   ```sh
   bun services/bayn/tools/run-multi-account-daily-sleeves.ts \
     --manifest "${SLEEVE_MANIFEST:?set the private F4/O1 Shadow manifest}" \
     --canary-evidence "${CANARY_EVIDENCE:?set the verified O1 evidence}" \
     --output "$evidence/shadow.json"
   ```

2. **Account #1:** on Monday before 09:30 ET, retain the verified broker opening carry. Use the verifier's
   [credential instructions](../../services/bayn/README.md#november-30-cutover-verification), pin
   `BAYN_ALPACA_ACCOUNT_ID`, `BAYN_MACRO_CORE_ALPACA_ACCOUNT_ID`, and `BAYN_MACRO_CANARY_ALPACA_ACCOUNT_ID`
   to the three intended UUIDs, and use the approved `bayn_audit_ro` TLS standby connection. Do not use
   `--skip-macro-accounts` or `--allow-live-endpoint`.

   ```sh
   bun services/bayn/tools/verify-monday-cutover.ts --phase pre-open --require-standby \
     --output "$evidence/pre-open.json" && stamp > "$evidence/pre-open-at"
   ```

Stop if this verification fails or cannot finish before the open. The dossier requires the single signed GOOGL
quantity `−103` from the pre-open broker report and the same opening quantity in the Monday ledger.

## After the opening fill (09:30 ET / 14:30 UTC)

Require unique GOOGL buy executions totaling exactly 103 shares during the opening minute (through but not
including 09:31 ET). A split fill is valid only if every execution has its own accounted broker event. Before
running the closing broker verification, obtain the latest exact reconciliation and its bound positions snapshot
after the fill. Follow the [audit connection runbook](live-profitability-audit-runbook.md#connect-to-the-standby)
for approved access, verify standby catch-up, and use the same Account #1 as the opening broker read. The
profitability CLI's database mode is Live-only, and its profitability verdict is not the Paper settlement gate.

The following SELECT-only projection emits the private settlement object. Configure a trusted `PGSERVICE` for
the same `bayn_audit_ro` login and standby with `sslmode=verify-full` and its approved CA. Load the credential via
the approved private path, not in the command or shell history. `accountId` is a UUID, not a credential. Missing
rows are not proof of settlement: on a primary, the wrong login, an error, or an empty result, stop.

```sh
PGSERVICE="${PGSERVICE:?set the approved standby service}" \
  psql -X -w -qAt -v ON_ERROR_STOP=1 -v account_id="${BAYN_ALPACA_ACCOUNT_ID:?pin Account 1}" \
  > "$evidence/settlement.json" <<'SQL'
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '5s';
WITH scope AS (
  SELECT :'account_id'::text AS account_id, timestamptz '2026-11-30 05:00:00+00' AS day_start,
    transaction_timestamp() AS captured_at
  WHERE current_user = 'bayn_audit_ro' AND pg_catalog.pg_is_in_recovery()
), ledger AS (
  SELECT t.symbol, t.quantity_delta_atoms AS qty, t.cost_basis_delta_micros AS basis, t.occurred_at AS at
  FROM public.accounting_transactions t JOIN scope s USING (account_id)
  WHERE t.occurred_at <= s.captured_at
  UNION ALL
  SELECT d.symbol, -d.quantity_atoms, -d.cost_basis_micros, d.effective_at
  FROM public.broker_inventory_debits d JOIN scope s USING (account_id)
  WHERE d.posted AND d.effective_at <= s.captured_at
), opening AS (
  SELECT l.symbol, sum(l.qty)::text AS "quantityAtoms"
  FROM ledger l CROSS JOIN scope s WHERE l.at < s.day_start
  GROUP BY l.symbol HAVING sum(l.qty) <> 0
), nonflat AS (
  SELECT symbol FROM ledger GROUP BY symbol HAVING sum(qty) <> 0 OR sum(basis) <> 0
), fill_proofs AS (
  SELECT f.fill_id AS id, f.event_id AS "brokerEventId", f.symbol, f.side, f.source_timestamp AS at,
    f.quantity_atoms::text AS "quantityAtoms",
    CASE WHEN r.receipt_id IS NOT NULL AND t.account_id = f.account_id AND t.symbol = f.symbol
      AND t.side = f.side AND t.quantity_atoms = f.quantity_atoms AND t.price_atoms = f.price_atoms
      AND t.fee_micros = f.fee_micros AND t.occurred_at = e.occurred_at
      AND r.intent_id IS NOT DISTINCT FROM t.intent_id
      AND (f.intent_id IS NULL OR t.intent_id IS NOT DISTINCT FROM f.intent_id)
    THEN jsonb_build_object('id', r.receipt_id, 'brokerEventId', r.broker_event_id,
      'recordedAt', to_char(r.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
    END AS "accountingReceipt"
  FROM public.fills f JOIN scope s USING (account_id)
  JOIN public.broker_events e ON e.event_id = f.event_id AND e.account_id = s.account_id
  LEFT JOIN public.accounting_transactions t ON t.broker_event_id = f.event_id
  LEFT JOIN public.accounting_receipts r ON r.broker_event_id = f.event_id
  WHERE e.occurred_at >= s.day_start
), latest AS (
  SELECT r.reconciliation_id AS id, p.snapshot_id AS "positionSnapshotId", p.position_count AS "positionCount",
    to_char(r.reconciled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
    to_char(p.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "positionsAt",
    (r.status = 'EXACT' AND jsonb_array_length(r.discrepancies) = 0) AS exact,
    (r.account_event_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.position_snapshots newer
      WHERE newer.account_id = s.account_id AND newer.observed_at >= p.observed_at
        AND newer.position_count <> 0
    ) AND NOT EXISTS (
      SELECT 1 FROM public.mutation_events m JOIN public.intents i USING (intent_id)
      WHERE i.account_id = s.account_id AND m.occurred_at > LEAST(r.reconciled_at, p.observed_at)
    ) AND NOT EXISTS (
      SELECT 1 FROM public.broker_events e LEFT JOIN public.fills f USING (event_id)
      LEFT JOIN public.accounting_receipts a ON a.broker_event_id = e.event_id
      WHERE e.account_id = s.account_id AND e.occurred_at >= s.day_start AND (
        (e.event_kind IN ('ORDER', 'FILL') AND e.observed_at > r.reconciled_at) OR
        (e.event_kind = 'FILL' AND (f.fill_id IS NULL OR a.receipt_id IS NULL OR
          e.occurred_at > p.observed_at OR a.recorded_at > r.reconciled_at))
      )
    )) AS "coversActivity"
  FROM scope s CROSS JOIN LATERAL (
    SELECT r.* FROM public.reconciliations r WHERE r.account_id = s.account_id
    ORDER BY r.reconciled_at DESC, r.reconciliation_id COLLATE "C" DESC LIMIT 1
  ) r
  JOIN public.position_snapshots p ON p.account_id = s.account_id AND p.snapshot_id = r.position_snapshot_id
)
SELECT jsonb_build_object(
  'accountId', s.account_id, 'capturedAt', to_char(s.captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'openingPositions', COALESCE((SELECT jsonb_agg(o ORDER BY o.symbol) FROM opening o), '[]'::jsonb),
  'fills', COALESCE((SELECT jsonb_agg(f ORDER BY f.id) FROM fill_proofs f), '[]'::jsonb),
  'reconciliation', (SELECT to_jsonb(r) FROM latest r), 'nonFlatLedgerSymbols', (SELECT count(*) FROM nonflat)
) FROM scope s;
COMMIT;
SQL

stamp > "$evidence/post-flatten-at"
bun services/bayn/tools/verify-monday-cutover.ts --phase post-flatten --require-standby \
  --output "$evidence/post-flatten.json"
```

The dossier is stricter than the verifier's post-flatten GOOGL-only check: the broker reads and bound snapshot must
show **zero positions**, the ledger must have zero residual quantity and basis, and there must be no open broker
orders. Both the snapshot and receipt must be no more than 60 seconds old at evaluation; the closing broker read
must start after the settlement capture. Confirm terminal intents/cycles, settled fees and no unresolved claims in
the independent [#16395 settlement procedure](https://github.com/proompteng/lab/pull/16395) as well. Do not swap
receipts between accounts, reuse evidence after new activity, or rerun the opening or shadow steps after their cutoffs.

## Assemble and evaluate

Use the IDs that were pinned for both verifier calls. The verifier intentionally omits UUIDs and capture times from
its output; the surrounding capture records bind the reports to those verified inputs. Bundle the source JSON
unchanged. Do not use an amended report, relax a timestamp, or substitute a fixture for a missing observation.

```sh
jq -n \
  --arg intraday "${BAYN_ALPACA_ACCOUNT_ID:?pin Account 1}" \
  --arg core "${BAYN_MACRO_CORE_ALPACA_ACCOUNT_ID:?pin Account 2}" \
  --arg canary "${BAYN_MACRO_CANARY_ALPACA_ACCOUNT_ID:?pin Account 3}" \
  --rawfile preTime "$evidence/pre-open-at" --rawfile postTime "$evidence/post-flatten-at" \
  --slurpfile pre "$evidence/pre-open.json" --slurpfile post "$evidence/post-flatten.json" \
  --slurpfile settlement "$evidence/settlement.json" --slurpfile shadow "$evidence/shadow.json" \
  '{schemaVersion:"bayn.monday-cutover-dossier-evidence.v1",
    preOpen:{accountId:$intraday,completedAt:$preTime,report:$pre[0]},
    postFlatten:{accounts:{intraday:$intraday,core:$core,canary:$canary},startedAt:$postTime,report:$post[0]},
    settlement:$settlement[0],shadowReadiness:$shadow[0]}' > "$evidence/dossier-input.json"
bun services/bayn/tools/monday-cutover-dossier.ts --evidence "$evidence/dossier-input.json"
```

- **`HOLD_PR_16395` (nonzero)** or no trustworthy report: keep the PR held and leave the incumbent recovery owner in place. Review
  `blockingReasons` and escalate absent/late fills, unsettled receipt or inventory, a crossed account binding,
  missing shadow readiness, or stale evidence. A late flatten does not qualify as this opening cut.
- **`AUTHORIZE_PR_16395_MERGE` (zero, `replay: false`)**: this dossier's evidence gate passed at `asOf`. Share the
  redacted result and retain the underlying evidence privately. The reviewer still needs to verify the current
  broker/accounting cut and satisfy #16395's normal review, CI and settlement gates. This tool does not open,
  approve, or merge #16395 and does not activate v3 or authorize broker or capital actions.
- **Offline replay:** pass `--as-of` with a canonical UTC millisecond instant to reproduce a historical decision.
  `replay: true` is never current merge evidence, even if the historical result was `AUTHORIZE_PR_16395_MERGE`.
  Keep source files/UUIDs in approved private evidence storage, then remove temporary copies and stop port forwards.

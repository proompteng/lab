# Bayn multi-account sleeves (Wave 11A)

This is an isolation contract and a paper onboarding runbook, not a deployment or a grant of capital authority.
It changes neither the primary Bayn deployment nor its active v2 strategy, migrations, or bound hashes.

## Account layout

| Account                               | Sleeve and execution                                                                                                                                                                                      | Isolation                                                                                                                                  |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| #1 — existing primary `bayn`          | Pillar 1 target: Pure-ETF intraday v3, QQQ + SMH (later XLK), flat overnight, using eligible intraday buying power up to 4×                                                                               | Keep the existing account, Restate names, database, ledger and activation workflow. This wave does not activate v3 or change buying power. |
| #2 — Alpaca Paper `macro-core`        | Pillar 2: F4 or `F2_F4_EQUAL` (F2 also supported). Daily data, next regular open, with full QQQ eligibility. SPY, QQQ, IEF, TLT, GLD, HYG and SHY are representative holdings, not a hard-coded universe. | Dedicated Paper UUID, API key pair, equity and order book. Do not supply QQQ exclusions as a workaround.                                   |
| #3 — Alpaca Paper `macro-canary`      | O1: macro canary, trend (TSMOM), and regime blend. SPY, QQQ, EFA, EEM, TLT, IEF, GLD, DBC, HYG and SHY are representative holdings.                                                                       | Different Paper UUID, key pair, equity and order book from #1 and #2.                                                                      |
| #4+ — additional independent intraday | One controller deployment per broker account and compiled strategy behavior.                                                                                                                              | Unique Restate service prefix, account UUID, PostgreSQL database and TigerBeetle ledger per sleeve.                                        |

The [10.9-year dual-horizon evidence](evidence/2026-11-27-10yr-pure-etf-dual-horizon/README.md) shows why
an overnight QQQ holding and a flat-overnight Noise Area strategy cannot safely share that symbol in one
broker account. The [core research](evidence/2026-11-27-macro-etf-core-dual-horizon/README.md) reports
historical F4 metrics, not expected paper returns. Separate accounts keep order ownership, positions and
buying power independent; they do not diversify overlapping ETF risk. Both daily sleeves can target QQQ on
the same date. Their active symbol sets come from the entire compiled universes, including symbols not
currently held or selected.

## Runtime and storage audit

The account router is not an account registry. The [runtime config](../../services/bayn/src/config/source.ts)
still selects one Alpaca identity, Postgres URL, TigerBeetle cluster/ledger and immutable strategy binding.
The daily tool does **not** connect to any native Bayn writer, Postgres, Restate, or TigerBeetle. Its state is
Alpaca Paper plus its private receipt and submission journal.

For native execution, the boundary is **one broker account per Postgres database**. Audit scope: the
[registered migration chain](../../services/bayn/src/db/migrations.ts) through 0225 (including the keys, partial
unique indexes, trigger functions, and replacement/drop migrations), the SQL readers and writers in
[`src/db`](../../services/bayn/src/db/), and their execution, qualification, expense, and accounting callers.
The table families below group tables that share the same isolation assumption; a foreign key to a
content-addressed row does not establish a tenant boundary.

| SQL family                                    | Account and trigger findings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Broker and reconciliation                     | `broker_events` and its typed account/position/order/fill payloads, snapshots, `broker_observation*`, `broker_notification_receipts`, `broker_source_event*`, `broker_activity_*`, `valuations`, `reconciliations` and account baselines use account/provider binding or derive it through an event FK. Source/order triggers enforce provider versions, typed payload identity and append-only evidence; account advisory locks serialize source ingestion and reconciliation. Provider IDs and evidence IDs are not uniformly keyed as `(account_id, id)`. See [0206 source guards](../../services/bayn/migrations/0206_durable_broker_source_events.ts), [0211](../../services/bayn/migrations/0211_durable_broker_activities.ts) and [reconciliation](../../services/bayn/src/db/reconciliation.ts).                                                                                       |
| Execution authority and orders                | `authority_state` has **one** `CHECK (singleton)` row; `authority_generations` forms one versioned lineage. Grants, intents, mutation events, risk decisions, and native protection commands/receipts/claims/plans derive authority from this row or its lineage. The admission, rearm and settlement guards and the writer fence are database-wide, not per-prefix. [Initial authority DDL](../../services/bayn/migrations/0002_paper_contracts.ts), [generation guards](../../services/bayn/migrations/0014_authority_generation_history.ts), and [configured-account selection](../../services/bayn/src/db/execution-store/observe-authority.ts) are the decisive boundaries. Account selection in the unprefixed runtime is a **handoff**, not a second writer; a prefixed runtime rejects replacement of an existing different broker binding at preflight and at fenced activation.      |
| Controller, cycle and lifecycle               | `execution_controller_status` and observation history identify the controller key. Cycle, closure, replan, lifecycle, shadow-decision, expected-session and forward-performance tables/query paths bind account, generation, cycle or plan, but the current authority and qualification witnesses still see one database-wide owner. Monotonic controller projection and [operational controller witness](../../services/bayn/migrations/0175_operational_controller_evidence.ts) do not make activation multi-tenant.                                                                                                                                                                                                                                                                                                                                                                         |
| Accounting                                    | `accounting_receipts`, `accounting_transactions`, broker fees/accruals/matches/corrections/posting acknowledgements, `account_cash_reporting`, and cash settlements read account/generation or follow the original event/transaction. Their guards enforce immutable source and exact postings, not row-level isolation. Some joins/uniqueness checks are by transaction/receipt/source ID alone. The persisted cluster/ledger and plan-hash comparisons fail on a wrong ledger; they do not migrate any history. See [accounting rows](../../services/bayn/src/db/accounting-rows.ts), [fee posting](../../services/bayn/src/db/fee-posting.ts), [accounting](../../services/bayn/src/accounting/) and [ledger queries](../../services/bayn/src/ledger/decisions.ts).                                                                                                                         |
| Decision, market evidence and inference       | Candidate, streaming/intraday/simulated snapshot and clock rows, native arrivals/chunks/seals and archive availability are scoped by cycle, capture, feed, content or explicit account, depending on the contract. Jev requests/receipts/resolutions, batch plans/results, staged/chart claims, handoffs, work/cursors and inference expense queues use content/cycle IDs and source triggers. Claims and expiry use current authority and account/plan bindings; shared `LISTEN/NOTIFY` channels are database-wide. See [inference work](../../services/bayn/src/db/jev-inference-work-postgres.ts), [work DDL](../../services/bayn/migrations/0195_jev_inference_work.ts), [source seals](../../services/bayn/migrations/0205_inference_source_seals.ts) and [native arrivals](../../services/bayn/src/db/native-arrival-postgres.ts).                                                       |
| Research, qualification and operational audit | Protocol/qualification locks, run/trial/artifact/event/outcome/status and research capture/inference tables use run, trial, capture or content IDs, not a broker tenancy key. The system qualification origin and attempt sequence are global; registration, evidence cuts, admission witnesses, replay/assessment, safety/authority/mutation evidence, paired seals and source records derive from the same authority. Cutover/retention guards, schema migrations and catalog operations can affect all rows in the database. See [registration origin](../../services/bayn/migrations/0156_system_registration.ts), [safety witnesses](../../services/bayn/migrations/0181_operational_safety_baseline.ts), [paired admission](../../services/bayn/migrations/0210_paired_qualification_admission.ts) and [schema retirement](../../services/bayn/migrations/0134_remove_unused_schema.ts). |

[TigerBeetle account and transfer IDs](https://docs.tigerbeetle.com/coding/data-modeling/#id) are cluster-wide; a ledger number is not an ID namespace. In
[`accounting/domain.ts`](../../services/bayn/src/accounting/domain.ts), native account IDs derive from the
broker account ID plus account role; transfer IDs derive from the broker event ID plus accounting leg.
Broker event provenance binds the account; fee events additionally derive IDs from account and activity IDs.
Account reconciliation filters by configured ledger and account-derived tags. Posting verifies the complete
existing ID record, including ledger, rather than treating any `exists` response as success. Research
[`ledger-plan/build.ts`](../../services/bayn/src/ledger-plan/build.ts) instead derives IDs from run ID plus
role/event/leg. Do not post the same research run ID into multiple ledgers on the same cluster. Do not move
an existing native account to a different ledger or duplicate it across two controller namespaces. Keep the
default primary ledger unchanged; allocate a new unused ledger number before provisioning each new
broker account, and reconcile against the exact ledger before granting mutation authority.

### Adding another Restate deployment

1. Provision a new broker account, dedicated Postgres database and restricted role (not another schema or a
   copied live database), and an unused TigerBeetle ledger on the selected cluster. Run the existing migrations
   in the new database only. Give the matching activation Job, worker, and status reader the same account and
   storage configuration. Start in OBSERVE using the normal activation path.
2. Select a unique `BAYN_RESTATE_SERVICE_PREFIX`, for example `sleeve-4` (1–32 lowercase letters, digits or
   hyphens, starting with a letter). Set it on the Restate deployment, activation Job and health/status reader.
   Use a distinct Kubernetes deployment/endpoint identity. Restate discovers `sleeve-4-BaynExecutionController`,
   `sleeve-4-BaynBrokerObservations`, `sleeve-4-BaynBrokerSourceProjector`, `sleeve-4-BaynBrokerActivities` and
   `sleeve-4-BaynEntryInference`. The object key remains the broker identity hash. Internal sends, self-scheduling,
   market wakeups, activation and status/health ingress use the same name mapping. Never rename a running
   namespace to rotate an image; changing the name creates new Restate state.
3. Set `BAYN_ALPACA_ACCOUNT_ID`, `BAYN_POSTGRES_URL`, `BAYN_TIGERBEETLE_LEDGER`, and the exact
   `BAYN_STRATEGY_BEHAVIOR_HASH` and parameter hash of the **selected immutable image**. The environment cannot
   select an arbitrary strategy: [application-plan validation](../../services/bayn/src/application-plan.ts)
   rejects a mismatch with compiled behavior. The prefix is transport config only, excluded from application-plan,
   config and behavior hashes. Leaving it unset/empty keeps all five legacy names and request material unchanged.
4. Provision a broker-event/activity producer for the new account and send notifications to
   `/<prefix>-BaynBrokerObservations/<identity-hash>/notify` and the matching `<prefix>-BaynBrokerActivities`
   endpoints. The existing [Dorvud publisher](../../services/dorvud/websockets/src/main/kotlin/ai/proompteng/dorvud/ws/RestateBrokerPublisher.kt)
   is wired to the primary service names; it is not a multi-account router. Do not repoint its existing
   subscription. Verify the independent account's read-only fills, catch-up, and health before any activation
   grant. Use separate Kafka consumer groups where consumers must read the whole shared feed, and retain
   account identity in broker-cache keys. Share only read-only market inputs, not broker credentials or state.
5. Verify Restate discovers both independent service sets and that the new activation, market wakeup, durable
   controller pass and broker reconciliation land only in the new bindings. Certify account, ledger, plan hash
   and observation proof separately; discovery alone grants no authority.

## Enroll Paper accounts #2 and #3

1. In the [Alpaca Paper dashboard](https://docs.alpaca.markets/us/docs/paper-trading), select the Paper account
   selector at the upper left, choose **Open New Paper Account**, and set the planned simulated balance. Record
   which account is `macro-core`. With that account selected, generate its API key pair from the API Keys
   panel and retain it in the approved credential store. Repeat for `macro-canary`; do not rotate or reuse the
   primary account's key. Check both accounts have the SIP data entitlement required by the runner.
2. Read each key pair's `GET https://paper-api.alpaca.markets/v2/account` **`id`** (UUID, not the displayed
   account number). Verify both differ from one another and from the primary runtime's already configured
   `BAYN_ALPACA_ACCOUNT_ID`. The example below does this Paper read as part of sealing; it prints only the UUID.
3. For the reference job below, seal one Secret per account for the separate `bayn-paper` namespace.
   If these accounts are already enrolled, reuse the verified bindings rather than opening replacement
   accounts or rotating their keys. The [existing Bayn sealed credentials](https://github.com/proompteng/lab/pull/16408)
   use `bayn-alpaca-macro-core-auth` and `bayn-alpaca-macro-canary-auth` in namespace `bayn`.
   A reviewed Job in that namespace can project each Secret's `key-id` and `secret-key` into the matching
   prefixed variables with explicit `secretKeyRef` entries. Ciphertext cannot be copied to `bayn-paper`. Confirm the intended context
   with the [cluster access runbook](../runbooks/galactic-kubernetes-access.md); the controller is
   `sealed-secrets/sealed-secrets`. Use a local/private staging directory **outside** live manifests. Do not
   apply or add any output to `argocd/applications/bayn/kustomization.yaml` in this wave.

```bash
# Bash; set GALACTIC_CONTEXT to the verified context and create ./sealed-staging privately.
set +x
umask 077
mkdir -p ./sealed-staging
kubectl --context "$GALACTIC_CONTEXT" -n sealed-secrets get svc sealed-secrets
kubeseal --context "$GALACTIC_CONTEXT" --controller-namespace sealed-secrets \
  --controller-name sealed-secrets --fetch-cert > ./sealed-staging/galactic.pem

seal_paper_sleeve() (
  set +x
  set -euo pipefail
  local name=$1 prefix=$2 key secret uuid
  read -rsp "$name Alpaca Paper key ID: " key; printf '\n' >&2
  read -rsp "$name Alpaca Paper secret: " secret; printf '\n' >&2
  # Alpaca key material is alphanumeric; reject characters that can change the curl config.
  [[ $key =~ ^[[:alnum:]]+$ && $secret =~ ^[[:alnum:]]+$ ]]
  uuid=$(
    printf 'header = "APCA-API-KEY-ID: %s"\nheader = "APCA-API-SECRET-KEY: %s"\n' "$key" "$secret" |
      curl --config - --silent --show-error --fail --url 'https://paper-api.alpaca.markets/v2/account' |
      jq -er '.id | select(test("^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$"))'
  )
  jq -n --arg name "$name" --arg prefix "$prefix" \
    --rawfile key <(printf '%s' "$key") --rawfile secret <(printf '%s' "$secret") '
      {apiVersion:"v1",kind:"Secret",type:"Opaque",metadata:{name:$name,namespace:"bayn-paper"},
       stringData:{($prefix+"_ALPACA_KEY_ID"):$key,($prefix+"_ALPACA_SECRET_KEY"):$secret}}
    ' |
    kubeseal --cert ./sealed-staging/galactic.pem --scope strict --format yaml \
      > "./sealed-staging/$name.yaml"
  kubeseal --context "$GALACTIC_CONTEXT" --controller-namespace sealed-secrets \
    --controller-name sealed-secrets --validate < "./sealed-staging/$name.yaml"
  printf '%s %s\n' "$name" "$uuid"
)

seal_paper_sleeve bayn-macro-core-paper MACRO_CORE
seal_paper_sleeve bayn-macro-canary-paper MACRO_CANARY
```

The plaintext Secret only flows through a pipe. Strict sealing binds it to the final Secret name and namespace;
if either changes, reseal instead of renaming the ciphertext. See [Sealed Secrets scopes and certificate handling](https://github.com/bitnami/sealed-secrets#scopes).
Keep access to keys and evidence separate from anyone who only needs paper results.

## Shadow verification and PaperSubmit

Create a private `sleeves.json`, replacing all three example UUIDs with the verified account IDs. Omitted
`mode` means `Shadow`; omitted `excludeSymbols` means no exclusions. The capital budget is a cent-precision
USD ceiling (up to $150,000 per sleeve), reduced by the existing account and inventory limits.

```json
{
  "schemaVersion": "bayn.multi-account-daily-sleeves-config.v1",
  "intradayAccountId": "11111111-1111-4111-8111-111111111111",
  "sleeves": [
    {
      "sleeveId": "macro-core",
      "strategy": "MacroEtfCore",
      "profile": "F4",
      "accountId": "22222222-2222-4222-8222-222222222222",
      "credentialsEnvPrefix": "MACRO_CORE",
      "capitalBudgetUsd": 50000
    },
    {
      "sleeveId": "macro-canary",
      "strategy": "MacroCanaryEtf",
      "profile": "O1",
      "accountId": "33333333-3333-4333-8333-333333333333",
      "credentialsEnvPrefix": "MACRO_CANARY",
      "capitalBudgetUsd": 50000
    }
  ]
}
```

Do not enable `allowSharedAccount` for this layout. The exception requires explicit opt-in and pairwise disjoint
potential order symbols, including sells and cash-proxy holdings. The intraday UUID additionally requires explicit
QQQ and SMH exclusions even for O1; add XLK when it enters the intraday book. Sharing symbols across **different**
accounts is allowed. Multiple sleeves that would submit orders on one account in one portfolio run fail preflight
even if their symbols are disjoint: that would share cash and buying power across separately planned orders.

### O1 market and account evidence

The O1 adapter calls the merged [production signal and planner](../../services/bayn/src/strategy/macro-canary-etf/),
not the separate [Wave 7C research-parity tool](../../services/bayn/tools/macro-canary-runner/README.md).
O1 uses the production all-universe 2018-06-19 anchor, capped long-only targets, and registered review cadence.
The [Alpaca bars endpoint](https://docs.alpaca.markets/us/reference/stockbars) does **not** attest adjustment
vintage: `asof` is for symbol mapping. Do not certify point-in-time data using that parameter.

1. In the same finalized-close window, verify the all-adjusted SIP history independently against a trusted
   point-in-time snapshot or corporate-action archive through the last completed session. Verify prior raw
   closes refer to the same instruments and reject unresolved next-open splits/reorganizations. Run without
   `--canary-evidence` if needed to get the observed `signalSession`, `executionSession`, and `marketSha256`
   from `UnverifiedCanaryAdjustments` in the failed receipt (no orders). Compare that SHA to the independently
   verified data, not just to another copy of the failed receipt. The digest material is `{calendar, feed:"sip",
timeframe:"1Day", adjustment:"all", bars, rawSizingBars}`: calendar is ordered session dates from the
   policy anchor through execution, adjusted bars are session-major and policy-universe ordered
   `{session,symbol,open,high,low,close,volume}`, and raw sizing rows are `{symbol,bar}` in policy order
   using the validated Alpaca raw bar object. Hash the material with Bayn's canonical JSON v1 SHA-256.
2. On a review day, independently reconcile each O1 account's positions/availability, cash, outstanding
   orders and corporate actions through the next-open boundary. Establish its remaining rolling-year
   one-way turnover bps from fills; do not use the 60,000 bps ceiling as an estimate for an existing book.
   The `snapshotSha256` binds the decoded `{account,positions,openOrders}` (positions ordered by symbol,
   orders by ID); if account evidence is missing the receipt exposes the observed digest for comparison.
   The adapter will not place an order with missing/stale evidence, unavailable or fractional managed
   shares, or open orders. Off-cadence O1 needs market evidence, but not the per-account entry.
3. Have the independent verifier publish a private, read-only attestation of the verified evidence. The tool
   checks exact SHA/date bindings, not the trustworthiness of the verifier. Withhold O1 if verification or
   the trusted evidence source is unavailable. Use separate manifest runs to qualify core while onboarding O1;
   a combined run with failed O1 will not submit any other sleeve's orders.

Evidence contract (schema `bayn.macro-canary-next-open-evidence.v1`):

| Field                               | Value                                                                                                                                          |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`                     | `bayn.macro-canary-next-open-evidence.v1`                                                                                                      |
| `signalSession`, `executionSession` | ISO exchange session dates from verified market evidence                                                                                       |
| `marketSha256`                      | 64 lowercase hex characters                                                                                                                    |
| `accounts`                          | Array of `{accountId, snapshotSha256, remainingOneWayTurnoverBps}`; no duplicate UUIDs; empty only when no O1 account requires review evidence |

### Run and check

Load the four credential environment variables from the approved store into the command environment (without
shell tracing or copying them into a manifest). From the repository root with the pinned Bun and installed
workspace dependencies:

```bash
umask 077
mkdir -p /private/bayn-paper-receipts
bun services/bayn/tools/run-multi-account-daily-sleeves.ts \
  --manifest /private/sleeves.json \
  --canary-evidence /private/canary-evidence.json \
  --output /private/bayn-paper-receipts/shadow-YYYY-MM-DD.json
```

Run after **20:15 America/New_York** on a completed exchange session and before **two minutes before the next
regular open** (normally 09:28 ET). The broker calendar and clock must corroborate this window; the runner
checks complete SIP bars and separately sourced raw sizing prices. Never retry by relaxing data or clock checks.
Check a review date as well as a non-review date. Confirm `allBrokerAccountsVerified: true`, a `shadow`
disposition for each sleeve, no POSTs/orders at Alpaca and complete aggregate evidence. Confirm QQQ is in both
active universes and compare its target to the corresponding strategy on an eligible review; a zero weight
from the signal is valid, an imposed QQQ exclusion is not. On non-review dates there is no actionable new
target contribution. Target cents are model exposure sized against current sleeve budgets, not positions,
submitted notional, or fill evidence.

To enable Paper, change only the approved sleeve's mode to `PaperSubmit` and add
`--confirm-paper-submit` to the same command with a **new** output path. Review the matching account receipt
and old orders first. This command cannot target live Alpaca. Use the **same private durable output directory**
for all runs that touch those accounts; do not run the standalone paper writers or other broker-side writers on
them concurrently. The paper path checks exact unchanged account state, history since the signal close
(including terminal orders), and the live clock again before any mutation.

The final canonical JSON is a single `bayn.multi-account-daily-sleeves-receipt.v1`; verify
`portfolioSha256` over the canonical payload without the hash field. A redacted typed sleeve failure yields a receipt
and nonzero status after manifest validation. Planning failures withhold all paper writes. Dispatch failure
withholds later writes; previously acknowledged orders in other accounts are not rolled back. An interrupted
process can leave no final receipt or an incomplete output file. The separately fsynced account/session journal
retains the prepared plan, each attempted request and acknowledgements. A dispatch without a verified ack is
**uncertain**: stop and look up its `client_order_id` on the verified Paper account. Never delete its journal,
change the output directory, or retry uncertain submissions. Do not share the private receipts.

### Reference CronJob (not installed)

Stage this only after static review and authorized onboarding. Use an immutable reviewed tool image that
contains a pinned Bun and the bundled command at `/app/run-multi-account-daily-sleeves.js` (bundle with
`bun build services/bayn/tools/run-multi-account-daily-sleeves.ts --target=bun --outfile /app/run-multi-account-daily-sleeves.js`).
The existing Bayn runtime image is not the tool image. Provision a private PVC for the shared journal
directory and the two separate mounted inputs. Schedule only completed trading sessions; this weekday
illustration needs exchange-holiday exclusions or suspension, and the verifier must refresh the evidence
for each eligible signal. Start suspended and Shadow. For an approved paper Job, disable automatic retries
and add the confirmation flag explicitly; do not restart a failed paper Job without broker reconciliation.

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: bayn-daily-sleeves
  namespace: bayn-paper
spec:
  schedule: '30 20 * * 1-5'
  timeZone: America/New_York
  suspend: true
  concurrencyPolicy: Forbid
  startingDeadlineSeconds: 600
  jobTemplate:
    spec:
      backoffLimit: 0
      activeDeadlineSeconds: 600
      template:
        spec:
          restartPolicy: Never
          automountServiceAccountToken: false
          securityContext:
            runAsNonRoot: true
            runAsUser: 10001
            fsGroup: 10001
            seccompProfile:
              type: RuntimeDefault
          containers:
            - name: runner
              image: registry.example/bayn-daily-sleeves@sha256:REPLACE_WITH_VERIFIED_DIGEST
              command: ['/bin/sh', '-ec']
              args:
                - |
                  exec bun /app/run-multi-account-daily-sleeves.js \
                    --manifest /config/sleeves.json \
                    --canary-evidence /evidence/canary-evidence.json \
                    --output "/receipts/${POD_UID}.json"
              securityContext:
                allowPrivilegeEscalation: false
                readOnlyRootFilesystem: true
                capabilities:
                  drop: [ALL]
              env:
                - name: POD_UID
                  valueFrom:
                    fieldRef:
                      fieldPath: metadata.uid
              envFrom:
                - secretRef:
                    name: bayn-macro-core-paper
                - secretRef:
                    name: bayn-macro-canary-paper
              volumeMounts:
                - name: sleeves-config
                  mountPath: /config
                  readOnly: true
                - name: verified-evidence
                  mountPath: /evidence
                  readOnly: true
                - name: receipts
                  mountPath: /receipts
          volumes:
            - name: sleeves-config
              configMap:
                name: bayn-daily-sleeves-config
            - name: verified-evidence
              configMap:
                name: bayn-daily-sleeves-verified-evidence
            - name: receipts
              persistentVolumeClaim:
                claimName: bayn-daily-sleeves-private-receipts
```

# Retained Jev session evidence

Run `bayn-jev-study-export` to export the complete committed batch inventory for one configured account and session.
The Bayn image installs this wrapper and its compiled Node entry point. `--help` needs no configuration.
It reads PostgreSQL and writes a new private local directory. It requires the configured account ID, PostgreSQL URL,
and the existing verified PostgreSQL CA. It has no broker or model client and requires neither credential.

```sh
node dist/jev-study-export-command.js --session YYYY-MM-DD --output /private/new-session-directory
```

Use the native command instead of a `json_agg` over full observation payloads. PostgreSQL aggregate transition state
can consume much more memory than the compressed stored documents. The command selects one batch ID and retrieves
one observation at a time. Each query has a five-second server deadline. The complete read runs inside one
`REPEATABLE READ, READ ONLY` transaction. It does not take an execution writer fence or mutate financial records.

The new directory uses mode `0700`; its files use `0600`. It contains private broker-state and trading observations.
Do not commit, publish, or paste the data file into logs. The command prints only the receipt.

## Execution and storage

Run the export in a separate research process with the existing database read access and a private output filesystem.
Do not run full session exports inside Bayn API or execution-controller pods. Their `/tmp` volume is shared with
the running service and limited to 256 MiB, while one admitted export can reach 512 MiB. A read-only database
transaction still writes local files; exceeding the pod's temporary-storage limit can evict the trading worker.

Before starting, verify both filesystem headroom and any container or volume quota. Reserve the full 512 MiB file
bound plus receipt and operational headroom for each concurrent export, counting all retained complete and partial
attempts on the same volume. A filesystem free-space check alone does not establish the pod's volume allowance.
After a failed export, account for its partial directory before another attempt. Keep incomplete evidence on the
research filesystem and use a new destination; do not accumulate retries on a service pod.

## Contents and integrity

`batches.ndjson` begins with a `bayn.jev-study-session.v1` header containing the account binding hash, session date,
database cut and complete Jev cycle inventory. A blocked or no-batch cycle stays in that inventory.
The remaining lines contain every committed batch in ascending batch-ID order:

- Original stored observation, source rows and manifest, with its content hash.
- Complete plan, including source and quote exclusions and requests for unselected candidates.
- Stored result, including abstentions, failed or unattempted candidates and their retained receipts and resolutions.
  A missing result remains `null`.
- Reproduced entry or management purpose.

Each observation and plan must reproduce through the native source and request builders. Each result must validate
against its plan. The export rejects missing observations, changed content identities, foreign accounts or sessions,
duplicate rows and a paging cursor that fails to advance. It does not silently skip old or invalid records.

After the transaction finishes, the command flushes the data and writes `receipt.json`. The
`bayn.jev-study-export.v1` receipt contains the complete file's SHA-256 and byte length, cycle and batch counts,
entry and management counts, pending-result count, and its own canonical hash. Verify these before consuming the
data. A missing or invalid receipt means the export is incomplete; retain it as diagnostic evidence and use a new
directory for another attempt. Existing destinations are never overwritten.

The bounds are 10,000 cycles, 16 MiB per encoded line and 512 MiB per session file. Exceeding a bound fails the export
and withholds the receipt. These limits are admission boundaries, not sampled datasets or evidence of memory capacity.

## Using the evidence

Use entry lines as the `observation`, `batchPlan` and nullable `batchResult` inputs of the existing
[signal screen](jev-signal-study.md). Keep the full header inventory and exclusions when reporting coverage;
do not select only filled trades or successful model calls. Management lines support separate exit diagnostics.
Read session-wide inference costs with the existing [operating-cost command](../../services/bayn/src/inference-cost-command.ts), which includes
claimed requests for blocked, unfilled and no-trade cycles. An export is not an invoice or a fee allocation.

Freeze the source manifest, execution and cost assumptions, development trials and untouched evaluation before
comparing portfolios. Existing [matched-entry](matched-entry-study.md), [portfolio control](control-portfolios.md)
and [ridge](six-bar-ridge.md) requirements continue to govern their own inputs and conclusions.

Stored decision snapshots reproduce the observations Bayn retained. They do not recreate every original consumer
arrival, missed poll, unobserved candidate window or alternative portfolio path. The receipt therefore always reports
`sourceCoverage: RECORDED_OBSERVATIONS_ONLY`, `qualification: UNQUALIFIED` and `controllerCoverage: UNKNOWN`.
Keep the separate [original capture](../../services/bayn/src/research-capture/README.md) requirements intact.
Neither this export nor a positive retrospective label grants trading or capital authority.

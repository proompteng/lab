# Cold source-bound decision verification

Current v40 replay previously decoded and semantically verified every supplied batch request before independently
reconstructing and verifying the same requests from the observation. The replay boundary now strictly parses the
supplied plan and computes its actual canonical content hash, then reconstructs the complete plan. Both the supplied
content commitment and reconstructed identity must equal its recorded batch ID. The reconstruction retains all source,
candidate, question-set, funding, ordering, exclusion and original-deadline checks. Standalone batch/request decoders
are unchanged. No cache or new runtime configuration is introduced.

## Reproduce

At baseline `311842d17f46c77d754a25206c3f2a114013d3ed`, bundle the financial projection:

```sh
bun build services/bayn/src/forward-performance/postgres/projection.ts \
  --target=node --external tigerbeetle-node --external @platformatic/kafka \
  --outfile=/tmp/current-decision-baseline.mjs
```

At the candidate, bundle that same module and the measurement tool:

```sh
bun build services/bayn/src/forward-performance/postgres/projection.ts \
  --target=node --external tigerbeetle-node --external @platformatic/kafka \
  --outfile=/tmp/current-decision-candidate.mjs
bun build services/bayn/tools/benchmark-cold-decision-verification.ts \
  --target=node --outfile=/tmp/cold-decision-benchmark.mjs
node /tmp/cold-decision-benchmark.mjs \
  /tmp/current-decision-baseline.mjs /tmp/current-decision-candidate.mjs /private/decision-rows.ndjson
```

The private NDJSON input contains one complete row per line with `cycle_id`, `decision_hash`, `created_at` as an ISO
timestamp, and the original `document`. Capture a bounded, account/generation-scoped sample through an authorized
read-only query. Keep its complete bytes unchanged for both implementations. Do not commit financial payloads or
credentials. The tool prints only timings, counts and a digest of the complete verified output; it never prints the
financial documents. Remove the private copy when the comparison is finished.

Each measured run starts a fresh Node process. Input parsing and output digest calculation are outside the timed
verification region. Three baseline/candidate pairs alternate order; every document must pass, and complete output
digests must match across all six runs. Child processes have a 120-second diagnostic ceiling. This tool does not run
a full financial report, call the broker, change authority or set the operator report deadline.

## Observed production-evidence comparison

Node 24.11.1, Bun 1.4.2 bundler, Linux x64, November 13, 2026. Six completed current-generation v40 entry documents were
captured privately in one read-only query. The NDJSON sample was 38,483,558 bytes; source decision clocks ranged from
19:54:07.370Z through 20:57:14.797Z. It is a bounded sample, not the complete generation.

| Measurement                               |               Baseline |              Candidate |
| ----------------------------------------- | ---------------------: | ---------------------: |
| Cold-process median for all six documents |           4,434.428 ms |           4,355.189 ms |
| Individual run range                      | 4,388.475–4,436.717 ms | 4,345.040–4,363.271 ms |
| Median CPU time                           |           5,148.594 ms |           5,052.962 ms |

The final tool measured an elapsed reduction of **1.79%**, with identical complete verified outputs. An earlier
independent comparison measured 2.19%. This modest gain does not establish the full-report deadline. Hardware load
was not isolated from other cluster work.

Regression cases retain actual supplied-content authentication: a forged unchanged batch ID cannot hide changed
request hashes, request identities, funding or expiry. Rehashing those changes, duplicate/reordered candidates,
unexpected fields or a changed question set still fails independent source reconstruction. Valid output bytes remain
unchanged. Existing tests cover exact exclusions, omitted candidates, altered observation/protocol and simulated sources.

## Remaining full-report boundary

On deployed baseline `311842d17f46c77d754a25206c3f2a114013d3ed`, both the current status-bound generation and a retained
nonempty generation exceeded the existing 30-second operator deadline and returned zero report bytes. Both use v40;
an exploratory v38/v39 optimization was therefore discarded rather than presented as a fix for this failure.

A diagnostic-only longer read-only run completed the retained report in 86.122 seconds. Its phases were PostgreSQL
evidence loading/verification 46.619 seconds, market-volume evidence 14.707 seconds, ledger 0.652 seconds, inference
source capture 0.584 seconds and inference-expense verification 21.903 seconds. The PostgreSQL phase includes synchronous
verification and is not a measurement of SQL execution time alone. Peak process RSS was 781,656 KiB. The report retained
incomplete operating-cost coverage and undetermined profitability.

A later paired full-report diagnostic produced no usable result before the tool-call timeout; its owned processes and
temporary files were removed. It supplies no acceptance evidence. Issue #15928 remains open for complete-cut parity and
the original 30-second command budget. No complete-report speedup, profitable edge or additional capital authority is
established by the document benchmark.

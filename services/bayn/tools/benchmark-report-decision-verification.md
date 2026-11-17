# Report decision verification benchmark

`benchmark-report-decision-verification.ts` compares complete decision verification in alternating fresh native Node
processes. Each process verifies every distinct input once. This matters because v40 keeps a bounded set of verified
target fingerprints: repeatedly timing the same warm targets bypasses the reconstruction being optimized.

The input is newline-delimited JSON containing the original report rows, with `cycle_id`, `decision_hash`, `created_at`
and `document`. Preserve the exact selected account, generation, completed-cycle membership and reconciliation cut
from `decisionQuery`. The harness checks each row's metadata against its document, requires every complete projection
to verify, and compares a SHA-256 of the entire output. Input capture, module import and output hashing are outside the
verification timer. Setup and CPU time are reported separately. Actual financial documents remain temporary inputs;
do not commit them.

Build the baseline verifier in its unchanged checkout, then build the candidate verifier and harness in the candidate
checkout:

```sh
bun build services/bayn/src/forward-performance/postgres/projection.ts --target=node --outfile=/tmp/bayn-baseline.mjs
bun build services/bayn/src/forward-performance/postgres/projection.ts --target=node --outfile=/tmp/bayn-candidate.mjs
bun build services/bayn/tools/benchmark-report-decision-verification.ts --target=node --outfile=/tmp/bayn-verification-benchmark.mjs
node --max-old-space-size=256 --max-semi-space-size=8 /tmp/bayn-verification-benchmark.mjs /tmp/bayn-baseline.mjs /tmp/bayn-candidate.mjs /tmp/bayn-distinct-decisions.jsonl
```

The parent propagates its Node arguments to each child. These heap arguments reproduce the report verifier's 256 MiB
old-generation and 16 MiB young-generation limits; Node 24.11.1 reports a 293,601,280-byte total heap limit. The harness
discards two initial pairs, then reports medians from seven alternating pairs. No report command, database access,
receipt persistence or trading authority is involved.

## Descriptor lookup measurement, 2026-11-17

The baseline was source `23f0ba07c920dfe670ddcad26077b7753ad8f09a`. The only candidate production change replaced the
per-field descriptor callback passed to `inspect` with a direct `Object.getOwnPropertyDescriptor` call and equivalent
`try`/`catch`. All validation, reflection ordering and error fields were retained.

The exact retained-generation report selection contained 83 v40 decisions: 60 entries averaging 4,906,580 bytes and
23 exits averaging 2,357,574 bytes of PostgreSQL JSON text. A read-only export captured the two largest entries and the
largest exit. Their compact document sizes were 6,070,332, 5,976,003 and 2,392,937 bytes. The 15,212,216-byte original
row envelope had SHA-256 `6203efde681cba4a682f66326b0f98846af0cd85245f46c1fa597c5ad957caf3`.

On the deployed ARM API pod, native Node 24.11.1 with the worker heap limits produced:

| Measurement                             |   Baseline | Direct descriptor lookup |
| --------------------------------------- | ---------: | -----------------------: |
| Median complete verification            | 4,728.6 ms |               4,514.6 ms |
| Median CPU time                         | 8,434.9 ms |               7,859.2 ms |
| Median setup                            |   261.5 ms |                 258.9 ms |
| Complete verified projections per child |          3 |                        3 |

Verification elapsed time fell 4.52%, and CPU time fell 6.83%. Every child produced complete-output SHA-256
`701783a543b224d9edd03c2b946b5dc7692619976c158735f02d8bfd2a8d06d2`. Copied verifier, input and harness hashes were
verified before execution; the exact owned pod directory was removed afterward. This temporary offline diagnostic
did not change the deployed service.

The host's default-heap fresh-process comparison improved only 1.65%, so it must not substitute for the bounded-heap
ARM result. Neither measurement proves the full report's deadline: SQL, archive reads, parallel workers, receipt
construction and cancellation still require packaged report acceptance after the normal release path.

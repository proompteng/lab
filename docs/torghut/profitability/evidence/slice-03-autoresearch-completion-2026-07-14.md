# Slice 3 Production Evidence: Autoresearch Completion Semantics

Status: production-proven for the Slice 3 semantic invariant. This evidence is not a profitability result, a market
replay, or capital authorization.

Evidence window: `2026-07-14T14:37:48Z` through `2026-07-14T15:05:16Z`.

## Invariant And Scope

The invariant under test is:

> A discarded, invalid, duplicate, or otherwise unproved candidate cannot satisfy the run objective or stop the
> autoresearch search.

The production path computes the raw objective independently, validates terminal candidate status, and only then
allows a retained valid candidate to set `objective_met`. Search decisions and their reasons are append-only run
artifacts. Frontier checkpoints make interruption and resume deterministic at committed boundaries.

The controlled deployed exercise below used synthetic candidates against the bundled strict `$300/day` research
program. It invoked the production `process_candidate_batch` implementation in the deployed scheduler image, but did
not query or mutate CNPG, ClickHouse, TigerBeetle, Alpaca, Kafka, capital authority, or live strategy configuration.

## Immutable Delivery Chain

| Boundary            | Evidence                                                                                                                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source PR           | `#12456`, `fix(torghut): enforce autoresearch completion semantics`                                                                                                                          |
| Source merge        | `11d676e9e4c3b5b7a8b3a82b7cb812e88b9a9317`                                                                                                                                                   |
| PR CI               | Torghut CI run `29341706270`: static gate, five Pyright profiles, eight general pytest shards, four autoresearch shards, mutation-fencing CAS, coverage, complexity, and security all passed |
| Local broad suite   | `5085 passed, 27 skipped`; skips were explicit opt-in PostgreSQL-DSN tests                                                                                                                   |
| Local focused suite | `81 passed`; one existing `asyncio.get_event_loop` warning                                                                                                                                   |
| Image build         | Multi-architecture build run `29342239231` passed for `linux/amd64` and `linux/arm64` and published the OCI index                                                                            |
| Image identity      | `registry.ide-newton.ts.net/lab/torghut@sha256:9c643f62e3defd6abd77aadce5b71771c7121bd24f06566ced8150bf531a987f`                                                                             |
| Release workflow    | Run `29342599746` verified the platform contract and generated the promotion                                                                                                                 |
| Promotion PR        | `#12458`, merged as `17906cf72d05ae852433efc562abe65e815176a5`                                                                                                                               |
| Core GitOps state   | Argo application `torghut`: `Synced`, `Healthy`, revision `17906cf72d05ae852433efc562abe65e815176a5`, operation `Succeeded`                                                                  |

The arm64 build emitted a non-blocking Attic cache-warm annotation. The registry push and multi-platform OCI index,
which are the release authorities, both succeeded.

## Automated Failure-Boundary Coverage

The shipped tests cover:

- a raw-objective hit that selection discards;
- a retained candidate below the objective and a retained candidate above it;
- stop-disabled behavior;
- vetoed, missing-ID, and duplicate candidates;
- duplicate identities across frontiers;
- interruption during setup and during frontier execution;
- repeated interruption followed by deterministic resume;
- completed-run idempotence;
- checkpoint corruption and changed-input-contract rejection;
- explicit max-frontier and worklist-exhaustion reasons;
- absence of credentials from checkpoint payloads.

The checkpoint execution digest binds the program, family templates, seed sweep, strategy ConfigMap, optional replay
inputs, and data-affecting arguments. Output destinations and credentials are deliberately excluded.

## GitOps And Runtime Readback

The standard migration hook completed with exit code zero before application rollout. No schema change was present.
The promoted core workloads reported:

| Workload              | Live evidence                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `torghut-scheduler`   | `1/1` ready, `1/1` available, zero restarts, promoted digest and source commit in pod and environment readback |
| Knative `torghut`     | Ready revision `torghut-01451`, promoted digest, `/healthz` HTTP 200                                           |
| Knative `torghut-sim` | Ready revision `torghut-sim-01527`, promoted digest, `/healthz` HTTP 200                                       |

Scheduler startup initially returned `scheduler_success_missing` and then briefly `scheduler_success_stale` while it
drained the bounded startup signal backlog. The process remained live, had no restart or reported scheduler error, and
continued rejecting signals with missing or excessive-spread executable quotes. After the first backlog cycles, 12
consecutive five-second readiness observations remained HTTP 200 across multiple new trading and reconciliation
success timestamps. The final readback at `2026-07-14T15:05:16Z` was:

```json
{
  "detail": "ok",
  "last_reconcile_at": "2026-07-14T15:05:10.417661+00:00",
  "last_run_at": "2026-07-14T15:05:10.300190+00:00",
  "reconcile_success_is_fresh": true,
  "running": true,
  "trading_success_is_fresh": true
}
```

## Deployed Controlled Exercise

The exercise was invoked through the deployed scheduler container with:

```sh
kubectl -n torghut exec -i deployment/torghut-scheduler -- python -
```

The script loaded `/app/config/trading/research-programs/strict-daily-profit-autoresearch-300-v1.yaml`, loaded the
checked-in family template and seed sweep, constrained the bounded selection to one retained candidate, and called
`process_candidate_batch` with:

- `feasible-below-objective`: capital-feasible and below the raw objective;
- `discarded-raw-objective-hit`: above every raw objective threshold but capital-infeasible and therefore not selected.

Assertions were evaluated inside the container and the process exited zero. The compact result was:

```json
{
  "commit": "11d676e9e4c3b5b7a8b3a82b7cb812e88b9a9317",
  "continuation_count": 1,
  "history": [
    {
      "candidate_id": "feasible-below-objective",
      "objective_met": false,
      "raw_objective_met": false,
      "search_action": "continue",
      "search_reason": "objective_not_met",
      "status": "keep",
      "terminal_validation_reason": "terminal_validation_passed",
      "terminal_validation_status": "valid"
    },
    {
      "candidate_id": "discarded-raw-objective-hit",
      "objective_met": false,
      "raw_objective_met": true,
      "search_action": "continue",
      "search_reason": "candidate_not_selected",
      "status": "discard",
      "terminal_validation_reason": "candidate_not_selected",
      "terminal_validation_status": "discarded"
    }
  ],
  "image_digest": "sha256:9c643f62e3defd6abd77aadce5b71771c7121bd24f06566ced8150bf531a987f",
  "objective_met": false,
  "program_id": "strict_daily_profit_autoresearch_300_v1",
  "scope": "deployed_read_only_synthetic_candidate_processing",
  "status": "pass",
  "termination": null
}
```

This proves the deployed semantic transition: the raw-objective hit remained non-objective, recorded the discard
reason, did not terminate the run, and left one continuation. It does not prove that any candidate is profitable.

## Capital And Economic Safety Readback

After rollout, direct CNPG readback returned:

```json
{"active_broker_grants": 0, "disabled": 8, "research_only": 6, "shadow_allowed": 3}
{"decisions_since_rollout": 0, "filled_since_rollout": 0}
```

Direct scheduler status also reported `entry_allowed=false`. Slice 3 created no capital-stage change, broker mutation,
trade decision, or fill.

## Unresolved Deltas

- The separate `torghut-options` Argo application remained intentionally contained by a live AppProject deny sync
  window and retained the prior shared-image digest. That live window is not represented by current repository
  AppProject configuration. It was not bypassed because doing so would broaden the Slice 3 rollout into an unrelated
  options-writer recovery. Core Torghut, the production entry point for this capability, is fully promoted and proven.
- Alpaca SIP fallback requests continued returning subscription HTTP 403 for some symbols. Quote-quality enforcement
  rejected those signals. This is a pre-existing data/execution blocker and remains profitability work; it is not
  evidence for or against the Slice 3 completion invariant.
- The deployed exercise is deliberately synthetic. Immutable market replay, candidate profitability, and promotion
  eligibility remain unproved and must be established by later roadmap slices.

## Verdict

Slice 3 satisfies its production completion contract: the behavior is reachable in the shipped entry point, failure
boundaries are tested, CI and immutable image publication passed, GitOps promoted the source and image identities, and
the deployed controlled exercise proved that a discarded raw-objective hit cannot stop the search. Real-capital
risk-increasing submission remains blocked.

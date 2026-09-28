# 05. Dataset and Feature Versioning Spec

## Objective

Guarantee that every research and promotion decision is reproducible via versioned datasets, point-in-time feature
snapshots, and strict schema compatibility.

## Versioning Model

Dataset identity:

- `dataset_id`: immutable identifier,
- `universe_snapshot_id`,
- `start_ts` and `end_ts`,
- `source_hash`.

Feature identity:

- `feature_schema_version`,
- `mapper_version`,
- `normalization_version`,
- `parity_hash`.

## Point-in-Time Correctness Rules

- no future leakage in features,
- no same-bar fill assumptions for close-derived signals,
- symbol membership frozen per snapshot.

## Storage and Registry

- research registry table stores dataset and feature metadata.
- artifacts include manifest JSON and checksum.
- promotion cannot proceed if referenced snapshot is unavailable.

## Compatibility Policy

- additive fields => minor schema bump,
- breaking field change => major schema bump,
- strategy declares minimum required schema version.

## Parity and Drift Checks

- nightly online/offline feature parity check.
- drift report includes top symbols, fields, and deltas.
- parity failure blocks promotion.

## Retention and Replay Policy

- keep minimum replay horizon required by promotion gates.
- archive old snapshots with immutable checksums.
- maintain deterministic rehydration instructions.

## Agent Implementation Scope (Significant)

Workstream A: metadata schema

- add dataset/feature registry tables and migrations.

Workstream B: snapshot tooling

- implement dataset snapshot builder and manifest writer.

Workstream C: parity verifier

- implement online/offline parity check and drift report.

Workstream D: gate integration

- enforce snapshot/feature compatibility in promotion checks.

Owned areas:

- `services/torghut/migrations/**`
- `services/torghut/app/trading/features.py`
- `services/torghut/scripts/**`
- `services/torghut/tests/**`

Minimum deliverables:

- registry schema,
- snapshot CLI,
- parity checker,
- gate integration tests.

## AgentRun Handoff Bundle

- `ImplementationSpec`: `torghut-v3-data-feature-versioning-impl-v1`.
- Required keys:
  - `datasetWindow`
  - `universe`
  - `featureSchemaVersion`
  - `artifactPath`
- Exit criteria:
  - snapshot reproducibility proven across reruns,
  - parity drift alerts integrated,
  - promotions blocked on version mismatch.

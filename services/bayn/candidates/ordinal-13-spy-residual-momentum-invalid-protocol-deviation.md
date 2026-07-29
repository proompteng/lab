# Candidate ordinal 13: SPY-residual momentum invalid protocol deviation

Status: **INVALID_PROTOCOL_DEVIATION — consumed development attempt; executable candidate removed**

Candidate 13 did not produce valid development evidence. Its one metric-bearing execution reached the preregistered
doubled-cost causal replay, but the exact baseline order quantities required borrowed cash under the frozen `2x` cost
model. The replay therefore failed closed before a conforming stressed path, economic verdict, bootstrap analysis, or
walk-forward analysis could be produced. This outcome is neither `PASS` nor `HOLD_REJECT`, and it is not evidence of
profitability.

## Immutable lineage

- Fresh base commit: `e0d6f23814df4749f6c9432d6b53d5f8c9e00f80`.
- Candidate-development v2 source revision: `ad9a7477d645b4644c83384158783b2083fc7f88`.
- Deployed image digest used for the read-only run:
  `sha256:ad8c84a312bcf66cc998029b91f13e4e785f50e30351396e69a1b0f68183e881`.
- Preregistration commit: `3e8edb4f15d54f9d6be177c411062c3ee614c992`.
- Preregistration parent: `e0d6f23814df4749f6c9432d6b53d5f8c9e00f80`.
- Preregistration file SHA-256:
  `69d9f06cc53cc54265279ad969396bc6fa5d0aedea1c50eda78313a22d444af8`.
- Evaluated implementation commit: `864c9f5d1c0867f31924357e913bed12df9c3b3d`.
- Evaluated implementation parent: `3e8edb4f15d54f9d6be177c411062c3ee614c992`.
- Candidate ordinal: `13`.
- Prior trial count: `12`.
- Protocol schema: `bayn.candidate-development-protocol.v2`.
- Protocol identity hash: `e9cc365a8b1c2cffe2aa37b496387000695e2a78d1093ad36e142261eab88454`.
- Bootstrap policy: 10,000 samples, adjusted lower-tail sample count 38, one-sided family alpha `0.05 / 13`.

The Git ancestry remains the durable proof that the evaluated implementation followed the immutable preregistration.
The final cleanup commit is a descendant of the evaluated implementation and removes its executable code without
rewriting either frozen commit.

## Frozen data request and preflight

- Snapshot ID: `2a91f0177684f7022f746207333e510c8268f9b77a04b778a04220a33ccf79e0`.
- Read-only table: `signal.adjusted_daily_bars_v2`.
- Exact query ID: `bayn-candidate-13-development-bars-one-shot`.
- Bounds: `2016-01-04` through `2022-12-30`, inclusive.
- Ordered universe: `DBC,EFA,IEF,SPY,VNQ`.
- Official sessions: 1,762.
- Expected ordered bar rows: 8,810.
- Candidate-development calendar hash:
  `a6df7a68249842fa35814f282b3df63db19c52f6ea0697899979d3a8c970d9b1`.
- First eligible signal and execution: `2017-01-31` close to `2017-02-01` open.
- Selected comparison observations: 1,489, `2017-02-02` through `2022-12-30`.
- Walk-forward geometry: 504 initial observations followed by five non-overlapping 197-observation folds, with one
  earlier eligible observation unused.

The execution reached baseline simulation and then the stressed causal replay. Under the evaluated control flow, that is
possible only after the complete ordered data shape, OHLCV validity, snapshot identity, canonical calendar, and locally
computed data hashes have passed validation. The process returned before report construction, so the run-specific
`barsContentHash` and dataset `sessionsContentHash` were not emitted and cannot be truthfully reconstructed without an
unauthorized rerun. They are recorded as **not durably emitted**, not guessed.

## Exact one-shot execution evidence

The evaluated source was bundled for the deployed Node 24 runtime without changing source or research bytes. The
transport bundle embedded only the exact preregistration bytes so the evaluator could hash them before I/O.

- Node ESM evaluated bundle SHA-256:
  `e52b1e589bc1c52a6740603f8cb72cf75683273c1c931f728d1503bd49a22557`.
- Streamed transport bundle SHA-256:
  `e99f173f65f91d18462bac613baf11943bdf47c27a99417b647ab0955da7398e`.
- Metric-bearing process start: `2026-07-29T21:23:48.671Z`.
- Metric-bearing process finish: `2026-07-29T21:23:50.193Z`.
- Process exit code: `1`.
- Standard-error artifact size: 147 bytes.
- Standard-error artifact SHA-256:
  `a321a5a14e44c064e303b8aaf1b3e87d569a959ab4a9e933f257a3724c27b50a`.
- Standard-output/report artifact size: 0 bytes.
- Empty report artifact SHA-256:
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

Three transport-only attempts preceded the metric-bearing process and produced no report or development metric: an
incorrect wrapper expectation for the evaluated Git SHA aborted before `kubectl exec`; a Bun invocation failed before
application startup because the deployed image contains Node rather than Bun; and one invocation request was rejected
before command dispatch by the tool safety envelope. None queried development bars. The final Node transport was the
only metric-bearing execution.

## Terminal protocol deviation

The exact terminal failure was:

```text
Candidate13DoubledCostReplayInvalid:fixed baseline quantities require borrowed cash on 2022-03-01: -1961434411
```

The amount is denominated in micros: `-1961434411` micros, or `-$1,961.434411`.

The shared baseline simulator completed far enough to produce the exact ordered baseline signal decisions and order
quantities. The candidate-local stressed replay then held those quantities invariant and recomputed spread, slippage,
fees, cash, positions, marks, and returns under exactly `2x` costs. On `2022-03-01`, the frozen 1% cash reserve was
insufficient and cash became negative. Borrowing was explicitly forbidden by the preregistration, so the replay returned
`INVALID_PROTOCOL_DEVIATION` immediately.

Because the stressed replay did not complete, candidate-development v2 could not attest an identical conforming
baseline/stressed signal and quantity path. No alternative reserve, quantity, cost model, execution order, parameter,
seed, or family is authorized. Candidate 13 is consumed.

## Metrics, gates, folds, and confidence bounds

The evaluated implementation calculated baseline simulation state internally before entering the stressed replay, but it
returned the typed replay failure before serializing baseline metrics or constructing report evidence. The one-shot rule
forbids rerunning the development bars to recover those transient values. Therefore:

- no durable baseline performance metric values were emitted;
- no conforming doubled-cost performance metric exists;
- no stronger benchmark was selected;
- no economic gate verdict was constructed;
- no bootstrap samples or bootstrap hash were constructed;
- no annualized excess-return lower confidence bound was constructed;
- no Sharpe-difference lower confidence bound was constructed;
- no walk-forward fold metrics or fold verdicts were constructed; and
- no report hash or family run ID was emitted.

These fields are **not available because protocol validation terminated first**. They are not zero, not failed statistical
gates, and not omitted evidence that may be recovered with a second run.

## Holdout and mutation proof

The untouched holdout remains:

```text
start=2023-01-03
end=2025-12-31
inspected=false
accessCount=0
```

The only market-data query was statically bounded to `2016-01-04` through `2022-12-30`; no query mentioned or spanned a
holdout date. The command used ClickHouse `readonly=1` and contained no database write, broker access, capital grant,
runtime composition, manifest, GitOps, deployment, authority, or order-submission path. No broker, capital, database,
runtime, manifest, or deployment mutation occurred.

## Final disposition

Candidate 13 is permanently classified `INVALID_PROTOCOL_DEVIATION`. Its candidate-specific CLI, source, tests, and
package script are removed from the final branch. This Markdown outcome and the immutable preregistration are retained.
The pull request must remain closed and unmerged. Candidate 13 supplies no basis for terminal qualification, holdout
access, PAPER or LIVE authority, capital allocation, deployment, or profitability claims.

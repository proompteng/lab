# `bilig` Observability Contract

## Required signals

- release SHA
- app version
- WASM binary version
- formula execution metrics:
  - JS oracle validations
  - WASM shadow runs
  - WASM production runs
- formula error rates by visible Excel error family
- recalc latency
- browser/runtime startup latency

## Top 100-specific requirement

Observability must let operators answer:

- which formula families are running in WASM production mode
- whether a promoted family is still falling back unexpectedly
- whether a rollout regressed formula latency or error rates

## Ownership split

- metric semantics originate in `bilig`
- collection, routing, dashboards, and alerts are owned by `lab`

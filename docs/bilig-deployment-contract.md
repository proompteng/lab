# `bilig` Deployment Contract

## Scope

`lab` owns the deployment contract for `bilig` runtime environments.

## Required deployment surfaces

- `bilig-web`
- `bilig-sync`
- supporting stateful dependencies required by the active product milestone

## Runtime assumptions imported from `bilig`

- Top 100 formula milestone is the active product milestone
- WASM binary size and frontend bundle size are release-gated
- workbook metadata needed by formulas must be preserved across runtime boundaries
- volatile/runtime context required by the formula engine must be injectable by the deployed runtime

## Explicit non-scope

- formula semantics
- parser behavior
- compatibility registry content

Those remain owned by `bilig`.

#!/usr/bin/env bun

if (import.meta.main) {
  console.error(
    'deploy:torghut has been retired. Merge source and desired-state changes to main; CI, Kargo, and Argo deploy the retained market-data workloads. See argocd/applications/torghut/runtime-retirement.md.',
  )
  process.exitCode = 1
}

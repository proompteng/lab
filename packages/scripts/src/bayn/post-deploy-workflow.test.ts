import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const workflow = readFileSync(
  new URL('../../../../.github/workflows/bayn-post-deploy-verify.yml', import.meta.url),
  'utf8',
)

describe('Bayn post-deploy verifier workflow', () => {
  test('runs after Bayn GitOps changes and supports exact manual verification', () => {
    expect(workflow).toContain('name: bayn-post-deploy-verify')
    expect(workflow).toContain("- 'argocd/applications/bayn/**'")
    expect(workflow).toContain("- 'argocd/applicationsets/product.yaml'")
    expect(workflow).toContain('expected_revision:')
    expect(workflow).toContain('runs-on: arc-arm64')
  })

  test('is observe-only and never mutates Argo or workloads', () => {
    expect(workflow).not.toContain('kubectl patch')
    expect(workflow).not.toContain('kubectl annotate')
    expect(workflow).not.toContain('kubectl apply')
    expect(workflow).not.toContain('kubectl rollout restart')
    expect(workflow).not.toContain('contents: write')
  })

  test('requires healthy Argo, a converged Deployment, and the full runtime evidence contract', () => {
    expect(workflow).toContain('[ "${SYNC_STATUS}" = \'Synced\' ]')
    expect(workflow).toContain('[ "${HEALTH_STATUS}" = \'Healthy\' ]')
    expect(workflow).toContain('kubectl rollout status deployment/bayn -n bayn --timeout=10m')
    expect(workflow).toContain('packages/scripts/src/bayn/post-deploy-evidence.ts')
    expect(workflow).toContain('http://bayn.bayn.svc.cluster.local/readyz')
    expect(workflow).toContain('http://bayn.bayn.svc.cluster.local/v1/status')
  })

  test('allows only a safe descendant revision that leaves Bayn GitOps inputs unchanged', () => {
    expect(workflow).toContain('git merge-base --is-ancestor "${EXPECTED_REVISION}" "${actual}"')
    expect(workflow).toContain('git diff --quiet "${EXPECTED_REVISION}..${actual}" --')
    expect(workflow).toContain('argocd/applications/bayn')
    expect(workflow).toContain('argocd/applicationsets/product.yaml')
  })
})

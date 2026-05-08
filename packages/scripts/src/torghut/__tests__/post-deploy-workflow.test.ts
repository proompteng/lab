import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'bun:test'

const workflow = readFileSync(
  new URL('../../../../../.github/workflows/torghut-post-deploy-verify.yml', import.meta.url),
  'utf8',
)
const agentsCiClusterRbac = readFileSync(
  new URL('../../../../../argocd/applications/agents-ci/runner-rbac-cluster.yaml', import.meta.url),
  'utf8',
)

describe('torghut post-deploy verifier workflow', () => {
  it('does not skip Knative Service readiness when the runner lacks RBAC', () => {
    expect(workflow).not.toContain('Skipping Knative Service readiness check')
    expect(workflow).toContain('Failed to read Knative Service torghut')
  })

  it('fails the deploy verifier when Torghut readyz is not 2xx', () => {
    expect(workflow).toContain('expected 2xx')
    expect(workflow).toContain('[ "${TORGHUT_READYZ_HTTP_STATUS}" -lt 200 ]')
    expect(workflow).toContain('[ "${TORGHUT_READYZ_HTTP_STATUS}" -ge 300 ]')
  })

  it('grants the ARC runner read access to Torghut Knative Service readiness', () => {
    expect(agentsCiClusterRbac).toContain('agents-ci-runner-torghut-post-deploy-read')
    expect(agentsCiClusterRbac).toContain('serving.knative.dev')
    expect(agentsCiClusterRbac).toContain('arc-arm64-gha-rs-kube-mode')
  })
})

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

  it('uses a shell-safe jsonpath for Knative Service readiness', () => {
    expect(workflow).toContain(`jsonpath='{.status.conditions[?(@.type=="Ready")].status}'`)
    expect(workflow).not.toContain(`jsonpath='{.status.conditions[?(@.type==\\"Ready\\")].status}'`)
  })

  it('fails the deploy verifier when Torghut readyz is not 2xx', () => {
    expect(workflow).toContain('expected 2xx')
    expect(workflow).toContain('[ "${TORGHUT_READYZ_HTTP_STATUS}" -lt 200 ]')
    expect(workflow).toContain('[ "${TORGHUT_READYZ_HTTP_STATUS}" -ge 300 ]')
  })

  it('requests Argo refresh before polling deployed revisions', () => {
    expect(workflow).toContain('argocd.argoproj.io/refresh=hard --overwrite')
    expect(workflow).toContain('for app in torghut torghut-options; do')
  })

  it('grants the ARC runner read access to Torghut Knative Service readiness', () => {
    expect(agentsCiClusterRbac).toContain('agents-ci-runner-torghut-post-deploy-read')
    expect(agentsCiClusterRbac).toContain('serving.knative.dev')
    expect(agentsCiClusterRbac).toContain('arc-arm64-gha-rs-kube-mode')
  })

  it('grants the ARC runner patch access for explicit Argo refreshes', () => {
    expect(agentsCiClusterRbac).toContain('agents-ci-runner-argocd-application-refresh')
    expect(agentsCiClusterRbac).toContain('argoproj.io')
    expect(agentsCiClusterRbac).toContain('patch')
  })
})

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const root = new URL('../../../../', import.meta.url)
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8')

const workflow = read('.github/workflows/bayn-post-deploy-verify.yml')
const rbac = read('argocd/applications/agents-ci/bayn-post-deploy-rbac.yaml')
const agentsCiKustomization = read('argocd/applications/agents-ci/kustomization.yaml')
const baynNetworkPolicy = read('argocd/applications/bayn/networkpolicy.yaml')

describe('Bayn post-deploy workflow', () => {
  test('runs after Bayn GitOps changes, on a 30-minute surveillance cadence, or explicit dispatch', () => {
    expect(workflow).toContain("- 'argocd/applications/bayn/**'")
    expect(workflow).toContain("- 'argocd/applications/agents-ci/bayn-post-deploy-rbac.yaml'")
    expect(workflow).toContain("- 'argocd/applications/agents-ci/kustomization.yaml'")
    expect(workflow).toContain("- '.github/workflows/bayn-post-deploy-verify.yml'")
    expect(workflow).toContain("- 'packages/scripts/src/bayn/verify-post-deploy.ts'")
    expect(workflow).toContain("- cron: '11,41 * * * *'")
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('cancel-in-progress: true')
    expect(workflow).not.toContain('argocd/applications/agents-ci/**')
  })

  test('binds scheduled surveillance to the latest Bayn GitOps commit instead of unrelated main changes', () => {
    expect(workflow).toContain('if [ "${EVENT_NAME}" = \'schedule\' ]; then')
    expect(workflow).toContain('git log -1 --format=%H origin/main -- argocd/applications/bayn')
  })

  test('defaults manual dispatch to the main commit that was actually checked out', () => {
    expect(workflow).toContain('expected_revision="$(git rev-parse HEAD)"')
    expect(workflow).not.toContain('expected_revision="${GITHUB_SHA}"')
  })

  test('uses the low-authority amd64 runner and does not mutate GitHub or Argo', () => {
    expect(workflow).toContain('runs-on: arc-amd64')
    expect(workflow).toContain('contents: read')
    expect(workflow).toContain("ref: ${{ github.event_name == 'push' && github.sha || 'main' }}")
    expect(workflow).not.toContain('contents: write')
    expect(workflow).not.toContain('pull-requests: write')
    expect(workflow).not.toContain('kubectl patch')
    expect(workflow).not.toContain('kubectl annotate')
    expect(workflow).toContain('verify-post-deploy.ts')
  })

  test('adds only the missing named RestateDeployment read to the no-permission runner identity', () => {
    expect(agentsCiKustomization).toContain('- bayn-post-deploy-rbac.yaml')
    expect(rbac).toContain('name: arc-amd64-gha-rs-no-permission')
    expect(rbac).toContain('namespace: arc')
    expect(rbac).toContain('resourceNames:\n      - bayn-execution-controller')
    expect(rbac).not.toContain('services/proxy')
    expect(rbac).not.toContain('- deployments')
    expect(rbac).not.toContain('secrets')
    expect(rbac).not.toContain('- create')
    expect(rbac).not.toContain('- update')
    expect(rbac).not.toContain('- patch')
    expect(rbac).not.toContain('- delete')
  })

  test('allows only the repository amd64 runner to read the Bayn HTTP evidence surface', () => {
    expect(baynNetworkPolicy).toContain('kubernetes.io/metadata.name: arc')
    expect(baynNetworkPolicy).toContain('actions.github.com/organization: proompteng')
    expect(baynNetworkPolicy).toContain('actions.github.com/repository: lab')
    expect(baynNetworkPolicy).toContain('actions.github.com/scale-set-name: arc-amd64')
    expect(baynNetworkPolicy).toContain('app.kubernetes.io/component: runner')
  })
})

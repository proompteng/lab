import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const root = new URL('../../../../', import.meta.url)
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8')

const workflow = read('.github/workflows/bayn-post-deploy-verify.yml')
const rbac = read('argocd/applications/agents-ci/bayn-post-deploy-rbac.yaml')
const agentsCiKustomization = read('argocd/applications/agents-ci/kustomization.yaml')

describe('Bayn post-deploy workflow', () => {
  test('runs after Bayn GitOps changes, on a 30-minute surveillance cadence, or explicit dispatch', () => {
    expect(workflow).toContain("- 'argocd/applications/bayn/**'")
    expect(workflow).toContain("- cron: '11,41 * * * *'")
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('cancel-in-progress: true')
    expect(workflow).not.toContain('argocd/applications/agents-ci/**')
  })

  test('binds scheduled surveillance to the latest Bayn GitOps commit instead of unrelated main changes', () => {
    expect(workflow).toContain('if [ "${EVENT_NAME}" = \'schedule\' ]; then')
    expect(workflow).toContain('git log -1 --format=%H origin/main -- argocd/applications/bayn')
  })

  test('uses the low-authority amd64 runner and does not mutate GitHub or Argo', () => {
    expect(workflow).toContain('runs-on: arc-amd64')
    expect(workflow).toContain('contents: read')
    expect(workflow).not.toContain('contents: write')
    expect(workflow).not.toContain('pull-requests: write')
    expect(workflow).not.toContain('kubectl patch')
    expect(workflow).not.toContain('kubectl annotate')
    expect(workflow).toContain('verify-post-deploy.ts')
  })

  test('adds only the missing named Bayn reads to the no-permission runner identity', () => {
    expect(agentsCiKustomization).toContain('- bayn-post-deploy-rbac.yaml')
    expect(rbac).toContain('name: arc-amd64-gha-rs-no-permission')
    expect(rbac).toContain('namespace: arc')
    expect(rbac).toContain('resourceNames:\n      - bayn')
    expect(rbac).toContain('- bayn:80')
    expect(rbac).toContain('resourceNames:\n      - bayn-execution-controller')
    expect(rbac).toContain('- services/proxy')
    expect(rbac).not.toContain('- deployments')
    expect(rbac).not.toContain('secrets')
    expect(rbac).not.toContain('- create')
    expect(rbac).not.toContain('- update')
    expect(rbac).not.toContain('- patch')
    expect(rbac).not.toContain('- delete')
  })
})

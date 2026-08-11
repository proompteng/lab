import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'
import { parse } from 'yaml'

import { baynPromotionManifestPaths } from './verify-promotion-eligibility'

const workflowPath = new URL('../../../../.github/workflows/bayn-promotion-eligibility.yml', import.meta.url)
const workflow = readFileSync(workflowPath, 'utf8')
const parsed = parse(workflow) as Record<string, unknown>
const events = parsed.on as Record<string, unknown>
const jobs = parsed.jobs as Record<string, Record<string, unknown>>

const count = (value: string): number => workflow.split(value).length - 1

describe('Bayn promotion eligibility workflow', () => {
  test('publishes a matrix-evaluated exact-head context for the promotion shape', () => {
    expect(parsed.name).toBe('bayn-promotion-eligibility')
    expect(jobs.required?.name).toBe('${{ matrix.checkName }}')
    expect(workflow).toContain('include: ${{ fromJSON(')
    expect(workflow).toContain('"checkName":"Bayn promotion exact-head gate"')
    expect(workflow).toContain('"requireApplicable":"true"')
    expect(workflow).not.toContain('name: Bayn release gate')
    expect(workflow).toContain("if: github.event_name == 'pull_request_target'")
    expect(workflow).not.toContain('workflow_dispatch:')
    expect(workflow).not.toContain('\n  push:')
  })

  test('isolates non-promotion manifest PRs with a distinct matrix context', () => {
    const pullRequestTarget = events.pull_request_target as { readonly paths: readonly string[] }
    expect(pullRequestTarget.paths).toEqual([...baynPromotionManifestPaths])
    expect(workflow).toContain('Matrix names are evaluated by the hosted runtime')
    expect(workflow).toContain('"checkName":"Bayn promotion eligibility (not applicable)"')
    expect(workflow).toContain('"requireApplicable":"false"')
    expect(workflow).toContain('--require-applicable "${{ matrix.requireApplicable }}"')
  })

  test('reruns automatically for synchronization, issue comments, and settled fallback evidence', () => {
    for (const event of ['pull_request_target:', 'issue_comment:', 'schedule:']) {
      expect(workflow).toContain(`  ${event}`)
    }
    expect(workflow).not.toContain('  pull_request_review:')
    expect(workflow).not.toContain('  pull_request_review_comment:')
    for (const type of ['opened', 'synchronize', 'reopened', 'ready_for_review', 'created', 'edited', 'deleted']) {
      expect(workflow).toContain(`      - ${type}`)
    }
    expect(workflow).toContain('cancel-in-progress: true')
    expect(workflow).toContain("format('gate-{0}', github.event.pull_request.number)")
    expect(workflow).toContain("format('refresh-comment-{0}', github.event.issue.number)")
    expect(workflow).toContain("'refresh-schedule'")
    expect(workflow).toContain("cron: '7,22,37,52 * * * *'")
  })

  test('keeps required polling and evidence refresh in separate concurrency lanes', () => {
    expect(workflow).toContain("github.event_name == 'pull_request_target'")
    expect(workflow).toContain("github.event_name == 'issue_comment'")
    expect(workflow).toContain("format('gate-{0}'")
    expect(workflow).toContain("format('refresh-comment-{0}'")
    expect(workflow).not.toContain('github.event.pull_request.number ||\n      github.event.issue.number')
  })

  test('limits the exact context trigger to release-owned manifest paths', () => {
    expect(workflow).toContain('    paths:')
    expect(workflow).not.toContain('    paths-ignore:')
    expect(workflow).not.toContain('    branches:')
    expect(workflow).not.toContain('    branches-ignore:')
  })

  test('runs the verifier only from trusted main with read-only GitHub authority', () => {
    expect(workflow).toContain('actions: read')
    expect(workflow).toContain('contents: read')
    expect(workflow).toContain('pull-requests: read')
    expect(workflow).not.toContain(': write')
    expect(workflow).not.toContain('ref: ${{ github.event.pull_request.head.sha }}')
    expect(count('ref: main')).toBe(1)
    expect(count('ref: ${{ github.sha }}')).toBe(1)
    expect(workflow).toContain('persist-credentials: false')
    expect(workflow).toContain('BAYN_PROMOTION_GITHUB_TOKEN: ${{ github.token }}')
  })

  test('runs the bounded exact-head review and immutable provenance verifier', () => {
    expect(workflow).toContain('bun packages/scripts/src/bayn/verify-promotion-eligibility.ts')
    expect(workflow).toContain('--repository "${GITHUB_REPOSITORY}"')
    expect(workflow).toContain('--pull-number "${PROMOTION_PR_NUMBER}"')
    expect(workflow).toContain('--head-sha "${PROMOTION_HEAD_SHA}"')
    expect(workflow).toContain('--max-attempts 36')
    expect(workflow).toContain('--poll-interval-ms 10000')
    expect(workflow).toContain('--request-timeout-ms 10000')
    expect(workflow).toContain('--require-applicable "${{ matrix.requireApplicable }}"')
    expect(workflow).toContain('timeout-minutes: 8')
  })

  test('installs locked verifier dependencies in every job before executing the verifier', () => {
    const install = 'bun install --frozen-lockfile --ignore-scripts --filter @proompteng/scripts'
    const verifier = 'bun packages/scripts/src/bayn/verify-promotion-eligibility.ts'
    const requiredStart = workflow.indexOf('  required:')
    const refreshStart = workflow.indexOf('  refresh:')
    const required = workflow.slice(requiredStart, refreshStart)
    const refresh = workflow.slice(refreshStart)

    expect(workflow.split(install).length - 1).toBe(2)
    expect(required.indexOf(install)).toBeGreaterThan(-1)
    expect(required.indexOf(install)).toBeLessThan(required.indexOf(verifier))
    expect(refresh.indexOf(install)).toBeGreaterThan(-1)
    expect(refresh.indexOf(install)).toBeLessThan(refresh.indexOf(verifier))
  })

  test('refreshes the exact-head gate in both directions without touching unrelated pull requests', () => {
    expect(workflow).toContain('name: Refresh the exact-head gate when eligibility changes')
    expect(workflow).toContain("github.event_name == 'schedule'")
    expect(workflow).toContain("github.event_name == 'issue_comment'")
    expect(workflow).toContain('BAYN_PROMOTION_RERUN_TOKEN: ${{ secrets.AGENTS_SPLIT_TOKEN }}')
    expect(workflow).toContain('GH_TOKEN: ${{ github.token }}')
    expect(workflow).toContain('--max-attempts 1')
    expect(workflow).toContain('is not the exact Bayn promotion shape; no refresh is required.')
    expect(workflow).toContain('commits/${head_sha}/check-runs?filter=latest&per_page=100')
    expect(workflow).toContain('.name == "Bayn promotion exact-head gate"')
    expect(workflow).toContain('"${verifier_status}" == \'0\' && "${conclusion}" != success')
    expect(workflow).toContain('"${verifier_status}" != \'0\' && "${conclusion}" == success')
    expect(workflow).toContain('Promotion PR #${pull_number} gate already reflects current eligibility.')
    expect(workflow).toContain('/actions/runs/([0-9]+)/job/')
    expect(workflow).toContain('actions/runs/${run_id}/rerun')
    expect(workflow).not.toContain('rulesets/')
    expect(workflow).not.toContain('branches/main/protection')
    expect(workflow).not.toContain('@codex')
  })

  test('serializes and bounds a current-base refresh through the verified causal release', () => {
    expect(workflow).toContain('group: bayn-promotion-eligibility-current-base-refresh')
    expect(workflow).toContain('cancel-in-progress: false')
    expect(workflow).toContain('name: Refresh a verified behind promotion through its causal release')
    expect(workflow).toContain("if: github.event_name == 'schedule'")
    expect(workflow).toContain('--mode current-base-refresh')
    expect(workflow).toContain('--default-branch-sha "${EXPECTED_DEFAULT_BRANCH_SHA}"')
    expect(workflow).toContain('BAYN_PROMOTION_BASE_REFRESH\\ pr=#')
    expect(workflow).toContain('[[ "$(jq -r \'.default_branch\' <<< "${repository}")" != main ]]')
    expect(workflow).toContain('[[ "$(jq -r \'.base.sha\' <<< "${pull}")" != "${current_base_sha}" ]]')
    expect(workflow).toContain('[[ "$(jq -r \'.run_attempt\' <<< "${release_run}")" != "${release_attempt}" ]]')
    expect(workflow).toContain('[[ "$(jq -r \'.head_sha\' <<< "${release_run}")" != "${source_sha}" ]]')
    expect(workflow).toContain('actions/runs/${release_run_id}/rerun')
    expect(workflow).toContain('no duplicate rerun requested')
    expect(workflow).not.toContain('actions/workflows/bayn-release.yml/dispatches')
    expect(workflow).not.toContain('git push')
    expect(workflow).not.toContain('git branch -D')
  })
})

import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'
import { parse } from 'yaml'

const workflowPath = new URL('../../../../.github/workflows/bayn-promotion-automerge.yml', import.meta.url)
const workflow = readFileSync(workflowPath, 'utf8')
const parsed = parse(workflow) as Record<string, unknown>
const events = parsed.on as Record<string, unknown>
const permissions = parsed.permissions as Record<string, string>

const count = (value: string): number => workflow.split(value).length - 1

describe('Bayn promotion auto-merge workflow', () => {
  test('owns one serialized unattended schedule with explicit merge authority', () => {
    expect(parsed.name).toBe('bayn-promotion-automerge')
    expect(events.schedule).toEqual([{ cron: '12,27,42,57 * * * *' }])
    expect(workflow).not.toContain('workflow_dispatch:')
    expect(workflow).not.toContain('pull_request_target:')
    expect(workflow).not.toContain('\n  push:')
    expect(workflow).toContain('group: bayn-promotion-automerge')
    expect(workflow).toContain('cancel-in-progress: false')
    expect(permissions).toEqual({
      actions: 'read',
      checks: 'read',
      contents: 'write',
      'pull-requests': 'write',
    })
  })

  test('checks out only the trusted schedule revision and refuses a stale main policy', () => {
    expect(workflow).toContain('name: Checkout trusted current-main merge policy')
    expect(workflow).toContain('ref: ${{ github.sha }}')
    expect(workflow).toContain('persist-credentials: false')
    expect(workflow).not.toContain('ref: ${{ github.event.pull_request.head.sha }}')
    expect(workflow).toContain('TRUSTED_MAIN_SHA: ${{ github.sha }}')
    expect(count('git/ref/heads/main')).toBe(2)
    expect(workflow).toContain('Main advanced from trusted workflow revision')
    expect(workflow).toContain('Main advanced during verification; refusing a stale merge.')
  })

  test('discovers exactly one same-repository preserved release branch', () => {
    expect(workflow).toContain(
      'pulls?state=open&base=main&head=${repository_owner}:codex/bayn-release-current&per_page=100',
    )
    expect(workflow).toContain('Expected exactly one preserved Bayn promotion PR')
    expect(workflow).toContain('No open Bayn promotion PR is ready for automatic merge.')
    expect(workflow).toContain('[[ ! "${expected_head_sha}" =~ ^[0-9a-f]{40}$ ]]')
  })

  test('uses the existing non-recursive token and never falls back to the event token for a merge', () => {
    expect(workflow).toContain('GH_TOKEN: ${{ secrets.AGENTS_SPLIT_TOKEN }}')
    expect(workflow).toContain('BAYN_PROMOTION_GITHUB_TOKEN: ${{ secrets.AGENTS_SPLIT_TOKEN }}')
    expect(workflow).not.toContain('secrets.GITHUB_TOKEN')
    expect(workflow).not.toContain('github.token')
    expect(workflow).toContain(
      'AGENTS_SPLIT_TOKEN is required so the merge triggers the normal push and GitOps workflows.',
    )
  })

  test('binds current PR metadata and exact-head checks into two fail-closed snapshots', () => {
    expect(count('write_snapshot "${')).toBe(2)
    expect(count('verify_snapshot "${')).toBe(2)
    expect(workflow).toContain('--json name,state,workflow,link')
    expect(workflow).toContain('--json number,state,isDraft,mergeable,mergeStateStatus')
    expect(workflow).toContain('autoMergeEnabled: ($pull.autoMergeRequest != null)')
    expect(workflow).toContain('headRepository: ($pull.headRepository.nameWithOwner // "")')
    expect(workflow).toContain('files: [$pull.files[] | {path, status: .changeType}]')
    expect(workflow).toContain('checks: [$checks[] | {workflow, name, state, link}]')
    expect(workflow).toContain("checks_status}\" != '0'")
    expect(workflow).toContain("checks_status}\" != '1'")
    expect(workflow).toContain("checks_status}\" != '8'")
  })

  test('reproves immutable promotion eligibility before and immediately after the final snapshot', () => {
    expect(count('bun packages/scripts/src/bayn/verify-promotion-eligibility.ts')).toBe(2)
    expect(workflow).toContain('--head-sha "${expected_head_sha}"')
    expect(workflow).toContain('--max-attempts 1')
    expect(workflow).toContain('--poll-interval-ms 1')
    expect(workflow).toContain('--request-timeout-ms 10000')
    expect(workflow).toContain('--require-applicable true')
  })

  test('squash-merges only the unchanged exact head and preserves its branch', () => {
    expect(workflow).toContain('gh pr merge "${pull_number}"')
    expect(workflow).toContain('--squash')
    expect(workflow).toContain('--match-head-commit "${expected_head_sha}"')
    expect(workflow).not.toContain('--auto')
    expect(workflow).not.toContain('--admin')
    expect(workflow).not.toContain('--delete-branch')
    expect(workflow).not.toContain('git push')
    expect(workflow).toContain("merged_state}\" != 'MERGED'")
    expect(workflow).toContain('BAYN_PROMOTION_AUTOMERGED')
  })

  test('does not mutate repository or cluster security policy', () => {
    for (const forbidden of [
      'rulesets/',
      'branches/main/protection',
      'kubectl',
      'NetworkPolicy',
      'workflow_dispatch',
      'actions/workflows/bayn-release.yml/dispatches',
      '@codex',
    ]) {
      expect(workflow).not.toContain(forbidden)
    }
  })
})

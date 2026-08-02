import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'
import { parse } from 'yaml'

const workflowPath = new URL('../../../../.github/workflows/bayn-build-push.yml', import.meta.url)
const workflow = readFileSync(workflowPath, 'utf8')
const parsed = parse(workflow) as {
  readonly name: string
  readonly concurrency: {
    readonly group: string
    readonly 'cancel-in-progress': boolean
  }
}

const normalizedConcurrencyGroup = parsed.concurrency.group.replace(/\s+/g, ' ').trim()

const expectedConcurrencyGroup = [
  '${{ github.workflow }}-${{',
  "github.event_name == 'schedule' && 'retry-schedule' ||",
  "github.event_name == 'issue_comment' && format('retry-comment-{0}', github.event.issue.number) ||",
  "'main'",
  '}}',
].join(' ')

type RetryEvent = { readonly name: 'schedule' } | { readonly name: 'issue_comment'; readonly issueNumber: number }

const concurrencyGroupFor = (event: RetryEvent): string => {
  if (event.name === 'schedule') return `${parsed.name}-retry-schedule`
  return `${parsed.name}-retry-comment-${event.issueNumber}`
}

const cancelsRunningEvent = (running: RetryEvent, incoming: RetryEvent): boolean =>
  parsed.concurrency['cancel-in-progress'] && concurrencyGroupFor(running) === concurrencyGroupFor(incoming)

describe('Bayn build-push workflow concurrency', () => {
  test('publishes every main SHA while retaining trusted review verification', () => {
    expect(workflow).not.toContain('    paths:')
    expect(workflow).toContain('packages/scripts/src/bayn/verify-release-review.ts')
    expect(workflow.match(/--repository-root "\$\{GITHUB_WORKSPACE\}"/g)).toHaveLength(3)
  })

  test('does not let an unrelated issue comment cancel scheduled retry discovery', () => {
    expect(normalizedConcurrencyGroup).toBe(expectedConcurrencyGroup)

    const scheduledDiscovery = concurrencyGroupFor({ name: 'schedule' })
    const unrelatedCandidateComment = concurrencyGroupFor({ name: 'issue_comment', issueNumber: 13_379 })

    expect(scheduledDiscovery).toBe('bayn-build-push-retry-schedule')
    expect(unrelatedCandidateComment).toBe('bayn-build-push-retry-comment-13379')
    expect(cancelsRunningEvent({ name: 'schedule' }, { name: 'issue_comment', issueNumber: 13_379 })).toBe(false)
  })

  test('retains cancellation only for equivalent retry triggers', () => {
    expect(parsed.concurrency['cancel-in-progress']).toBe(true)

    expect(cancelsRunningEvent({ name: 'schedule' }, { name: 'schedule' })).toBe(true)
    expect(
      cancelsRunningEvent(
        { name: 'issue_comment', issueNumber: 13_404 },
        { name: 'issue_comment', issueNumber: 13_404 },
      ),
    ).toBe(true)
    expect(
      cancelsRunningEvent(
        { name: 'issue_comment', issueNumber: 13_404 },
        { name: 'issue_comment', issueNumber: 13_379 },
      ),
    ).toBe(false)
  })
})

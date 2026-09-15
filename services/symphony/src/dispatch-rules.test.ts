import { describe, expect, test } from 'bun:test'

import { evaluateDispatchIssue, shouldDispatchIssue, sortIssuesForDispatch } from './dispatch-rules'
import { makeTestConfig } from './test-fixtures'
import type { Issue, SymphonyConfig } from './types'

const baseConfig: SymphonyConfig = makeTestConfig({
  workflowPath: '/tmp/WORKFLOW.md',
  workspaceRoot: '/tmp/symphony',
  agent: {
    maxConcurrentAgents: 2,
    maxConcurrentAgentsByState: { 'in progress': 1 },
    maxRetryBackoffMs: 300_000,
    maxTurns: 20,
  },
})

const issue = (overrides: Partial<Issue>): Issue => ({
  id: overrides.id ?? '1',
  identifier: overrides.identifier ?? 'ABC-1',
  title: overrides.title ?? 'Example',
  description: overrides.description ?? null,
  priority: overrides.priority ?? 2,
  state: overrides.state ?? 'Todo',
  branchName: overrides.branchName ?? null,
  url: overrides.url ?? null,
  labels: overrides.labels ?? [],
  blockedBy: overrides.blockedBy ?? [],
  createdAt: overrides.createdAt ?? '2026-03-13T00:00:00.000Z',
  updatedAt: overrides.updatedAt ?? '2026-03-13T00:00:00.000Z',
})

describe('dispatch rules', () => {
  test('sortIssuesForDispatch sorts by priority then oldest createdAt then identifier', () => {
    const sorted = sortIssuesForDispatch([
      issue({ id: '3', identifier: 'ABC-3', priority: 3, createdAt: '2026-03-13T00:00:02.000Z' }),
      issue({ id: '2', identifier: 'ABC-2', priority: 1, createdAt: '2026-03-13T00:00:03.000Z' }),
      issue({ id: '1', identifier: 'ABC-1', priority: 1, createdAt: '2026-03-13T00:00:01.000Z' }),
    ])

    expect(sorted.map((entry) => entry.identifier)).toEqual(['ABC-1', 'ABC-2', 'ABC-3'])
  })

  test('Todo issue with non-terminal blockers is ineligible', () => {
    const decision = evaluateDispatchIssue(
      issue({
        blockedBy: [{ id: 'b1', identifier: 'ABC-0', state: 'In Progress' }],
      }),
      { config: baseConfig, runningIssues: [], claimedIssueIds: new Set() },
    )

    expect(decision).toEqual({ eligible: false, reason: 'blocked_issue' })
  })

  test('Todo issue with terminal blockers is eligible', () => {
    const eligible = shouldDispatchIssue(
      issue({
        blockedBy: [{ id: 'b1', identifier: 'ABC-0', state: 'Done' }],
      }),
      { config: baseConfig, runningIssues: [], claimedIssueIds: new Set() },
    )

    expect(eligible).toBe(true)
  })

  test('per-state concurrency caps additional in-progress work', () => {
    const decision = evaluateDispatchIssue(issue({ id: '2', identifier: 'ABC-2', state: 'In Progress' }), {
      config: baseConfig,
      runningIssues: [issue({ id: '1', identifier: 'ABC-1', state: 'In Progress' })],
      claimedIssueIds: new Set(),
    })

    expect(decision).toEqual({ eligible: false, reason: 'state_slots_exhausted' })
  })

  test('global concurrency exhaustion reports no_slots', () => {
    const decision = evaluateDispatchIssue(issue({ id: '3', identifier: 'ABC-3', state: 'Todo' }), {
      config: baseConfig,
      runningIssues: [
        issue({ id: '1', identifier: 'ABC-1', state: 'Todo' }),
        issue({ id: '2', identifier: 'ABC-2', state: 'In Progress' }),
      ],
      claimedIssueIds: new Set(),
    })

    expect(decision).toEqual({ eligible: false, reason: 'no_slots' })
  })

  test('shouldDispatchIssue stays compatible with evaluateDispatchIssue', () => {
    const context = { config: baseConfig, runningIssues: [], claimedIssueIds: new Set<string>() }
    expect(shouldDispatchIssue(issue({ id: '4', identifier: 'ABC-4', state: 'Todo' }), context)).toBe(true)
    expect(
      shouldDispatchIssue(
        issue({
          id: '5',
          identifier: 'ABC-5',
          state: 'Todo',
          blockedBy: [{ id: 'blocked', identifier: 'ABC-0', state: 'In Progress' }],
        }),
        context,
      ),
    ).toBe(false)
  })

  test('manual-only labels block dispatch', () => {
    const decision = evaluateDispatchIssue(issue({ labels: ['manual-only'] }), {
      config: baseConfig,
      runningIssues: [],
      claimedIssueIds: new Set(),
    })

    expect(decision).toEqual({ eligible: false, reason: 'manual_work_required' })
  })
})

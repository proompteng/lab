import { describe, expect, test } from 'bun:test'

import { shouldDispatchIssue, sortIssuesForDispatch } from './dispatch-rules'
import type { Issue, SymphonyConfig } from './types'

const baseConfig: SymphonyConfig = {
  workflowPath: '/tmp/WORKFLOW.md',
  tracker: {
    kind: 'linear',
    endpoint: 'https://api.linear.app/graphql',
    apiKey: 'token',
    projectSlug: 'symphony',
    activeStates: ['Todo', 'In Progress'],
    terminalStates: ['Done', 'Closed'],
  },
  pollingIntervalMs: 30_000,
  workspaceRoot: '/tmp/symphony',
  hooks: {
    afterCreate: null,
    beforeRun: null,
    afterRun: null,
    beforeRemove: null,
    timeoutMs: 60_000,
  },
  worker: {
    sshHosts: [],
    maxConcurrentAgentsPerHost: null,
  },
  agent: {
    maxConcurrentAgents: 2,
    maxConcurrentAgentsByState: { 'in progress': 1 },
    maxRetryBackoffMs: 300_000,
    maxTurns: 20,
  },
  codex: {
    command: 'codex app-server',
    approvalPolicy: 'never',
    threadSandbox: 'workspace-write',
    turnSandboxPolicy: null,
    turnTimeoutMs: 3_600_000,
    readTimeoutMs: 5_000,
    stallTimeoutMs: 300_000,
  },
  server: {
    host: '127.0.0.1',
    port: null,
  },
}

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
    const eligible = shouldDispatchIssue(
      issue({
        blockedBy: [{ id: 'b1', identifier: 'ABC-0', state: 'In Progress' }],
      }),
      { config: baseConfig, runningIssues: [], claimedIssueIds: new Set() },
    )

    expect(eligible).toBe(false)
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
    const eligible = shouldDispatchIssue(issue({ id: '2', identifier: 'ABC-2', state: 'In Progress' }), {
      config: baseConfig,
      runningIssues: [issue({ id: '1', identifier: 'ABC-1', state: 'In Progress' })],
      claimedIssueIds: new Set(),
    })

    expect(eligible).toBe(false)
  })
})

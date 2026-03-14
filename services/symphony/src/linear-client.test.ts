import { afterEach, describe, expect, test } from 'bun:test'

import { Effect, Layer, ManagedRuntime } from 'effect'
import * as Stream from 'effect/Stream'

import { createLogger } from './logger'
import { makeTrackerLayer, TrackerService } from './linear-client'
import type { SymphonyConfig } from './types'
import { WorkflowService } from './workflow'

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
    maxConcurrentAgents: 10,
    maxConcurrentAgentsByState: {},
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

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const makeRuntime = () =>
  ManagedRuntime.make(
    makeTrackerLayer(createLogger({ test: 'linear' })).pipe(
      Layer.provide(
        Layer.succeed(WorkflowService, {
          current: Effect.succeed({ definition: { config: {}, promptTemplate: '' }, config: baseConfig }),
          config: Effect.succeed(baseConfig),
          reload: Effect.succeed({ definition: { config: {}, promptTemplate: '' }, config: baseConfig }),
          changes: Stream.empty,
        }),
      ),
    ),
  )

describe('linear tracker client', () => {
  test('fetchIssuesByStates skips API calls for empty inputs', async () => {
    let called = false
    globalThis.fetch = (async () => {
      called = true
      throw new Error('should not be called')
    }) as unknown as typeof fetch

    const runtime = makeRuntime()
    try {
      const issues = await runtime.runPromise(
        Effect.gen(function* () {
          const tracker = yield* TrackerService
          return yield* tracker.fetchIssuesByStates([])
        }),
      )

      expect(issues).toEqual([])
      expect(called).toBe(false)
    } finally {
      await runtime.dispose()
    }
  })

  test('fetchCandidateIssues normalizes labels and blockers', async () => {
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = []
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const rawBody = typeof init?.body === 'string' ? init.body : '{}'
      const body = JSON.parse(rawBody) as { query: string; variables: Record<string, unknown> }
      requests.push(body)
      return new Response(
        JSON.stringify({
          data: {
            issues: {
              nodes: [
                {
                  id: 'issue-1',
                  identifier: 'ABC-123',
                  title: 'Example issue',
                  description: 'Ship Symphony',
                  priority: 1,
                  branchName: 'abc-123',
                  url: 'https://linear.app/abc/issue/ABC-123',
                  createdAt: '2026-03-13T00:00:00.000Z',
                  updatedAt: '2026-03-13T01:00:00.000Z',
                  state: { name: 'Todo' },
                  labels: { nodes: [{ name: 'Bug' }, { name: 'High' }] },
                  inverseRelations: {
                    nodes: [
                      {
                        type: 'blocks',
                        issue: {
                          id: 'issue-0',
                          identifier: 'ABC-122',
                          state: { name: 'In Progress' },
                        },
                      },
                    ],
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    const runtime = makeRuntime()
    try {
      const issues = await runtime.runPromise(
        Effect.gen(function* () {
          const tracker = yield* TrackerService
          return yield* tracker.fetchCandidateIssues
        }),
      )

      expect(requests).toHaveLength(1)
      expect(requests[0]?.query).toContain('slugId')
      expect(requests[0]?.query).not.toContain('inverseRelations(filter:')
      expect(requests[0]?.variables.projectSlug).toBe('symphony')
      expect(issues).toHaveLength(1)
      expect(issues[0]?.labels).toEqual(['bug', 'high'])
      expect(issues[0]?.blockedBy).toEqual([{ id: 'issue-0', identifier: 'ABC-122', state: 'In Progress' }])
    } finally {
      await runtime.dispose()
    }
  })
})

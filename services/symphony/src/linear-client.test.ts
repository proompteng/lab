import { afterEach, describe, expect, test } from 'bun:test'

import { Effect, Layer, ManagedRuntime } from 'effect'
import * as Stream from 'effect/Stream'

import { createLogger } from './logger'
import { makeTrackerLayer, TrackerService } from './linear-client'
import { makeTestConfig } from './test-fixtures'
import type { SymphonyConfig } from './types'
import { WorkflowService } from './workflow'

const baseConfig: SymphonyConfig = makeTestConfig()

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
      expect(requests[0]?.query).not.toContain('sourceIssue')
      expect(requests[0]?.variables.projectSlug).toBe('symphony')
      expect(issues).toHaveLength(1)
      expect(issues[0]?.labels).toEqual(['bug', 'high'])
      expect(issues[0]?.blockedBy).toEqual([{ id: 'issue-0', identifier: 'ABC-122', state: 'In Progress' }])
    } finally {
      await runtime.dispose()
    }
  })

  test('handoffIssue comments and moves the issue to the configured handoff state', async () => {
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = []
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const rawBody = typeof init?.body === 'string' ? init.body : '{}'
      const body = JSON.parse(rawBody) as { query: string; variables: Record<string, unknown> }
      requests.push(body)

      if (body.query.includes('SymphonyIssueTeamStates')) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                team: {
                  states: {
                    nodes: [
                      { id: 'state-backlog', name: 'Backlog' },
                      { id: 'state-todo', name: 'Todo' },
                    ],
                  },
                },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }

      if (body.query.includes('SymphonyCommentOnIssue')) {
        return new Response(
          JSON.stringify({
            data: {
              commentCreate: {
                success: true,
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }

      if (body.query.includes('SymphonyMoveIssueToHandoff')) {
        return new Response(
          JSON.stringify({
            data: {
              issueUpdate: {
                success: true,
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }

      throw new Error(`unexpected query: ${body.query}`)
    }) as unknown as typeof fetch

    const runtime = makeRuntime()
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const tracker = yield* TrackerService
          yield* tracker.handoffIssue(
            'issue-1',
            'Autonomous execution was skipped because a promotion PR is already open.',
            'Backlog',
          )
        }),
      )

      expect(requests).toHaveLength(3)
      expect(requests[0]?.query).toContain('SymphonyIssueTeamStates')
      expect(requests[0]?.query).toContain('$issueId: String!')
      expect(requests[0]?.variables.issueId).toBe('issue-1')
      expect(requests[1]?.query).toContain('commentCreate')
      expect(requests[1]?.query).toContain('$issueId: String!')
      expect(requests[1]?.variables.body).toContain('promotion PR is already open')
      expect(requests[2]?.query).toContain('issueUpdate')
      expect(requests[2]?.query).toContain('$issueId: String!')
      expect(requests[2]?.query).toContain('$stateId: String!')
      expect(requests[2]?.variables.stateId).toBe('state-backlog')
    } finally {
      await runtime.dispose()
    }
  })
})

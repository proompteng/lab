import { describe, expect, test } from 'bun:test'

import { Effect, Layer, ManagedRuntime } from 'effect'
import * as Stream from 'effect/Stream'

import { CodexSessionService, type CodexSessionOptions } from './codex-app-session'
import { DeliveryService, createEmptyDeliveryTransaction } from './delivery-service'
import { makeIssueRunnerLayer, IssueRunnerService } from './issue-runner'
import { createLogger } from './logger'
import { PostHogTelemetryService } from './posthog'
import { makeTestConfig } from './test-fixtures'
import type { Issue } from './types'
import { TrackerService } from './linear-client'
import { WorkflowService } from './workflow'
import { WorkspaceService } from './workspace-manager'

const issue: Issue = {
  id: 'issue-1',
  identifier: 'ABC-1',
  title: 'Test issue',
  description: null,
  priority: 1,
  state: 'Todo',
  branchName: null,
  url: null,
  labels: [],
  blockedBy: [],
  createdAt: '2026-03-16T03:00:00.000Z',
  updatedAt: '2026-03-16T03:00:00.000Z',
}

describe('issue runner runtime tools', () => {
  test('advertises github delivery actions and routes tool calls through DeliveryService', async () => {
    const config = makeTestConfig({ agent: { maxTurns: 1 } })
    const seenTools: string[][] = []
    const seenGithubCalls: Array<{ repo: string; headSha: string }> = []

    const runtime = ManagedRuntime.make(
      makeIssueRunnerLayer(createLogger({ test: 'issue-runner-tools' })).pipe(
        Layer.provide(
          Layer.succeed(WorkflowService, {
            current: Effect.succeed({
              definition: { config: {}, promptTemplate: 'Work on {{issue.identifier}}' },
              config,
            }),
            config: Effect.succeed(config),
            reload: Effect.succeed({
              definition: { config: {}, promptTemplate: 'Work on {{issue.identifier}}' },
              config,
            }),
            changes: Stream.empty,
          }),
        ),
        Layer.provide(
          Layer.succeed(TrackerService, {
            fetchCandidateIssues: Effect.succeed([]),
            fetchIssuesByStates: () => Effect.succeed([]),
            fetchIssueStatesByIds: () => Effect.succeed([issue]),
            executeLinearGraphql: () => Effect.succeed({ data: { ok: true } }),
            handoffIssue: () => Effect.void,
          }),
        ),
        Layer.provide(
          Layer.succeed(DeliveryService, {
            createPullRequest: () => Effect.die('not used'),
            getPullRequest: () => Effect.die('not used'),
            mergePullRequest: () => Effect.die('not used'),
            inspectRequiredChecks: (repo, headSha) =>
              Effect.sync(() => {
                seenGithubCalls.push({ repo, headSha })
                return {
                  state: 'success',
                  headSha,
                  requiredCount: 2,
                  passingCount: 2,
                  failingCount: 0,
                  pendingCount: 0,
                  url: 'https://github.com/proompteng/lab/pull/1/checks',
                }
              }),
            getWorkflowRun: () => Effect.die('not used'),
            refreshIssueDelivery: (record) => Effect.succeed(record.delivery ?? createEmptyDeliveryTransaction()),
          }),
        ),
        Layer.provide(
          Layer.succeed(WorkspaceService, {
            createForIssue: (identifier: string) =>
              Effect.succeed({
                path: `/tmp/${identifier}`,
                workspaceKey: identifier,
                createdNow: false,
              }),
            runBeforeRun: () => Effect.void,
            runAfterRun: () => Effect.void,
            removeWorkspace: () => Effect.void,
          }),
        ),
        Layer.provide(
          Layer.succeed(CodexSessionService, {
            createSession: (options: CodexSessionOptions) =>
              Effect.sync(() => {
                seenTools.push(options.dynamicTools.map((tool) => tool.name))
                return {
                  runTurn: () =>
                    options
                      .onToolCall('github_delivery', {
                        action: 'inspect_required_checks',
                        headSha: 'abcdef0123456789abcdef0123456789abcdef01',
                      })
                      .pipe(
                        Effect.flatMap((response) =>
                          Effect.sync(() => {
                            const firstItem = response.contentItems[0]
                            const payload = JSON.parse(
                              firstItem && 'text' in firstItem && typeof firstItem.text === 'string'
                                ? firstItem.text
                                : '{}',
                            ) as { state?: string }
                            expect(response.success).toBe(true)
                            expect(payload.state).toBe('success')
                            return {
                              status: 'completed' as const,
                              threadId: 'thread-1',
                              turnId: 'turn-1',
                            }
                          }),
                        ),
                      ),
                }
              }),
          }),
        ),
        Layer.provide(
          Layer.succeed(PostHogTelemetryService, {
            captureTrace: () => Effect.void,
            captureSpan: () => Effect.void,
            captureGeneration: () => Effect.void,
            summary: Effect.succeed({
              enabled: false,
              host: null,
              projectId: null,
              distinctId: 'symphony:test',
              lastError: null,
            }),
          }),
        ),
      ),
    )

    const previousGhToken = process.env.GH_TOKEN
    process.env.GH_TOKEN = 'test-token'

    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const runner = yield* IssueRunnerService
          const workspacePath = yield* runner.runAttempt(
            issue,
            null,
            {
              onEvent: () => Effect.void,
              onWorkspacePath: () => Effect.void,
            },
            {
              sessionId: 'session-1',
              traceId: 'trace-1',
              rootSpanId: 'root-1',
            },
          )

          expect(workspacePath).toBe('/tmp/ABC-1')
          expect(seenTools[0]).toContain('linear_graphql')
          expect(seenTools[0]).toContain('github_delivery')
          expect(seenGithubCalls).toEqual([
            {
              repo: 'proompteng/lab',
              headSha: 'abcdef0123456789abcdef0123456789abcdef01',
            },
          ])
        }),
      )
    } finally {
      if (previousGhToken === undefined) {
        delete process.env.GH_TOKEN
      } else {
        process.env.GH_TOKEN = previousGhToken
      }
      await runtime.dispose()
    }
  })
})

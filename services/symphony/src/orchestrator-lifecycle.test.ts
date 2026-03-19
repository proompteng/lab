import { describe, expect, test } from 'bun:test'

import { Effect, Layer, ManagedRuntime } from 'effect'
import * as Stream from 'effect/Stream'

import { IssueRunnerService } from './issue-runner'
import { createLogger } from './logger'
import { LeaderElectionService } from './leader-election'
import { TrackerService } from './linear-client'
import { makeOrchestratorLayer, OrchestratorService } from './orchestrator'
import { PostHogTelemetryService } from './posthog'
import { emptyPersistedSchedulerState, StateStoreService } from './state-store'
import { TargetHealthService } from './target-health'
import { makeTestConfig } from './test-fixtures'
import type { Issue, LeaderSnapshot, TargetHealthSummary } from './types'
import { WorkflowService } from './workflow'
import { WorkspaceService } from './workspace-manager'

const candidateIssue: Issue = {
  id: 'issue-1',
  identifier: 'ABC-1',
  title: 'Test candidate',
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

const leaderSnapshot: LeaderSnapshot = {
  enabled: true,
  required: true,
  isLeader: true,
  leaseName: 'symphony-leader',
  leaseNamespace: 'jangar',
  identity: 'test-leader',
  lastTransitionAt: '2026-03-16T03:00:00.000Z',
  lastAttemptAt: '2026-03-16T03:00:00.000Z',
  lastSuccessAt: '2026-03-16T03:00:00.000Z',
  lastError: null,
}

const targetHealthSummary: TargetHealthSummary = {
  checkedAt: '2026-03-16T03:00:00.000Z',
  readyForDispatch: true,
  openPromotionPr: false,
  promotionPrCount: 0,
  checks: [],
  lastError: null,
}

const posthogLayer = Layer.succeed(PostHogTelemetryService, {
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
})

describe('orchestrator lifecycle', () => {
  test('continues processing refresh work after start returns', async () => {
    const config = makeTestConfig({
      pollingIntervalMs: 60_000,
      health: { preDispatch: [], postDeploy: [] },
    })

    let fetchCandidateIssuesCalls = 0

    const runtime = ManagedRuntime.make(
      makeOrchestratorLayer(createLogger({ test: 'orchestrator-lifecycle' })).pipe(
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
            fetchCandidateIssues: Effect.sync(() => {
              fetchCandidateIssuesCalls += 1
              return [candidateIssue]
            }),
            fetchIssuesByStates: () => Effect.succeed([]),
            fetchIssueStatesByIds: () => Effect.succeed([candidateIssue]),
            executeLinearGraphql: () => Effect.succeed({}),
            handoffIssue: () => Effect.void,
          }),
        ),
        Layer.provide(
          Layer.succeed(WorkspaceService, {
            createForIssue: () => Effect.die('not used'),
            runBeforeRun: () => Effect.void,
            runAfterRun: () => Effect.void,
            removeWorkspace: () => Effect.void,
          }),
        ),
        Layer.provide(
          Layer.succeed(IssueRunnerService, {
            runAttempt: (_issue, _attempt, callbacks, _telemetryContext) =>
              callbacks.onWorkspacePath('/workspace/symphony/ABC-1').pipe(Effect.zipRight(Effect.never)),
          }),
        ),
        Layer.provide(posthogLayer),
        Layer.provide(
          Layer.succeed(LeaderElectionService, {
            start: Effect.void,
            stop: Effect.void,
            status: Effect.succeed(leaderSnapshot),
            changes: Stream.empty,
          }),
        ),
        Layer.provide(
          Layer.succeed(StateStoreService, {
            load: Effect.succeed(emptyPersistedSchedulerState()),
            save: () => Effect.void,
            stateFilePath: Effect.succeed('/tmp/symphony-state.json'),
          }),
        ),
        Layer.provide(Layer.succeed(TargetHealthService, { evaluatePreDispatch: Effect.succeed(targetHealthSummary) })),
      ),
    )

    try {
      await runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const orchestrator = yield* OrchestratorService
            yield* orchestrator.start
            yield* orchestrator.triggerRefresh
            yield* Effect.sleep(50)

            const snapshot = yield* orchestrator.getSnapshot
            expect(fetchCandidateIssuesCalls).toBeGreaterThan(0)
            expect(snapshot.counts.running).toBe(1)
            expect(snapshot.running[0]?.issueIdentifier).toBe('ABC-1')
            expect(snapshot.recentEvents.some((event) => event.event === 'worker_started')).toBe(true)

            yield* orchestrator.stop
          }),
        ),
      )
    } finally {
      await runtime.dispose()
    }
  })

  test('does not lose fast worker exits that happen during dispatch startup', async () => {
    const config = makeTestConfig({
      pollingIntervalMs: 60_000,
      health: { preDispatch: [], postDeploy: [] },
    })

    const runtime = ManagedRuntime.make(
      makeOrchestratorLayer(createLogger({ test: 'orchestrator-fast-exit' })).pipe(
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
            fetchCandidateIssues: Effect.succeed([candidateIssue]),
            fetchIssuesByStates: () => Effect.succeed([]),
            fetchIssueStatesByIds: () => Effect.succeed([candidateIssue]),
            executeLinearGraphql: () => Effect.succeed({}),
            handoffIssue: () => Effect.void,
          }),
        ),
        Layer.provide(
          Layer.succeed(WorkspaceService, {
            createForIssue: () => Effect.die('not used'),
            runBeforeRun: () => Effect.void,
            runAfterRun: () => Effect.void,
            removeWorkspace: () => Effect.void,
          }),
        ),
        Layer.provide(
          Layer.succeed(IssueRunnerService, {
            runAttempt: (_issue, _attempt, callbacks, _telemetryContext) =>
              callbacks
                .onWorkspacePath('/workspace/symphony/ABC-1')
                .pipe(Effect.zipRight(Effect.succeed('/workspace/symphony/ABC-1'))),
          }),
        ),
        Layer.provide(posthogLayer),
        Layer.provide(
          Layer.succeed(LeaderElectionService, {
            start: Effect.void,
            stop: Effect.void,
            status: Effect.succeed(leaderSnapshot),
            changes: Stream.empty,
          }),
        ),
        Layer.provide(
          Layer.succeed(StateStoreService, {
            load: Effect.succeed(emptyPersistedSchedulerState()),
            save: () => Effect.void,
            stateFilePath: Effect.succeed('/tmp/symphony-state.json'),
          }),
        ),
        Layer.provide(Layer.succeed(TargetHealthService, { evaluatePreDispatch: Effect.succeed(targetHealthSummary) })),
      ),
    )

    try {
      await runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const orchestrator = yield* OrchestratorService
            yield* orchestrator.start
            yield* orchestrator.triggerRefresh
            yield* Effect.sleep(50)

            const snapshot = yield* orchestrator.getSnapshot
            expect(snapshot.counts.running).toBe(0)
            expect(snapshot.counts.retrying).toBe(1)
            expect(snapshot.retrying[0]?.issueIdentifier).toBe('ABC-1')
            expect(snapshot.recentEvents.some((event) => event.event === 'retry_scheduled')).toBe(true)

            yield* orchestrator.stop
          }),
        ),
      )
    } finally {
      await runtime.dispose()
    }
  })

  test('releases persisted retry claims when the issue is no longer an active candidate', async () => {
    const config = makeTestConfig({
      pollingIntervalMs: 60_000,
      health: { preDispatch: [], postDeploy: [] },
    })

    const runtime = ManagedRuntime.make(
      makeOrchestratorLayer(createLogger({ test: 'orchestrator-retry-release' })).pipe(
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
            fetchIssueStatesByIds: () => Effect.succeed([]),
            executeLinearGraphql: () => Effect.succeed({}),
            handoffIssue: () => Effect.void,
          }),
        ),
        Layer.provide(
          Layer.succeed(WorkspaceService, {
            createForIssue: () => Effect.die('not used'),
            runBeforeRun: () => Effect.void,
            runAfterRun: () => Effect.void,
            removeWorkspace: () => Effect.void,
          }),
        ),
        Layer.provide(
          Layer.succeed(IssueRunnerService, {
            runAttempt: (_issue, _attempt, _callbacks, _telemetryContext) => Effect.die('not used'),
          }),
        ),
        Layer.provide(posthogLayer),
        Layer.provide(
          Layer.succeed(LeaderElectionService, {
            start: Effect.void,
            stop: Effect.void,
            status: Effect.succeed(leaderSnapshot),
            changes: Stream.empty,
          }),
        ),
        Layer.provide(
          Layer.succeed(StateStoreService, {
            load: Effect.succeed({
              ...emptyPersistedSchedulerState(),
              retrying: [
                {
                  issueId: candidateIssue.id,
                  identifier: candidateIssue.identifier,
                  attempt: 7,
                  dueAt: new Date(Date.now()).toISOString(),
                  error: 'retry poll failed',
                },
              ],
            }),
            save: () => Effect.void,
            stateFilePath: Effect.succeed('/tmp/symphony-state.json'),
          }),
        ),
        Layer.provide(Layer.succeed(TargetHealthService, { evaluatePreDispatch: Effect.succeed(targetHealthSummary) })),
      ),
    )

    try {
      await runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const orchestrator = yield* OrchestratorService
            yield* orchestrator.start
            yield* Effect.sleep(50)

            const snapshot = yield* orchestrator.getSnapshot
            expect(snapshot.counts.retrying).toBe(0)
            expect(snapshot.recentEvents.some((event) => event.event === 'claim_released')).toBe(true)

            const issue = yield* orchestrator.getIssueDetails(candidateIssue.identifier)
            expect(issue?.status).toBe('tracked')
            expect(issue?.retry).toBeNull()

            yield* orchestrator.stop
          }),
        ),
      )
    } finally {
      await runtime.dispose()
    }
  })
})

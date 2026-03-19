import { Context, Effect, Layer } from 'effect'
import * as Cause from 'effect/Cause'
import * as Duration from 'effect/Duration'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Queue from 'effect/Queue'
import * as Ref from 'effect/Ref'
import * as Schedule from 'effect/Schedule'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import * as SynchronizedRef from 'effect/SynchronizedRef'

import { validateDispatchConfigEffect } from './config'
import type { CodexEvent } from './codex-app-session'
import { evaluateDispatchIssue, sortIssuesForDispatch } from './dispatch-rules'
import { createEmptyDeliveryTransaction, DeliveryService } from './delivery-service'
import {
  OrchestratorError,
  toLogError,
  type ConfigError,
  type TrackerError,
  type WorkspaceError,
  type WorkflowError,
} from './errors'
import { IssueRunnerService, type IssueRunTelemetryContext } from './issue-runner'
import {
  finishSymphonySpan,
  recordCandidateFetch,
  recordCodexTokenUsage,
  recordIssueDispatch,
  recordIssueHandoff,
  recordPollTick,
  recordReconcileDuration,
  recordWorkerOutcome,
  startSymphonySpan,
  updateRuntimeGauges,
  withSymphonyEffectSpan,
} from './instrumentation'
import { LeaderElectionService } from './leader-election'
import { TrackerService } from './linear-client'
import { PostHogTelemetryService } from './posthog'
import { emptyPersistedSchedulerState, StateStoreService } from './state-store'
import { TargetHealthService } from './target-health'
import type {
  CapacitySnapshot,
  CodexTotals,
  InstanceSummary,
  Issue,
  IssueDetails,
  IssueRecord,
  LeaderSnapshot,
  LiveSession,
  PersistedSchedulerState,
  PolicySummary,
  RecentError,
  RecentEvent,
  ReleaseSummary,
  RunHistoryEntry,
  RuntimeSnapshot,
  SymphonyConfig,
  TargetSummary,
  TokenUsageTotals,
  WorkflowSummary,
} from './types'
import { normalizeState, readPositiveNumber } from './utils'
import { WorkflowService } from './workflow'
import { WorkspaceService } from './workspace-manager'
import type { Logger } from './logger'

type WorkerStopReason = 'running' | 'failed' | 'stalled' | 'terminal' | 'inactive' | 'leadership_lost'

type TurnTelemetryBuffer = {
  startedAt: string
  prompt: string | null
}

type RunningRuntimeEntry = {
  issue: Issue
  issueId: string
  identifier: string
  retryAttempt: number | null
  workspacePath: string
  startedAt: string
  startedAtMs: number
  session: LiveSession
  lastError: string | null
  recentEvents: RecentEvent[]
  workerFiber: Fiber.RuntimeFiber<void, never> | null
  stopReason: WorkerStopReason
  terminalCleanupRequested: boolean
  telemetry: IssueRunTelemetryContext & {
    turns: Map<string, TurnTelemetryBuffer>
  }
}

type RetryRuntimeEntry = {
  issueId: string
  identifier: string
  attempt: number
  dueAtMs: number
  error: string | null
  fiber: Fiber.RuntimeFiber<void, never> | null
}

type OrchestratorState = {
  pollIntervalMs: number
  maxConcurrentAgents: number
  running: Map<string, RunningRuntimeEntry>
  claimed: Set<string>
  retryAttempts: Map<string, RetryRuntimeEntry>
  completed: Set<string>
  codexTotals: CodexTotals
  codexRateLimits: RuntimeSnapshot['rateLimits']
  issueRecords: Map<string, IssueRecord>
  recentEvents: RecentEvent[]
  recentErrors: RecentError[]
}

type OrchestratorCommand =
  | { _tag: 'PollTick' }
  | { _tag: 'StallSweep' }
  | { _tag: 'RetryDue'; issueId: string }
  | { _tag: 'LeaderChanged'; leader: LeaderSnapshot }
  | { _tag: 'WorkspaceReady'; issueId: string; workspacePath: string }
  | { _tag: 'CodexEventReceived'; issueId: string; event: CodexEvent }
  | { _tag: 'WorkerExited'; issueId: string; exit: Exit.Exit<string, unknown> }

const MAX_GLOBAL_EVENTS = 100
const MAX_ISSUE_EVENTS = 50
const MAX_RECENT_ERRORS = 50
const MAX_RUN_HISTORY = 25
const DEFAULT_ORCHESTRATOR_COMMAND_TIMEOUT_MS = 30_000
const DEFAULT_POLL_TICK_TIMEOUT_MS = 45_000

const buildTelemetrySessionId = (projectSlug: string | null, issueId: string) =>
  `symphony:${projectSlug ?? 'unknown'}:${issueId}`

const buildTelemetryTraceId = (issueId: string, startedAtMs: number, attempt: number | null) =>
  `symphony:${issueId}:${startedAtMs}:${attempt ?? 0}`

const buildRootSpanId = (traceId: string) => `${traceId}:root`

const extractErrorDetails = (value: unknown): Record<string, unknown> => {
  if (value instanceof Error) {
    return { message: value.message, name: value.name }
  }
  if (value && typeof value === 'object') {
    return value as Record<string, unknown>
  }
  return { message: typeof value === 'string' ? value : JSON.stringify(value) }
}

const EMPTY_SESSION = (): LiveSession => ({
  sessionId: null,
  threadId: null,
  turnId: null,
  codexAppServerPid: null,
  lastCodexEvent: null,
  lastCodexTimestamp: null,
  lastCodexMessage: null,
  codexInputTokens: 0,
  codexOutputTokens: 0,
  codexTotalTokens: 0,
  lastReportedInputTokens: 0,
  lastReportedOutputTokens: 0,
  lastReportedTotalTokens: 0,
  turnCount: 0,
})

const EMPTY_TOTALS = (): CodexTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  endedRuntimeSeconds: 0,
})

const EMPTY_STATE = (): OrchestratorState => ({
  pollIntervalMs: 30_000,
  maxConcurrentAgents: 10,
  running: new Map(),
  claimed: new Set(),
  retryAttempts: new Map(),
  completed: new Set(),
  codexTotals: EMPTY_TOTALS(),
  codexRateLimits: null,
  issueRecords: new Map(),
  recentEvents: [],
  recentErrors: [],
})

const computeRetryDelayMs = (
  attempt: number,
  maxRetryBackoffMs: number,
  delayType: 'continuation' | 'failure',
): number =>
  delayType === 'continuation' ? 1_000 : Math.min(10_000 * 2 ** Math.max(0, attempt - 1), maxRetryBackoffMs)

const pushBounded = <T>(items: T[], item: T, limit: number) => {
  items.push(item)
  if (items.length > limit) {
    items.splice(0, items.length - limit)
  }
}

const ensureIssueRecord = (state: OrchestratorState, issueId: string, issueIdentifier: string): IssueRecord => {
  const existing = state.issueRecords.get(issueId)
  if (existing) return existing

  const created: IssueRecord = {
    issueIdentifier,
    issueId,
    status: 'tracked',
    workspacePath: null,
    attempts: {
      restartCount: 0,
      currentRetryAttempt: 0,
    },
    running: null,
    retry: null,
    logs: {
      codex_session_logs: [],
    },
    recentEvents: [],
    lastError: null,
    tracked: {},
    runHistory: [],
    delivery: createEmptyDeliveryTransaction(),
    updatedAt: new Date().toISOString(),
  }
  state.issueRecords.set(issueId, created)
  return created
}

const addRunHistory = (record: IssueRecord, entry: RunHistoryEntry) => {
  pushBounded(record.runHistory, entry, MAX_RUN_HISTORY)
  record.updatedAt = entry.at
}

const addRecentEvent = (state: OrchestratorState, event: RecentEvent) => {
  pushBounded(state.recentEvents, event, MAX_GLOBAL_EVENTS)
  if (event.issueId && event.issueIdentifier) {
    const record = ensureIssueRecord(state, event.issueId, event.issueIdentifier)
    pushBounded(record.recentEvents, event, MAX_ISSUE_EVENTS)
    record.updatedAt = event.at
  }
}

const addRecentError = (state: OrchestratorState, error: RecentError) => {
  pushBounded(state.recentErrors, error, MAX_RECENT_ERRORS)
  if (error.issueId && error.issueIdentifier) {
    const record = ensureIssueRecord(state, error.issueId, error.issueIdentifier)
    record.lastError = error.message
    record.updatedAt = error.at
  }
}

const syncRecordFromIssue = (record: IssueRecord, issue: Issue) => {
  record.tracked = {
    ...record.tracked,
    lastKnownState: issue.state,
    priority: issue.priority,
    branchName: issue.branchName,
    url: issue.url,
    labels: issue.labels,
    updatedAt: new Date().toISOString(),
  }
}

const syncRecordFromRunning = (record: IssueRecord, running: RunningRuntimeEntry) => {
  record.status = 'running'
  record.workspacePath = running.workspacePath || record.workspacePath
  record.attempts = {
    restartCount: Math.max(record.attempts.restartCount, running.retryAttempt ?? 0),
    currentRetryAttempt: running.retryAttempt ?? 0,
  }
  record.running = {
    sessionId: running.session.sessionId,
    turnCount: running.session.turnCount,
    state: running.issue.state,
    startedAt: running.startedAt,
    lastEvent: running.session.lastCodexEvent,
    lastMessage: running.session.lastCodexMessage,
    lastEventAt: running.session.lastCodexTimestamp,
    tokens: {
      inputTokens: running.session.codexInputTokens,
      outputTokens: running.session.codexOutputTokens,
      totalTokens: running.session.codexTotalTokens,
    },
  }
  record.retry = null
  record.lastError = running.lastError
  record.updatedAt = new Date().toISOString()
  syncRecordFromIssue(record, running.issue)
}

const toIssueDetails = (record: IssueRecord): IssueDetails => ({
  issueIdentifier: record.issueIdentifier,
  issueId: record.issueId,
  status: record.status,
  workspace: {
    path: record.workspacePath,
  },
  attempts: record.attempts,
  running: record.running,
  retry: record.retry,
  logs: record.logs,
  recentEvents: [...record.recentEvents],
  lastError: record.lastError,
  tracked: { ...record.tracked },
  runHistory: [...record.runHistory],
  delivery: record.delivery
    ? {
        ...record.delivery,
        codePr: record.delivery.codePr ? { ...record.delivery.codePr } : null,
        requiredChecks: record.delivery.requiredChecks ? { ...record.delivery.requiredChecks } : null,
        build: record.delivery.build ? { ...record.delivery.build } : null,
        releaseContract: record.delivery.releaseContract ? { ...record.delivery.releaseContract } : null,
        promotionPr: record.delivery.promotionPr ? { ...record.delivery.promotionPr } : null,
        argo: record.delivery.argo ? { ...record.delivery.argo } : null,
        postDeploy: record.delivery.postDeploy ? { ...record.delivery.postDeploy } : null,
        rollbackPr: record.delivery.rollbackPr ? { ...record.delivery.rollbackPr } : null,
      }
    : null,
})

const buildPolicySummary = (config: SymphonyConfig): PolicySummary => ({
  approvalPolicy: config.codex.approvalPolicy,
  threadSandbox: config.codex.threadSandbox,
  turnSandboxPolicy: config.codex.turnSandboxPolicy,
  allowedTools: config.tracker.kind === 'linear' && config.tracker.apiKey ? ['linear_graphql'] : [],
  workspaceRoot: config.workspaceRoot,
  pollIntervalMs: config.pollingIntervalMs,
  maxConcurrentAgents: config.agent.maxConcurrentAgents,
  activeStates: [...config.tracker.activeStates],
  terminalStates: [...config.tracker.terminalStates],
})

const buildWorkflowSummary = (
  workflowPath: string,
  issuePromptEmpty: boolean,
  config: SymphonyConfig,
): WorkflowSummary => ({
  workflowPath,
  trackerKind: config.tracker.kind,
  projectSlug: config.tracker.projectSlug,
  promptTemplateEmpty: issuePromptEmpty,
})

const buildInstanceSummary = (config: SymphonyConfig): InstanceSummary => ({
  name: config.instance.name,
  namespace: config.instance.namespace,
  argocdApplication: config.instance.argocdApplication,
})

const buildTargetSummary = (config: SymphonyConfig): TargetSummary => ({
  name: config.target.name,
  namespace: config.target.namespace,
  argocdApplication: config.target.argocdApplication,
  repo: config.target.repo,
  defaultBranch: config.target.defaultBranch,
})

const buildReleaseSummary = (config: SymphonyConfig): ReleaseSummary => ({
  mode: config.release.mode,
  requiredChecksSource: config.release.requiredChecksSource,
  promotionBranchPrefix: config.release.promotionBranchPrefix,
  blockedLabels: [...config.release.blockedLabels],
  deployables: config.release.deployables.map((deployable) => ({
    name: deployable.name,
    image: deployable.image,
    manifestPaths: [...deployable.manifestPaths],
    buildWorkflow: deployable.buildWorkflow,
    releaseWorkflow: deployable.releaseWorkflow,
    postDeployWorkflow: deployable.postDeployWorkflow,
  })),
})

const buildCapacitySnapshot = (state: OrchestratorState, config: SymphonyConfig): CapacitySnapshot => {
  const runningEntries = Array.from(state.running.values())
  const runningByState = new Map<string, number>()
  for (const entry of runningEntries) {
    const normalized = normalizeState(entry.issue.state)
    runningByState.set(normalized, (runningByState.get(normalized) ?? 0) + 1)
  }

  const states = Array.from(
    new Set([...Object.keys(config.agent.maxConcurrentAgentsByState), ...Array.from(runningByState.keys())]),
  ).sort()

  return {
    maxConcurrentAgents: config.agent.maxConcurrentAgents,
    running: runningEntries.length,
    retrying: state.retryAttempts.size,
    availableSlots: Math.max(0, config.agent.maxConcurrentAgents - runningEntries.length),
    saturated: runningEntries.length >= config.agent.maxConcurrentAgents,
    byState: states.map((stateName) => {
      const running = runningByState.get(stateName) ?? 0
      const limit = config.agent.maxConcurrentAgentsByState[stateName] ?? config.agent.maxConcurrentAgents
      return {
        state: stateName,
        running,
        limit,
        saturated: running >= limit,
      }
    }),
  }
}

const hydrateStateFromPersisted = (persisted: PersistedSchedulerState, config: SymphonyConfig): OrchestratorState => {
  const state = EMPTY_STATE()
  state.pollIntervalMs = config.pollingIntervalMs
  state.maxConcurrentAgents = config.agent.maxConcurrentAgents
  state.codexTotals = persisted.codexTotals
  state.codexRateLimits = persisted.rateLimits
  state.recentEvents = [...persisted.recentEvents]
  state.recentErrors = [...persisted.recentErrors]

  for (const record of persisted.issues) {
    state.issueRecords.set(record.issueId, {
      ...record,
      recentEvents: [...record.recentEvents],
      runHistory: [...record.runHistory],
      logs: { codex_session_logs: [...record.logs.codex_session_logs] },
      tracked: { ...record.tracked },
      delivery: record.delivery
        ? {
            ...record.delivery,
            codePr: record.delivery.codePr ? { ...record.delivery.codePr } : null,
            requiredChecks: record.delivery.requiredChecks ? { ...record.delivery.requiredChecks } : null,
            build: record.delivery.build ? { ...record.delivery.build } : null,
            releaseContract: record.delivery.releaseContract ? { ...record.delivery.releaseContract } : null,
            promotionPr: record.delivery.promotionPr ? { ...record.delivery.promotionPr } : null,
            argo: record.delivery.argo ? { ...record.delivery.argo } : null,
            postDeploy: record.delivery.postDeploy ? { ...record.delivery.postDeploy } : null,
            rollbackPr: record.delivery.rollbackPr ? { ...record.delivery.rollbackPr } : null,
          }
        : null,
    })
  }

  for (const retry of persisted.retrying) {
    const dueAtMs = Date.parse(retry.dueAt)
    state.retryAttempts.set(retry.issueId, {
      issueId: retry.issueId,
      identifier: retry.identifier,
      attempt: retry.attempt,
      dueAtMs: Number.isFinite(dueAtMs) ? dueAtMs : Date.now(),
      error: retry.error,
      fiber: null,
    })
    state.claimed.add(retry.issueId)
  }

  return state
}

const toPersistedState = (state: OrchestratorState): PersistedSchedulerState => ({
  version: 2,
  updatedAt: new Date().toISOString(),
  codexTotals: state.codexTotals,
  rateLimits: state.codexRateLimits,
  recentEvents: [...state.recentEvents],
  recentErrors: [...state.recentErrors],
  retrying: Array.from(state.retryAttempts.values())
    .map((entry) => ({
      issueId: entry.issueId,
      identifier: entry.identifier,
      attempt: entry.attempt,
      dueAt: new Date(entry.dueAtMs).toISOString(),
      error: entry.error,
    }))
    .sort((left, right) => left.identifier.localeCompare(right.identifier)),
  issues: Array.from(state.issueRecords.values()).sort((left, right) =>
    left.issueIdentifier.localeCompare(right.issueIdentifier),
  ),
})

const syncStateMetrics = (
  state: OrchestratorState,
  options: {
    targetHealthReady?: boolean
    leaderState?: boolean
    lastSuccessfulPollTimestampSeconds?: number
  } = {},
) => {
  updateRuntimeGauges({
    runningIssues: state.running.size,
    retryQueueSize: state.retryAttempts.size,
    ...options,
  })
}

const applyTokenUsage = (state: OrchestratorState, running: RunningRuntimeEntry, usage: TokenUsageTotals): void => {
  const deltaInput = Math.max(0, usage.inputTokens - running.session.lastReportedInputTokens)
  const deltaOutput = Math.max(0, usage.outputTokens - running.session.lastReportedOutputTokens)
  const deltaTotal = Math.max(0, usage.totalTokens - running.session.lastReportedTotalTokens)

  running.session.codexInputTokens = usage.inputTokens
  running.session.codexOutputTokens = usage.outputTokens
  running.session.codexTotalTokens = usage.totalTokens
  running.session.lastReportedInputTokens = usage.inputTokens
  running.session.lastReportedOutputTokens = usage.outputTokens
  running.session.lastReportedTotalTokens = usage.totalTokens

  state.codexTotals.inputTokens += deltaInput
  state.codexTotals.outputTokens += deltaOutput
  state.codexTotals.totalTokens += deltaTotal
  recordCodexTokenUsage(deltaInput, deltaOutput, deltaTotal)
}

const interruptWorkerFiber = (fiber: Fiber.RuntimeFiber<void, never> | null) =>
  fiber ? Fiber.interruptFork(fiber) : Effect.void

export interface OrchestratorServiceDefinition {
  readonly start: Effect.Effect<void, WorkflowError | ConfigError | TrackerError | WorkspaceError | OrchestratorError>
  readonly stop: Effect.Effect<void, never>
  readonly triggerRefresh: Effect.Effect<void, never>
  readonly getSnapshot: Effect.Effect<RuntimeSnapshot, never>
  readonly getIssueDetails: (issueIdentifier: string) => Effect.Effect<IssueDetails | null, never>
  readonly getCurrentConfig: Effect.Effect<SymphonyConfig, WorkflowError | ConfigError | OrchestratorError>
}

export class OrchestratorService extends Context.Tag('symphony/OrchestratorService')<
  OrchestratorService,
  OrchestratorServiceDefinition
>() {}

export const makeOrchestratorLayer = (logger: Logger) =>
  Layer.scoped(
    OrchestratorService,
    Effect.gen(function* () {
      const workflow = yield* WorkflowService
      const tracker = yield* TrackerService
      const workspace = yield* WorkspaceService
      const issueRunner = yield* IssueRunnerService
      const delivery = yield* DeliveryService
      const posthog = yield* PostHogTelemetryService
      const leaderElection = yield* LeaderElectionService
      const stateStore = yield* StateStoreService
      const targetHealth = yield* TargetHealthService
      const orchestratorLogger = logger.child({ component: 'orchestrator' })
      const serviceScope = (yield* Effect.scope) as Scope.Scope

      const stateRef = yield* SynchronizedRef.make<OrchestratorState>(EMPTY_STATE())
      const queue = yield* Queue.unbounded<OrchestratorCommand>()
      const startedRef = yield* Ref.make(false)
      const pollQueuedRef = yield* Ref.make(false)
      const stallQueuedRef = yield* Ref.make(false)
      const orchestratorCommandTimeoutMs = readPositiveNumber(
        process.env.SYMPHONY_COMMAND_TIMEOUT_MS,
        DEFAULT_ORCHESTRATOR_COMMAND_TIMEOUT_MS,
      )
      const pollTickTimeoutMs = readPositiveNumber(
        process.env.SYMPHONY_POLL_TICK_TIMEOUT_MS,
        DEFAULT_POLL_TICK_TIMEOUT_MS,
      )
      const seenLeaderStateRef = yield* Ref.make<boolean | null>(null)
      const processorFiberRef = yield* Ref.make<Fiber.RuntimeFiber<void, never> | null>(null)
      const pollFiberRef = yield* Ref.make<Fiber.RuntimeFiber<void, never> | null>(null)
      const stallFiberRef = yield* Ref.make<Fiber.RuntimeFiber<void, never> | null>(null)
      const leaderStreamFiberRef = yield* Ref.make<Fiber.RuntimeFiber<void, never> | null>(null)

      const persistStateBestEffort = SynchronizedRef.get(stateRef).pipe(
        Effect.flatMap((state) => stateStore.save(toPersistedState(state))),
        Effect.catchAll((error) =>
          Effect.sync(() => {
            orchestratorLogger.log('warn', 'durable_state_persist_failed', toLogError(error))
          }),
        ),
      )

      const enqueuePoll = Ref.getAndSet(pollQueuedRef, true).pipe(
        Effect.flatMap((alreadyQueued) => (alreadyQueued ? Effect.void : Queue.offer(queue, { _tag: 'PollTick' }))),
      )

      const enqueueStallSweep = Ref.getAndSet(stallQueuedRef, true).pipe(
        Effect.flatMap((alreadyQueued) => (alreadyQueued ? Effect.void : Queue.offer(queue, { _tag: 'StallSweep' }))),
      )

      const createRetryFiber = (issueId: string, dueAtMs: number) =>
        Effect.sleep(Duration.millis(Math.max(0, dueAtMs - Date.now()))).pipe(
          Effect.zipRight(Queue.offer(queue, { _tag: 'RetryDue', issueId })),
          Effect.asVoid,
          Effect.forkIn(serviceScope),
        )

      const rehydrateRetryTimers = Effect.gen(function* () {
        const leader = yield* leaderElection.status
        if (!leader.isLeader) return

        const missingFibers = yield* SynchronizedRef.modifyEffect(stateRef, (state) =>
          Effect.succeed([
            Array.from(state.retryAttempts.values()).filter((entry) => entry.fiber === null),
            state,
          ] as const),
        )

        for (const retry of missingFibers) {
          const fiber = yield* createRetryFiber(retry.issueId, retry.dueAtMs)
          yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
            const current = state.retryAttempts.get(retry.issueId)
            if (current) {
              current.fiber = fiber
            }
            return Effect.succeed([undefined, state] as const)
          })
        }
      })

      const startupCleanup = workflow.config.pipe(
        Effect.flatMap((config) =>
          tracker.fetchIssuesByStates(config.tracker.terminalStates).pipe(
            Effect.flatMap((issues) => Effect.forEach(issues, (issue) => workspace.removeWorkspace(issue.identifier))),
            Effect.catchAll((error) =>
              Effect.sync(() => {
                orchestratorLogger.log('warn', 'startup_terminal_cleanup_failed', toLogError(error))
              }),
            ),
          ),
        ),
      )

      const buildHandoffMessage = (issue: Issue, config: SymphonyConfig, detail: string) =>
        [
          `Symphony did not start autonomous work for ${issue.identifier}.`,
          `Reason: ${detail}`,
          `The issue was moved to ${config.tracker.handoffState} so it leaves the active automation queue.`,
          'Re-activate it only after the blocking condition has been resolved.',
        ].join('\n')

      const handoffSkippedIssue = (
        issue: Issue,
        config: SymphonyConfig,
        reason: 'manual_work_required' | 'promotion_pr_open' | 'target_not_ready',
        detail: string,
      ) =>
        Effect.gen(function* () {
          const startedAtMs = Date.now()
          const sessionId = buildTelemetrySessionId(config.tracker.projectSlug, issue.id)
          const traceId = buildTelemetryTraceId(issue.id, startedAtMs, 0)
          const rootSpanId = buildRootSpanId(traceId)
          yield* posthog.captureTrace({
            traceId,
            sessionId,
            spanName: 'symphony_issue_handoff',
            inputState: {
              issue_id: issue.id,
              issue_identifier: issue.identifier,
              title: issue.title,
              state: issue.state,
              detail,
              reason,
            },
            properties: {
              issue_id: issue.id,
              issue_identifier: issue.identifier,
            },
          })
          return yield* tracker
            .handoffIssue(issue.id, buildHandoffMessage(issue, config, detail), config.tracker.handoffState)
            .pipe(
              Effect.tap(() => Effect.sync(() => recordIssueHandoff(reason))),
              Effect.tap(() =>
                posthog.captureSpan({
                  traceId,
                  sessionId,
                  spanId: rootSpanId,
                  spanName: 'handoff',
                  latencySeconds: Math.max(0, Date.now() - startedAtMs) / 1_000,
                  outputState: {
                    handoff_state: config.tracker.handoffState,
                    detail,
                    reason,
                  },
                  properties: {
                    issue_id: issue.id,
                    issue_identifier: issue.identifier,
                  },
                }),
              ),
              Effect.tap(() =>
                SynchronizedRef.modifyEffect(stateRef, (state) => {
                  addRecentEvent(state, {
                    at: new Date().toISOString(),
                    event: 'issue_handed_off',
                    message: `issue ${issue.identifier} moved to ${config.tracker.handoffState}: ${detail}`,
                    issueId: issue.id,
                    issueIdentifier: issue.identifier,
                    level: 'warn',
                    reason,
                  })
                  const record = ensureIssueRecord(state, issue.id, issue.identifier)
                  record.delivery = {
                    ...(record.delivery ?? createEmptyDeliveryTransaction()),
                    stage: 'handoff_required',
                    updatedAt: new Date().toISOString(),
                    lastError: detail,
                  }
                  return Effect.succeed([undefined, state] as const)
                }),
              ),
              Effect.catchAll((error) =>
                posthog
                  .captureSpan({
                    traceId,
                    sessionId,
                    spanId: rootSpanId,
                    spanName: 'handoff',
                    latencySeconds: Math.max(0, Date.now() - startedAtMs) / 1_000,
                    error: extractErrorDetails(error),
                    properties: {
                      issue_id: issue.id,
                      issue_identifier: issue.identifier,
                      handoff_state: config.tracker.handoffState,
                      reason,
                    },
                  })
                  .pipe(
                    Effect.zipRight(
                      Effect.sync(() => {
                        orchestratorLogger.log('warn', 'issue_handoff_failed', {
                          issue_id: issue.id,
                          issue_identifier: issue.identifier,
                          handoff_state: config.tracker.handoffState,
                          reason,
                          ...toLogError(error),
                        })
                      }),
                    ),
                  )
                  .pipe(
                    Effect.zipRight(
                      SynchronizedRef.modifyEffect(stateRef, (state) => {
                        addRecentError(state, {
                          at: new Date().toISOString(),
                          code: error.code,
                          message: error.message,
                          issueId: issue.id,
                          issueIdentifier: issue.identifier,
                          context: 'issue_handoff',
                        })
                        return Effect.succeed([undefined, state] as const)
                      }),
                    ),
                  ),
              ),
            )
        })

      const scheduleRetry = (
        issueId: string,
        identifier: string,
        attempt: number,
        delayType: 'continuation' | 'failure',
        error: string | null,
        telemetryContext?: IssueRunTelemetryContext | null,
      ) =>
        Effect.gen(function* () {
          const config = yield* workflow.config
          const leader = yield* leaderElection.status
          const delayMs = computeRetryDelayMs(attempt, config.agent.maxRetryBackoffMs, delayType)
          const dueAtMs = Date.now() + delayMs

          const existing = yield* SynchronizedRef.modifyEffect(stateRef, (state) =>
            Effect.succeed([state.retryAttempts.get(issueId) ?? null, state] as const),
          )
          if (existing?.fiber) {
            yield* Fiber.interruptFork(existing.fiber)
          }

          const fiber = leader.isLeader ? yield* createRetryFiber(issueId, dueAtMs) : null

          yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
            state.claimed.add(issueId)
            state.retryAttempts.set(issueId, {
              issueId,
              identifier,
              attempt,
              dueAtMs,
              error,
              fiber,
            })

            const record = ensureIssueRecord(state, issueId, identifier)
            record.status = 'retrying'
            record.retry = {
              attempt,
              dueAt: new Date(dueAtMs).toISOString(),
              error,
            }
            const priorSessionId = record.running?.sessionId ?? null
            record.running = null
            record.lastError = error
            record.attempts = {
              restartCount: Math.max(record.attempts.restartCount, attempt),
              currentRetryAttempt: attempt,
            }
            addRunHistory(record, {
              at: new Date().toISOString(),
              status: 'retry_scheduled',
              attempt,
              message: error,
              workspacePath: record.workspacePath,
              sessionId: priorSessionId,
            })
            addRecentEvent(state, {
              at: new Date().toISOString(),
              event: 'retry_scheduled',
              message: error ?? `retry attempt ${attempt} scheduled`,
              issueId,
              issueIdentifier: identifier,
              level: error ? 'warn' : 'info',
              reason: delayType,
            })
            syncStateMetrics(state)
            return Effect.succeed([undefined, state] as const)
          })

          if (telemetryContext) {
            yield* posthog.captureSpan({
              traceId: telemetryContext.traceId,
              sessionId: telemetryContext.sessionId,
              spanId: `${telemetryContext.traceId}:retry:${attempt}:${Date.now()}`,
              parentId: telemetryContext.rootSpanId,
              spanName: 'retry_wait',
              outputState: {
                due_at: new Date(dueAtMs).toISOString(),
                delay_type: delayType,
                error,
              },
              latencySeconds: delayMs / 1_000,
              error,
              properties: {
                issue_id: issueId,
                issue_identifier: identifier,
                retry_attempt: attempt,
              },
            })
          }

          yield* persistStateBestEffort
        })

      const releaseClaim = (issueId: string, issueIdentifier: string, message: string) =>
        SynchronizedRef.modifyEffect(stateRef, (state) => {
          state.claimed.delete(issueId)
          state.retryAttempts.delete(issueId)
          const record = ensureIssueRecord(state, issueId, issueIdentifier)
          record.status = 'tracked'
          record.retry = null
          record.running = null
          addRecentEvent(state, {
            at: new Date().toISOString(),
            event: 'claim_released',
            message,
            issueId,
            issueIdentifier,
            level: 'info',
          })
          addRunHistory(record, {
            at: new Date().toISOString(),
            status: 'inactive',
            attempt: record.attempts.currentRetryAttempt,
            message,
            workspacePath: record.workspacePath,
            sessionId: null,
          })
          syncStateMetrics(state)
          return Effect.succeed([undefined, state] as const)
        }).pipe(Effect.zipRight(persistStateBestEffort))

      const handleCodexEvent = (issueId: string, event: CodexEvent) =>
        SynchronizedRef.modifyEffect(stateRef, (state) => {
          const running = state.running.get(issueId)
          if (!running) {
            return Effect.succeed([
              { shouldPersist: false, telemetryEffects: [] as Array<Effect.Effect<void, never>> },
              state,
            ] as const)
          }

          running.session.codexAppServerPid = event.codexAppServerPid
          running.session.sessionId = event.sessionId ?? running.session.sessionId
          running.session.threadId = event.threadId ?? running.session.threadId
          running.session.turnId = event.turnId ?? running.session.turnId
          running.session.lastCodexEvent = event.event
          running.session.lastCodexTimestamp = event.timestamp
          running.session.lastCodexMessage = event.message ?? running.session.lastCodexMessage
          if (event.event === 'turn_started') {
            running.session.turnCount += 1
          }
          if (event.rateLimits) {
            state.codexRateLimits = event.rateLimits
          }
          if (event.usage) {
            applyTokenUsage(state, running, event.usage)
          }

          const record = ensureIssueRecord(state, running.issueId, running.identifier)
          syncRecordFromRunning(record, running)

          let shouldPersist = false
          const telemetryEffects: Array<Effect.Effect<void, never>> = []
          if (event.message && event.message.trim().length > 0) {
            const recentEvent: RecentEvent = {
              at: event.timestamp,
              event: event.event,
              message: event.message,
              issueId,
              issueIdentifier: running.identifier,
              level: 'info',
            }
            pushBounded(running.recentEvents, recentEvent, MAX_ISSUE_EVENTS)
            addRecentEvent(state, recentEvent)
            shouldPersist = true
          }

          if (event.event === 'turn_started' && event.turnId) {
            running.telemetry.turns.set(event.turnId, {
              startedAt: event.timestamp,
              prompt: event.prompt ?? null,
            })
          }

          if (event.toolCall) {
            const toolSpanId = `${running.telemetry.traceId}:tool:${event.toolCall.callId ?? Date.parse(event.timestamp)}`
            telemetryEffects.push(
              posthog.captureSpan({
                traceId: running.telemetry.traceId,
                sessionId: running.telemetry.sessionId,
                spanId: toolSpanId,
                parentId: running.telemetry.rootSpanId,
                spanName: event.toolCall.name,
                inputState: { args: event.toolCall.args },
                outputState: { result: event.toolCall.result, status: event.toolCall.status },
                latencySeconds: event.toolCall.latencySeconds,
                error: event.toolCall.status === 'failed' ? extractErrorDetails(event.toolCall.result) : null,
                properties: {
                  issue_id: running.issueId,
                  issue_identifier: running.identifier,
                  call_id: event.toolCall.callId,
                  retry_attempt: running.retryAttempt ?? 0,
                  span_kind: 'linear_graphql_tool_call',
                },
              }),
            )
          }

          if (
            event.event === 'session_started' ||
            event.event === 'turn_started' ||
            event.event === 'turn_completed' ||
            event.event === 'turn_failed' ||
            event.event === 'turn_cancelled' ||
            event.event === 'turn_ended_with_error'
          ) {
            addRunHistory(record, {
              at: event.timestamp,
              status:
                event.event === 'turn_completed'
                  ? 'succeeded'
                  : event.event === 'turn_started'
                    ? 'started'
                    : event.event === 'turn_failed' || event.event === 'turn_ended_with_error'
                      ? 'failed'
                      : event.event === 'turn_cancelled'
                        ? 'inactive'
                        : 'started',
              attempt: running.retryAttempt,
              message: event.message ?? null,
              workspacePath: running.workspacePath || null,
              sessionId: running.session.sessionId,
            })
            shouldPersist = true
          }

          if (
            event.event === 'turn_completed' ||
            event.event === 'turn_failed' ||
            event.event === 'turn_cancelled' ||
            event.event === 'turn_ended_with_error'
          ) {
            const turnId = event.turnId ?? running.session.turnId ?? `${running.telemetry.traceId}:unknown-turn`
            const turnBuffer = running.telemetry.turns.get(turnId) ?? null
            if (turnBuffer) {
              running.telemetry.turns.delete(turnId)
            }
            const derivedLatencySeconds =
              event.latencySeconds ??
              (turnBuffer ? Math.max(0, Date.parse(event.timestamp) - Date.parse(turnBuffer.startedAt)) / 1_000 : null)
            const outputChoices =
              event.outputChoices && event.outputChoices.length > 0
                ? event.outputChoices
                : [
                    {
                      role: 'assistant',
                      content: event.message?.trim() || `Turn ${turnId} ended with ${event.event}`,
                    },
                  ]

            telemetryEffects.push(
              posthog.captureGeneration({
                traceId: running.telemetry.traceId,
                sessionId: running.telemetry.sessionId,
                spanId: `${running.telemetry.traceId}:generation:${turnId}`,
                spanName: 'codex_turn',
                parentId: running.telemetry.rootSpanId,
                model: event.model ?? 'unknown',
                provider: event.provider ?? 'codex',
                input: turnBuffer?.prompt ? [{ role: 'user', content: turnBuffer.prompt }] : [],
                outputChoices,
                inputTokens: event.usage?.inputTokens ?? null,
                outputTokens: event.usage?.outputTokens ?? null,
                latencySeconds: derivedLatencySeconds,
                timeToFirstTokenSeconds: event.timeToFirstTokenSeconds ?? null,
                stream: event.stream ?? null,
                error:
                  event.event === 'turn_completed'
                    ? null
                    : extractErrorDetails(event.rawParams ?? event.message ?? event.event),
                properties: {
                  issue_id: running.issueId,
                  issue_identifier: running.identifier,
                  retry_attempt: running.retryAttempt ?? 0,
                  turn_id: turnId,
                  thread_id: event.threadId ?? running.session.threadId,
                  codex_session_id: running.session.sessionId,
                  output_capture_mode:
                    event.outputChoices && event.outputChoices.length > 0 ? 'captured' : 'summary_fallback',
                  turn_status:
                    event.event === 'turn_completed'
                      ? 'completed'
                      : event.event === 'turn_cancelled'
                        ? 'cancelled'
                        : 'failed',
                },
              }),
            )
          }

          return Effect.succeed([{ shouldPersist, telemetryEffects }, state] as const)
        }).pipe(
          Effect.flatMap(({ shouldPersist, telemetryEffects }) =>
            Effect.forEach(telemetryEffects, (effect) => effect, { concurrency: 1, discard: true }).pipe(
              Effect.zipRight(shouldPersist ? persistStateBestEffort : Effect.void),
            ),
          ),
        )

      const dispatchIssue = (issue: Issue, attempt: number | null) =>
        Effect.gen(function* () {
          const startedAtMs = Date.now()
          const startedAt = new Date(startedAtMs).toISOString()
          recordIssueDispatch(normalizeState(issue.state))
          const config = yield* workflow.config
          const traceId = buildTelemetryTraceId(issue.id, startedAtMs, attempt)
          const telemetryContext: IssueRunTelemetryContext = {
            sessionId: buildTelemetrySessionId(config.tracker.projectSlug, issue.id),
            traceId,
            rootSpanId: buildRootSpanId(traceId),
          }

          const existingRetry = yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
            state.claimed.add(issue.id)
            const retry = state.retryAttempts.get(issue.id) ?? null
            if (retry) {
              state.retryAttempts.delete(issue.id)
            }

            const running: RunningRuntimeEntry = {
              issue,
              issueId: issue.id,
              identifier: issue.identifier,
              retryAttempt: attempt,
              workspacePath: '',
              startedAt,
              startedAtMs,
              session: EMPTY_SESSION(),
              lastError: null,
              recentEvents: [],
              workerFiber: null,
              stopReason: 'running',
              terminalCleanupRequested: false,
              telemetry: {
                ...telemetryContext,
                turns: new Map(),
              },
            }
            state.running.set(issue.id, running)

            const record = ensureIssueRecord(state, issue.id, issue.identifier)
            syncRecordFromIssue(record, issue)
            syncRecordFromRunning(record, running)
            addRecentEvent(state, {
              at: startedAt,
              event: 'worker_started',
              message: `attempt ${attempt ?? 0} started`,
              issueId: issue.id,
              issueIdentifier: issue.identifier,
              level: 'info',
            })
            addRunHistory(record, {
              at: startedAt,
              status: 'started',
              attempt,
              message: null,
              workspacePath: null,
              sessionId: null,
            })
            syncStateMetrics(state)
            return Effect.succeed([retry, state] as const)
          })

          if (existingRetry?.fiber) {
            yield* Fiber.interruptFork(existingRetry.fiber)
          }

          yield* posthog.captureTrace({
            traceId: telemetryContext.traceId,
            sessionId: telemetryContext.sessionId,
            spanName: 'symphony_issue_run',
            inputState: {
              issue_id: issue.id,
              issue_identifier: issue.identifier,
              title: issue.title,
              description: issue.description,
              priority: issue.priority,
              state: issue.state,
              branch_name: issue.branchName,
              labels: issue.labels,
              blocked_by: issue.blockedBy,
              attempt: attempt ?? 0,
              workflow_path: config.workflowPath,
              target_repo: config.target.repo,
              target_application: config.target.argocdApplication,
              target_namespace: config.target.namespace,
            },
            properties: {
              issue_id: issue.id,
              issue_identifier: issue.identifier,
              retry_attempt: attempt ?? 0,
              service: 'symphony',
            },
          })

          const workerEffect = issueRunner
            .runAttempt(
              issue,
              attempt,
              {
                onEvent: (event) =>
                  Queue.offer(queue, { _tag: 'CodexEventReceived', issueId: issue.id, event }).pipe(Effect.asVoid),
                onWorkspacePath: (workspacePath) =>
                  Queue.offer(queue, { _tag: 'WorkspaceReady', issueId: issue.id, workspacePath }).pipe(Effect.asVoid),
              },
              telemetryContext,
            )
            .pipe(
              Effect.exit,
              Effect.flatMap((exit) => Queue.offer(queue, { _tag: 'WorkerExited', issueId: issue.id, exit })),
              Effect.asVoid,
            )

          const workerFiber = yield* Effect.forkIn(workerEffect, serviceScope)
          yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
            const running = state.running.get(issue.id)
            if (running) {
              running.workerFiber = workerFiber
            }
            syncStateMetrics(state)
            return Effect.succeed([undefined, state] as const)
          })
          yield* persistStateBestEffort
        })

      const reconcileRunningIssues = (config: SymphonyConfig) =>
        (() => {
          const startedAtMs = Date.now()
          return withSymphonyEffectSpan(
            'symphony.reconcile',
            {},
            Effect.gen(function* () {
              const runningEntries = yield* SynchronizedRef.modifyEffect(stateRef, (state) =>
                Effect.succeed([Array.from(state.running.values()), state] as const),
              )
              if (runningEntries.length === 0) return

              const refreshed = yield* tracker.fetchIssueStatesByIds(runningEntries.map((entry) => entry.issueId)).pipe(
                Effect.catchAll((error) =>
                  Effect.sync(() => {
                    orchestratorLogger.log('warn', 'running_state_refresh_failed', toLogError(error))
                  }).pipe(Effect.zipRight(Effect.succeed<Issue[]>([]))),
                ),
              )
              if (refreshed.length === 0) return

              const refreshedById = new Map(refreshed.map((issue) => [issue.id, issue]))
              const activeStates = new Set(config.tracker.activeStates.map((state) => normalizeState(state)))
              const terminalStates = new Set(config.tracker.terminalStates.map((state) => normalizeState(state)))

              for (const running of runningEntries) {
                const latest = refreshedById.get(running.issueId)
                if (!latest) {
                  yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
                    const current = state.running.get(running.issueId)
                    if (current) {
                      current.stopReason = 'inactive'
                    }
                    return Effect.succeed([undefined, state] as const)
                  })
                  yield* interruptWorkerFiber(running.workerFiber)
                  continue
                }

                const nextState = normalizeState(latest.state)
                if (terminalStates.has(nextState)) {
                  yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
                    const current = state.running.get(running.issueId)
                    if (current) {
                      current.issue = latest
                      current.stopReason = 'terminal'
                      current.terminalCleanupRequested = true
                    }
                    return Effect.succeed([undefined, state] as const)
                  })
                  yield* interruptWorkerFiber(running.workerFiber)
                  continue
                }

                if (!activeStates.has(nextState)) {
                  yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
                    const current = state.running.get(running.issueId)
                    if (current) {
                      current.issue = latest
                      current.stopReason = 'inactive'
                    }
                    return Effect.succeed([undefined, state] as const)
                  })
                  yield* interruptWorkerFiber(running.workerFiber)
                  continue
                }

                yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
                  const current = state.running.get(running.issueId)
                  if (current) {
                    current.issue = latest
                    const record = ensureIssueRecord(state, current.issueId, current.identifier)
                    syncRecordFromRunning(record, current)
                  }
                  return Effect.succeed([undefined, state] as const)
                })
              }
            }),
          ).pipe(Effect.ensuring(Effect.sync(() => recordReconcileDuration(Date.now() - startedAtMs))))
        })()

      const reconcileDeliveryTransactions = (config: SymphonyConfig) =>
        Effect.gen(function* () {
          const records = yield* SynchronizedRef.get(stateRef).pipe(
            Effect.map((state) =>
              Array.from(state.issueRecords.values()).filter((record) => {
                const trackedState =
                  typeof record.tracked.lastKnownState === 'string' ? record.tracked.lastKnownState : null
                const activeOrHandoff =
                  trackedState !== null &&
                  (config.tracker.activeStates.includes(trackedState) || trackedState === config.tracker.handoffState)
                const deliveryStage = record.delivery?.stage ?? 'coding'
                return (
                  activeOrHandoff ||
                  !['completed', 'rolled_back', 'failed'].includes(deliveryStage) ||
                  record.status !== 'tracked'
                )
              }),
            ),
          )

          for (const record of records) {
            const refreshed = yield* delivery.refreshIssueDelivery(record, config)
            yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
              const current = state.issueRecords.get(record.issueId)
              if (current) {
                current.delivery = refreshed
                current.updatedAt = new Date().toISOString()
              }
              return Effect.succeed([undefined, state] as const)
            })
          }
        })

      const reconcileStalledRuns = (config: SymphonyConfig) =>
        config.codex.stallTimeoutMs <= 0
          ? Effect.void
          : Effect.gen(function* () {
              const nowMs = Date.now()
              const runningEntries = yield* SynchronizedRef.modifyEffect(stateRef, (state) =>
                Effect.succeed([Array.from(state.running.values()), state] as const),
              )
              for (const running of runningEntries) {
                const lastEventMs = running.session.lastCodexTimestamp
                  ? Date.parse(running.session.lastCodexTimestamp)
                  : running.startedAtMs
                if (nowMs - lastEventMs > config.codex.stallTimeoutMs) {
                  yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
                    const current = state.running.get(running.issueId)
                    if (current) {
                      current.stopReason = 'stalled'
                    }
                    return Effect.succeed([undefined, state] as const)
                  })
                  yield* interruptWorkerFiber(running.workerFiber)
                }
              }
            })

      const handleLeaderChanged = (leader: LeaderSnapshot) =>
        Effect.gen(function* () {
          yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
            addRecentEvent(state, {
              at: new Date().toISOString(),
              event: 'leader_state_changed',
              message: leader.isLeader ? 'instance became leader' : 'instance became follower',
              level: leader.isLeader ? 'info' : 'warn',
              reason: leader.isLeader ? 'leader' : 'follower',
            })
            syncStateMetrics(state, { leaderState: leader.isLeader })
            return Effect.succeed([undefined, state] as const)
          })

          if (leader.isLeader) {
            yield* startupCleanup
            yield* rehydrateRetryTimers
            yield* enqueuePoll
            yield* persistStateBestEffort
            return
          }

          const interrupted = yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
            const running = Array.from(state.running.values())
            const retries = Array.from(state.retryAttempts.values())

            for (const entry of running) {
              const record = ensureIssueRecord(state, entry.issueId, entry.identifier)
              record.status = 'tracked'
              record.running = null
              record.retry = null
              record.lastError = 'leadership lost'
              syncRecordFromIssue(record, entry.issue)
              addRunHistory(record, {
                at: new Date().toISOString(),
                status: 'leadership_lost',
                attempt: entry.retryAttempt,
                message: 'worker interrupted because leadership moved to another replica',
                workspacePath: entry.workspacePath || null,
                sessionId: entry.session.sessionId,
              })
            }

            state.running.clear()
            for (const retry of retries) {
              const current = state.retryAttempts.get(retry.issueId)
              if (current) {
                current.fiber = null
              }
            }
            state.claimed = new Set(Array.from(state.retryAttempts.keys()))
            return Effect.succeed([{ running, retries }, state] as const)
          })

          for (const running of interrupted.running) {
            yield* interruptWorkerFiber(running.workerFiber)
          }
          for (const retry of interrupted.retries) {
            if (retry.fiber) {
              yield* Fiber.interruptFork(retry.fiber)
            }
          }
          yield* persistStateBestEffort
        })

      const processPollTick = () => {
        const startedAtMs = Date.now()
        const pollSpan = startSymphonySpan('symphony.poll_tick')
        let finished = false
        let pollResult = 'success'

        const finishPoll = (error?: unknown) => {
          if (!finished) {
            finished = true
            finishSymphonySpan(pollSpan, error)
            recordPollTick(pollResult, Date.now() - startedAtMs)
          }
        }

        return Effect.gen(function* () {
          yield* Ref.set(pollQueuedRef, false)

          const leader = yield* leaderElection.status
          if (!leader.isLeader) {
            pollResult = 'follower_not_leader'
            yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
              addRecentEvent(state, {
                at: new Date().toISOString(),
                event: 'poll_skipped',
                message: 'poll skipped because this replica is not leader',
                level: 'warn',
                reason: 'follower_not_leader',
              })
              syncStateMetrics(state, { leaderState: leader.isLeader })
              return Effect.succeed([undefined, state] as const)
            })
            yield* persistStateBestEffort
            return
          }

          const loaded = yield* workflow.current
          const { config } = loaded
          yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
            state.pollIntervalMs = config.pollingIntervalMs
            state.maxConcurrentAgents = config.agent.maxConcurrentAgents
            syncStateMetrics(state, { leaderState: leader.isLeader })
            return Effect.succeed([undefined, state] as const)
          })

          yield* withSymphonyEffectSpan('symphony.poll_tick.reconcile', {}, reconcileRunningIssues(config), {
            parentSpan: pollSpan,
          })
          yield* withSymphonyEffectSpan(
            'symphony.poll_tick.delivery_reconcile',
            {},
            reconcileDeliveryTransactions(config),
            {
              parentSpan: pollSpan,
            },
          )

          const validation = yield* Effect.either(validateDispatchConfigEffect(config))
          if (validation._tag === 'Left') {
            pollResult = 'config_invalid'
            yield* Effect.sync(() => {
              orchestratorLogger.log('error', 'dispatch_validation_failed', toLogError(validation.left))
            })
            yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
              addRecentError(state, {
                at: new Date().toISOString(),
                code: validation.left.code,
                message: validation.left.message,
                issueId: null,
                issueIdentifier: null,
                context: 'dispatch_validation',
              })
              addRecentEvent(state, {
                at: new Date().toISOString(),
                event: 'dispatch_skipped',
                message: validation.left.message,
                level: 'error',
                reason: 'config_invalid',
              })
              return Effect.succeed([undefined, state] as const)
            })
            yield* persistStateBestEffort
            return
          }

          const preDispatchHealth = yield* withSymphonyEffectSpan(
            'symphony.poll_tick.target_health',
            {},
            targetHealth.evaluatePreDispatch,
            { parentSpan: pollSpan },
          )
          if (!preDispatchHealth.readyForDispatch) {
            pollResult = preDispatchHealth.openPromotionPr ? 'promotion_pr_open' : 'target_not_ready'
            const handoffReason = preDispatchHealth.openPromotionPr ? 'promotion_pr_open' : 'target_not_ready'
            const blockedMessage = preDispatchHealth.openPromotionPr
              ? 'dispatch paused because a promotion pull request is already open'
              : preDispatchHealth.lastError
                ? `dispatch paused: ${preDispatchHealth.lastError}`
                : preDispatchHealth.checks
                    .filter((check) => !check.ok)
                    .map((check) => check.message)
                    .join('; ') || 'dispatch paused because target health checks are failing'
            yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
              addRecentEvent(state, {
                at: new Date().toISOString(),
                event: 'dispatch_paused',
                message: blockedMessage,
                level: 'warn',
                reason: handoffReason,
              })
              syncStateMetrics(state, { targetHealthReady: false, leaderState: leader.isLeader })
              return Effect.succeed([undefined, state] as const)
            })
            const issuesToHandoff = yield* withSymphonyEffectSpan(
              'symphony.poll_tick.candidate_fetch_handoff',
              {},
              tracker.fetchCandidateIssues.pipe(
                Effect.tap(() => Effect.sync(() => recordCandidateFetch('success'))),
                Effect.catchAll((error) =>
                  Effect.sync(() => {
                    recordCandidateFetch('error')
                    orchestratorLogger.log('error', 'candidate_fetch_failed_for_handoff', toLogError(error))
                  }).pipe(
                    Effect.zipRight(
                      SynchronizedRef.modifyEffect(stateRef, (state) => {
                        addRecentError(state, {
                          at: new Date().toISOString(),
                          code: error.code,
                          message: error.message,
                          issueId: null,
                          issueIdentifier: null,
                          context: 'candidate_fetch_handoff',
                        })
                        return Effect.succeed([undefined, state] as const)
                      }),
                    ),
                    Effect.zipRight(Effect.succeed<Issue[]>([])),
                  ),
                ),
              ),
              { parentSpan: pollSpan },
            )
            yield* Effect.forEach(
              issuesToHandoff,
              (issue) => handoffSkippedIssue(issue, config, handoffReason, blockedMessage),
              { concurrency: 1, discard: true },
            )
            yield* persistStateBestEffort
            return
          }

          yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
            syncStateMetrics(state, { targetHealthReady: true, leaderState: leader.isLeader })
            return Effect.succeed([undefined, state] as const)
          })

          const issues = yield* withSymphonyEffectSpan(
            'symphony.poll_tick.candidate_fetch',
            {},
            tracker.fetchCandidateIssues.pipe(
              Effect.tap(() => Effect.sync(() => recordCandidateFetch('success'))),
              Effect.catchAll((error) =>
                Effect.sync(() => {
                  recordCandidateFetch('error')
                  orchestratorLogger.log('error', 'candidate_fetch_failed', toLogError(error))
                }).pipe(
                  Effect.zipRight(
                    SynchronizedRef.modifyEffect(stateRef, (state) => {
                      addRecentError(state, {
                        at: new Date().toISOString(),
                        code: error.code,
                        message: error.message,
                        issueId: null,
                        issueIdentifier: null,
                        context: 'candidate_fetch',
                      })
                      return Effect.succeed([undefined, state] as const)
                    }),
                  ),
                  Effect.zipRight(Effect.succeed<Issue[]>([])),
                ),
              ),
            ),
            { parentSpan: pollSpan },
          )

          if (issues.length === 0) {
            yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
              syncStateMetrics(state, {
                targetHealthReady: true,
                leaderState: leader.isLeader,
                lastSuccessfulPollTimestampSeconds: Math.floor(Date.now() / 1000),
              })
              return Effect.succeed([undefined, state] as const)
            })
            yield* persistStateBestEffort
            return
          }

          for (const issue of sortIssuesForDispatch(issues)) {
            const currentState = yield* SynchronizedRef.get(stateRef)
            const decision = evaluateDispatchIssue(issue, {
              config,
              runningIssues: Array.from(currentState.running.values()).map((entry) => entry.issue),
              claimedIssueIds: currentState.claimed,
            })

            if (decision.eligible) {
              yield* withSymphonyEffectSpan(
                'symphony.poll_tick.dispatch',
                { 'issue.identifier': issue.identifier, 'issue.id': issue.id, 'issue.state': issue.state },
                dispatchIssue(issue, null),
                { parentSpan: pollSpan },
              )
              continue
            }

            if (
              decision.reason === 'no_slots' ||
              decision.reason === 'manual_work_required' ||
              decision.reason === 'blocked_issue' ||
              decision.reason === 'non_active_state'
            ) {
              yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
                addRecentEvent(state, {
                  at: new Date().toISOString(),
                  event: 'dispatch_skipped',
                  message: `issue ${issue.identifier} not dispatched: ${decision.reason}`,
                  issueId: issue.id,
                  issueIdentifier: issue.identifier,
                  level: 'warn',
                  reason: decision.reason,
                })
                return Effect.succeed([undefined, state] as const)
              })
              if (decision.reason === 'manual_work_required') {
                yield* handoffSkippedIssue(
                  issue,
                  config,
                  'manual_work_required',
                  'the issue requires manual work outside the first-wave autonomous scope',
                )
              }
              if (decision.reason === 'no_slots') {
                pollResult = 'no_slots'
                break
              }
            }
          }

          yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
            syncStateMetrics(state, {
              targetHealthReady: true,
              leaderState: leader.isLeader,
              lastSuccessfulPollTimestampSeconds: Math.floor(Date.now() / 1000),
            })
            return Effect.succeed([undefined, state] as const)
          })
          yield* persistStateBestEffort
        }).pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              pollResult = 'failed'
              finishPoll(error)
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              finishPoll()
            }),
          ),
        )
      }

      const processRetryDue = (issueId: string) =>
        withSymphonyEffectSpan(
          'symphony.retry_due',
          { 'issue.id': issueId },
          Effect.gen(function* () {
            const leader = yield* leaderElection.status
            if (!leader.isLeader) {
              yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
                const current = state.retryAttempts.get(issueId)
                if (current) {
                  current.fiber = null
                }
                syncStateMetrics(state, { leaderState: leader.isLeader })
                return Effect.succeed([undefined, state] as const)
              })
              return
            }

            const retryEntry = yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
              const current = state.retryAttempts.get(issueId) ?? null
              if (current) {
                state.retryAttempts.delete(issueId)
              }
              syncStateMetrics(state, { leaderState: leader.isLeader })
              return Effect.succeed([current, state] as const)
            })
            if (!retryEntry) return

            const candidatesResult = yield* tracker.fetchCandidateIssues.pipe(
              Effect.tap(() => Effect.sync(() => recordCandidateFetch('success'))),
              Effect.either,
            )

            if (candidatesResult._tag === 'Left') {
              const error = candidatesResult.left
              recordCandidateFetch('error')
              yield* Effect.sync(() => {
                orchestratorLogger.log('warn', 'retry_poll_failed', {
                  issue_id: issueId,
                  issue_identifier: retryEntry.identifier,
                  ...toLogError(error),
                })
              })
              yield* scheduleRetry(
                issueId,
                retryEntry.identifier,
                retryEntry.attempt + 1,
                'failure',
                'retry poll failed',
              )
              return
            }

            const candidates = candidatesResult.right

            const preDispatchHealth = yield* withSymphonyEffectSpan(
              'symphony.retry_due.target_health',
              { 'issue.id': issueId },
              targetHealth.evaluatePreDispatch,
            )
            if (!preDispatchHealth.readyForDispatch) {
              const reason = preDispatchHealth.openPromotionPr
                ? 'promotion pull request already open'
                : preDispatchHealth.lastError || 'target health checks are failing'
              yield* scheduleRetry(issueId, retryEntry.identifier, retryEntry.attempt + 1, 'failure', reason)
              return
            }

            const issue = candidates.find((candidate) => candidate.id === issueId)
            if (!issue) {
              yield* releaseClaim(issueId, retryEntry.identifier, 'issue no longer active during retry dispatch')
              return
            }

            const config = yield* workflow.config
            const runtimeState = yield* SynchronizedRef.get(stateRef)
            const claimedIssueIds = new Set(runtimeState.claimed)
            claimedIssueIds.delete(issueId)
            const decision = evaluateDispatchIssue(issue, {
              config,
              runningIssues: Array.from(runtimeState.running.values()).map((entry) => entry.issue),
              claimedIssueIds,
            })

            if (!decision.eligible) {
              const reason =
                decision.reason === 'no_slots'
                  ? 'no available orchestrator slots'
                  : decision.reason === 'blocked_issue'
                    ? 'issue blocked by active dependency'
                    : `issue not dispatchable: ${decision.reason}`
              yield* scheduleRetry(issueId, issue.identifier, retryEntry.attempt + 1, 'failure', reason)
              return
            }

            yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
              state.claimed.delete(issueId)
              syncStateMetrics(state)
              return Effect.succeed([undefined, state] as const)
            })
            yield* dispatchIssue(issue, retryEntry.attempt)
          }),
        )

      const processWorkerExit = (issueId: string, exit: Exit.Exit<string, unknown>) =>
        Effect.gen(function* () {
          const completedAtMs = Date.now()
          const running = yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
            const current = state.running.get(issueId) ?? null
            if (current) {
              state.running.delete(issueId)
              const runtimeSeconds = Math.max(0, completedAtMs - current.startedAtMs) / 1_000
              state.codexTotals.endedRuntimeSeconds += runtimeSeconds
              syncStateMetrics(state)
            }
            return Effect.succeed([current, state] as const)
          })
          if (!running) return

          const errorMessage = Exit.isFailure(exit) ? toUnknownMessage(exit.cause) : null
          const reason = Exit.isSuccess(exit)
            ? 'normal'
            : running.stopReason !== 'running'
              ? running.stopReason
              : 'failed'
          const durationMs = Math.max(0, completedAtMs - running.startedAtMs)
          recordWorkerOutcome(reason, durationMs)
          const runtimeSeconds = durationMs / 1_000

          const record = yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
            const existing = ensureIssueRecord(state, running.issueId, running.identifier)
            existing.running = null
            existing.retry = null
            existing.lastError = errorMessage
            syncRecordFromIssue(existing, running.issue)
            return Effect.succeed([existing, state] as const)
          })

          yield* posthog.captureSpan({
            traceId: running.telemetry.traceId,
            sessionId: running.telemetry.sessionId,
            spanId: running.telemetry.rootSpanId,
            spanName: 'symphony_issue_run',
            latencySeconds: runtimeSeconds,
            outputState: {
              reason,
              issue_state: running.issue.state,
              workspace_path: running.workspacePath || null,
              turn_count: running.session.turnCount,
              last_event: running.session.lastCodexEvent,
              total_tokens: running.session.codexTotalTokens,
            },
            error: reason === 'normal' || reason === 'terminal' ? null : { message: errorMessage, reason },
            properties: {
              issue_id: running.issueId,
              issue_identifier: running.identifier,
              retry_attempt: running.retryAttempt ?? 0,
            },
          })

          if (reason === 'terminal') {
            yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
              state.claimed.delete(issueId)
              const current = ensureIssueRecord(state, running.issueId, running.identifier)
              current.status = 'tracked'
              addRunHistory(current, {
                at: new Date().toISOString(),
                status: 'terminal',
                attempt: running.retryAttempt,
                message: 'issue reached terminal state',
                workspacePath: running.workspacePath || null,
                sessionId: running.session.sessionId,
              })
              addRecentEvent(state, {
                at: new Date().toISOString(),
                event: 'worker_stopped',
                message: 'worker stopped because issue became terminal',
                issueId,
                issueIdentifier: running.identifier,
                level: 'info',
                reason: 'terminal',
              })
              syncStateMetrics(state)
              return Effect.succeed([undefined, state] as const)
            })
            if (running.terminalCleanupRequested) {
              const cleanupStartedAtMs = Date.now()
              yield* workspace.removeWorkspace(running.identifier).pipe(
                Effect.tap(() =>
                  posthog.captureSpan({
                    traceId: running.telemetry.traceId,
                    sessionId: running.telemetry.sessionId,
                    spanId: `${running.telemetry.traceId}:terminal-cleanup:${cleanupStartedAtMs}`,
                    parentId: running.telemetry.rootSpanId,
                    spanName: 'terminal_cleanup',
                    latencySeconds: Math.max(0, Date.now() - cleanupStartedAtMs) / 1_000,
                    outputState: {
                      workspace_identifier: running.identifier,
                    },
                    properties: {
                      issue_id: running.issueId,
                      issue_identifier: running.identifier,
                    },
                  }),
                ),
                Effect.catchAll((error) =>
                  posthog
                    .captureSpan({
                      traceId: running.telemetry.traceId,
                      sessionId: running.telemetry.sessionId,
                      spanId: `${running.telemetry.traceId}:terminal-cleanup:${cleanupStartedAtMs}`,
                      parentId: running.telemetry.rootSpanId,
                      spanName: 'terminal_cleanup',
                      latencySeconds: Math.max(0, Date.now() - cleanupStartedAtMs) / 1_000,
                      error: extractErrorDetails(error),
                      properties: {
                        issue_id: running.issueId,
                        issue_identifier: running.identifier,
                      },
                    })
                    .pipe(
                      Effect.zipRight(
                        Effect.sync(() => {
                          orchestratorLogger.log('warn', 'terminal_workspace_cleanup_failed', {
                            issue_id: issueId,
                            issue_identifier: running.identifier,
                            ...toLogError(error),
                          })
                        }),
                      ),
                    ),
                ),
              )
            }
            yield* persistStateBestEffort
            return
          }

          if (reason === 'inactive' || reason === 'leadership_lost') {
            yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
              state.claimed.delete(issueId)
              const current = ensureIssueRecord(state, running.issueId, running.identifier)
              current.status = 'tracked'
              addRunHistory(current, {
                at: new Date().toISOString(),
                status: reason === 'inactive' ? 'inactive' : 'leadership_lost',
                attempt: running.retryAttempt,
                message:
                  reason === 'inactive'
                    ? 'issue left the configured active states'
                    : 'worker interrupted because leadership moved',
                workspacePath: running.workspacePath || null,
                sessionId: running.session.sessionId,
              })
              syncStateMetrics(state)
              return Effect.succeed([undefined, state] as const)
            })
            yield* persistStateBestEffort
            return
          }

          if (reason === 'normal') {
            yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
              state.completed.add(issueId)
              addRunHistory(record, {
                at: new Date().toISOString(),
                status: 'succeeded',
                attempt: running.retryAttempt,
                message: null,
                workspacePath: running.workspacePath || null,
                sessionId: running.session.sessionId,
              })
              return Effect.succeed([undefined, state] as const)
            })
            yield* scheduleRetry(issueId, running.identifier, 1, 'continuation', null, running.telemetry)
            return
          }

          yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
            addRecentError(state, {
              at: new Date().toISOString(),
              code: reason === 'stalled' ? 'turn_timeout' : 'worker_aborted',
              message: errorMessage ?? 'worker exited unexpectedly',
              issueId,
              issueIdentifier: running.identifier,
              context: 'worker_exit',
            })
            addRunHistory(record, {
              at: new Date().toISOString(),
              status: reason === 'stalled' ? 'stalled' : 'failed',
              attempt: running.retryAttempt,
              message: errorMessage,
              workspacePath: running.workspacePath || null,
              sessionId: running.session.sessionId,
            })
            return Effect.succeed([undefined, state] as const)
          })
          yield* scheduleRetry(
            issueId,
            running.identifier,
            (running.retryAttempt ?? 0) + 1,
            'failure',
            errorMessage,
            running.telemetry,
          )
        })

      const getCommandTimeoutMs = (command: OrchestratorCommand): number =>
        command._tag === 'PollTick' ? pollTickTimeoutMs : orchestratorCommandTimeoutMs

      const buildCommandEffect = (command: OrchestratorCommand) => {
        switch (command._tag) {
          case 'PollTick':
            return processPollTick()
          case 'StallSweep':
            return Ref.set(stallQueuedRef, false).pipe(
              Effect.zipRight(
                leaderElection.status.pipe(
                  Effect.flatMap((leader) =>
                    leader.isLeader
                      ? workflow.config.pipe(Effect.flatMap((config) => reconcileStalledRuns(config)))
                      : Effect.void,
                  ),
                ),
              ),
            )
          case 'RetryDue':
            return processRetryDue(command.issueId)
          case 'LeaderChanged':
            return handleLeaderChanged(command.leader)
          case 'WorkspaceReady':
            return SynchronizedRef.modifyEffect(stateRef, (state) => {
              const running = state.running.get(command.issueId)
              let telemetryEffect: Effect.Effect<void, never> = Effect.void
              if (running) {
                running.workspacePath = command.workspacePath
                const record = ensureIssueRecord(state, running.issueId, running.identifier)
                record.workspacePath = command.workspacePath
                syncRecordFromRunning(record, running)
                addRunHistory(record, {
                  at: new Date().toISOString(),
                  status: 'workspace_ready',
                  attempt: running.retryAttempt,
                  message: null,
                  workspacePath: command.workspacePath,
                  sessionId: running.session.sessionId,
                })
                addRecentEvent(state, {
                  at: new Date().toISOString(),
                  event: 'workspace_ready',
                  message: command.workspacePath,
                  issueId: running.issueId,
                  issueIdentifier: running.identifier,
                  level: 'info',
                })
                telemetryEffect = posthog.captureSpan({
                  traceId: running.telemetry.traceId,
                  sessionId: running.telemetry.sessionId,
                  spanId: `${running.telemetry.traceId}:workspace-ready:${Date.now()}`,
                  parentId: running.telemetry.rootSpanId,
                  spanName: 'workspace_ready',
                  outputState: {
                    workspace_path: command.workspacePath,
                  },
                  properties: {
                    issue_id: running.issueId,
                    issue_identifier: running.identifier,
                  },
                })
              }
              return Effect.succeed([telemetryEffect, state] as const)
            }).pipe(
              Effect.flatMap((telemetryEffect) => telemetryEffect),
              Effect.zipRight(persistStateBestEffort),
            )
          case 'CodexEventReceived':
            return handleCodexEvent(command.issueId, command.event)
          case 'WorkerExited':
            return processWorkerExit(command.issueId, command.exit)
        }
      }

      const handleCommand = (command: OrchestratorCommand) =>
        buildCommandEffect(command).pipe(
          Effect.timeoutFail({
            duration: Duration.millis(getCommandTimeoutMs(command)),
            onTimeout: () =>
              new OrchestratorError(
                'runtime_unavailable',
                `orchestrator command ${command._tag} timed out after ${getCommandTimeoutMs(command)}ms`,
              ),
          }),
          Effect.catchAllCause((cause) => {
            if (Cause.isInterruptedOnly(cause)) {
              return Effect.void
            }
            return Effect.sync(() => {
              orchestratorLogger.log('warn', 'orchestrator_command_failed', {
                command: command._tag,
                ...toLogError(Cause.squash(cause)),
              })
            })
          }),
        )

      const startProcessor = Effect.forever(Queue.take(queue).pipe(Effect.flatMap(handleCommand))).pipe(
        Effect.forkIn(serviceScope),
      )

      const startSchedulers = Effect.gen(function* () {
        const pollSchedule = Schedule.addDelayEffect(Schedule.forever, () =>
          workflow.config.pipe(
            Effect.map((config) => Duration.millis(config.pollingIntervalMs)),
            Effect.catchAll(() => Effect.succeed(Duration.millis(30_000))),
          ),
        )
        const stallSchedule = Schedule.addDelayEffect(Schedule.forever, () =>
          workflow.config.pipe(
            Effect.map((config) =>
              Duration.millis(
                config.codex.stallTimeoutMs > 0
                  ? Math.max(1_000, Math.min(config.pollingIntervalMs, Math.floor(config.codex.stallTimeoutMs / 2)))
                  : Math.max(5_000, config.pollingIntervalMs),
              ),
            ),
            Effect.catchAll(() => Effect.succeed(Duration.millis(30_000))),
          ),
        )

        const pollFiber = yield* Effect.repeat(enqueuePoll, pollSchedule).pipe(
          Effect.asVoid,
          Effect.forkIn(serviceScope),
        )
        const stallFiber = yield* Effect.repeat(enqueueStallSweep, stallSchedule).pipe(
          Effect.asVoid,
          Effect.forkIn(serviceScope),
        )
        yield* Ref.set(pollFiberRef, pollFiber)
        yield* Ref.set(stallFiberRef, stallFiber)
      })

      const service: OrchestratorServiceDefinition = {
        start: Ref.get(startedRef).pipe(
          Effect.flatMap((started) =>
            started
              ? Effect.void
              : Effect.gen(function* () {
                  const loaded = yield* workflow.current
                  yield* validateDispatchConfigEffect(loaded.config)

                  const persisted = yield* stateStore.load.pipe(
                    Effect.catchAll((error) =>
                      Effect.sync(() => {
                        orchestratorLogger.log('warn', 'durable_state_restore_failed', toLogError(error))
                      }).pipe(Effect.zipRight(Effect.succeed(emptyPersistedSchedulerState()))),
                    ),
                  )
                  const restoredState = hydrateStateFromPersisted(persisted, loaded.config)
                  syncStateMetrics(restoredState, { leaderState: false })
                  yield* SynchronizedRef.set(stateRef, restoredState)

                  yield* leaderElection.start

                  const processorFiber = yield* startProcessor
                  yield* Ref.set(processorFiberRef, processorFiber)

                  const leaderFiber = yield* Stream.runForEach(leaderElection.changes, (leader) =>
                    Ref.getAndSet(seenLeaderStateRef, leader.isLeader).pipe(
                      Effect.flatMap((previous) =>
                        previous === leader.isLeader
                          ? Effect.void
                          : Queue.offer(queue, { _tag: 'LeaderChanged', leader }),
                      ),
                    ),
                  ).pipe(Effect.forkIn(serviceScope))
                  yield* Ref.set(leaderStreamFiberRef, leaderFiber)

                  const currentLeader = yield* leaderElection.status
                  yield* Ref.set(seenLeaderStateRef, currentLeader.isLeader)
                  yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
                    syncStateMetrics(state, { leaderState: currentLeader.isLeader })
                    return Effect.succeed([undefined, state] as const)
                  })
                  yield* Queue.offer(queue, { _tag: 'LeaderChanged', leader: currentLeader })

                  yield* startSchedulers
                  yield* Ref.set(startedRef, true)
                }),
          ),
        ),
        stop: Effect.gen(function* () {
          yield* Ref.set(startedRef, false)

          const processorFiber = yield* Ref.get(processorFiberRef)
          if (processorFiber) {
            yield* Fiber.interruptFork(processorFiber)
          }

          const pollFiber = yield* Ref.get(pollFiberRef)
          if (pollFiber) {
            yield* Fiber.interruptFork(pollFiber)
          }

          const stallFiber = yield* Ref.get(stallFiberRef)
          if (stallFiber) {
            yield* Fiber.interruptFork(stallFiber)
          }

          const leaderFiber = yield* Ref.get(leaderStreamFiberRef)
          if (leaderFiber) {
            yield* Fiber.interruptFork(leaderFiber)
          }

          const state = yield* SynchronizedRef.get(stateRef)
          for (const retry of state.retryAttempts.values()) {
            if (retry.fiber) {
              yield* Fiber.interruptFork(retry.fiber)
            }
          }
          for (const running of state.running.values()) {
            yield* interruptWorkerFiber(running.workerFiber)
          }

          yield* leaderElection.stop
        }),
        triggerRefresh: enqueuePoll,
        getSnapshot: Effect.gen(function* () {
          const state = yield* SynchronizedRef.get(stateRef)
          const leader = yield* leaderElection.status
          const workflowResult = yield* Effect.either(workflow.current)
          const telemetrySummary = yield* posthog.summary
          const generatedAt = new Date().toISOString()
          const nowMs = Date.now()
          const running = Array.from(state.running.values())
          const retrying = Array.from(state.retryAttempts.values())
          const activeRuntimeSeconds = running.reduce(
            (total, entry) => total + Math.max(0, nowMs - entry.startedAtMs) / 1_000,
            0,
          )

          const config =
            workflowResult._tag === 'Right'
              ? workflowResult.right.config
              : ({
                  workflowPath: '',
                  tracker: {
                    kind: null,
                    endpoint: '',
                    apiKey: null,
                    projectSlug: null,
                    activeStates: [],
                    terminalStates: [],
                    handoffState: 'Backlog',
                  },
                  pollingIntervalMs: state.pollIntervalMs,
                  workspaceRoot: '',
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
                    maxConcurrentAgents: state.maxConcurrentAgents,
                    maxConcurrentAgentsByState: {},
                    maxRetryBackoffMs: 300_000,
                    maxTurns: 20,
                  },
                  codex: {
                    command: '',
                    approvalPolicy: null,
                    threadSandbox: null,
                    turnSandboxPolicy: null,
                    turnTimeoutMs: 3_600_000,
                    readTimeoutMs: 5_000,
                    stallTimeoutMs: 300_000,
                  },
                  server: {
                    host: '127.0.0.1',
                    port: null,
                  },
                  posthog: {
                    enabled: false,
                    host: 'http://posthog-capture.posthog.svc.cluster.local:3000',
                    apiKey: null,
                    projectId: null,
                    distinctId: 'symphony:symphony',
                    requestTimeoutMs: 1_000,
                    flushAt: 1,
                    flushIntervalMs: 1_000,
                  },
                  instance: {
                    name: 'symphony',
                    namespace: 'jangar',
                    argocdApplication: 'symphony',
                  },
                  target: {
                    name: 'symphony',
                    namespace: 'jangar',
                    argocdApplication: 'symphony',
                    repo: 'proompteng/lab',
                    defaultBranch: 'main',
                  },
                  release: {
                    mode: 'gitops_pr_on_main',
                    requiredChecksSource: 'branch_protection',
                    promotionBranchPrefix: 'codex/symphony-release-',
                    blockedLabels: [],
                    deployables: [],
                  },
                  health: {
                    preDispatch: [],
                    postDeploy: [],
                  },
                } satisfies SymphonyConfig)

          const preDispatchHealth = yield* targetHealth.evaluatePreDispatch

          return {
            generatedAt,
            counts: {
              running: running.length,
              retrying: retrying.length,
            },
            running: running.map((entry) => ({
              issueId: entry.issueId,
              issueIdentifier: entry.identifier,
              state: entry.issue.state,
              sessionId: entry.session.sessionId,
              turnCount: entry.session.turnCount,
              lastEvent: entry.session.lastCodexEvent,
              lastMessage: entry.session.lastCodexMessage,
              startedAt: entry.startedAt,
              lastEventAt: entry.session.lastCodexTimestamp,
              tokens: {
                inputTokens: entry.session.codexInputTokens,
                outputTokens: entry.session.codexOutputTokens,
                totalTokens: entry.session.codexTotalTokens,
              },
            })),
            retrying: retrying.map((entry) => ({
              issueId: entry.issueId,
              issueIdentifier: entry.identifier,
              attempt: entry.attempt,
              dueAt: new Date(entry.dueAtMs).toISOString(),
              error: entry.error,
            })),
            codexTotals: {
              inputTokens: state.codexTotals.inputTokens,
              outputTokens: state.codexTotals.outputTokens,
              totalTokens: state.codexTotals.totalTokens,
              secondsRunning: state.codexTotals.endedRuntimeSeconds + activeRuntimeSeconds,
            },
            rateLimits: state.codexRateLimits,
            instance: buildInstanceSummary(config),
            target: buildTargetSummary(config),
            release: buildReleaseSummary(config),
            policy: buildPolicySummary(config),
            workflow: buildWorkflowSummary(
              config.workflowPath,
              workflowResult._tag === 'Right'
                ? workflowResult.right.definition.promptTemplate.trim().length === 0
                : true,
              config,
            ),
            targetHealth: preDispatchHealth,
            leader,
            telemetry: telemetrySummary,
            recentEvents: [...state.recentEvents],
            recentErrors: [...state.recentErrors],
            capacity: buildCapacitySnapshot(state, config),
            issues: Array.from(state.issueRecords.values())
              .sort((left, right) => left.issueIdentifier.localeCompare(right.issueIdentifier))
              .map((record) => ({
                issueId: record.issueId,
                issueIdentifier: record.issueIdentifier,
                status: record.status,
                trackedState: typeof record.tracked.lastKnownState === 'string' ? record.tracked.lastKnownState : null,
                updatedAt: record.updatedAt,
                lastError: record.lastError,
                delivery: record.delivery
                  ? {
                      ...record.delivery,
                      codePr: record.delivery.codePr ? { ...record.delivery.codePr } : null,
                      requiredChecks: record.delivery.requiredChecks ? { ...record.delivery.requiredChecks } : null,
                      build: record.delivery.build ? { ...record.delivery.build } : null,
                      releaseContract: record.delivery.releaseContract ? { ...record.delivery.releaseContract } : null,
                      promotionPr: record.delivery.promotionPr ? { ...record.delivery.promotionPr } : null,
                      argo: record.delivery.argo ? { ...record.delivery.argo } : null,
                      postDeploy: record.delivery.postDeploy ? { ...record.delivery.postDeploy } : null,
                      rollbackPr: record.delivery.rollbackPr ? { ...record.delivery.rollbackPr } : null,
                    }
                  : null,
              })),
          } satisfies RuntimeSnapshot
        }),
        getIssueDetails: (issueIdentifier) =>
          SynchronizedRef.get(stateRef).pipe(
            Effect.map((state) => {
              const record = Array.from(state.issueRecords.values()).find(
                (entry) => entry.issueIdentifier === issueIdentifier,
              )
              return record ? toIssueDetails(record) : null
            }),
          ),
        getCurrentConfig: workflow.config.pipe(
          Effect.mapError((error) => new OrchestratorError('runtime_unavailable', error.message, error)),
        ),
      }

      return service
    }),
  )

const toUnknownMessage = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message
  if (cause && typeof cause === 'object' && 'failure' in cause) {
    const failure = (cause as { failure?: unknown }).failure
    if (failure instanceof Error) return failure.message
    if (typeof failure === 'string') return failure
  }
  return typeof cause === 'string' ? cause : JSON.stringify(cause)
}

import { Context, Effect, Layer } from 'effect'
import * as Duration from 'effect/Duration'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Queue from 'effect/Queue'
import * as Ref from 'effect/Ref'
import * as Schedule from 'effect/Schedule'
import * as SynchronizedRef from 'effect/SynchronizedRef'

import { validateDispatchConfigEffect } from './config'
import type { CodexEvent } from './codex-app-session'
import { shouldDispatchIssue, sortIssuesForDispatch } from './dispatch-rules'
import {
  OrchestratorError,
  toLogError,
  type ConfigError,
  type TrackerError,
  type WorkspaceError,
  type WorkflowError,
} from './errors'
import { IssueRunnerService } from './issue-runner'
import { TrackerService } from './linear-client'
import type {
  CodexTotals,
  Issue,
  IssueDetails,
  LiveSession,
  RecentEvent,
  RuntimeSnapshot,
  SymphonyConfig,
  TokenUsageTotals,
} from './types'
import { normalizeState } from './utils'
import { WorkflowService } from './workflow'
import { WorkspaceService } from './workspace-manager'
import type { Logger } from './logger'

type WorkerStopReason = 'running' | 'failed' | 'stalled' | 'terminal' | 'inactive'

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
  workerFiber: Fiber.RuntimeFiber<void, never>
  stopReason: WorkerStopReason
  terminalCleanupRequested: boolean
}

type RetryRuntimeEntry = {
  issueId: string
  identifier: string
  attempt: number
  dueAtMs: number
  error: string | null
  fiber: Fiber.RuntimeFiber<void, never>
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
}

type OrchestratorCommand =
  | { _tag: 'PollTick' }
  | { _tag: 'StallSweep' }
  | { _tag: 'RetryDue'; issueId: string }
  | { _tag: 'WorkspaceReady'; issueId: string; workspacePath: string }
  | { _tag: 'CodexEventReceived'; issueId: string; event: CodexEvent }
  | { _tag: 'WorkerExited'; issueId: string; exit: Exit.Exit<string, unknown> }

const MAX_RECENT_EVENTS = 50

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
})

const computeRetryDelayMs = (
  attempt: number,
  maxRetryBackoffMs: number,
  delayType: 'continuation' | 'failure',
): number =>
  delayType === 'continuation' ? 1_000 : Math.min(10_000 * 2 ** Math.max(0, attempt - 1), maxRetryBackoffMs)

const buildIssueDetails = (state: OrchestratorState, issueIdentifier: string): IssueDetails | null => {
  const running = Array.from(state.running.values()).find((entry) => entry.identifier === issueIdentifier)
  if (running) {
    return {
      issueIdentifier: running.identifier,
      issueId: running.issueId,
      status: 'running',
      workspace: { path: running.workspacePath || null },
      attempts: {
        restartCount: running.retryAttempt ?? 0,
        currentRetryAttempt: running.retryAttempt ?? 0,
      },
      running: {
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
      },
      retry: null,
      logs: { codex_session_logs: [] },
      recentEvents: running.recentEvents,
      lastError: running.lastError,
      tracked: {},
    }
  }

  const retry = Array.from(state.retryAttempts.values()).find((entry) => entry.identifier === issueIdentifier)
  if (retry) {
    return {
      issueIdentifier: retry.identifier,
      issueId: retry.issueId,
      status: 'retrying',
      workspace: { path: null },
      attempts: {
        restartCount: retry.attempt,
        currentRetryAttempt: retry.attempt,
      },
      running: null,
      retry: {
        attempt: retry.attempt,
        dueAt: new Date(retry.dueAtMs).toISOString(),
        error: retry.error,
      },
      logs: { codex_session_logs: [] },
      recentEvents: [],
      lastError: retry.error,
      tracked: {},
    }
  }

  return null
}

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
      const orchestratorLogger = logger.child({ component: 'orchestrator' })

      const stateRef = yield* SynchronizedRef.make<OrchestratorState>(EMPTY_STATE())
      const queue = yield* Queue.unbounded<OrchestratorCommand>()
      const startedRef = yield* Ref.make(false)
      const pollQueuedRef = yield* Ref.make(false)
      const stallQueuedRef = yield* Ref.make(false)
      const processorFiberRef = yield* Ref.make<Fiber.RuntimeFiber<void, never> | null>(null)
      const pollFiberRef = yield* Ref.make<Fiber.RuntimeFiber<void, never> | null>(null)
      const stallFiberRef = yield* Ref.make<Fiber.RuntimeFiber<void, never> | null>(null)

      const enqueuePoll = Ref.getAndSet(pollQueuedRef, true).pipe(
        Effect.flatMap((alreadyQueued) => (alreadyQueued ? Effect.void : Queue.offer(queue, { _tag: 'PollTick' }))),
      )

      const enqueueStallSweep = Ref.getAndSet(stallQueuedRef, true).pipe(
        Effect.flatMap((alreadyQueued) => (alreadyQueued ? Effect.void : Queue.offer(queue, { _tag: 'StallSweep' }))),
      )

      const applyTokenUsage = (
        state: OrchestratorState,
        running: RunningRuntimeEntry,
        usage: TokenUsageTotals,
      ): void => {
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
      }

      const scheduleRetry = (
        issueId: string,
        identifier: string,
        attempt: number,
        delayType: 'continuation' | 'failure',
        error: string | null,
      ) =>
        Effect.gen(function* () {
          const config = yield* workflow.config
          const delayMs = computeRetryDelayMs(attempt, config.agent.maxRetryBackoffMs, delayType)
          const dueAtMs = Date.now() + delayMs

          const existing = yield* SynchronizedRef.modifyEffect(stateRef, (state) =>
            Effect.succeed([state.retryAttempts.get(issueId) ?? null, state] as const),
          )
          if (existing) {
            yield* Fiber.interruptFork(existing.fiber)
          }

          const fiber = yield* Effect.sleep(Duration.millis(delayMs)).pipe(
            Effect.zipRight(Queue.offer(queue, { _tag: 'RetryDue', issueId })),
            Effect.asVoid,
            Effect.forkScoped,
          )

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
            return Effect.succeed([undefined, state] as const)
          })
        })

      const handleCodexEvent = (issueId: string, event: CodexEvent) =>
        SynchronizedRef.modifyEffect(stateRef, (state) => {
          const running = state.running.get(issueId)
          if (!running) {
            return Effect.succeed([undefined, state] as const)
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
          if (event.message && event.message.trim().length > 0) {
            running.recentEvents.push({
              at: event.timestamp,
              event: event.event,
              message: event.message,
            })
            if (running.recentEvents.length > MAX_RECENT_EVENTS) {
              running.recentEvents.splice(0, running.recentEvents.length - MAX_RECENT_EVENTS)
            }
          }
          if (event.rateLimits) {
            state.codexRateLimits = event.rateLimits
          }
          if (event.usage) {
            applyTokenUsage(state, running, event.usage)
          }
          return Effect.succeed([undefined, state] as const)
        })

      const dispatchIssue = (issue: Issue, attempt: number | null) =>
        Effect.gen(function* () {
          const workerEffect = issueRunner
            .runAttempt(issue, attempt, {
              onEvent: (event) =>
                Queue.offer(queue, { _tag: 'CodexEventReceived', issueId: issue.id, event }).pipe(Effect.asVoid),
              onWorkspacePath: (workspacePath) =>
                Queue.offer(queue, { _tag: 'WorkspaceReady', issueId: issue.id, workspacePath }).pipe(Effect.asVoid),
            })
            .pipe(
              Effect.exit,
              Effect.flatMap((exit) => Queue.offer(queue, { _tag: 'WorkerExited', issueId: issue.id, exit })),
              Effect.asVoid,
            )

          const workerFiber = yield* Effect.forkScoped(workerEffect)
          const startedAtMs = Date.now()
          const startedAt = new Date(startedAtMs).toISOString()

          yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
            state.claimed.add(issue.id)
            const existingRetry = state.retryAttempts.get(issue.id)
            if (existingRetry) {
              state.retryAttempts.delete(issue.id)
            }
            state.running.set(issue.id, {
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
              workerFiber,
              stopReason: 'running',
              terminalCleanupRequested: false,
            })
            return Effect.succeed([existingRetry ?? null, state] as const)
          }).pipe(
            Effect.flatMap((existingRetry) => (existingRetry ? Fiber.interruptFork(existingRetry.fiber) : Effect.void)),
          )
        })

      const reconcileRunningIssues = (config: SymphonyConfig) =>
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
              yield* Fiber.interruptFork(running.workerFiber)
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
              yield* Fiber.interruptFork(running.workerFiber)
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
              yield* Fiber.interruptFork(running.workerFiber)
              continue
            }

            yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
              const current = state.running.get(running.issueId)
              if (current) {
                current.issue = latest
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
                  yield* Fiber.interruptFork(running.workerFiber)
                }
              }
            })

      const processPollTick = Effect.gen(function* () {
        yield* Ref.set(pollQueuedRef, false)
        const { config } = yield* workflow.current
        yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
          state.pollIntervalMs = config.pollingIntervalMs
          state.maxConcurrentAgents = config.agent.maxConcurrentAgents
          return Effect.succeed([undefined, state] as const)
        })

        yield* reconcileRunningIssues(config)
        yield* validateDispatchConfigEffect(config).pipe(
          Effect.catchAll((error) =>
            Effect.sync(() => {
              orchestratorLogger.log('error', 'dispatch_validation_failed', toLogError(error))
            }),
          ),
        )

        const validation = yield* Effect.either(validateDispatchConfigEffect(config))
        if (validation._tag === 'Left') return

        const issues = yield* tracker.fetchCandidateIssues.pipe(
          Effect.catchAll((error) =>
            Effect.sync(() => {
              orchestratorLogger.log('error', 'candidate_fetch_failed', toLogError(error))
            }).pipe(Effect.zipRight(Effect.succeed<Issue[]>([]))),
          ),
        )

        if (issues.length === 0) return

        const state = yield* SynchronizedRef.get(stateRef)
        for (const issue of sortIssuesForDispatch(issues)) {
          if (
            shouldDispatchIssue(issue, {
              config,
              runningIssues: Array.from(state.running.values()).map((entry) => entry.issue),
              claimedIssueIds: state.claimed,
            })
          ) {
            yield* dispatchIssue(issue, null)
          }
        }
      })

      const processRetryDue = (issueId: string) =>
        Effect.gen(function* () {
          const retryEntry = yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
            const current = state.retryAttempts.get(issueId) ?? null
            if (current) {
              state.retryAttempts.delete(issueId)
            }
            return Effect.succeed([current, state] as const)
          })
          if (!retryEntry) return

          const candidates = yield* tracker.fetchCandidateIssues.pipe(
            Effect.catchAll((error) =>
              Effect.sync(() => {
                orchestratorLogger.log('warn', 'retry_poll_failed', {
                  issue_id: issueId,
                  issue_identifier: retryEntry.identifier,
                  ...toLogError(error),
                })
              }).pipe(Effect.zipRight(Effect.succeed<Issue[]>([]))),
            ),
          )

          if (candidates.length === 0) {
            yield* scheduleRetry(issueId, retryEntry.identifier, retryEntry.attempt + 1, 'failure', 'retry poll failed')
            return
          }

          const issue = candidates.find((candidate) => candidate.id === issueId)
          if (!issue) {
            yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
              state.claimed.delete(issueId)
              return Effect.succeed([undefined, state] as const)
            })
            return
          }

          const config = yield* workflow.config
          const state = yield* SynchronizedRef.get(stateRef)
          if (
            !shouldDispatchIssue(issue, {
              config,
              runningIssues: Array.from(state.running.values()).map((entry) => entry.issue),
              claimedIssueIds: state.claimed,
            })
          ) {
            yield* scheduleRetry(
              issueId,
              issue.identifier,
              retryEntry.attempt + 1,
              'failure',
              'no available orchestrator slots',
            )
            return
          }

          yield* SynchronizedRef.modifyEffect(stateRef, (runtimeState) => {
            runtimeState.claimed.delete(issueId)
            return Effect.succeed([undefined, runtimeState] as const)
          })
          yield* dispatchIssue(issue, retryEntry.attempt)
        })

      const processWorkerExit = (issueId: string, exit: Exit.Exit<string, unknown>) =>
        Effect.gen(function* () {
          const running = yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
            const current = state.running.get(issueId) ?? null
            if (current) {
              state.running.delete(issueId)
              const runtimeSeconds = Math.max(0, Date.now() - current.startedAtMs) / 1_000
              state.codexTotals.endedRuntimeSeconds += runtimeSeconds
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

          if (reason === 'terminal') {
            yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
              state.claimed.delete(issueId)
              return Effect.succeed([undefined, state] as const)
            })
            if (running.terminalCleanupRequested) {
              yield* workspace.removeWorkspace(running.identifier).pipe(
                Effect.catchAll((error) =>
                  Effect.sync(() => {
                    orchestratorLogger.log('warn', 'terminal_workspace_cleanup_failed', {
                      issue_id: issueId,
                      issue_identifier: running.identifier,
                      ...toLogError(error),
                    })
                  }),
                ),
              )
            }
            return
          }

          if (reason === 'inactive') {
            yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
              state.claimed.delete(issueId)
              return Effect.succeed([undefined, state] as const)
            })
            return
          }

          if (reason === 'normal') {
            yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
              state.completed.add(issueId)
              return Effect.succeed([undefined, state] as const)
            })
            yield* scheduleRetry(issueId, running.identifier, 1, 'continuation', null)
            return
          }

          yield* scheduleRetry(issueId, running.identifier, (running.retryAttempt ?? 0) + 1, 'failure', errorMessage)
        })

      const handleCommand = (command: OrchestratorCommand) =>
        Effect.matchEffect(
          (() => {
            switch (command._tag) {
              case 'PollTick':
                return processPollTick
              case 'StallSweep':
                return Ref.set(stallQueuedRef, false).pipe(
                  Effect.zipRight(workflow.config.pipe(Effect.flatMap((config) => reconcileStalledRuns(config)))),
                )
              case 'RetryDue':
                return processRetryDue(command.issueId)
              case 'WorkspaceReady':
                return SynchronizedRef.modifyEffect(stateRef, (state) => {
                  const running = state.running.get(command.issueId)
                  if (running) {
                    running.workspacePath = command.workspacePath
                  }
                  return Effect.succeed([undefined, state] as const)
                })
              case 'CodexEventReceived':
                return handleCodexEvent(command.issueId, command.event)
              case 'WorkerExited':
                return processWorkerExit(command.issueId, command.exit)
            }
          })(),
          {
            onFailure: (error) =>
              Effect.sync(() => {
                orchestratorLogger.log('warn', 'orchestrator_command_failed', {
                  command: command._tag,
                  ...toLogError(error),
                })
              }),
            onSuccess: () => Effect.void,
          },
        )

      const startProcessor = Effect.forever(Queue.take(queue).pipe(Effect.flatMap(handleCommand))).pipe(
        Effect.forkScoped,
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

        const pollFiber = yield* Effect.repeat(enqueuePoll, pollSchedule).pipe(Effect.asVoid, Effect.forkScoped)
        const stallFiber = yield* Effect.repeat(enqueueStallSweep, stallSchedule).pipe(Effect.asVoid, Effect.forkScoped)
        yield* Ref.set(pollFiberRef, pollFiber)
        yield* Ref.set(stallFiberRef, stallFiber)
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

      const service: OrchestratorServiceDefinition = {
        start: Effect.scoped(
          Ref.get(startedRef).pipe(
            Effect.flatMap((started) =>
              started
                ? Effect.void
                : Effect.gen(function* () {
                    const config = yield* workflow.config
                    yield* validateDispatchConfigEffect(config)
                    yield* startupCleanup
                    const processorFiber = yield* startProcessor
                    yield* Ref.set(processorFiberRef, processorFiber)
                    yield* startSchedulers
                    yield* Ref.set(startedRef, true)
                  }),
            ),
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

          const state = yield* SynchronizedRef.get(stateRef)
          for (const retry of state.retryAttempts.values()) {
            yield* Fiber.interruptFork(retry.fiber)
          }
          for (const running of state.running.values()) {
            yield* Fiber.interruptFork(running.workerFiber)
          }
        }),
        triggerRefresh: enqueuePoll,
        getSnapshot: SynchronizedRef.get(stateRef).pipe(
          Effect.map((state) => {
            const generatedAt = new Date().toISOString()
            const nowMs = Date.now()
            const running = Array.from(state.running.values())
            const retrying = Array.from(state.retryAttempts.values())
            const activeRuntimeSeconds = running.reduce(
              (total, entry) => total + Math.max(0, nowMs - entry.startedAtMs) / 1_000,
              0,
            )

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
            } satisfies RuntimeSnapshot
          }),
        ),
        getIssueDetails: (issueIdentifier) =>
          SynchronizedRef.get(stateRef).pipe(Effect.map((state) => buildIssueDetails(state, issueIdentifier))),
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

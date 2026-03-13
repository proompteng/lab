import { setTimeout as delay } from 'node:timers/promises'

import { toError } from './errors'
import { sortIssuesForDispatch, shouldDispatchIssue } from './dispatch-rules'
import { createLinearTrackerClient, type IssueTrackerClient } from './linear-client'
import type { Logger } from './logger'
import type {
  CodexTotals,
  Issue,
  LiveSession,
  RecentEvent,
  RetryEntry,
  RunningEntry,
  RuntimeSnapshot,
  SymphonyConfig,
  TokenUsageTotals,
} from './types'
import { normalizeState } from './utils'
import { validateDispatchConfig } from './config'
import { WorkspaceManager } from './workspace-manager'
import { IssueRunner } from './issue-runner'
import { WorkflowStore } from './workflow'
import type { CodexEvent } from './codex-app-session'

type WorkerExitReason = 'normal' | 'failed' | 'stalled' | 'terminal' | 'inactive'

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

const MAX_RECENT_EVENTS = 50

export class SymphonyOrchestrator {
  private readonly workflowStore: WorkflowStore
  private readonly logger: Logger
  private readonly workspaceManager: WorkspaceManager
  private readonly tracker: Promise<IssueTrackerClient>
  private readonly issueRunner: Promise<IssueRunner>

  private pollTimer: Timer | null = null
  private tickInFlight = false
  private refreshRequested = false
  private started = false

  private readonly state = {
    running: new Map<string, RunningEntry>(),
    claimed: new Set<string>(),
    retryAttempts: new Map<string, RetryEntry>(),
    completed: new Set<string>(),
    codexTotals: EMPTY_TOTALS(),
    codexRateLimits: null as RuntimeSnapshot['rateLimits'],
  }

  constructor(workflowPath: string, logger: Logger) {
    this.logger = logger.child({ component: 'orchestrator' })
    this.workflowStore = new WorkflowStore(workflowPath, this.logger)
    this.workspaceManager = new WorkspaceManager(
      async () => (await this.workflowStore.getCurrent()).config,
      this.logger,
    )
    this.tracker = createLinearTrackerClient(async () => (await this.workflowStore.getCurrent()).config)
    this.issueRunner = this.tracker.then(
      (tracker) =>
        new IssueRunner({
          configProvider: async () => (await this.workflowStore.getCurrent()).config,
          workflowProvider: async () => this.workflowStore.getCurrent(),
          tracker,
          workspaceManager: this.workspaceManager,
          logger: this.logger,
        }),
    )
  }

  async start(): Promise<void> {
    await this.workflowStore.initialize()
    this.workflowStore.startWatching()
    const { config } = await this.workflowStore.getCurrent()
    validateDispatchConfig(config)

    const tracker = await this.tracker
    try {
      const terminalIssues = await tracker.fetchIssuesByStates(config.tracker.terminalStates)
      await Promise.all(terminalIssues.map((issue) => this.workspaceManager.removeWorkspace(issue.identifier)))
    } catch (error) {
      this.logger.log('warn', 'startup_terminal_cleanup_failed', { error: toError(error).message })
    }

    this.started = true
    this.scheduleTick(0)
  }

  async stop(): Promise<void> {
    this.started = false
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
    }
    this.pollTimer = null
    this.workflowStore.close()
    for (const retryEntry of this.state.retryAttempts.values()) {
      clearTimeout(retryEntry.timerHandle)
    }
    this.state.retryAttempts.clear()
    for (const running of this.state.running.values()) {
      running.abortController.abort()
    }
    await delay(10)
  }

  async triggerRefresh(): Promise<void> {
    this.refreshRequested = true
    this.scheduleTick(0)
  }

  getSnapshot(): RuntimeSnapshot {
    const generatedAt = new Date().toISOString()
    const nowMs = Date.now()
    const running = Array.from(this.state.running.values())
    const retrying = Array.from(this.state.retryAttempts.values())
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
        inputTokens: this.state.codexTotals.inputTokens,
        outputTokens: this.state.codexTotals.outputTokens,
        totalTokens: this.state.codexTotals.totalTokens,
        secondsRunning: this.state.codexTotals.endedRuntimeSeconds + activeRuntimeSeconds,
      },
      rateLimits: this.state.codexRateLimits,
    }
  }

  async getCurrentConfig(): Promise<SymphonyConfig> {
    return (await this.workflowStore.getCurrent()).config
  }

  getIssueDetails(issueIdentifier: string) {
    const running = Array.from(this.state.running.values()).find((entry) => entry.identifier === issueIdentifier)
    if (running) {
      return {
        issueIdentifier: running.identifier,
        issueId: running.issueId,
        status: 'running',
        workspace: { path: running.workspacePath },
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

    const retry = Array.from(this.state.retryAttempts.values()).find((entry) => entry.identifier === issueIdentifier)
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

  private scheduleTick(delayMs: number): void {
    if (!this.started) return
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
    }
    this.pollTimer = setTimeout(
      () => {
        void this.tick()
      },
      Math.max(0, delayMs),
    )
  }

  private async tick(): Promise<void> {
    if (this.tickInFlight) {
      this.refreshRequested = true
      return
    }

    this.tickInFlight = true
    try {
      const { config } = await this.workflowStore.getCurrent()
      await this.reconcileRunningIssues(config)

      try {
        validateDispatchConfig(config)
      } catch (error) {
        this.logger.log('error', 'dispatch_validation_failed', { error: toError(error).message })
        this.scheduleTick(config.pollingIntervalMs)
        return
      }

      const tracker = await this.tracker
      let issues: Issue[]
      try {
        issues = await tracker.fetchCandidateIssues()
      } catch (error) {
        this.logger.log('error', 'candidate_fetch_failed', { error: toError(error).message })
        this.scheduleTick(config.pollingIntervalMs)
        return
      }

      const sorted = sortIssuesForDispatch(issues)

      for (const issue of sorted) {
        if (!this.shouldDispatch(issue, config)) continue
        this.dispatchIssue(issue, null)
      }

      this.scheduleTick(this.refreshRequested ? 0 : config.pollingIntervalMs)
      this.refreshRequested = false
    } finally {
      this.tickInFlight = false
    }
  }

  private async reconcileRunningIssues(config: SymphonyConfig): Promise<void> {
    if (config.codex.stallTimeoutMs > 0) {
      const nowMs = Date.now()
      for (const running of this.state.running.values()) {
        const lastEventMs = running.session.lastCodexTimestamp
          ? Date.parse(running.session.lastCodexTimestamp)
          : running.startedAtMs
        if (nowMs - lastEventMs > config.codex.stallTimeoutMs) {
          running.stopReason = 'stalled'
          running.abortController.abort()
        }
      }
    }

    if (this.state.running.size === 0) return

    try {
      const tracker = await this.tracker
      const refreshed = await tracker.fetchIssueStatesByIds(Array.from(this.state.running.keys()))
      const refreshedById = new Map(refreshed.map((issue) => [issue.id, issue]))
      const activeStates = new Set(config.tracker.activeStates.map((state) => normalizeState(state)))
      const terminalStates = new Set(config.tracker.terminalStates.map((state) => normalizeState(state)))

      for (const [issueId, running] of this.state.running.entries()) {
        const latest = refreshedById.get(issueId)
        if (!latest) {
          running.stopReason = 'inactive'
          running.abortController.abort()
          continue
        }
        const state = normalizeState(latest.state)
        if (terminalStates.has(state)) {
          running.issue = latest
          running.stopReason = 'terminal'
          running.terminalCleanupRequested = true
          running.abortController.abort()
          continue
        }
        if (!activeStates.has(state)) {
          running.issue = latest
          running.stopReason = 'inactive'
          running.abortController.abort()
          continue
        }
        running.issue = latest
      }
    } catch (error) {
      this.logger.log('warn', 'running_state_refresh_failed', { error: toError(error).message })
    }
  }

  private dispatchIssue(issue: Issue, attempt: number | null): void {
    if (this.state.running.has(issue.id) || this.state.claimed.has(issue.id)) return
    void this.spawnWorker(issue, attempt)
  }

  private async spawnWorker(issue: Issue, attempt: number | null): Promise<void> {
    const issueRunner = await this.issueRunner
    const startedAtMs = Date.now()
    const startedAt = new Date(startedAtMs).toISOString()
    const abortController = new AbortController()

    this.state.claimed.add(issue.id)
    const workerPromise = issueRunner
      .runAttempt(
        issue,
        attempt,
        (event) => {
          this.handleCodexEvent(issue.id, event)
        },
        abortController.signal,
      )
      .then(async (workspacePath) => {
        await this.handleWorkerExit(issue.id, 'normal', null, workspacePath)
      })
      .catch(async (error) => {
        const running = this.state.running.get(issue.id)
        const workspacePath = running?.workspacePath ?? ''
        const reason = running?.stopReason && running.stopReason !== 'running' ? running.stopReason : 'failed'
        await this.handleWorkerExit(issue.id, reason, error, workspacePath)
      })

    this.state.running.set(issue.id, {
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
      workerHandle: workerPromise,
      abortController,
      stopReason: 'running',
      terminalCleanupRequested: false,
    })
  }

  private async handleWorkerExit(
    issueId: string,
    reason: WorkerExitReason,
    error: unknown,
    workspacePath: string,
  ): Promise<void> {
    const running = this.state.running.get(issueId)
    if (!running) return

    if (workspacePath) {
      running.workspacePath = workspacePath
    }

    this.state.running.delete(issueId)
    const runtimeSeconds = Math.max(0, Date.now() - running.startedAtMs) / 1_000
    this.state.codexTotals.endedRuntimeSeconds += runtimeSeconds

    const errorMessage = error ? toError(error).message : null

    if (reason === 'terminal') {
      this.state.claimed.delete(issueId)
      if (running.terminalCleanupRequested) {
        await this.workspaceManager.removeWorkspace(running.identifier)
      }
      return
    }

    if (reason === 'inactive') {
      this.state.claimed.delete(issueId)
      return
    }

    if (reason === 'normal') {
      this.state.completed.add(issueId)
      this.scheduleRetry(issueId, 1, running.identifier, 'continuation', null)
      return
    }

    const nextAttempt = (running.retryAttempt ?? 0) + 1
    this.scheduleRetry(issueId, nextAttempt, running.identifier, 'failure', errorMessage)
  }

  private scheduleRetry(
    issueId: string,
    attempt: number,
    identifier: string,
    delayType: 'continuation' | 'failure',
    error: string | null,
  ): void {
    const existing = this.state.retryAttempts.get(issueId)
    if (existing) {
      clearTimeout(existing.timerHandle)
      this.state.retryAttempts.delete(issueId)
    }

    this.state.claimed.add(issueId)
    const maxRetryBackoffMs = (() => {
      const current = this.workflowStore.getCurrent()
      return current.then(({ config }) => config.agent.maxRetryBackoffMs)
    })()

    void maxRetryBackoffMs.then((capMs) => {
      const delayMs = delayType === 'continuation' ? 1_000 : Math.min(10_000 * 2 ** Math.max(0, attempt - 1), capMs)
      const dueAtMs = Date.now() + delayMs
      const timerHandle = setTimeout(() => {
        void this.onRetryTimer(issueId)
      }, delayMs)

      this.state.retryAttempts.set(issueId, {
        issueId,
        identifier,
        attempt,
        dueAtMs,
        timerHandle,
        error,
      })
    })
  }

  private async onRetryTimer(issueId: string): Promise<void> {
    const retryEntry = this.state.retryAttempts.get(issueId)
    if (!retryEntry) return
    this.state.retryAttempts.delete(issueId)

    const tracker = await this.tracker
    let candidates: Issue[]
    try {
      candidates = await tracker.fetchCandidateIssues()
    } catch (error) {
      this.logger.log('warn', 'retry_poll_failed', {
        issue_id: issueId,
        issue_identifier: retryEntry.identifier,
        error: toError(error).message,
      })
      this.scheduleRetry(issueId, retryEntry.attempt + 1, retryEntry.identifier, 'failure', 'retry poll failed')
      return
    }

    const issue = candidates.find((candidate) => candidate.id === issueId)
    if (!issue) {
      this.state.claimed.delete(issueId)
      return
    }

    const { config } = await this.workflowStore.getCurrent()
    if (!this.shouldDispatch(issue, config)) {
      this.scheduleRetry(
        issueId,
        retryEntry.attempt + 1,
        issue.identifier,
        'failure',
        'no available orchestrator slots',
      )
      return
    }

    this.state.claimed.delete(issueId)
    this.dispatchIssue(issue, retryEntry.attempt)
  }

  private shouldDispatch(issue: Issue, config: SymphonyConfig): boolean {
    return shouldDispatchIssue(issue, {
      config,
      runningIssues: Array.from(this.state.running.values()).map((entry) => entry.issue),
      claimedIssueIds: this.state.claimed,
    })
  }

  private handleCodexEvent(issueId: string, event: CodexEvent): void {
    const running = this.state.running.get(issueId)
    if (!running) return

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
      const recentEvent: RecentEvent = {
        at: event.timestamp,
        event: event.event,
        message: event.message,
      }
      running.recentEvents.push(recentEvent)
      if (running.recentEvents.length > MAX_RECENT_EVENTS) {
        running.recentEvents.splice(0, running.recentEvents.length - MAX_RECENT_EVENTS)
      }
    }
    if (event.rateLimits) {
      this.state.codexRateLimits = event.rateLimits
    }
    if (event.usage) {
      this.applyTokenUsage(running, event.usage)
    }
  }

  private applyTokenUsage(running: RunningEntry, usage: TokenUsageTotals): void {
    const deltaInput = Math.max(0, usage.inputTokens - running.session.lastReportedInputTokens)
    const deltaOutput = Math.max(0, usage.outputTokens - running.session.lastReportedOutputTokens)
    const deltaTotal = Math.max(0, usage.totalTokens - running.session.lastReportedTotalTokens)

    running.session.codexInputTokens = usage.inputTokens
    running.session.codexOutputTokens = usage.outputTokens
    running.session.codexTotalTokens = usage.totalTokens
    running.session.lastReportedInputTokens = usage.inputTokens
    running.session.lastReportedOutputTokens = usage.outputTokens
    running.session.lastReportedTotalTokens = usage.totalTokens

    this.state.codexTotals.inputTokens += deltaInput
    this.state.codexTotals.outputTokens += deltaOutput
    this.state.codexTotals.totalTokens += deltaTotal
  }
}

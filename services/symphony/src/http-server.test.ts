import { afterEach, describe, expect, test } from 'bun:test'

import { Effect, Layer, ManagedRuntime } from 'effect'

import { SymphonyHttpServer, parseIssueIdentifierPath } from './http-server'
import { createLogger } from './logger'
import { OrchestratorService } from './orchestrator'
import type { IssueDetails, RuntimeSnapshot, SymphonyConfig } from './types'

let server: SymphonyHttpServer<OrchestratorService, never> | null = null

afterEach(() => {
  server?.stop()
  server = null
})

const snapshot: RuntimeSnapshot = {
  generatedAt: '2026-03-14T12:00:00.000Z',
  counts: {
    running: 1,
    retrying: 1,
  },
  running: [
    {
      issueId: 'issue-1',
      issueIdentifier: 'ABC-1',
      state: 'In Progress',
      sessionId: 'thread-1-turn-1',
      turnCount: 3,
      lastEvent: 'turn_completed',
      lastMessage: 'Working on tests',
      startedAt: '2026-03-14T11:59:00.000Z',
      lastEventAt: '2026-03-14T11:59:30.000Z',
      tokens: {
        inputTokens: 100,
        outputTokens: 80,
        totalTokens: 180,
      },
    },
  ],
  retrying: [
    {
      issueId: 'issue-2',
      issueIdentifier: 'ABC-2',
      attempt: 2,
      dueAt: '2026-03-14T12:02:00.000Z',
      error: 'no available orchestrator slots',
    },
  ],
  codexTotals: {
    inputTokens: 400,
    outputTokens: 250,
    totalTokens: 650,
    secondsRunning: 123.4,
  },
  rateLimits: null,
  policy: {
    approvalPolicy: 'never',
    threadSandbox: 'workspace-write',
    turnSandboxPolicy: null,
    allowedTools: ['linear_graphql'],
    workspaceRoot: '/workspace/symphony',
    pollIntervalMs: 30_000,
    maxConcurrentAgents: 10,
    activeStates: ['Todo', 'In Progress'],
    terminalStates: ['Done', 'Closed'],
  },
  workflow: {
    workflowPath: '/etc/symphony/WORKFLOW.md',
    trackerKind: 'linear',
    projectSlug: 'symphony',
    promptTemplateEmpty: false,
  },
  leader: {
    enabled: true,
    required: true,
    isLeader: true,
    leaseName: 'symphony-leader',
    leaseNamespace: 'jangar',
    identity: 'symphony-0_abc',
    lastTransitionAt: '2026-03-14T11:58:00.000Z',
    lastAttemptAt: '2026-03-14T11:59:59.000Z',
    lastSuccessAt: '2026-03-14T11:59:59.000Z',
    lastError: null,
  },
  recentEvents: [
    {
      at: '2026-03-14T12:00:00.000Z',
      event: 'dispatch_skipped',
      message: 'issue ABC-2 not dispatched: no_slots',
      issueId: 'issue-2',
      issueIdentifier: 'ABC-2',
      level: 'warn',
      reason: 'no_slots',
    },
  ],
  recentErrors: [
    {
      at: '2026-03-14T11:58:45.000Z',
      code: 'worker_aborted',
      message: 'worker exited unexpectedly',
      issueId: 'issue-3',
      issueIdentifier: 'ABC-3',
      context: 'worker_exit',
    },
  ],
  capacity: {
    maxConcurrentAgents: 10,
    running: 1,
    retrying: 1,
    availableSlots: 9,
    saturated: false,
    byState: [{ state: 'in progress', running: 1, limit: 10, saturated: false }],
  },
}

const issueDetails: IssueDetails = {
  issueIdentifier: 'ABC-1',
  issueId: 'issue-1',
  status: 'running',
  workspace: { path: '/workspace/symphony/ABC-1' },
  attempts: {
    restartCount: 1,
    currentRetryAttempt: 1,
  },
  running: {
    sessionId: 'thread-1-turn-1',
    turnCount: 3,
    state: 'In Progress',
    startedAt: '2026-03-14T11:59:00.000Z',
    lastEvent: 'turn_completed',
    lastMessage: 'Working on tests',
    lastEventAt: '2026-03-14T11:59:30.000Z',
    tokens: {
      inputTokens: 100,
      outputTokens: 80,
      totalTokens: 180,
    },
  },
  retry: null,
  logs: { codex_session_logs: [] },
  recentEvents: [],
  lastError: null,
  tracked: { lastKnownState: 'In Progress' },
  runHistory: [],
}

const baseConfig: SymphonyConfig = {
  workflowPath: '/etc/symphony/WORKFLOW.md',
  tracker: {
    kind: 'linear',
    endpoint: 'https://api.linear.app/graphql',
    apiKey: 'token',
    projectSlug: 'symphony',
    activeStates: ['Todo', 'In Progress'],
    terminalStates: ['Done', 'Closed'],
  },
  pollingIntervalMs: 30_000,
  workspaceRoot: '/workspace/symphony',
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

const makeRuntime = () =>
  ManagedRuntime.make(
    Layer.succeed(OrchestratorService, {
      start: Effect.void,
      stop: Effect.void,
      triggerRefresh: Effect.void,
      getSnapshot: Effect.succeed(snapshot),
      getIssueDetails: (issueIdentifier: string) => Effect.succeed(issueIdentifier === 'ABC-1' ? issueDetails : null),
      getCurrentConfig: Effect.succeed(baseConfig),
    }),
  )

describe('http request parsing', () => {
  test('parses issue identifier paths', () => {
    expect(parseIssueIdentifierPath('/api/v1/ABC-123')).toEqual({ issueIdentifier: 'ABC-123' })
  })

  test('rejects empty issue identifier paths', () => {
    expect(parseIssueIdentifierPath('/api/v1/')).toBeNull()
  })

  test('serves enriched runtime state and issue detail payloads', async () => {
    const runtime = makeRuntime()
    server = new SymphonyHttpServer(runtime, createLogger({ test: 'http-server' }))
    const port = server.start(0, '127.0.0.1')

    try {
      const stateResponse = await fetch(`http://127.0.0.1:${port}/api/v1/state`)
      expect(stateResponse.status).toBe(200)
      const stateBody = await stateResponse.json()
      expect(stateBody.policy.allowedTools).toEqual(['linear_graphql'])
      expect(stateBody.leader.isLeader).toBe(true)
      expect(stateBody.recentErrors).toHaveLength(1)

      const issueResponse = await fetch(`http://127.0.0.1:${port}/api/v1/ABC-1`)
      expect(issueResponse.status).toBe(200)
      const issueBody = await issueResponse.json()
      expect(issueBody.workspace.path).toBe('/workspace/symphony/ABC-1')
      expect(issueBody.status).toBe('running')

      const dashboardResponse = await fetch(`http://127.0.0.1:${port}/`)
      const dashboardText = await dashboardResponse.text()
      expect(dashboardResponse.status).toBe(200)
      expect(dashboardText).toContain('Leader Status')
      expect(dashboardText).toContain('Recent Errors')
      expect(dashboardText).toContain('/api/v1/ABC-1')
    } finally {
      server.stop()
      server = null
      await runtime.dispose()
    }
  })
})

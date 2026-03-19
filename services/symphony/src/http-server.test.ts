import { afterEach, describe, expect, test } from 'bun:test'

import { Effect, Layer, ManagedRuntime } from 'effect'

import { SymphonyHttpServer, parseIssueIdentifierPath } from './http-server'
import { createLogger } from './logger'
import { OrchestratorService } from './orchestrator'
import { makeTestConfig, makeTestSnapshot } from './test-fixtures'
import type { IssueDetails, RuntimeSnapshot, SymphonyConfig } from './types'

let server: SymphonyHttpServer<OrchestratorService, never> | null = null

afterEach(() => {
  server?.stop()
  server = null
})

const snapshot: RuntimeSnapshot = makeTestSnapshot()

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
  delivery: {
    stage: 'checks_pending',
    updatedAt: '2026-03-14T12:00:00.000Z',
    codePr: {
      number: 101,
      url: 'https://github.com/proompteng/lab/pull/101',
      branch: 'codex/proompt-336',
      state: 'open',
      title: 'feat(symphony): add delivery engine',
      createdAt: '2026-03-14T11:30:00.000Z',
      updatedAt: '2026-03-14T12:00:00.000Z',
      mergedAt: null,
      mergedCommitSha: null,
    },
    requiredChecks: {
      state: 'pending',
      headSha: 'abcdef0123456789abcdef0123456789abcdef01',
      requiredCount: 3,
      passingCount: 2,
      failingCount: 0,
      pendingCount: 1,
      url: 'https://github.com/proompteng/lab/pull/101/checks',
    },
    mergedCommitSha: null,
    build: null,
    releaseContract: null,
    promotionPr: null,
    argo: null,
    postDeploy: null,
    rollbackPr: null,
    lastError: null,
  },
}

const baseConfig: SymphonyConfig = makeTestConfig({
  workflowPath: '/etc/symphony/WORKFLOW.md',
  workspaceRoot: '/workspace/symphony',
})

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
      expect(stateBody.instance.name).toBe('symphony')
      expect(stateBody.target.name).toBe('Symphony')
      expect(stateBody.release.mode).toBe('gitops_pr_on_main')
      expect(stateBody.targetHealth.readyForDispatch).toBe(true)
      expect(stateBody.telemetry.enabled).toBe(true)
      expect(stateBody.issues[0]?.delivery?.codePr?.number).toBe(101)

      const issueResponse = await fetch(`http://127.0.0.1:${port}/api/v1/ABC-1`)
      expect(issueResponse.status).toBe(200)
      const issueBody = await issueResponse.json()
      expect(issueBody.workspace.path).toBe('/workspace/symphony/ABC-1')
      expect(issueBody.status).toBe('running')
      expect(issueBody.delivery.stage).toBe('checks_pending')

      const dashboardResponse = await fetch(`http://127.0.0.1:${port}/`)
      const dashboardText = await dashboardResponse.text()
      expect(dashboardResponse.status).toBe(200)
      expect(dashboardText).toContain('Leader Status')
      expect(dashboardText).toContain('Telemetry')
      expect(dashboardText).toContain('Recent Errors')
      expect(dashboardText).toContain('Target Health')
      expect(dashboardText).toContain('Delivery Transactions')
      expect(dashboardText).toContain('/api/v1/ABC-1')
    } finally {
      server.stop()
      server = null
      await runtime.dispose()
    }
  })
})

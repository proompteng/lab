import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { Effect, Layer, ManagedRuntime } from 'effect'
import * as Stream from 'effect/Stream'

import { createLogger } from './logger'
import {
  clearDurableStateForTests,
  getDurableStateFilePath,
  makeStateStoreLayer,
  StateStoreService,
} from './state-store'
import type { PersistedSchedulerState, SymphonyConfig } from './types'
import { WorkflowService } from './workflow'

const workspaceRoots: string[] = []

afterEach(async () => {
  await Promise.all(workspaceRoots.map((root) => clearDurableStateForTests(root)))
  workspaceRoots.length = 0
})

const makeConfig = (workspaceRoot: string): SymphonyConfig => ({
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
  workspaceRoot,
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
})

const makeRuntime = (workspaceRoot: string) => {
  const config = makeConfig(workspaceRoot)
  return ManagedRuntime.make(
    makeStateStoreLayer(createLogger({ test: 'state-store' })).pipe(
      Layer.provide(
        Layer.succeed(WorkflowService, {
          current: Effect.succeed({ definition: { config: {}, promptTemplate: '' }, config }),
          config: Effect.succeed(config),
          reload: Effect.succeed({ definition: { config: {}, promptTemplate: '' }, config }),
          changes: Stream.empty,
        }),
      ),
    ),
  )
}

describe('durable state store', () => {
  test('saves and reloads persisted scheduler state under workspace root', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-state-'))
    workspaceRoots.push(workspaceRoot)
    const runtime = makeRuntime(workspaceRoot)

    const state: PersistedSchedulerState = {
      version: 1,
      updatedAt: '2026-03-14T12:00:00.000Z',
      codexTotals: {
        inputTokens: 11,
        outputTokens: 7,
        totalTokens: 18,
        endedRuntimeSeconds: 42,
      },
      rateLimits: null,
      recentEvents: [
        {
          at: '2026-03-14T12:00:00.000Z',
          event: 'retry_scheduled',
          message: 'waiting for slots',
          issueId: 'issue-1',
          issueIdentifier: 'ABC-1',
          level: 'warn',
          reason: 'no_slots',
        },
      ],
      recentErrors: [
        {
          at: '2026-03-14T12:00:01.000Z',
          code: 'worker_aborted',
          message: 'worker exited unexpectedly',
          issueId: 'issue-1',
          issueIdentifier: 'ABC-1',
          context: 'worker_exit',
        },
      ],
      retrying: [
        {
          issueId: 'issue-1',
          identifier: 'ABC-1',
          attempt: 2,
          dueAt: '2026-03-14T12:01:00.000Z',
          error: 'waiting for slots',
        },
      ],
      issues: [
        {
          issueIdentifier: 'ABC-1',
          issueId: 'issue-1',
          status: 'retrying',
          workspacePath: '/workspace/ABC-1',
          attempts: {
            restartCount: 2,
            currentRetryAttempt: 2,
          },
          running: null,
          retry: {
            attempt: 2,
            dueAt: '2026-03-14T12:01:00.000Z',
            error: 'waiting for slots',
          },
          logs: {
            codex_session_logs: [],
          },
          recentEvents: [],
          lastError: 'waiting for slots',
          tracked: {
            lastKnownState: 'Todo',
          },
          runHistory: [],
          updatedAt: '2026-03-14T12:00:02.000Z',
        },
      ],
    }

    try {
      await runtime
        .runPromise(
          Effect.gen(function* () {
            const store = yield* StateStoreService
            yield* store.save(state)
            return yield* store.load
          }),
        )
        .then((loaded) => {
          expect(loaded).toEqual(state)
        })

      const filePath = getDurableStateFilePath(workspaceRoot)
      expect(await Bun.file(filePath).exists()).toBe(true)
    } finally {
      await runtime.dispose()
    }
  })

  test('invalid durable state falls back to an empty state', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-state-invalid-'))
    workspaceRoots.push(workspaceRoot)
    const filePath = getDurableStateFilePath(workspaceRoot)
    await mkdir(path.dirname(filePath), { recursive: true })
    await Bun.write(filePath, '{not-json')
    const runtime = makeRuntime(workspaceRoot)

    try {
      const loaded = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* StateStoreService
          return yield* store.load
        }),
      )

      expect(loaded.retrying).toEqual([])
      expect(loaded.issues).toEqual([])
      expect(loaded.recentEvents).toEqual([])
    } finally {
      await runtime.dispose()
    }
  })
})

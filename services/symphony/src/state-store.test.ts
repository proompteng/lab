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
import { makeTestConfig } from './test-fixtures'
import type { PersistedSchedulerState, SymphonyConfig } from './types'
import { WorkflowService } from './workflow'

const workspaceRoots: string[] = []

afterEach(async () => {
  await Promise.all(workspaceRoots.map((root) => clearDurableStateForTests(root)))
  workspaceRoots.length = 0
})

const makeConfig = (workspaceRoot: string): SymphonyConfig => makeTestConfig({ workspaceRoot })

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
      version: 2,
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
          delivery: {
            stage: 'promotion_pr_open',
            updatedAt: '2026-03-14T12:00:02.000Z',
            codePr: {
              number: 101,
              url: 'https://github.com/proompteng/lab/pull/101',
              branch: 'codex/proompt-336',
              state: 'merged',
              title: 'feat(symphony): add delivery engine',
              createdAt: '2026-03-14T11:00:00.000Z',
              updatedAt: '2026-03-14T12:00:02.000Z',
              mergedAt: '2026-03-14T11:45:00.000Z',
              mergedCommitSha: 'abcdef0123456789abcdef0123456789abcdef01',
            },
            requiredChecks: {
              state: 'success',
              headSha: 'abcdef0123456789abcdef0123456789abcdef01',
              requiredCount: 3,
              passingCount: 3,
              failingCount: 0,
              pendingCount: 0,
              url: 'https://github.com/proompteng/lab/pull/101/checks',
            },
            mergedCommitSha: 'abcdef0123456789abcdef0123456789abcdef01',
            build: {
              id: 501,
              url: 'https://github.com/proompteng/lab/actions/runs/501',
              name: 'symphony-build-push',
              state: 'success',
              status: 'completed',
              conclusion: 'success',
              event: 'push',
              headSha: 'abcdef0123456789abcdef0123456789abcdef01',
              headBranch: 'main',
              createdAt: '2026-03-14T11:46:00.000Z',
              updatedAt: '2026-03-14T11:48:00.000Z',
            },
            releaseContract: {
              sourceSha: 'abcdef0123456789abcdef0123456789abcdef01',
              tag: 'abcdef01',
              digest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
              image: 'registry.ide-newton.ts.net/lab/symphony',
              reason: 'promotion_pr',
              resolvedAt: '2026-03-14T11:50:00.000Z',
            },
            promotionPr: {
              number: 102,
              url: 'https://github.com/proompteng/lab/pull/102',
              branch: 'codex/symphony-release-abcdef01',
              state: 'open',
              title: 'chore(symphony): promote image abcdef01',
              createdAt: '2026-03-14T11:50:00.000Z',
              updatedAt: '2026-03-14T11:50:00.000Z',
              mergedAt: null,
              mergedCommitSha: null,
            },
            argo: null,
            postDeploy: null,
            rollbackPr: null,
            lastError: null,
          },
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

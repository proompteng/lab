import { describe, expect, test } from 'bun:test'

import {
  createEmptyDeliveryTransaction,
  deriveDeliveryStage,
  makeDeliveryServiceLayer,
  DeliveryService,
} from './delivery-service'
import { createLogger } from './logger'
import { makeTestConfig } from './test-fixtures'
import { WorkflowService } from './workflow'
import { Effect, Layer, ManagedRuntime } from 'effect'
import * as Stream from 'effect/Stream'

describe('delivery transaction stages', () => {
  test('starts in coding when no delivery artifacts exist', () => {
    expect(
      deriveDeliveryStage({
        handoffRequired: false,
        codePr: null,
        requiredChecks: null,
        mergedCommitSha: null,
        build: null,
        releaseContract: null,
        promotionPr: null,
        kargo: null,
        argo: null,
        postDeploy: null,
        rollbackPr: null,
        lastError: null,
      }),
    ).toBe('coding')
  })

  test('moves through checks and build states', () => {
    expect(
      deriveDeliveryStage({
        handoffRequired: false,
        codePr: {
          number: 101,
          url: 'https://github.com/proompteng/lab/pull/101',
          branch: 'codex/proompt-336',
          state: 'open',
          title: 'feat(symphony): add delivery engine',
          createdAt: null,
          updatedAt: null,
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
          url: null,
        },
        mergedCommitSha: null,
        build: null,
        releaseContract: null,
        promotionPr: null,
        kargo: null,
        argo: null,
        postDeploy: null,
        rollbackPr: null,
        lastError: null,
      }),
    ).toBe('checks_pending')

    expect(
      deriveDeliveryStage({
        handoffRequired: false,
        codePr: null,
        requiredChecks: null,
        mergedCommitSha: 'abcdef0123456789abcdef0123456789abcdef01',
        build: {
          id: 501,
          url: 'https://github.com/proompteng/lab/actions/runs/501',
          name: 'symphony-build-push',
          state: 'in_progress',
          status: 'in_progress',
          conclusion: null,
          event: 'push',
          headSha: 'abcdef0123456789abcdef0123456789abcdef01',
          headBranch: 'main',
          createdAt: null,
          updatedAt: null,
        },
        releaseContract: null,
        promotionPr: null,
        kargo: null,
        argo: null,
        postDeploy: null,
        rollbackPr: null,
        lastError: null,
      }),
    ).toBe('build_running')
  })

  test('marks completion and rollback outcomes', () => {
    expect(
      deriveDeliveryStage({
        handoffRequired: false,
        codePr: null,
        requiredChecks: null,
        mergedCommitSha: 'abcdef0123456789abcdef0123456789abcdef01',
        build: null,
        releaseContract: null,
        promotionPr: {
          number: 102,
          url: 'https://github.com/proompteng/lab/pull/102',
          branch: 'codex/symphony-release-abcdef01',
          state: 'merged',
          title: 'chore(symphony): promote image abcdef01',
          createdAt: null,
          updatedAt: null,
          mergedAt: '2026-03-14T12:00:00.000Z',
          mergedCommitSha: 'fedcba9876543210fedcba9876543210fedcba98',
        },
        kargo: null,
        argo: {
          application: 'symphony',
          namespace: 'jangar',
          revision: 'fedcba9876543210fedcba9876543210fedcba98',
          health: 'Healthy',
          sync: 'Synced',
          checkedAt: '2026-03-14T12:05:00.000Z',
        },
        postDeploy: {
          id: 601,
          url: 'https://github.com/proompteng/lab/actions/runs/601',
          name: 'symphony-post-deploy-verify',
          state: 'success',
          status: 'completed',
          conclusion: 'success',
          event: 'push',
          headSha: 'fedcba9876543210fedcba9876543210fedcba98',
          headBranch: 'main',
          createdAt: null,
          updatedAt: null,
        },
        rollbackPr: null,
        lastError: null,
      }),
    ).toBe('completed')

    expect(
      deriveDeliveryStage({
        handoffRequired: false,
        codePr: null,
        requiredChecks: null,
        mergedCommitSha: 'abcdef0123456789abcdef0123456789abcdef01',
        build: null,
        releaseContract: null,
        promotionPr: null,
        kargo: null,
        argo: null,
        postDeploy: null,
        rollbackPr: {
          number: 103,
          url: 'https://github.com/proompteng/lab/pull/103',
          branch: 'codex/symphony-rollback-1-1',
          state: 'open',
          title: 'rollback(symphony): revert failed promotion',
          createdAt: null,
          updatedAt: null,
          mergedAt: null,
          mergedCommitSha: null,
        },
        lastError: 'post-deploy verification failed',
      }),
    ).toBe('rollback_open')
  })

  test('builds an empty transaction shell', () => {
    expect(createEmptyDeliveryTransaction()).toMatchObject({
      stage: 'coding',
      codePr: null,
      promotionPr: null,
      rollbackPr: null,
    })
  })

  test('revalidates a paginated superseding Kargo promotion and verifier without searching for a promotion PR', async () => {
    const originalFetch = globalThis.fetch
    const originalGhToken = process.env.GH_TOKEN
    process.env.GH_TOKEN = 'test-token'

    const sourceSha = 'abcdef0123456789abcdef0123456789abcdef01'
    const supersedingSourceSha = '2222222222222222222222222222222222222222'
    const divergedSourceSha = '3333333333333333333333333333333333333333'
    const previousKargoRevision = '1111111111111111111111111111111111111111'
    const kargoRevision = 'fedcba9876543210fedcba9876543210fedcba98'
    const divergedKargoRevision = '4444444444444444444444444444444444444444'
    const config = makeTestConfig({
      release: {
        mode: 'kargo_auto',
        promotionAuthority: 'kargo',
        kargoProject: 'lab-delivery',
        kargoWarehouse: 'symphony',
        kargoBranch: 'kargo/symphony',
        kargoStages: ['symphony'],
      },
    })
    const requestedUrls: string[] = []

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input)
      requestedUrls.push(url)

      if (url.includes('/pulls?state=all&base=main')) {
        return new Response(
          JSON.stringify([
            {
              number: 201,
              html_url: 'https://github.com/proompteng/lab/pull/201',
              state: 'closed',
              title: 'feat(symphony): ABC-2 use Kargo delivery',
              body: 'ABC-2',
              draft: false,
              created_at: null,
              updated_at: null,
              merged_at: '2026-08-29T23:00:00.000Z',
              merge_commit_sha: sourceSha,
              head: { ref: 'codex/abc-2', sha: sourceSha },
              base: { ref: 'main' },
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url.includes(`/commits/${sourceSha}/check-runs`)) {
        return new Response(
          JSON.stringify({
            check_runs: [
              {
                name: 'symphony',
                html_url: 'https://github.com/proompteng/lab/actions/runs/701',
                status: 'completed',
                conclusion: 'success',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url.includes(`/commits/${sourceSha}/status`)) {
        return new Response(JSON.stringify({ state: 'success', statuses: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes(`/actions/runs?head_sha=${sourceSha}`)) {
        return new Response(
          JSON.stringify({
            workflow_runs: [
              {
                id: 701,
                html_url: 'https://github.com/proompteng/lab/actions/runs/701',
                name: 'symphony-build-push',
                status: 'completed',
                conclusion: 'success',
                event: 'push',
                head_sha: sourceSha,
                head_branch: 'main',
                created_at: '2026-08-29T23:01:00.000Z',
                updated_at: '2026-08-29T23:05:00.000Z',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url.includes('/commits?sha=kargo%2Fsymphony&per_page=100&page=1')) {
        return new Response(
          JSON.stringify(
            Array.from({ length: 100 }, (_, index) => ({
              sha: index.toString(16).padStart(40, '0'),
              html_url: `https://github.com/proompteng/lab/commit/${index.toString(16).padStart(40, '0')}`,
              commit: {
                message: `kargo(symphony): promote older-freight-${index}`,
                author: { date: '2026-08-29T22:00:00.000Z' },
                committer: { date: '2026-08-29T22:00:00.000Z' },
              },
            })),
          ),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url.includes('/commits?sha=kargo%2Fsymphony&per_page=100&page=2')) {
        return new Response(
          JSON.stringify([
            {
              sha: divergedKargoRevision,
              html_url: `https://github.com/proompteng/lab/commit/${divergedKargoRevision}`,
              commit: {
                message: `kargo(symphony): promote freight-diverged\n\nSource commit: ${divergedSourceSha}`,
                author: { date: '2026-08-29T23:07:00.000Z' },
                committer: { date: '2026-08-29T23:07:00.000Z' },
              },
            },
            {
              sha: kargoRevision,
              html_url: `https://github.com/proompteng/lab/commit/${kargoRevision}`,
              commit: {
                message: `kargo(symphony): promote freight-abc\n\nSource commit: ${supersedingSourceSha}`,
                author: { date: '2026-08-29T23:06:00.000Z' },
                committer: { date: '2026-08-29T23:06:00.000Z' },
              },
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url.includes(`/compare/${sourceSha}...${divergedSourceSha}`)) {
        return new Response(JSON.stringify({ status: 'diverged' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes(`/compare/${sourceSha}...${supersedingSourceSha}`)) {
        return new Response(JSON.stringify({ status: 'ahead' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes(`/actions/runs?head_sha=${kargoRevision}`)) {
        return new Response(
          JSON.stringify({
            workflow_runs: [
              {
                id: 702,
                html_url: 'https://github.com/proompteng/lab/actions/runs/702',
                name: 'symphony-post-deploy-verify',
                status: 'completed',
                conclusion: 'success',
                event: 'push',
                head_sha: kargoRevision,
                head_branch: 'kargo/symphony',
                created_at: '2026-08-29T23:07:00.000Z',
                updated_at: '2026-08-29T23:10:00.000Z',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    }) as typeof fetch

    const runtime = ManagedRuntime.make(
      makeDeliveryServiceLayer(createLogger({ test: 'kargo-delivery-refresh' })).pipe(
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

    try {
      const refreshed = await runtime.runPromise(
        Effect.gen(function* () {
          const delivery = yield* DeliveryService
          return yield* delivery.refreshIssueDelivery(
            {
              issueIdentifier: 'ABC-2',
              issueId: 'issue-2',
              status: 'tracked',
              workspacePath: null,
              attempts: { restartCount: 0, currentRetryAttempt: 0 },
              running: null,
              retry: null,
              logs: { codex_session_logs: [] },
              recentEvents: [],
              lastError: null,
              tracked: { lastKnownState: 'In Progress' },
              runHistory: [],
              delivery: {
                ...createEmptyDeliveryTransaction('argo_rollout_pending'),
                mergedCommitSha: sourceSha,
                kargo: {
                  project: 'lab-delivery',
                  warehouse: 'symphony',
                  stages: ['symphony'],
                  branch: 'kargo/symphony',
                  revision: previousKargoRevision,
                  sourceSha,
                  freight: 'freight-old',
                  url: `https://github.com/proompteng/lab/commit/${previousKargoRevision}`,
                  observedAt: '2026-08-29T22:00:00.000Z',
                },
              },
              updatedAt: '2026-08-29T23:00:00.000Z',
            },
            config,
          )
        }),
      )

      expect(refreshed).toMatchObject({
        stage: 'completed',
        mergedCommitSha: sourceSha,
        promotionPr: null,
        rollbackPr: null,
        releaseContract: {
          sourceSha: supersedingSourceSha,
          reason: 'kargo_freight',
        },
        kargo: {
          project: 'lab-delivery',
          warehouse: 'symphony',
          stages: ['symphony'],
          branch: 'kargo/symphony',
          revision: kargoRevision,
          sourceSha: supersedingSourceSha,
          freight: 'freight-abc',
        },
        postDeploy: {
          name: 'symphony-post-deploy-verify',
          state: 'success',
          headSha: kargoRevision,
        },
        lastError: null,
      })
      expect(requestedUrls.filter((url) => url.includes('/pulls?'))).toHaveLength(1)
      expect(requestedUrls.some((url) => url.includes('/commits?sha=kargo%2Fsymphony&per_page=100&page=1'))).toBe(true)
      expect(requestedUrls.some((url) => url.includes('/commits?sha=kargo%2Fsymphony&per_page=100&page=2'))).toBe(true)
      expect(requestedUrls.some((url) => url.includes(`/compare/${sourceSha}...${divergedSourceSha}`))).toBe(true)
      expect(requestedUrls.some((url) => url.includes(`/compare/${sourceSha}...${supersedingSourceSha}`))).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
      if (originalGhToken === undefined) {
        delete process.env.GH_TOKEN
      } else {
        process.env.GH_TOKEN = originalGhToken
      }
      await runtime.dispose()
    }
  })

  test('clears stale delivery errors after terminal success', async () => {
    const originalFetch = globalThis.fetch
    const originalGhToken = process.env.GH_TOKEN
    process.env.GH_TOKEN = 'test-token'

    const config = makeTestConfig()
    const issue = {
      issueIdentifier: 'ABC-1',
      issueId: 'issue-1',
      status: 'tracked' as const,
      workspacePath: null,
      attempts: { restartCount: 0, currentRetryAttempt: 0 },
      running: null,
      retry: null,
      logs: { codex_session_logs: [] },
      recentEvents: [],
      lastError: null,
      tracked: { lastKnownState: 'In Progress' },
      runHistory: [],
      delivery: {
        stage: 'promotion_merged' as const,
        updatedAt: '2026-03-16T03:00:00.000Z',
        codePr: {
          number: 101,
          url: 'https://github.com/proompteng/lab/pull/101',
          branch: 'codex/proompt-338',
          state: 'merged' as const,
          title: 'feat(symphony): harden delivery runtime',
          createdAt: null,
          updatedAt: null,
          mergedAt: '2026-03-16T02:55:00.000Z',
          mergedCommitSha: 'abcdef0123456789abcdef0123456789abcdef01',
        },
        requiredChecks: {
          state: 'success' as const,
          headSha: 'abcdef0123456789abcdef0123456789abcdef01',
          requiredCount: 2,
          passingCount: 2,
          failingCount: 0,
          pendingCount: 0,
          url: null,
        },
        mergedCommitSha: 'abcdef0123456789abcdef0123456789abcdef01',
        build: null,
        releaseContract: null,
        promotionPr: {
          number: 102,
          url: 'https://github.com/proompteng/lab/pull/102',
          branch: 'codex/symphony-release-abcdef01',
          state: 'merged' as const,
          title: 'chore(symphony): promote image abcdef01',
          createdAt: null,
          updatedAt: null,
          mergedAt: '2026-03-16T03:00:00.000Z',
          mergedCommitSha: 'fedcba9876543210fedcba9876543210fedcba98',
        },
        kargo: null,
        argo: null,
        postDeploy: null,
        rollbackPr: null,
        lastError: 'transient github refresh failed',
      },
      updatedAt: '2026-03-16T03:00:00.000Z',
    }

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.includes('/commits/abcdef0123456789abcdef0123456789abcdef01/check-runs')) {
        return new Response(JSON.stringify({ check_runs: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('/pulls/101')) {
        return new Response(
          JSON.stringify({
            number: 101,
            html_url: 'https://github.com/proompteng/lab/pull/101',
            state: 'closed',
            title: 'feat(symphony): harden delivery runtime',
            body: '',
            draft: false,
            created_at: null,
            updated_at: null,
            merged_at: '2026-03-16T02:55:00.000Z',
            merge_commit_sha: 'abcdef0123456789abcdef0123456789abcdef01',
            head: {
              ref: 'codex/proompt-338',
              sha: 'abcdef0123456789abcdef0123456789abcdef01',
            },
            base: { ref: 'main' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url.includes('/commits/abcdef0123456789abcdef0123456789abcdef01/status')) {
        return new Response(JSON.stringify({ state: 'success', statuses: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('/actions/runs?head_sha=abcdef0123456789abcdef0123456789abcdef01')) {
        return new Response(JSON.stringify({ workflow_runs: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('/actions/runs?head_sha=fedcba9876543210fedcba9876543210fedcba98')) {
        return new Response(
          JSON.stringify({
            workflow_runs: [
              {
                id: 601,
                html_url: 'https://github.com/proompteng/lab/actions/runs/601',
                name: 'symphony-post-deploy-verify',
                status: 'completed',
                conclusion: 'success',
                event: 'push',
                head_sha: 'fedcba9876543210fedcba9876543210fedcba98',
                head_branch: 'main',
                created_at: null,
                updated_at: null,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url.includes('/pulls/102')) {
        return new Response(
          JSON.stringify({
            number: 102,
            html_url: 'https://github.com/proompteng/lab/pull/102',
            state: 'closed',
            title: 'chore(symphony): promote image abcdef01',
            body: 'Source commit: `abcdef0123456789abcdef0123456789abcdef01`',
            draft: false,
            created_at: null,
            updated_at: null,
            merged_at: '2026-03-16T03:00:00.000Z',
            merge_commit_sha: 'fedcba9876543210fedcba9876543210fedcba98',
            head: {
              ref: 'codex/symphony-release-abcdef01',
              sha: 'fedcba9876543210fedcba9876543210fedcba98',
            },
            base: { ref: 'main' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url.includes('/pulls?state=all')) {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/pulls?state=open')) {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }) as typeof fetch

    const runtime = ManagedRuntime.make(
      makeDeliveryServiceLayer(createLogger({ test: 'delivery-refresh' })).pipe(
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

    try {
      const refreshed = await runtime.runPromise(
        Effect.gen(function* () {
          const delivery = yield* DeliveryService
          return yield* delivery.refreshIssueDelivery(issue, config)
        }),
      )

      expect(refreshed.stage).toBe('completed')
      expect(refreshed.lastError).toBeNull()
    } finally {
      globalThis.fetch = originalFetch
      if (originalGhToken === undefined) {
        delete process.env.GH_TOKEN
      } else {
        process.env.GH_TOKEN = originalGhToken
      }
      await runtime.dispose()
    }
  })
})

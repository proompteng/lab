import { describe, expect, test } from 'bun:test'

import { createEmptyDeliveryTransaction, deriveDeliveryStage } from './delivery-service'

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
})

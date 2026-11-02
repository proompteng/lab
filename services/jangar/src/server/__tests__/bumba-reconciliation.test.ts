import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildAtlasReconciliationWorkflowId } from '@proompteng/bumba/atlas/reconciliation'
import { __test__ } from '~/server/bumba'

describe('Bumba Atlas reconciliation', () => {
  const previousEnv: Partial<
    Record<'BUMBA_WORKER_REPO_ROOT' | 'JANGAR_BUMBA_TASK_QUEUE' | 'TEMPORAL_TASK_QUEUE', string | undefined>
  > = {}

  beforeEach(() => {
    previousEnv.BUMBA_WORKER_REPO_ROOT = process.env.BUMBA_WORKER_REPO_ROOT
    previousEnv.JANGAR_BUMBA_TASK_QUEUE = process.env.JANGAR_BUMBA_TASK_QUEUE
    previousEnv.TEMPORAL_TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE
  })

  afterEach(() => {
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = value
      }
    }
  })

  it('prefers the Bumba task queue override', () => {
    process.env.TEMPORAL_TASK_QUEUE = 'legacy-queue'
    process.env.JANGAR_BUMBA_TASK_QUEUE = 'bumba'
    expect(__test__.resolveTaskQueue()).toBe('bumba')
  })

  it('starts one full main reconciliation in the worker-local checkout', () => {
    delete process.env.BUMBA_WORKER_REPO_ROOT
    process.env.JANGAR_BUMBA_TASK_QUEUE = 'bumba'

    expect(
      __test__.resolveAtlasReconciliationStart({
        repository: 'proompteng/lab',
        ref: 'main',
        commit: 'dbbb0c561ace177647e8226e94ff454bfbdefa74',
      }),
    ).toEqual({
      repoRoot: '/workspace/lab',
      taskQueue: 'bumba',
      workflow: {
        workflowId: buildAtlasReconciliationWorkflowId('proompteng/lab'),
        workflowType: 'reconcileAtlasRepository',
        taskQueue: 'bumba',
        workflowIdReusePolicy: 1,
        versioningBehavior: 2,
        args: [
          {
            repoRoot: '/workspace/lab',
            repository: 'proompteng/lab',
            ref: 'main',
            commit: 'dbbb0c561ace177647e8226e94ff454bfbdefa74',
            eventDeliveryId: undefined,
          },
        ],
      },
    })
  })

  it('rejects non-main reconciliation', () => {
    expect(() => __test__.resolveAtlasReconciliationStart({ repository: 'proompteng/lab', ref: 'feature' })).toThrow(
      'Atlas reconciles only main',
    )
  })
})

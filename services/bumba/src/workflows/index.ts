import { defineWorkflow, log, WorkflowBlockedError } from '@proompteng/temporal-bun-sdk/workflow'
import { Effect } from 'effect'
import * as Cause from 'effect/Cause'
import * as Chunk from 'effect/Chunk'
import * as Schema from 'effect/Schema'

import type { ReconcileAtlasRepositoryInput, ReconcileAtlasRepositoryOutput } from '../activities/index'
import { LEGACY_RECONCILE_PENDING_ERROR } from '../atlas/ingestion-status'
import type { MainMergeMemoryNoteInput } from '../event-consumer'

const activityRetry = {
  initialIntervalMs: 2_000,
  backoffCoefficient: 2,
  maximumIntervalMs: 30_000,
  maximumAttempts: 4,
}

const upsertIngestionTimeouts = {
  startToCloseTimeoutMs: 30_000,
  scheduleToCloseTimeoutMs: 900_000,
}

const reconcilePendingPatchId = 'reconcileAtlasRepository.preserve-pending.v1'

const logWorkflow = (event: string, fields: Record<string, unknown> = {}) => {
  log.info('[bumba:workflow]', { event, ...fields })
}

const getCauseError = (cause: Cause.Cause<unknown>): Error | undefined => {
  const failure = Cause.failureOption(cause)
  if (failure._tag === 'Some' && failure.value instanceof Error) {
    return failure.value
  }
  const defects = Cause.defects(cause)
  if (Chunk.isNonEmpty(defects)) {
    const defect = Chunk.unsafeHead(defects)
    if (defect instanceof Error) return defect
  }
  return undefined
}

const isWorkflowBlocked = (cause: Cause.Cause<unknown>): boolean => getCauseError(cause) instanceof WorkflowBlockedError

const MainMergeMemoryNoteWorkflowInput = Schema.Struct({
  eventId: Schema.String,
  deliveryId: Schema.String,
  repoRoot: Schema.String,
  ref: Schema.String,
  commit: Schema.String,
})

const ReconcileAtlasRepositoryWorkflowInput = Schema.Struct({
  repoRoot: Schema.String,
  repository: Schema.String,
  ref: Schema.optional(Schema.String),
  commit: Schema.optional(Schema.String),
  eventDeliveryId: Schema.optional(Schema.String),
})

export const workflows = [
  defineWorkflow('publishMainMergeMemoryNote', MainMergeMemoryNoteWorkflowInput, ({ input, activities, info }) =>
    Effect.gen(function* () {
      logWorkflow('publishMainMergeMemoryNote.started', {
        workflowId: info.workflowId,
        runId: info.runId,
        eventId: input.eventId,
        deliveryId: input.deliveryId,
        commit: input.commit,
      })

      yield* activities.schedule('publishMainMergeMemoryNote', [input as MainMergeMemoryNoteInput], {
        startToCloseTimeoutMs: 600_000,
        scheduleToCloseTimeoutMs: 7 * 24 * 60 * 60 * 1_000,
        retry: {
          initialIntervalMs: 5_000,
          backoffCoefficient: 2,
          maximumIntervalMs: 600_000,
        },
      })

      logWorkflow('publishMainMergeMemoryNote.completed', {
        workflowId: info.workflowId,
        runId: info.runId,
        deliveryId: input.deliveryId,
      })
    }),
  ),
  defineWorkflow(
    'reconcileAtlasRepository',
    ReconcileAtlasRepositoryWorkflowInput,
    ({ input, activities, determinism, info }) =>
      Effect.gen(function* () {
        const eventDeliveryId = input.eventDeliveryId
        if (eventDeliveryId) {
          yield* activities.schedule(
            'upsertIngestion',
            [{ deliveryId: eventDeliveryId, workflowId: info.workflowId, status: 'running' }],
            { ...upsertIngestionTimeouts, retry: activityRetry },
          )
        }

        const preservePendingReconciliation = determinism.patched(reconcilePendingPatchId)

        const reconcile = activities.schedule('reconcileAtlasRepository', [input as ReconcileAtlasRepositoryInput], {
          startToCloseTimeoutMs: 24 * 60 * 60 * 1_000,
          scheduleToCloseTimeoutMs: 3 * 24 * 60 * 60 * 1_000,
          heartbeatTimeoutMs: 90_000,
          retry: {
            initialIntervalMs: 30_000,
            backoffCoefficient: 2,
            maximumIntervalMs: 15 * 60 * 1_000,
          },
        }) as Effect.Effect<ReconcileAtlasRepositoryOutput, unknown, never>

        const result = yield* Effect.catchAllCause(reconcile, (cause) =>
          Effect.gen(function* () {
            const workflowBlocked = isWorkflowBlocked(cause)
            if (preservePendingReconciliation && workflowBlocked) {
              return yield* Effect.failCause(cause)
            }
            if (eventDeliveryId) {
              if (!preservePendingReconciliation) {
                yield* activities.schedule(
                  'upsertIngestion',
                  [
                    {
                      deliveryId: eventDeliveryId,
                      workflowId: info.workflowId,
                      status: 'failed',
                      error: LEGACY_RECONCILE_PENDING_ERROR,
                    },
                  ],
                  { ...upsertIngestionTimeouts, retry: activityRetry },
                )
              }
              if (workflowBlocked) {
                return yield* Effect.failCause(cause)
              }
              yield* activities.schedule(
                'upsertIngestion',
                [
                  {
                    deliveryId: eventDeliveryId,
                    workflowId: info.workflowId,
                    status: 'failed',
                    error: getCauseError(cause)?.message,
                    ...(preservePendingReconciliation ? {} : { correctLegacyPendingFailure: true }),
                  },
                ],
                { ...upsertIngestionTimeouts, retry: activityRetry },
              )
            }
            return yield* Effect.failCause(cause)
          }),
        )

        if (eventDeliveryId) {
          if (!preservePendingReconciliation) {
            // Pre-patch histories recorded this command while activity-1 was pending. Consume that command and its
            // existing result before emitting the corrective completed upsert so those histories remain replayable.
            yield* activities.schedule(
              'upsertIngestion',
              [
                {
                  deliveryId: eventDeliveryId,
                  workflowId: info.workflowId,
                  status: 'failed',
                  error: LEGACY_RECONCILE_PENDING_ERROR,
                },
              ],
              { ...upsertIngestionTimeouts, retry: activityRetry },
            )
          }
          yield* activities.schedule(
            'upsertIngestion',
            [
              {
                deliveryId: eventDeliveryId,
                workflowId: info.workflowId,
                status: 'completed',
                ...(preservePendingReconciliation ? {} : { correctLegacyPendingFailure: true }),
              },
            ],
            { ...upsertIngestionTimeouts, retry: activityRetry },
          )
        }
        return result
      }),
  ),
]

export default workflows

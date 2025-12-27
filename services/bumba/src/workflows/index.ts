import { defineWorkflow, defineWorkflowSignals, log } from '@proompteng/temporal-bun-sdk/workflow'
import { Effect } from 'effect'
import * as Schema from 'effect/Schema'

import type {
  AstSummaryOutput,
  EnrichOutput,
  ListRepoFilesOutput,
  PersistEnrichmentRecordOutput,
  PersistFileVersionOutput,
  ReadRepoFileOutput,
} from '../activities/index'

const activityRetry = {
  initialIntervalMs: 2_000,
  backoffCoefficient: 2,
  maximumIntervalMs: 30_000,
  maximumAttempts: 4,
}

const readRepoFileTimeouts = {
  startToCloseTimeoutMs: 90_000,
  scheduleToCloseTimeoutMs: 600_000,
}

const listRepoFilesTimeouts = {
  startToCloseTimeoutMs: 90_000,
  scheduleToCloseTimeoutMs: 600_000,
}

const extractAstSummaryTimeouts = {
  startToCloseTimeoutMs: 120_000,
  scheduleToCloseTimeoutMs: 600_000,
}

const enrichWithModelTimeouts = {
  startToCloseTimeoutMs: 360_000,
  scheduleToCloseTimeoutMs: 1_800_000,
}

const createEmbeddingTimeouts = {
  startToCloseTimeoutMs: 180_000,
  scheduleToCloseTimeoutMs: 900_000,
}

const persistFileVersionTimeouts = {
  startToCloseTimeoutMs: 60_000,
  scheduleToCloseTimeoutMs: 300_000,
}

const persistEnrichmentRecordTimeouts = {
  startToCloseTimeoutMs: 60_000,
  scheduleToCloseTimeoutMs: 300_000,
}

const persistEmbeddingTimeouts = {
  startToCloseTimeoutMs: 60_000,
  scheduleToCloseTimeoutMs: 300_000,
}

const persistFactsTimeouts = {
  startToCloseTimeoutMs: 120_000,
  scheduleToCloseTimeoutMs: 600_000,
}

const markEventProcessedTimeouts = {
  startToCloseTimeoutMs: 30_000,
  scheduleToCloseTimeoutMs: 120_000,
}

const cleanupEnrichmentTimeouts = {
  startToCloseTimeoutMs: 120_000,
  scheduleToCloseTimeoutMs: 600_000,
}

const PARENT_CLOSE_POLICY_ABANDON = 2
const CHILD_WORKFLOW_BATCH_SIZE = 50
const CHILD_WORKFLOW_PROGRESS_INTERVAL = 25
const CHILD_WORKFLOW_COMPLETED_SIGNAL = '__childWorkflowCompleted'

const logWorkflow = (event: string, fields: Record<string, unknown> = {}) => {
  log.info('[bumba:workflow]', { event, ...fields })
}

type ChildWorkflowCompletion = {
  workflowId: string
  runId?: string
  status: 'completed' | 'failed' | 'canceled' | 'terminated' | 'timed_out'
}

const isChildWorkflowCompletion = (payload: unknown): payload is ChildWorkflowCompletion => {
  if (!payload || typeof payload !== 'object') return false
  const record = payload as Record<string, unknown>
  const status = record.status
  if (
    status !== 'completed' &&
    status !== 'failed' &&
    status !== 'canceled' &&
    status !== 'terminated' &&
    status !== 'timed_out'
  ) {
    return false
  }
  if (typeof record.workflowId !== 'string') return false
  if (record.runId !== undefined && typeof record.runId !== 'string') return false
  return true
}

const EnrichFileInput = Schema.Struct({
  repoRoot: Schema.String,
  filePath: Schema.String,
  repository: Schema.optional(Schema.String),
  ref: Schema.optional(Schema.String),
  commit: Schema.optional(Schema.String),
  context: Schema.optional(Schema.String),
  eventDeliveryId: Schema.optional(Schema.String),
  force: Schema.optional(Schema.Boolean),
  parentWorkflowId: Schema.optional(Schema.String),
  parentRunId: Schema.optional(Schema.String),
})

const EnrichRepositoryInput = Schema.Struct({
  repoRoot: Schema.String,
  repository: Schema.optional(Schema.String),
  ref: Schema.optional(Schema.String),
  commit: Schema.optional(Schema.String),
  context: Schema.optional(Schema.String),
  pathPrefix: Schema.optional(Schema.String),
  maxFiles: Schema.optional(Schema.Number),
  files: Schema.optional(Schema.Array(Schema.String)),
  queuedCount: Schema.optional(Schema.Number),
  stats: Schema.optional(
    Schema.Struct({
      total: Schema.Number,
      skipped: Schema.Number,
    }),
  ),
})

const ChildWorkflowCompletionSignal = Schema.Struct({
  workflowId: Schema.String,
  runId: Schema.optional(Schema.String),
  status: Schema.Union(
    Schema.Literal('completed'),
    Schema.Literal('failed'),
    Schema.Literal('canceled'),
    Schema.Literal('terminated'),
    Schema.Literal('timed_out'),
  ),
}) as Schema.Schema<unknown>

const enrichRepositorySignals = defineWorkflowSignals({
  [CHILD_WORKFLOW_COMPLETED_SIGNAL]: ChildWorkflowCompletionSignal,
})

export const workflows = [
  defineWorkflow('enrichFile', EnrichFileInput, ({ input, activities, info }) => {
    const { repoRoot, filePath, repository, ref, commit, context, eventDeliveryId, force } = input

    return Effect.gen(function* () {
      logWorkflow('enrichFile.started', {
        workflowId: info.workflowId,
        runId: info.runId,
        repoRoot,
        filePath,
        repository: repository ?? null,
        ref: ref ?? null,
        commit: commit ?? null,
        context: context ?? null,
        eventDeliveryId: eventDeliveryId ?? null,
        force: force ?? false,
        parentWorkflowId: input.parentWorkflowId ?? null,
        parentRunId: input.parentRunId ?? null,
      })

      const readRepoInput: { repoRoot: string; filePath: string; repository?: string; ref?: string; commit?: string } =
        {
          repoRoot,
          filePath,
        }
      if (repository) readRepoInput.repository = repository
      if (ref) readRepoInput.ref = ref
      if (commit) readRepoInput.commit = commit

      const fileResult = (yield* activities.schedule('readRepoFile', [readRepoInput], {
        ...readRepoFileTimeouts,
        retry: activityRetry,
      })) as ReadRepoFileOutput
      const readSourceMeta = fileResult.metadata.metadata ?? {}
      const readSource = typeof readSourceMeta.source === 'string' ? readSourceMeta.source : null

      logWorkflow('enrichFile.readRepoFile', {
        workflowId: info.workflowId,
        runId: info.runId,
        filePath,
        repoRef: fileResult.metadata.repoRef,
        repoCommit: fileResult.metadata.repoCommit,
        readSource,
        readSourceMeta,
        contentHash: fileResult.metadata.contentHash,
      })

      if (force) {
        logWorkflow('enrichFile.cleanupRequested', {
          workflowId: info.workflowId,
          runId: info.runId,
          filePath,
        })
        yield* activities.schedule(
          'cleanupEnrichment',
          [
            {
              fileMetadata: fileResult.metadata,
            },
          ],
          {
            ...cleanupEnrichmentTimeouts,
            retry: activityRetry,
          },
        )
      }

      const astResult = (yield* activities.schedule(
        'extractAstSummary',
        [{ repoRoot, filePath, content: fileResult.content }],
        {
          ...extractAstSummaryTimeouts,
          retry: activityRetry,
        },
      )) as AstSummaryOutput

      const enriched = (yield* activities.schedule(
        'enrichWithModel',
        [
          {
            filename: filePath,
            content: fileResult.content,
            astSummary: astResult.astSummary,
            context: context ?? '',
          },
        ],
        {
          ...enrichWithModelTimeouts,
          retry: activityRetry,
        },
      )) as EnrichOutput

      const embedding = (yield* activities.schedule('createEmbedding', [{ text: enriched.enriched }], {
        ...createEmbeddingTimeouts,
        retry: activityRetry,
      })) as { embedding: number[] }

      const fileVersion = (yield* activities.schedule(
        'persistFileVersion',
        [
          {
            fileMetadata: fileResult.metadata,
          },
        ],
        {
          ...persistFileVersionTimeouts,
          retry: activityRetry,
        },
      )) as PersistFileVersionOutput

      const enrichmentRecord = (yield* activities.schedule(
        'persistEnrichmentRecord',
        [
          {
            fileVersionId: fileVersion.fileVersionId,
            summary: enriched.summary,
            enriched: enriched.enriched,
            astSummary: astResult.astSummary,
            contentHash: fileResult.metadata.contentHash,
            metadata: {
              ...astResult.metadata,
              ...enriched.metadata,
            },
          },
        ],
        {
          ...persistEnrichmentRecordTimeouts,
          retry: activityRetry,
        },
      )) as PersistEnrichmentRecordOutput

      const persistEmbedding = activities.schedule(
        'persistEmbedding',
        [
          {
            enrichmentId: enrichmentRecord.enrichmentId,
            embedding: embedding.embedding,
          },
        ],
        {
          ...persistEmbeddingTimeouts,
          retry: activityRetry,
        },
      )

      const persistFacts =
        astResult.facts.length > 0
          ? activities.schedule(
              'persistFacts',
              [
                {
                  fileVersionId: fileVersion.fileVersionId,
                  facts: astResult.facts,
                },
              ],
              {
                ...persistFactsTimeouts,
                retry: activityRetry,
              },
            )
          : Effect.succeed({ inserted: 0 })

      yield* Effect.all([persistEmbedding, persistFacts], { concurrency: 2 })

      if (eventDeliveryId) {
        yield* activities.schedule(
          'markEventProcessed',
          [
            {
              deliveryId: eventDeliveryId,
            },
          ],
          {
            ...markEventProcessedTimeouts,
            retry: activityRetry,
          },
        )
      }

      logWorkflow('enrichFile.completed', {
        workflowId: info.workflowId,
        runId: info.runId,
        filePath,
        enrichmentId: enrichmentRecord.enrichmentId,
        fileVersionId: fileVersion.fileVersionId,
        facts: astResult.facts.length,
        summaryChars: enriched.summary.length,
        enrichedChars: enriched.enriched.length,
        readSource,
        eventDeliveryId: eventDeliveryId ?? null,
      })

      return {
        id: enrichmentRecord.enrichmentId,
        filename: filePath,
      }
    })
  }),
  defineWorkflow({
    name: 'enrichRepository',
    schema: EnrichRepositoryInput,
    signals: enrichRepositorySignals,
    handler: ({ input, activities, childWorkflows, signals, info }) =>
      Effect.gen(function* () {
        const { repoRoot, repository, ref, commit, context, pathPrefix, maxFiles } = input

        logWorkflow('enrichRepository.started', {
          workflowId: info.workflowId,
          runId: info.runId,
          repoRoot,
          repository: repository ?? null,
          ref: ref ?? null,
          commit: commit ?? null,
          context: context ?? null,
          pathPrefix: pathPrefix ?? null,
          maxFiles: maxFiles ?? null,
          providedFiles: input.files ? input.files.length : null,
        })

        const listRef = commit ?? ref
        let files = input.files
        let stats = input.stats

        if (!files) {
          const listResult = (yield* activities.schedule(
            'listRepoFiles',
            [{ repoRoot, ref: listRef, pathPrefix, maxFiles }],
            {
              ...listRepoFilesTimeouts,
              retry: activityRetry,
            },
          )) as ListRepoFilesOutput
          files = listResult.files
          stats = { total: listResult.total, skipped: listResult.skipped }
        }

        const total = stats?.total ?? files.length
        const skipped = stats?.skipped ?? 0

        logWorkflow('enrichRepository.filesReady', {
          workflowId: info.workflowId,
          runId: info.runId,
          fileCount: files.length,
          total,
          skipped,
        })

        let started = 0
        let completed = 0
        let failed = 0
        let childSequence = 0
        const completionSignal = enrichRepositorySignals[CHILD_WORKFLOW_COMPLETED_SIGNAL]

        // Maintain a sliding window of in-flight child workflows.
        const pending = new Set<string>()
        let nextIndex = 0

        while (nextIndex < files.length || pending.size > 0) {
          while (pending.size < CHILD_WORKFLOW_BATCH_SIZE && nextIndex < files.length) {
            const filePath = files[nextIndex]
            const childWorkflowId = `${info.workflowId}-child-${info.runId}-${childSequence}`
            childSequence += 1
            nextIndex += 1
            pending.add(childWorkflowId)
            started += 1

            yield* childWorkflows.start(
              'enrichFile',
              [
                {
                  repoRoot,
                  filePath,
                  repository,
                  ref,
                  commit,
                  context,
                },
              ],
              {
                parentClosePolicy: PARENT_CLOSE_POLICY_ABANDON,
                workflowId: childWorkflowId,
              },
            )
          }

          if (started > 0 && (started % CHILD_WORKFLOW_BATCH_SIZE === 0 || started === files.length)) {
            logWorkflow('enrichRepository.childrenStarted', {
              workflowId: info.workflowId,
              runId: info.runId,
              started,
              pending: pending.size,
              completed,
              failed,
              totalFiles: files.length,
            })
          }

          if (pending.size === 0) {
            break
          }

          const delivery = yield* signals.waitFor(completionSignal)
          if (!isChildWorkflowCompletion(delivery.payload)) {
            continue
          }
          if (!pending.delete(delivery.payload.workflowId)) {
            continue
          }
          if (delivery.payload.status === 'completed') {
            completed += 1
          } else {
            failed += 1
          }

          const finished = completed + failed
          if (finished % CHILD_WORKFLOW_PROGRESS_INTERVAL === 0 || finished === files.length) {
            logWorkflow('enrichRepository.progress', {
              workflowId: info.workflowId,
              runId: info.runId,
              started,
              completed,
              failed,
              pending: pending.size,
              totalFiles: files.length,
              nextIndex,
            })
          }
        }

        logWorkflow('enrichRepository.completed', {
          workflowId: info.workflowId,
          runId: info.runId,
          total,
          skipped,
          queued: started,
          completed,
          failed,
        })

        return {
          total,
          skipped,
          queued: started,
          completed,
          failed,
        }
      }),
  }),
]

export default workflows

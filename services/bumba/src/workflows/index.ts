import { defineWorkflow, defineWorkflowSignals } from '@proompteng/temporal-bun-sdk/workflow'
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
const CHILD_WORKFLOW_COMPLETED_SIGNAL = '__childWorkflowCompleted'

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
  defineWorkflow('enrichFile', EnrichFileInput, ({ input, activities }) => {
    const { repoRoot, filePath, repository, ref, commit, context, eventDeliveryId, force } = input

    return Effect.gen(function* () {
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

      if (force) {
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
        let started = 0
        let completed = 0
        let failed = 0
        let childSequence = 0
        const completionSignal = enrichRepositorySignals[CHILD_WORKFLOW_COMPLETED_SIGNAL]

        for (let offset = 0; offset < files.length; offset += CHILD_WORKFLOW_BATCH_SIZE) {
          const batch = files.slice(offset, offset + CHILD_WORKFLOW_BATCH_SIZE)
          const pending = new Set<string>()
          const batchEntries: Array<{ filePath: string; childWorkflowId: string }> = []

          for (const filePath of batch) {
            const childWorkflowId = `${info.workflowId}-child-${info.runId}-${childSequence}`
            childSequence += 1
            pending.add(childWorkflowId)
            batchEntries.push({ filePath, childWorkflowId })
          }

          if (batchEntries.length === 0) {
            continue
          }

          started += batchEntries.length

          for (const { filePath, childWorkflowId } of batchEntries) {
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

          while (pending.size > 0) {
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
          }
        }

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

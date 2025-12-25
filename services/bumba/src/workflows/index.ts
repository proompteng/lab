import { defineWorkflow } from '@proompteng/temporal-bun-sdk/workflow'
import { Effect } from 'effect'
import * as Schema from 'effect/Schema'

import type {
  AstSummaryOutput,
  EnrichOutput,
  ListRepoFilesOutput,
  PersistInput,
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

const persistEnrichmentTimeouts = {
  startToCloseTimeoutMs: 180_000,
  scheduleToCloseTimeoutMs: 1_200_000,
}

const PARENT_CLOSE_POLICY_ABANDON = 2
const MAX_CHILD_WORKFLOWS_PER_RUN = 500

const EnrichFileInput = Schema.Struct({
  repoRoot: Schema.String,
  filePath: Schema.String,
  repository: Schema.optional(Schema.String),
  ref: Schema.optional(Schema.String),
  commit: Schema.optional(Schema.String),
  context: Schema.optional(Schema.String),
  eventDeliveryId: Schema.optional(Schema.String),
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

export const workflows = [
  defineWorkflow('enrichFile', EnrichFileInput, ({ input, activities }) =>
    Effect.gen(function* () {
      const { repoRoot, filePath, repository, ref, commit, context, eventDeliveryId } = input

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

      const persistInput: PersistInput = {
        filename: filePath,
        summary: enriched.summary,
        content: fileResult.content,
        astSummary: astResult.astSummary,
        enriched: enriched.enriched,
        embedding: embedding.embedding,
        metadata: {
          ...astResult.metadata,
          ...enriched.metadata,
        },
        fileMetadata: fileResult.metadata,
        facts: astResult.facts,
        eventDeliveryId: eventDeliveryId ?? undefined,
      }

      const persist = (yield* activities.schedule('persistEnrichment', [persistInput], {
        ...persistEnrichmentTimeouts,
        retry: activityRetry,
      })) as { id: string }

      return {
        id: persist.id,
        filename: filePath,
      }
    }),
  ),
  defineWorkflow('enrichRepository', EnrichRepositoryInput, ({ input, activities, childWorkflows, continueAsNew }) =>
    Effect.gen(function* () {
      const { repoRoot, repository, ref, commit, context, pathPrefix, maxFiles, queuedCount } = input

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

      const queuedSoFar = queuedCount ?? 0
      const batch = files.slice(0, MAX_CHILD_WORKFLOWS_PER_RUN)
      const remaining = files.slice(MAX_CHILD_WORKFLOWS_PER_RUN)

      yield* Effect.forEach(
        batch,
        (filePath) =>
          childWorkflows.start(
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
            },
          ),
        { concurrency: 10 },
      )

      const queuedTotal = queuedSoFar + batch.length

      if (remaining.length > 0) {
        return yield* continueAsNew({
          workflowType: 'enrichRepository',
          input: [
            {
              repoRoot,
              repository,
              ref,
              commit,
              context,
              pathPrefix,
              maxFiles,
              files: remaining,
              queuedCount: queuedTotal,
              stats,
            },
          ],
        })
      }

      return {
        total: stats?.total ?? files.length,
        skipped: stats?.skipped ?? 0,
        queued: queuedTotal,
      }
    }),
  ),
]

export default workflows

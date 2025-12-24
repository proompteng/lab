import { defineWorkflow } from '@proompteng/temporal-bun-sdk/workflow'
import { Effect } from 'effect'
import * as Schema from 'effect/Schema'

import type { AstSummaryOutput, EnrichOutput, PersistInput, ReadRepoFileOutput } from '../activities/index'

const EnrichFileInput = Schema.Struct({
  repoRoot: Schema.String,
  filePath: Schema.String,
  repository: Schema.optional(Schema.String),
  commit: Schema.optional(Schema.String),
  context: Schema.optional(Schema.String),
  eventDeliveryId: Schema.optional(Schema.String),
})

export const workflows = [
  defineWorkflow('enrichFile', EnrichFileInput, ({ input, activities }) =>
    Effect.gen(function* () {
      const { repoRoot, filePath, repository, commit, context, eventDeliveryId } = input

      const readRepoInput: { repoRoot: string; filePath: string; repository?: string; commit?: string } = {
        repoRoot,
        filePath,
      }
      if (repository) readRepoInput.repository = repository
      if (commit) readRepoInput.commit = commit

      const fileResult = (yield* activities.schedule('readRepoFile', [readRepoInput], {
        startToCloseTimeoutMs: 30_000,
      })) as ReadRepoFileOutput

      const astResult = (yield* activities.schedule(
        'extractAstSummary',
        [{ repoRoot, filePath, content: fileResult.content }],
        {
          startToCloseTimeoutMs: 60_000,
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
        { startToCloseTimeoutMs: 180_000 },
      )) as EnrichOutput

      const embedding = (yield* activities.schedule('createEmbedding', [{ text: enriched.enriched }], {
        startToCloseTimeoutMs: 90_000,
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
        startToCloseTimeoutMs: 30_000,
      })) as { id: string }

      return {
        id: persist.id,
        filename: filePath,
      }
    }),
  ),
]

export default workflows

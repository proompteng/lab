import { defineWorkflow } from '@proompteng/temporal-bun-sdk/workflow'
import { Effect } from 'effect'
import * as Schema from 'effect/Schema'

import activities from '../activities/index'

const EnrichFileInput = Schema.Struct({
  repoRoot: Schema.String,
  filePath: Schema.String,
  context: Schema.optional(Schema.String),
})

export const workflows = [
  defineWorkflow('bumbaEnrichFile', EnrichFileInput, ({ input }) =>
    Effect.gen(function* () {
      const { repoRoot, filePath, context } = input

      const fileResult = yield* Effect.promise(() => activities.readRepoFile({ repoRoot, filePath }))
      const astResult = yield* Effect.promise(() => activities.extractAstSummary({ repoRoot, filePath }))

      const enriched = yield* Effect.promise(() =>
        activities.enrichWithModel({
          filename: filePath,
          content: fileResult.content,
          astSummary: astResult.astSummary,
          context: context ?? '',
        }),
      )

      const embedding = yield* Effect.promise(() => activities.createEmbedding({ text: enriched.enriched }))

      const persist = yield* Effect.promise(() =>
        activities.persistEnrichment({
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
        }),
      )

      return {
        id: persist.id,
        filename: filePath,
      }
    }),
  ),
]

export default workflows

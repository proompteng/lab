import { type Kysely, sql } from 'kysely'

import type { AgentsDatabase } from '../db'
import { resolveEmbeddingConfig } from '../memory-config'
import { getMemoryProviderSchemaStatements } from '../memory-provider-schema'

const resolveEmbeddingDimension = () => resolveEmbeddingConfig(process.env).dimension

export const up = async (db: Kysely<AgentsDatabase>) => {
  const embeddingDimension = resolveEmbeddingDimension()

  for (const statement of getMemoryProviderSchemaStatements(embeddingDimension, 'public')) {
    await sql.raw(statement).execute(db)
  }
}

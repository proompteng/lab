import type { z } from 'zod'
import type { promptCatalogSchema, promptDefinitionSchema } from './schema'

export type PromptDefinition = z.infer<typeof promptDefinitionSchema>
export type PromptCatalog = z.infer<typeof promptCatalogSchema>
export type PromptCatalogEntry = PromptCatalog['streams'][number]
export type PromptMetadata = PromptDefinition['metadata']

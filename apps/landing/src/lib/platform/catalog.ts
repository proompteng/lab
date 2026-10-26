import { z } from 'zod'

export const connectorCatalogSchema = z.object({
  operations: z.array(
    z.object({
      connectorId: z.string(),
      name: z.string(),
      action: z.string(),
      description: z.string(),
      readOnly: z.boolean(),
      targets: z.array(z.object({ name: z.string(), resource: z.object({ kind: z.string(), id: z.string() }) })),
    }),
  ),
})
export type ConnectorCatalog = z.infer<typeof connectorCatalogSchema>

export const policyCatalogSchema = z.object({
  version: z.number().int().positive(),
  resources: z.array(
    z.object({
      kind: z.string(),
      relations: z.array(z.object({ name: z.string(), subjects: z.array(z.enum(['human', 'workload'])) })),
    }),
  ),
})

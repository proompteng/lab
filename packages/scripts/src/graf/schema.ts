import { z } from 'zod'

const promptInputSchema = z.object({
  name: z.string(),
  type: z.string(),
  description: z.string(),
  required: z.boolean().optional(),
  example: z.string().optional(),
})

const envelopeFieldSchema = z.object({
  name: z.string(),
  type: z.string(),
  description: z.string(),
  required: z.boolean().optional(),
})

const expectedJsonEnvelopeSchema = z.object({
  summary: z.string(),
  fields: z.array(envelopeFieldSchema).min(1),
})

const citationPolicySchema = z.object({
  summary: z.string(),
  references: z.array(z.string()).min(1),
  enforcement: z.string().optional(),
})

export const promptDefinitionSchema = z.object({
  promptId: z.string(),
  title: z.string(),
  streamId: z.string(),
  objective: z.string(),
  description: z.string().optional(),
  promptTemplate: z.string(),
  metadata: z.record(z.string()).optional(),
  inputs: z.array(promptInputSchema).min(1),
  expectedJsonEnvelope: expectedJsonEnvelopeSchema,
  scoringHeuristics: z.array(z.string()).min(1),
  citationPolicy: citationPolicySchema,
})

const catalogEntrySchema = z.object({
  promptId: z.string(),
  streamId: z.string(),
  file: z.string(),
  priority: z.string().optional(),
  cadence: z.string().optional(),
  metadata: z.record(z.string()).optional(),
})

export const promptCatalogSchema = z.object({
  catalogId: z.string(),
  name: z.string(),
  description: z.string(),
  version: z.string(),
  schema: z.string(),
  updatedAt: z.string(),
  documentation: z.string().optional(),
  streams: z.array(catalogEntrySchema).min(1),
})

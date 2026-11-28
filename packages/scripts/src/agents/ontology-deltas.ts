import { z } from 'zod'

import { containsCredentials, findOntologyDisclosure } from './ontology-disclosure'
import { compare, serializeSortedJson } from './ontology-json'

const safeText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((text) => !containsCredentials(text), 'Possible credential; remove it before submitting')

const evidence = {
  sourceCommit: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/i, 'Expected a 7–40 digit hexadecimal Git SHA')
    .transform((sha) => sha.toLowerCase()),
  verificationNote: safeText(2_000),
}
const provenance = z.strictObject(evidence).optional()
const entry = z.strictObject({ description: safeText(4_000), name: safeText(120) })
const analysis = entry.extend({ sql: safeText(16_000) })

const bundleSchema = z.strictObject({
  acronyms: z.array(entry.extend({ provenance })),
  customAnalyses: z.array(analysis.extend({ provenance })),
  dataSource: z.literal('agents-db-next'),
  database: safeText(120).optional(),
  ruleTag: safeText(25).optional(),
  rules: z.array(entry.extend({ provenance })),
  version: z.literal(1),
})

export const knowledgeDeltaSchema = z
  .strictObject({
    acronyms: z.array(entry).min(1).optional(),
    customAnalyses: z.array(analysis).min(1).optional(),
    kind: z.literal('knowledge-delta'),
    rules: z.array(entry).min(1).optional(),
    ...evidence,
    version: z.literal(1),
  })
  .refine((delta) => delta.acronyms || delta.customAnalyses || delta.rules, 'Expected at least one knowledge entry')

export type KnowledgeDelta = z.infer<typeof knowledgeDeltaSchema>
export type KnowledgeBundle = z.infer<typeof bundleSchema>

const validate = <T>(schema: z.ZodType<T>, value: unknown, label: string): T => {
  const disclosure = findOntologyDisclosure(value)
  if (disclosure) throw new Error(label + ': ' + disclosure)
  const result = schema.safeParse(value)
  if (result.success) return result.data

  // Strict-object errors can include untrusted property names; never echo them.
  const details = result.error.issues.map((issue) => {
    const field = issue.path.join('.') || 'root'
    return `${field}: ${issue.code === 'unrecognized_keys' ? 'Unknown field(s)' : issue.message}`
  })
  throw new Error(`${label}: ${details.join('; ')}`)
}

export const validateKnowledgeDelta = (value: unknown, label = 'Knowledge delta'): KnowledgeDelta =>
  validate(knowledgeDeltaSchema, value, label)

export const serializeBundle = (bundle: KnowledgeBundle): string => serializeSortedJson(bundle)

type NamedEntry = z.infer<typeof entry> & { provenance?: z.infer<typeof provenance>; sql?: string }

const mergeEntries = <T extends NamedEntry>(existing: T[], proposed: T[], section: string) => {
  const byName = new Map<string, T>()
  for (const item of existing) {
    const key = item.name.toLowerCase()
    if (byName.has(key)) throw new Error(`Duplicate name in bundle ${section}: ${JSON.stringify(item.name)}`)
    byName.set(key, item)
  }

  for (const item of proposed) {
    const key = item.name.toLowerCase()
    const prior = byName.get(key)
    if (!prior) byName.set(key, item)
    else if (prior.name !== item.name || prior.description !== item.description || prior.sql !== item.sql) {
      throw new Error(`Conflicting duplicate name in ${section}: ${JSON.stringify(item.name)}`)
    }
  }
  return [...byName.entries()].sort(([a], [b]) => compare(a, b)).map(([, item]) => item)
}

export const mergeKnowledgeDeltas = (
  target: unknown,
  inputs: readonly { label: string; value: unknown }[],
): KnowledgeBundle => {
  const bundle = validate(bundleSchema, target, 'Knowledge bundle')
  // Keep reviewed provenance on replay and choose stable evidence for identical new entries.
  const deltas = inputs
    .map(({ label, value }) => validateKnowledgeDelta(value, label))
    .sort((a, b) => compare(a.sourceCommit, b.sourceCommit) || compare(a.verificationNote, b.verificationNote))

  const entries = <T extends NamedEntry>(pick: (delta: KnowledgeDelta) => T[] | undefined) =>
    deltas.flatMap((delta) =>
      (pick(delta) ?? []).map((item) => ({
        ...item,
        provenance: { sourceCommit: delta.sourceCommit, verificationNote: delta.verificationNote },
      })),
    )

  return {
    ...bundle,
    acronyms: mergeEntries(
      bundle.acronyms,
      entries((delta) => delta.acronyms),
      'acronyms',
    ),
    customAnalyses: mergeEntries(
      bundle.customAnalyses,
      entries((delta) => delta.customAnalyses),
      'custom analyses',
    ),
    rules: mergeEntries(
      bundle.rules,
      entries((delta) => delta.rules),
      'rules',
    ),
  }
}

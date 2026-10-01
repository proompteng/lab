import { z } from 'zod'

export const DEFAULT_CODEX_MODEL = 'gpt-6.1-sol'

export const codexModelIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9._:/-]+$/)
export const codexReasoningEffortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])

export type TengriCodexReasoningEffort = z.infer<typeof codexReasoningEffortSchema>
export type TengriCodexOptions = { model?: string; reasoningEffort?: TengriCodexReasoningEffort }

export const codexReasoningLabels = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
} satisfies Record<TengriCodexReasoningEffort, string>

const codexModelSchema = z
  .object({
    model: codexModelIdSchema,
    displayName: z.string().min(1).max(256),
    description: z.string().max(4096),
    defaultReasoningEffort: codexReasoningEffortSchema,
    supportedReasoningEfforts: z
      .array(z.object({ reasoningEffort: codexReasoningEffortSchema, description: z.string().max(4096) }))
      .min(1)
      .max(8),
  })
  .refine(
    (model) =>
      model.supportedReasoningEfforts.some((effort) => effort.reasoningEffort === model.defaultReasoningEffort),
    'The default reasoning effort is not supported by this model',
  )

const codexModelPageSchema = z.object({
  data: z.array(codexModelSchema).max(100),
  nextCursor: z.string().min(1).max(4096).nullable(),
})

export type TengriCodexModel = z.infer<typeof codexModelSchema>
export type TengriCodexModelPage = { models: TengriCodexModel[]; nextCursor: string | null }

export const codexSelectionSchema = z.strictObject({
  model: codexModelIdSchema,
  reasoningEffort: z.union([z.literal('default'), codexReasoningEffortSchema]),
})
export type TengriCodexSelection = z.infer<typeof codexSelectionSchema>

export function defaultCodexSelection(): TengriCodexSelection {
  return { model: DEFAULT_CODEX_MODEL, reasoningEffort: 'default' }
}

export function parseCodexModelPage(rawJson: string): TengriCodexModelPage {
  const page = codexModelPageSchema.parse(JSON.parse(rawJson))
  return { models: page.data, nextCursor: page.nextCursor }
}

export function codexOptionsForSelection(
  selection: TengriCodexSelection,
  models: TengriCodexModel[],
): TengriCodexOptions | null {
  const model = models.find((model) => model.model === selection.model)
  if (!model) return null
  const effort = selection.reasoningEffort === 'default' ? model.defaultReasoningEffort : selection.reasoningEffort
  if (!model.supportedReasoningEfforts.some((option) => option.reasoningEffort === effort)) return null
  return { model: model.model, reasoningEffort: effort }
}

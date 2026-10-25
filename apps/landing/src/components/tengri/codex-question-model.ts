import { z } from 'zod'
import type { TengriCodexEvent } from '@/lib/tengri/types'
import type { TengriCodexInputResponse } from '@/lib/tengri/codex-input'

export type QuestionField = {
  key: string
  title: string
  description: string
  type: 'string' | 'number' | 'integer' | 'boolean'
  required: boolean
  secret: boolean
  choices: { label: string; value: string; description: string }[]
  freeText: boolean
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
}
export type QuestionRequest = {
  mode: 'questions' | 'form' | 'url'
  message: string
  fields: QuestionField[]
  url?: string
}
const option = z.object({ label: z.string().min(1).max(1024), description: z.string().max(4096).optional() })
const questions = z.object({
  questions: z
    .array(
      z.object({
        id: z.string().min(1).max(160),
        header: z.string().max(4096).optional(),
        question: z.string().min(1).max(4096),
        isOther: z.boolean().optional(),
        isSecret: z.boolean().optional(),
        options: z.array(option).max(20).nullish(),
      }),
    )
    .min(1)
    .max(10),
})

export function codexQuestionRequest(event: TengriCodexEvent): QuestionRequest | null {
  if (
    event.kind !== 'approval' ||
    !['item/tool/requestUserInput', 'mcpServer/elicitation/request'].includes(event.method)
  )
    return null
  try {
    const { params } = JSON.parse(event.rawJson)
    if (event.method === 'item/tool/requestUserInput') {
      const input = questions.parse(params)
      if (new Set(input.questions.map((question) => question.id)).size !== input.questions.length) return null
      return {
        mode: 'questions',
        message: 'The agent needs your input.',
        fields: input.questions.map((question) => ({
          key: question.id,
          title: question.question,
          description: question.header ?? '',
          type: 'string',
          required: true,
          secret: question.isSecret ?? false,
          choices:
            question.options?.map((item) => ({ ...item, value: item.label, description: item.description ?? '' })) ??
            [],
          freeText: question.isOther === true || !question.options?.length,
        })),
      }
    }
    if (
      params._meta?.codex_approval_kind === 'mcp_tool_call' &&
      params.mode !== 'url' &&
      Object.keys(params.requestedSchema?.properties ?? {}).length === 0
    )
      return null
    if (params.mode === 'url') {
      const url = new URL(params.url)
      return url.protocol === 'https:' && !url.username && !url.password
        ? {
            mode: 'url',
            message: String(params.message ?? 'Complete this request in your browser.'),
            fields: [],
            url: url.href,
          }
        : null
    }
    if (!['form', 'openai/form', 'openaiForm'].includes(params.mode) || params.requestedSchema?.type !== 'object')
      return null
    const properties = Object.entries(params.requestedSchema.properties ?? {})
    if (properties.length > 20) return null
    const fields: QuestionField[] = []
    const allowed = new Set([
      'type',
      'title',
      'description',
      'enum',
      'default',
      'minLength',
      'maxLength',
      'minimum',
      'maximum',
    ])
    for (const [key, value] of properties) {
      const property = z
        .object({
          type: z.enum(['string', 'number', 'integer', 'boolean']),
          title: z.string().max(4096).optional(),
          description: z.string().max(4096).optional(),
          enum: z
            .array(z.union([z.string(), z.number(), z.boolean()]))
            .max(20)
            .optional(),
        })
        .passthrough()
        .parse(value)
      if (Object.keys(property).some((key) => !allowed.has(key))) return null
      const choices =
        property.enum?.map((value) => ({ label: String(value), value: String(value), description: '' })) ??
        (property.type === 'boolean'
          ? [
              { label: 'Yes', value: 'true', description: '' },
              { label: 'No', value: 'false', description: '' },
            ]
          : [])
      fields.push({
        key,
        title: property.title ?? key,
        description: property.description ?? '',
        type: property.type,
        required: params.requestedSchema.required?.includes(key) ?? false,
        secret: false,
        choices,
        freeText: !choices.length,
        minLength: typeof property.minLength === 'number' ? property.minLength : undefined,
        maxLength: typeof property.maxLength === 'number' ? property.maxLength : undefined,
        minimum: typeof property.minimum === 'number' ? property.minimum : undefined,
        maximum: typeof property.maximum === 'number' ? property.maximum : undefined,
      })
    }
    return { mode: 'form', message: String(params.message ?? 'Your input is needed.'), fields }
  } catch {
    return null
  }
}

export function codexQuestionResponse(
  request: QuestionRequest,
  values: Record<string, string>,
): TengriCodexInputResponse {
  if (request.mode === 'url') return { action: 'accept' }
  if (request.mode === 'questions')
    return {
      answers: Object.fromEntries(
        request.fields.map((field, index) => [field.key, { answers: [values[`q${index}`]] }]),
      ),
    }
  return {
    action: 'accept',
    content: Object.fromEntries(
      request.fields.flatMap((field, index) => {
        const value = values[`q${index}`]
        if (!value && !field.required) return []
        return [
          [
            field.key,
            field.type === 'boolean'
              ? value === 'true'
              : field.type === 'number' || field.type === 'integer'
                ? Number(value)
                : value,
          ],
        ]
      }),
    ),
  }
}

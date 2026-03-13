import Handlebars from 'handlebars'

import { SymphonyError } from './errors'
import type { Issue } from './types'

export type PromptTemplateInput = {
  issue: Issue
  attempt: number | null
}

const toText = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null || value === undefined) return ''
  return JSON.stringify(value)
}

const createTemplateEngine = () => {
  const engine = Handlebars.create()

  engine.registerHelper('helperMissing', function helperMissing(this: unknown, ...args: unknown[]) {
    const helperName = typeof args.at(-1) === 'object' ? (args.at(-1) as { name?: string }).name : 'unknown'
    throw new SymphonyError('template_render_error', `unknown helper ${helperName ?? 'unknown'}`)
  })

  engine.registerHelper('json', (value: unknown) => JSON.stringify(value))
  engine.registerHelper('join', (value: unknown, separator = ', ') => {
    if (!Array.isArray(value)) return ''
    return value.map((entry) => String(entry)).join(separator)
  })
  engine.registerHelper('lowercase', (value: unknown) => toText(value).toLowerCase())
  engine.registerHelper('uppercase', (value: unknown) => toText(value).toUpperCase())
  engine.registerHelper('default', (value: unknown, fallback: unknown) => {
    if (value === null || value === undefined || value === '') return fallback
    return value
  })

  return engine
}

const engine = createTemplateEngine()

export const renderPromptTemplate = (template: string, input: PromptTemplateInput): string => {
  let compiled: Handlebars.TemplateDelegate<PromptTemplateInput>
  try {
    compiled = engine.compile(template, { strict: true, noEscape: true })
  } catch (error) {
    throw new SymphonyError('template_parse_error', 'failed to parse workflow prompt template', error)
  }

  try {
    return compiled(input).trim()
  } catch (error) {
    throw new SymphonyError('template_render_error', 'failed to render workflow prompt template', error)
  }
}

import { type Tool, ToolSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import type { AutoOntologyUpstream } from './upstream'

const defineTool = <S extends z.ZodObject>(
  description: string,
  input: S,
  call: (args: z.output<S>, upstream: AutoOntologyUpstream, signal: AbortSignal) => Promise<Record<string, unknown>>,
) => ({
  description,
  inputSchema: ToolSchema.shape.inputSchema.parse(z.toJSONSchema(input, { io: 'input', target: 'draft-07' })),
  parse: (value: unknown) => input.safeParse(value),
  call: (value: unknown, upstream: AutoOntologyUpstream, signal: AbortSignal) =>
    call(input.parse(value), upstream, signal),
})

const id = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/)
  .describe('ID returned by the Auto Ontology catalog')
const question = z.string().trim().min(1).max(4000)
const page = {
  skip: z.int().min(0).max(100_000).optional(),
  limit: z.int().min(1).max(100).default(25),
}
const search = z.strictObject({ ...page, query: z.string().trim().min(1).max(200).optional() })
const term = z.strictObject({ term_id: id })
const termPage = term.extend(page)

const tools = {
  check_readiness: defineTool(
    'Check whether the semantic layer is compiled and a database catalog has been ingested. Does not test SQL connectivity.',
    z.strictObject({}),
    (_args, upstream, signal) => upstream.checkReadiness(signal),
  ),
  search_terms: defineTool('Search the business glossary by term name.', search, (args, upstream, signal) =>
    upstream.get('/api/terms', signal, args),
  ),
  get_term: defineTool(
    'Get one glossary term, including its description and synonyms.',
    term,
    ({ term_id }, upstream, signal) => upstream.get(`/api/terms/${term_id}`, signal),
  ),
  get_term_columns: defineTool(
    'List the physical columns mapped to a glossary term.',
    termPage,
    ({ term_id, ...args }, upstream, signal) => upstream.get(`/api/terms/${term_id}/column-attributes`, signal, args),
  ),
  get_term_sql_attributes: defineTool(
    'List the SQL attributes defined for a glossary term.',
    termPage,
    ({ term_id, ...args }, upstream, signal) => upstream.get(`/api/terms/${term_id}/sql-attributes`, signal, args),
  ),
  get_sql_attribute: defineTool(
    'Get the definition and expression of one SQL attribute.',
    z.strictObject({ attr_id: id }),
    ({ attr_id }, upstream, signal) => upstream.get(`/api/sql-attributes/${attr_id}`, signal),
  ),
  describe_table: defineTool(
    'Describe a catalog table and the glossary terms mapped to it.',
    z.strictObject({ table_id: id, ...page }),
    ({ table_id, ...args }, upstream, signal) =>
      upstream.get(`/api/exploration/tables/${table_id}/details`, signal, args),
  ),
  list_acronyms: defineTool(
    'List configured acronyms and their meanings.',
    z.strictObject({}),
    (_args, upstream, signal) => upstream.get('/api/acronyms', signal),
  ),
  list_rules: defineTool('List configured semantic rules.', search, (args, upstream, signal) =>
    upstream.get('/api/rules', signal, args),
  ),
  list_custom_analyses: defineTool(
    'List saved analysis definitions without executing them.',
    search,
    (args, upstream, signal) => upstream.get('/api/custom-analyses', signal, args),
  ),
  check_answerable: defineTool(
    'Check whether the semantic layer covers the entities in a question without running SQL.',
    z.strictObject({ question, max_distance: z.number().positive().optional() }),
    (args, upstream, signal) => upstream.checkAnswerable(args, signal),
  ),
  ask_question: defineTool(
    'Ask a data question via read-only text-to-SQL. Expensive; use check_answerable first when unsure. Does not save a conversation.',
    z.strictObject({ question, evidence: z.string().trim().min(1).max(4000).optional() }),
    (args, upstream, signal) => upstream.askQuestion(args, signal),
  ),
}

export const AUTO_ONTOLOGY_TOOLS: Tool[] = Object.entries(tools).map(([name, { description, inputSchema }]) => ({
  name,
  description,
  inputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}))

export const getAutoOntologyTool = (name: string) =>
  Object.hasOwn(tools, name) ? tools[name as keyof typeof tools] : undefined

import { Data, Redacted, Result, Schema } from 'effect'

import type { Analysis, BaynKnowledge } from './auto-ontology-knowledge'

export enum SyncMode {
  DryRun = 'dry-run',
  Apply = 'apply',
}
const decodeMode = Schema.decodeUnknownResult(Schema.Enum(SyncMode))

export class OntologySyncError extends Data.TaggedError('OntologySyncError')<{
  readonly operation: string
  readonly message: string
  readonly status?: number
  readonly cause?: Redacted.Redacted<unknown>
}> {}

export const parseMode = (args: readonly string[]) => {
  if (args.length === 0) return Result.succeed(SyncMode.DryRun)
  if (args.length === 2 && args[0] === '--mode') {
    const mode = decodeMode(args[1])
    if (Result.isSuccess(mode)) return Result.succeed(mode.success)
  }
  return Result.fail(new OntologySyncError({ operation: 'arguments', message: 'Use --mode dry-run or --mode apply' }))
}

export const bindContract = '$1: account ID (text); $2: inclusive start; $3: exclusive end (both timestamptz).'
const parameterTypes: ReadonlyMap<string, string> = new Map([
  ['$1', 'text'],
  ['$2', 'timestamptz'],
  ['$3', 'timestamptz'],
])
const queryCalls = new Set([
  // Parentheses in these clauses are syntax, not function calls.
  'and',
  'as',
  'by',
  'distinct',
  'exists',
  'filter',
  'in',
  'lateral',
  'not',
  'on',
  'or',
  'select',
  'using',
  'where',
  'bool_or',
  'count',
  'jsonb_array_elements',
  'jsonb_array_elements_text',
  'jsonb_typeof',
  'min',
  'string_agg',
  'sum',
])

// Only placeholders outside literals are bound. PostgreSQL parses the result as a view; this is not a SQL parser.
export const prepareAnalysis = (analysis: Analysis, index: number) => {
  const operation = `analyses[${index}]`
  const syntax = analysis.sql.replace(/'(?:[^']|'')*'/g, "''")
  const withoutBinds = syntax.replace(/\$[1-3]\b/g, '')
  if (
    !/^\s*(?:SELECT|WITH)\b/i.test(syntax) ||
    /[;"\\]/.test(analysis.sql) ||
    /--|\/\*|\*\/|\$/.test(withoutBinds) ||
    /\*/.test(syntax.replace(/\bCOUNT\s*\(\s*\*\s*\)/gi, ''))
  ) {
    return Result.fail(
      new OntologySyncError({
        operation,
        message: 'Expected one explicit-column SELECT without comments or SQL metacommands',
      }),
    )
  }
  // The database role and standby enforce read-only access. Also keep examples from invoking routines with side effects.
  if (
    /[^!-~]/.test(syntax.replace(/\s/g, '')) ||
    /\.\s*[a-z_][a-z0-9_]*\s*\(|\b(?:into|for\s+(?:update|share|key\s+share|no\s+key\s+update))\b/i.test(syntax) ||
    [...syntax.matchAll(/\b([a-z_][a-z0-9_]*)\s*\(/gi)].some((match) => !queryCalls.has(match[1]?.toLowerCase() ?? ''))
  ) {
    return Result.fail(
      new OntologySyncError({ operation, message: 'SQL uses a routine or clause outside the reviewed SELECT subset' }),
    )
  }
  const used = new Set(syntax.match(/\$[1-3]\b/g))
  if (used.size !== parameterTypes.size) {
    return Result.fail(
      new OntologySyncError({ operation, message: 'SQL must bind $1 (account), $2 (start), and $3 (end)' }),
    )
  }
  return Result.succeed({
    operation,
    analysis,
    viewSql: analysis.sql.replace(/'(?:[^']|'')*'|\$[1-3]\b/g, (token) => {
      const type = parameterTypes.get(token)
      return type === undefined ? token : `(NULL::${type})`
    }),
  })
}
export type PreparedAnalysis = Result.Result.Success<ReturnType<typeof prepareAnalysis>>

const sameSet = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((value) => right.includes(value))

export const verifyReferences = ({ operation, analysis }: PreparedAnalysis, actual: readonly string[]) =>
  sameSet(analysis.referencedTables, actual)
    ? Result.succeed(undefined)
    : Result.fail(
        new OntologySyncError({
          operation,
          message: 'SQL relations differ from referencedTables in the migrated public schema',
        }),
      )

const duplicate = (operation: string) =>
  new OntologySyncError({ operation, message: 'Duplicate Bayn knowledge identity' })
const keyOf = (name: string) => name.toLowerCase()
const hasDuplicates = (keys: readonly string[]) => new Set(keys.map(keyOf)).size !== keys.length

export const prepareKnowledge = (seed: BaynKnowledge) =>
  Result.gen(function* () {
    if (hasDuplicates(seed.acronyms.map(({ name }) => name))) return yield* Result.fail(duplicate('acronyms'))
    if (hasDuplicates(seed.rules.map(({ key }) => key))) return yield* Result.fail(duplicate('rules'))
    if (
      hasDuplicates(seed.analyses.map(({ name }) => name)) ||
      new Set(seed.analyses.map(({ sql }) => sql)).size !== seed.analyses.length
    ) {
      return yield* Result.fail(duplicate('custom-analyses'))
    }
    const analyses: PreparedAnalysis[] = []
    for (const [index, analysis] of seed.analyses.entries()) analyses.push(yield* prepareAnalysis(analysis, index))
    return analyses
  })

const Id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/))
export const NamedRow = Schema.Struct({ id: Id, name: Schema.String })
export const AcronymRow = Schema.Struct({ ...NamedRow.fields, description: Schema.NullOr(Schema.String) })
export const RuleRow = Schema.Struct({
  ...NamedRow.fields,
  search_term: Schema.String,
  text_match_option: Schema.String,
  filters: Schema.Struct({
    data: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
    tags: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
    objects: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
    description: Schema.Boolean,
    synonyms: Schema.Boolean,
  }),
  tags: Schema.Array(NamedRow),
})
export const AnalysisRow = Schema.Struct({
  id: Id,
  name: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  sql: Schema.NullOr(Schema.String),
})

export type Catalog = {
  readonly schemaId: string
  readonly ruleTagId: string
  readonly acronyms: readonly (typeof AcronymRow.Type)[]
  readonly rules: readonly (typeof RuleRow.Type)[]
  readonly analyses: readonly (typeof AnalysisRow.Type)[]
}

type Resource = 'acronyms' | 'rules' | 'custom-analyses'
type Mutation = {
  readonly resource: Resource
  readonly method: 'POST' | 'PATCH' | 'PUT'
  readonly id?: string
  readonly body: object
  readonly sql?: string
}

const sourceNote = (sources: readonly string[]) => `Evidence: ${sources.join(', ')}`

export const planUpserts = (seed: BaynKnowledge, catalog: Catalog) =>
  Result.gen(function* () {
    const writes: Mutation[] = []
    for (const { name, description, sources } of seed.acronyms) {
      const matches = catalog.acronyms.filter((row) => keyOf(row.name) === keyOf(name))
      if (matches.length > 1) return yield* Result.fail(duplicate('acronyms'))
      const previous = matches[0]
      const body = { name, description: `${description}\n\n${sourceNote(sources)}` }
      if (previous === undefined) writes.push({ resource: 'acronyms', method: 'POST', body })
      else if (previous.name !== body.name || previous.description !== body.description)
        writes.push({ resource: 'acronyms', method: 'PATCH', id: previous.id, body })
    }
    for (const { key, searchTerm, description, sources } of seed.rules) {
      // 1.3.0 only allows renaming; the stable key survives edits to the invariant text.
      const prefix = `Bayn [${key}]: `
      const matches = catalog.rules.filter((row) => keyOf(row.name).startsWith(keyOf(prefix)))
      if (matches.length > 1) return yield* Result.fail(duplicate('rules'))
      const previous = matches[0]
      const name = `${prefix}${description} ${sourceNote(sources)}`
      if (previous === undefined) {
        writes.push({
          resource: 'rules',
          method: 'POST',
          body: {
            name,
            search_term: searchTerm,
            text_match_option: 'contains',
            filters: { data: [catalog.schemaId], description: false, synonyms: false },
            tags: [{ id: catalog.ruleTagId }],
          },
        })
      } else if (
        previous.search_term !== searchTerm ||
        previous.text_match_option !== 'contains' ||
        !sameSet(previous.filters.data ?? [], [catalog.schemaId]) ||
        previous.filters.description ||
        previous.filters.synonyms ||
        (previous.filters.tags?.length ?? 0) !== 0 ||
        (previous.filters.objects?.length ?? 0) !== 0 ||
        !sameSet(
          previous.tags.map(({ id }) => id),
          [catalog.ruleTagId],
        )
      ) {
        return yield* Result.fail(
          new OntologySyncError({
            operation: 'rules',
            message: 'Existing Bayn rule has immutable search or tag drift; reconcile it manually',
          }),
        )
      } else if (previous.name !== name) {
        writes.push({ resource: 'rules', method: 'PATCH', id: previous.id, body: { name } })
      }
    }
    for (const { name, description, sql, sources } of seed.analyses) {
      const matches = catalog.analyses.filter((row) => row.name !== null && keyOf(row.name) === keyOf(name))
      if (matches.length > 1) return yield* Result.fail(duplicate('custom-analyses'))
      const previous = matches[0]
      if (catalog.analyses.some((row) => row.id !== previous?.id && row.sql === sql)) {
        return yield* Result.fail(
          new OntologySyncError({
            operation: 'custom-analyses',
            message: 'Canonical SQL is already stored under a different analysis name',
          }),
        )
      }
      const body = { name, description: `${description}\n\n${bindContract}\n\n${sourceNote(sources)}`, sql }
      if (previous === undefined) writes.push({ resource: 'custom-analyses', method: 'POST', body, sql })
      else if (previous.name !== body.name || previous.description !== body.description || previous.sql !== sql)
        writes.push({ resource: 'custom-analyses', method: 'PUT', id: previous.id, body, sql })
    }
    return writes
  })

import {
  type A_Expr,
  type ColumnRef,
  type FuncCall,
  type Node,
  type RangeVar,
  type SelectStmt,
  type SortBy,
  type TypeName,
  parse,
} from 'libpg-query'
import { z } from 'zod'

// All errors returned to the operator must use fixed text, not input or API response values.
export class BundleSyncError extends Error {}

const credentialPatterns = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/i,
  /\b(?:auto_ontology_|sk-(?:proj-|ant-|svcacct-)?|gh[pousr]_|github_pat_|xox[baprs]-|nvapi-)[\w-]{12,}/i,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bAIza[\w-]{35}\b/,
  /\beyJ[\w-]+\.eyJ[\w-]+\.[\w-]+\b/,
  /\b(?:basic|bearer)\s+[\w.~+/=-]{8,}/i,
  /(?:^|[^a-z0-9])(?:api[-_ ]?(?:key|token)|access[-_ ]?token|client[-_ ]?secret|password|passwd|secret[-_ ]?access[-_ ]?key)["']?\s*[:=]\s*["']?[^\s"',;]+/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,
]
const containsCredential = (text: string) => credentialPatterns.some((pattern) => pattern.test(text))
const safeText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !containsCredential(value))
const databaseName = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,63}$/)
  .refine((value) => !containsCredential(value))
const provenance = z
  .strictObject({
    sourceCommit: z.string().regex(/^[a-f0-9]{7,40}$/i),
    verificationNote: safeText(2_000),
  })
  .optional()
const entry = z.strictObject({ name: safeText(120), description: safeText(4_000), provenance })
const bundleSchema = z.strictObject({
  version: z.literal(1),
  dataSource: databaseName,
  database: databaseName.optional(),
  acronyms: z.array(entry),
  rules: z.array(entry.extend({ searchTerm: safeText(120).optional() })),
  customAnalyses: z.array(entry.extend({ sql: safeText(16_000) })),
})
type Bundle = z.infer<typeof bundleSchema>

const functions = new Set([
  'avg',
  'btrim',
  'count',
  'date_trunc',
  'extract',
  'lag',
  'lead',
  'length',
  'lower',
  'max',
  'min',
  'now',
  'percentile_cont',
  'round',
  'row_number',
  'sum',
  'upper',
])
const castTypes = new Set([
  'bool',
  'date',
  'float4',
  'float8',
  'int2',
  'int4',
  'int8',
  'interval',
  'json',
  'jsonb',
  'numeric',
  'text',
  'timestamp',
  'timestamptz',
  'uuid',
  'varchar',
])
const operators = new Set([
  '=',
  '<>',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  '+',
  '-',
  '*',
  '/',
  '%',
  '||',
  '->',
  '->>',
  '#>',
  '#>>',
  '~~',
  '!~~',
  '~~*',
  '!~~*',
])
const sensitiveIdentifier =
  /(?:^|_)(?:passwords?|passwd|credentials?|api_keys?|access_tokens?|refresh_tokens?|client_secrets?|secret_keys?|secrets?)(?:_|$)/i

const builtin = (parts: Node[] | undefined, allowed: ReadonlySet<string>) => {
  const path = (parts ?? []).map((part) => ('String' in part ? part.String.sval : undefined))
  const name = path.at(-1)
  return (
    name !== undefined && allowed.has(name) && (path.length === 1 || (path.length === 2 && path[0] === 'pg_catalog'))
  )
}

const validateAnalysis = async (sql: string, index: number, database: string, referenced: Map<string, Set<string>>) => {
  const reject = (reason: string): never => {
    throw new BundleSyncError(`customAnalyses[${index}]: ${reason}`)
  }
  const statements = await parse(sql).then(
    (result) => result.stmts,
    () => reject('Invalid PostgreSQL SQL'),
  )
  const root = statements?.[0]?.stmt
  if (statements?.length !== 1 || !root || !('SelectStmt' in root)) {
    return reject('Expected exactly one SELECT statement')
  }
  let readsRelation = false
  const visitSelect = (select: SelectStmt, inherited: ReadonlySet<string>) => {
    if (
      select.intoClause ||
      select.lockingClause?.length ||
      select.valuesLists?.length ||
      select.withClause?.recursive
    ) {
      reject('SELECT INTO, row locks, VALUES and recursive CTEs are not supported')
    }
    const visible = new Set(inherited)
    const { withClause, larg, rarg, ...clauses } = select
    for (const cte of withClause?.ctes ?? []) {
      if (
        !('CommonTableExpr' in cte) ||
        !cte.CommonTableExpr.ctename ||
        !cte.CommonTableExpr.ctequery ||
        !('SelectStmt' in cte.CommonTableExpr.ctequery)
      ) {
        return reject('CTEs must be read-only SELECTs')
      }
      visitSelect(cte.CommonTableExpr.ctequery.SelectStmt, visible)
      visible.add(cte.CommonTableExpr.ctename)
    }
    if (larg) visitSelect(larg, visible)
    if (rarg) visitSelect(rarg, visible)
    visit(clauses, visible)
  }
  const visit = (node: unknown, visible: ReadonlySet<string>): void => {
    if (typeof node === 'string' && containsCredential(node)) reject('Possible credential in SQL')
    if (Array.isArray(node)) {
      for (const child of node) visit(child, visible)
      return
    }
    if (node === null || typeof node !== 'object') return
    if ('SelectStmt' in node) return visitSelect(node.SelectStmt as SelectStmt, visible)
    if ('RangeVar' in node) {
      const { catalogname, schemaname, relname } = node.RangeVar as RangeVar
      if (!catalogname && !schemaname && relname && visible.has(relname)) return
      if (
        !relname ||
        !schemaname ||
        /^pg_/i.test(schemaname) ||
        schemaname.toLowerCase() === 'information_schema' ||
        sensitiveIdentifier.test(schemaname) ||
        sensitiveIdentifier.test(relname) ||
        (catalogname && catalogname !== database)
      ) {
        return reject('Query only schema-qualified relations in the selected user database')
      }
      const tables = referenced.get(schemaname) ?? new Set<string>()
      tables.add(relname)
      referenced.set(schemaname, tables)
      readsRelation = true
    }
    if ('FuncCall' in node && !builtin((node.FuncCall as FuncCall).funcname, functions)) {
      reject('Only allowlisted read-only PostgreSQL functions are supported')
    }
    if ('typeName' in node && !builtin((node.typeName as TypeName).names, castTypes)) {
      reject('Only allowlisted PostgreSQL built-in casts are supported')
    }
    const op =
      'A_Expr' in node ? (node.A_Expr as A_Expr).name : 'SortBy' in node ? (node.SortBy as SortBy).useOp : undefined
    if (op?.length && !builtin(op, operators)) reject('Only allowlisted PostgreSQL operators are supported')
    if ('ColumnRef' in node) {
      const fields = (node.ColumnRef as ColumnRef).fields ?? []
      if (
        fields.some(
          (field) => 'A_Star' in field || ('String' in field && sensitiveIdentifier.test(field.String.sval ?? '')),
        )
      ) {
        reject('Select explicit, non-credential columns')
      }
    }
    if (
      'RangeFunction' in node ||
      'RangeTableSample' in node ||
      'RangeTableFunc' in node ||
      'JsonTable' in node ||
      'ParamRef' in node
    ) {
      reject('Table routines, sampling and parameters are not supported in saved analyses')
    }
    for (const child of Object.values(node)) visit(child, visible)
  }

  visitSelect(root.SelectStmt, new Set())
  return readsRelation
}

const key = (name: string) => name.toLowerCase()

export const prepareBundle = async (input: unknown, applying: boolean) => {
  const decoded = bundleSchema.safeParse(input)
  if (!decoded.success) {
    const issue = decoded.error.issues[0]
    // Avoid issue messages/unknown keys: they can contain credential values.
    const field = issue?.path.join('.') || 'root'
    throw new BundleSyncError(`Invalid bundle at ${field}: unexpected field, invalid value or possible credential`)
  }
  const bundle = decoded.data
  const database = bundle.database ?? bundle.dataSource
  for (const section of ['acronyms', 'rules', 'customAnalyses'] as const) {
    const entries = bundle[section]
    if (new Set(entries.map(({ name }) => key(name))).size !== entries.length) {
      throw new BundleSyncError(`Duplicate name in ${section}`)
    }
  }
  const queries = new Set<string>()
  const referenced = new Map<string, Set<string>>()
  for (const [index, { sql }] of bundle.customAnalyses.entries()) {
    if (queries.has(sql)) throw new BundleSyncError('Duplicate SQL in customAnalyses')
    queries.add(sql)
    if (!(await validateAnalysis(sql, index, database, referenced)) && applying) {
      throw new BundleSyncError(`customAnalyses[${index}]: Apply requires a catalogued relation`)
    }
  }
  return { bundle, database, referenced }
}

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/)
export const NamedRow = z.object({ id, name: z.string() })
export const DatabaseRow = NamedRow.extend({ name: z.string().nullish() })
export const AcronymRow = NamedRow.extend({ description: z.string() })
export const AnalysisRow = NamedRow.extend({
  name: z.string().nullable(),
  description: z.string().nullable(),
  sql: z.string().nullable(),
})
export const RuleRow = NamedRow.extend({
  search_term: z.string(),
  text_match_option: z.string(),
  filters: z.object({
    data: z.array(z.string()).nullish(),
    description: z.boolean().default(false),
    synonyms: z.boolean().default(true),
    tags: z.array(z.string()).nullish(),
    objects: z.array(z.string()).nullish(),
  }),
  tags: z.array(NamedRow),
})

type Catalog = {
  databaseId: string
  ruleTagId?: string
  acronyms: z.infer<typeof AcronymRow>[]
  rules: z.infer<typeof RuleRow>[]
  analyses: z.infer<typeof AnalysisRow>[]
}

type Write = {
  resource: 'acronyms' | 'rules' | 'custom-analyses'
  method: 'POST' | 'PATCH' | 'PUT'
  id?: string
  body: object
  sql?: string
}

const match = <Row>(section: string, rows: readonly Row[], predicate: (row: Row) => boolean) => {
  const matches = rows.filter(predicate)
  if (matches.length > 1) throw new BundleSyncError(`Ambiguous catalog identity in ${section}; no writes attempted`)
  return matches[0]
}

export const planUpserts = (bundle: Bundle, catalog: Catalog): Write[] => {
  const writes: Write[] = []
  for (const { name, description } of bundle.acronyms) {
    const old = match('acronyms', catalog.acronyms, (row) => key(row.name) === key(name))
    const body = { name, description }
    if (!old) writes.push({ resource: 'acronyms', method: 'POST', body })
    else if (old.name !== name || old.description !== description) {
      writes.push({ resource: 'acronyms', method: 'PATCH', id: old.id, body })
    }
  }
  for (const { name, description, searchTerm = name } of bundle.rules) {
    if (!catalog.ruleTagId) throw new BundleSyncError('Expected one preconfigured canonical rule tag')
    // The 1.3.0 rules API supports renames but cannot update search or tags.
    const prefix = `${bundle.dataSource} [${JSON.stringify(name)}]: `
    const displayName = `${prefix}${description}`
    const old = match('rules', catalog.rules, (row) => key(row.name).startsWith(key(prefix)))
    if (!old) {
      writes.push({
        resource: 'rules',
        method: 'POST',
        body: {
          name: displayName,
          search_term: searchTerm,
          text_match_option: 'contains',
          filters: { data: [catalog.databaseId], description: false, synonyms: false },
          tags: [{ id: catalog.ruleTagId }],
        },
      })
    } else if (
      old.search_term !== searchTerm ||
      old.text_match_option !== 'contains' ||
      old.filters.description ||
      old.filters.synonyms ||
      old.filters.data?.length !== 1 ||
      old.filters.data[0] !== catalog.databaseId ||
      old.filters.tags?.length ||
      old.filters.objects?.length ||
      old.tags.length !== 1 ||
      old.tags[0]?.id !== catalog.ruleTagId
    ) {
      throw new BundleSyncError('Existing rule has search, scope or tag drift; reconcile it before applying')
    } else if (old.name !== displayName) {
      writes.push({ resource: 'rules', method: 'PATCH', id: old.id, body: { name: displayName } })
    }
  }
  for (const { name, description, sql } of bundle.customAnalyses) {
    const old = match('custom-analyses', catalog.analyses, (row) => row.name !== null && key(row.name) === key(name))
    if (catalog.analyses.some((row) => row.id !== old?.id && row.sql === sql)) {
      throw new BundleSyncError('SQL is already stored under a different analysis identity; no writes attempted')
    }
    const body = { name, description, sql }
    if (!old) writes.push({ resource: 'custom-analyses', method: 'POST', body, sql })
    else if (old.name !== name || old.description !== description || old.sql !== sql) {
      writes.push({ resource: 'custom-analyses', method: 'PUT', id: old.id, body, sql })
    }
  }
  return writes
}

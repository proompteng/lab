import {
  parse,
  type A_Expr,
  type ColumnRef,
  type FuncCall,
  type Node,
  type RangeVar,
  type SelectStmt,
  type SortBy,
  type TypeName,
} from 'libpg-query'

import type { KnowledgeBundle } from './ontology-deltas'

const readFunctions = new Set([
  'avg',
  'btrim',
  'count',
  'date_trunc',
  'extract',
  'jsonb_typeof',
  'lag',
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
const builtInTypes = new Set([
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
const systemColumns = new Set(['ctid', 'tableoid', 'xmin', 'xmax', 'cmin', 'cmax'])

const names = (parts: Node[] = []) => parts.map((part) => ('String' in part ? part.String.sval : undefined))
const isUnqualifiedOrBuiltin = (path: (string | undefined)[]) =>
  path.length === 1 || (path.length === 2 && path[0] === 'pg_catalog')
const isBuiltin = (parts: Node[] | undefined, allowed: ReadonlySet<string>) => {
  const path = names(parts)
  const name = path.at(-1)
  return name !== undefined && isUnqualifiedOrBuiltin(path) && allowed.has(name)
}

const validateSelect = (statement: SelectStmt, migrationTables: ReadonlySet<string>) => {
  let usesMigrationTable = false

  const visitSelect = (select: SelectStmt, inherited: ReadonlySet<string>) => {
    const { withClause, larg, rarg, ...clauses } = select
    if (select.intoClause || select.lockingClause?.length || select.valuesLists?.length) {
      throw new Error('Expected a read-only SELECT without INTO, row locking, or VALUES')
    }
    if (withClause?.recursive) throw new Error('Recursive CTEs are not supported')

    const visible = new Set(inherited)
    for (const node of withClause?.ctes ?? []) {
      if (!('CommonTableExpr' in node) || !node.CommonTableExpr.ctename || !node.CommonTableExpr.ctequery) {
        throw new Error('Invalid CTE')
      }
      const { ctename, ctequery } = node.CommonTableExpr
      if (!('SelectStmt' in ctequery)) throw new Error('CTEs must be read-only SELECTs')
      visitSelect(ctequery.SelectStmt, visible)
      // A non-recursive CTE is visible only after its definition, and only in this scope.
      visible.add(ctename)
    }
    if (larg) visitSelect(larg, visible)
    if (rarg) visitSelect(rarg, visible)
    visit(clauses, visible)
  }

  const visit = (node: unknown, visible: ReadonlySet<string>): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child, visible)
      return
    }
    if (!node || typeof node !== 'object') return
    if ('SelectStmt' in node) {
      visitSelect(node.SelectStmt as SelectStmt, visible)
      return
    }
    if ('RangeVar' in node) {
      const { catalogname, schemaname, relname } = node.RangeVar as RangeVar
      if (!catalogname && !schemaname && relname && visible.has(relname)) return
      if (!relname || catalogname || !migrationTables.has(`${schemaname ?? 'public'}.${relname}`)) {
        throw new Error('Schema drift: referenced table is not defined by the Agents migrations')
      }
      usesMigrationTable = true
    }
    if ('FuncCall' in node && !isBuiltin((node.FuncCall as FuncCall).funcname, readFunctions)) {
      throw new Error('Use only allowlisted read-only PostgreSQL functions')
    }
    if ('typeName' in node && !isBuiltin((node.typeName as TypeName).names, builtInTypes)) {
      throw new Error('Use only allowlisted PostgreSQL types in casts')
    }
    const operator =
      'A_Expr' in node ? (node.A_Expr as A_Expr).name : 'SortBy' in node ? (node.SortBy as SortBy).useOp : undefined
    if (operator && !isUnqualifiedOrBuiltin(names(operator))) {
      throw new Error('Use only built-in PostgreSQL operators')
    }
    if ('ColumnRef' in node) {
      const fields = (node.ColumnRef as ColumnRef).fields ?? []
      if (fields.some((field) => 'A_Star' in field) || systemColumns.has(names(fields).at(-1) ?? '')) {
        throw new Error('Select explicit migration columns, not wildcards or system columns')
      }
    }
    if ('RangeFunction' in node || 'RangeTableSample' in node || 'RangeTableFunc' in node || 'JsonTable' in node) {
      throw new Error('Use migration tables or SELECT subqueries as sources')
    }
    if ('ParamRef' in node) throw new Error('Saved analyses cannot require SQL parameters')
    for (const child of Object.values(node)) visit(child, visible)
  }

  visitSelect(statement, new Set())
  if (!usesMigrationTable) throw new Error('An analysis must query at least one Agents migration table')
}

export const validateOntologyAnalyses = async (
  analyses: KnowledgeBundle['customAnalyses'],
  schema: { tables: ReadonlySet<string>; describe: (sql: string) => Promise<unknown> },
) => {
  const queries = new Set<string>()
  for (const [index, analysis] of analyses.entries()) {
    try {
      let parsed: Awaited<ReturnType<typeof parse>>
      try {
        parsed = await parse(analysis.sql)
      } catch {
        throw new Error('Invalid PostgreSQL SQL')
      }
      const statements = parsed.stmts ?? []
      const root = statements[0]?.stmt
      if (statements.length !== 1 || !root || !('SelectStmt' in root)) {
        throw new Error('Expected exactly one read-only SELECT statement')
      }
      validateSelect(root.SelectStmt, schema.tables)
      const key = JSON.stringify(root, (field, value: unknown) => (field === 'location' ? undefined : value))
      if (queries.has(key)) throw new Error('Duplicate SQL under a different analysis name')
      queries.add(key)

      try {
        // Extended-protocol Parse/Describe resolves tables and columns without executing the query.
        await schema.describe(analysis.sql)
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? error.code : undefined
        if (code === '42P01' || code === '42703') throw new Error('Schema drift: unresolved table or column')
        throw new Error('PostgreSQL could not resolve the SELECT against the migrated schema')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not validate SQL'
      throw new Error(`Custom analysis ${index + 1} (${JSON.stringify(analysis.name)}): ${message}`)
    }
  }
}

import type { Node, TypeName } from 'libpg-query'

import { builtInTypes, isBuiltin, isBuiltinOperator, visitReadOnlySelect } from './ontology-bundle-sql'
import type { KnowledgeBundle } from './ontology-deltas'
import { assertSafeOntologyText } from './ontology-disclosure'

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
const systemColumns = new Set(['ctid', 'tableoid', 'xmin', 'xmax', 'cmin', 'cmax'])

const validateSelect = async (sql: string, migrationTables: ReadonlySet<string>) => {
  let usesMigrationTable = false
  const statement = await visitReadOnlySelect(sql, (node) => {
    if (typeof node === 'string') return assertSafeOntologyText(node)
    if (!node || typeof node !== 'object') return
    const ast = node as Node
    if ('RangeVar' in ast) {
      const { catalogname, schemaname, relname } = ast.RangeVar
      if (!relname || catalogname || !migrationTables.has(`${schemaname ?? 'public'}.${relname}`)) {
        throw new Error('Schema drift: referenced table is not defined by the Agents migrations')
      }
      usesMigrationTable = true
    }
    if ('FuncCall' in ast && !isBuiltin(ast.FuncCall.funcname, readFunctions)) {
      throw new Error('Use only allowlisted read-only PostgreSQL functions')
    }
    if ('typeName' in node && !isBuiltin((node.typeName as TypeName).names, builtInTypes)) {
      throw new Error('Use only allowlisted PostgreSQL types in casts')
    }
    const operator = 'A_Expr' in ast ? ast.A_Expr.name : 'SortBy' in ast ? ast.SortBy.useOp : undefined
    if (!isBuiltinOperator(operator)) {
      throw new Error('Use only built-in PostgreSQL operators')
    }
    if ('ColumnRef' in ast) {
      const fields = ast.ColumnRef.fields ?? []
      const column = fields.at(-1)
      if (column && ('A_Star' in column || ('String' in column && systemColumns.has(column.String.sval ?? '')))) {
        throw new Error('Select explicit migration columns, not wildcards or system columns')
      }
    }
    if ('RangeFunction' in node || 'RangeTableSample' in node || 'RangeTableFunc' in node || 'JsonTable' in node) {
      throw new Error('Use migration tables or SELECT subqueries as sources')
    }
    if ('ParamRef' in node) throw new Error('Saved analyses cannot require SQL parameters')
  })
  if (!usesMigrationTable) throw new Error('An analysis must query at least one Agents migration table')
  return statement
}

export const validateOntologyAnalyses = async (
  analyses: KnowledgeBundle['customAnalyses'],
  schema: { tables: ReadonlySet<string>; describe: (sql: string) => Promise<unknown> },
) => {
  const queries = new Set<string>()
  for (const [index, { sql }] of analyses.entries()) {
    try {
      const statement = await validateSelect(sql, schema.tables)
      const key = JSON.stringify(statement, (field, value: unknown) => (field === 'location' ? undefined : value))
      if (queries.has(key)) throw new Error('Duplicate SQL under a different analysis name')
      queries.add(key)

      try {
        // Extended-protocol Parse/Describe resolves tables and columns without executing the query.
        await schema.describe(sql)
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? error.code : undefined
        if (code === '42P01' || code === '42703') throw new Error('Schema drift: unresolved table or column')
        throw new Error('PostgreSQL could not resolve the SELECT against the migrated schema')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not validate SQL'
      throw new Error(`Custom analysis ${index + 1}: ${message}`)
    }
  }
}

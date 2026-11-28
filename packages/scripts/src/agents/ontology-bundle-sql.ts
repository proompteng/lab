import { type Node, parse, scan, type SelectStmt, type TypeName } from 'libpg-query'

export const quoteIdentifier = (name: string) => `"${name.replaceAll('"', '""')}"`
export const sqlIdentifier = (name: string) => (/^[a-z_][a-z0-9_$]*$/.test(name) ? name : quoteIdentifier(name))
export const relationKey = (schema: string, table: string) => `${sqlIdentifier(schema)}.${sqlIdentifier(table)}`

const identifier = String.raw`(?:"(?:[^"]|"")+"|[a-z_][a-z0-9_$]*)`
const tableName = new RegExp(`^(?:(${identifier})\\.)?(${identifier})$`, 'i')
const identifierValue = (name: string) =>
  name.startsWith('"') ? name.slice(1, -1).replaceAll('""', '"') : name.toLowerCase()

export const declaredRelation = (name: string) => {
  const match = tableName.exec(name)
  return match?.[2] ? relationKey(identifierValue(match[1] ?? 'public'), identifierValue(match[2])) : undefined
}

// Keep saved analyses on the reviewed built-in read path. SELECT can call routines that write or access other sources.
const readFunctions = new Set([
  'abs',
  'avg',
  'bool_and',
  'bool_or',
  'btrim',
  'count',
  'date_part',
  'date_trunc',
  'extract',
  'jsonb_array_elements',
  'jsonb_array_elements_text',
  'jsonb_typeof',
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
  'string_agg',
  'sum',
  'timezone',
  'upper',
])
export const builtInTypes: ReadonlySet<string> = new Set([
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

const names = (parts: Node[] = []) => parts.map((part) => ('String' in part ? part.String.sval : undefined))
const isBuiltinPath = (path: (string | undefined)[]) =>
  path.length === 1 || (path.length === 2 && path[0] === 'pg_catalog')
export const isBuiltin = (parts: Node[] | undefined, allowed: ReadonlySet<string>) => {
  const path = names(parts)
  const name = path.at(-1)
  return name !== undefined && isBuiltinPath(path) && allowed.has(name)
}

// Parse once per analysis and hide CTE aliases from the caller's relation policy.
export const visitReadOnlySelect = async (sql: string, inspect: (node: unknown) => void) => {
  let statement: SelectStmt | undefined
  let singleSelect: boolean
  try {
    const { tokens } = await scan(sql)
    const syntax = tokens.filter(({ tokenName }) => tokenName !== 'C_COMMENT' && tokenName !== 'SQL_COMMENT')
    const { stmts = [] } = await parse(sql)
    singleSelect =
      /^(?:select|with)$/i.test(syntax[0]?.text ?? '') &&
      syntax.slice(0, -1).every(({ text }) => text !== ';') &&
      stmts.length === 1
    const root = stmts[0]?.stmt
    statement = root && 'SelectStmt' in root ? root.SelectStmt : undefined
  } catch {
    throw new Error('Invalid PostgreSQL SQL')
  }
  if (!singleSelect || !statement) throw new Error('Expected one read-only SELECT or WITH ... SELECT statement')

  const visitSelect = (select: SelectStmt, inherited: ReadonlySet<string>) => {
    const { withClause, larg, rarg, ...clauses } = select
    // PostgreSQL also represents VALUES and TABLE (an implicit wildcard with no location) as SelectStmt nodes.
    if (
      select.intoClause ||
      select.lockingClause?.length ||
      select.valuesLists?.length ||
      select.targetList?.some((node) => 'ResTarget' in node && node.ResTarget.location === -1)
    ) {
      throw new Error('Use SELECT without INTO, row locks, VALUES, or TABLE shorthand')
    }
    if (withClause?.recursive) throw new Error('Recursive CTEs are not supported')
    const visible = new Set(inherited)
    for (const node of withClause?.ctes ?? []) {
      const cte = 'CommonTableExpr' in node ? node.CommonTableExpr : undefined
      if (!cte?.ctename || !cte.ctequery || !('SelectStmt' in cte.ctequery)) {
        throw new Error('CTEs must be read-only SELECTs')
      }
      visitSelect(cte.ctequery.SelectStmt, visible)
      // A nonrecursive CTE is visible only after its definition and only in its query's scope.
      visible.add(cte.ctename)
    }
    if (larg) visitSelect(larg, visible)
    if (rarg) visitSelect(rarg, visible)
    visit(clauses, visible)
  }

  const visit = (node: unknown, visible: ReadonlySet<string>): void => {
    if (!node || typeof node !== 'object') return inspect(node)
    const ast = node as Node
    if ('SelectStmt' in ast) {
      visitSelect(ast.SelectStmt, visible)
      return
    }
    if ('RangeVar' in ast) {
      const { catalogname, schemaname, relname } = ast.RangeVar
      if (!catalogname && !schemaname && relname && visible.has(relname)) return
    }
    inspect(node)
    for (const child of Object.values(node)) visit(child, visible)
  }

  visitSelect(statement, new Set())
}

export const readSelectRelations = async (
  sql: string,
  inspectText: (value: string) => void,
): Promise<ReadonlySet<string>> => {
  const relations = new Set<string>()
  await visitReadOnlySelect(sql, (node) => {
    if (typeof node === 'string') return inspectText(node)
    if (!node || typeof node !== 'object') return
    const ast = node as Node
    if ('RangeVar' in ast) {
      const { catalogname, schemaname, relname } = ast.RangeVar
      if (catalogname || !relname) throw new Error('Use a table in the owning database')
      relations.add(relationKey(schemaname ?? 'public', relname))
    }
    if ('FuncCall' in ast && !isBuiltin(ast.FuncCall.funcname, readFunctions)) {
      throw new Error('Use only allowlisted read-only PostgreSQL functions')
    }
    if ('typeName' in node && !isBuiltin((node.typeName as TypeName).names, builtInTypes)) {
      throw new Error('Use only allowlisted built-in PostgreSQL types')
    }
    const operator = 'A_Expr' in ast ? ast.A_Expr.name : 'SortBy' in ast ? ast.SortBy.useOp : undefined
    if (operator?.length && !isBuiltinPath(names(operator))) {
      throw new Error('Use only built-in PostgreSQL operators')
    }
    if ('RangeTableSample' in ast) throw new Error('TABLESAMPLE is not supported')
  })
  return relations
}

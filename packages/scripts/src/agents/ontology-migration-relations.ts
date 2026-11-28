import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { loadModule, type Node, type ObjectType, parsePlPgSQLSync, parseSync, type RangeVar } from 'libpg-query'
import { type Expression, parseSync as parseTypeScript, Visitor } from 'oxc-parser'

import { quoteIdentifier, relationKey, sqlIdentifier } from './ontology-bundle-sql'

const dynamic = '__ontology_dynamic__'
class StaticDdlError extends Error {}

const sqlMethod = (expression: Expression, ...methods: string[]) =>
  expression.type === 'MemberExpression' &&
  expression.object.type === 'Identifier' &&
  expression.object.name === 'sql' &&
  !expression.computed &&
  expression.property.type === 'Identifier' &&
  methods.includes(expression.property.name)

const migrationSql = (file: string, source: string): string[] => {
  if (file.endsWith('.sql')) return [source]
  const { program, errors } = parseTypeScript(file, source)
  if (errors.length) throw new StaticDdlError('Invalid TypeScript')

  const constants = new Map<string, string>()
  const render = (node: Expression | undefined): string => {
    if (!node) return dynamic
    if (node.type === 'Literal' && (typeof node.value === 'string' || typeof node.value === 'number')) {
      return String(node.value)
    }
    if (node.type === 'Identifier') return constants.get(node.name) ?? dynamic
    if (node.type === 'TemplateLiteral') {
      return node.quasis.map(({ value }, i) => (i === 0 ? '' : render(node.expressions[i - 1])) + value.cooked).join('')
    }
    if (node.type === 'CallExpression') {
      const argument = node.arguments[0]
      if (!argument || argument.type === 'SpreadElement') return dynamic
      if (sqlMethod(node.callee, 'raw')) return render(argument)
      if (sqlMethod(node.callee, 'ref') || (node.callee.type === 'Identifier' && node.callee.name === 'sql')) {
        return render(argument).split('.').map(quoteIdentifier).join('.')
      }
    }
    return dynamic
  }

  // Read the migration source instead of importing or executing it. Ignore rollback declarations.
  program.body = program.body.filter((statement) => {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement
    if (declaration?.type === 'FunctionDeclaration' && declaration.id?.name === 'down') return false
    if (declaration?.type !== 'VariableDeclaration') return true
    if (declaration.declarations.some(({ id }) => id.type === 'Identifier' && id.name === 'down')) return false
    if (declaration.kind === 'const') {
      for (const { id, init } of declaration.declarations) {
        if (id.type === 'Identifier' && init) constants.set(id.name, render(init))
      }
    }
    return true
  })

  const statements: string[] = []
  new Visitor({
    TaggedTemplateExpression({ tag, quasi }) {
      if (tag.type === 'Identifier' && tag.name === 'sql') statements.push(render(quasi))
    },
    CallExpression({ callee, arguments: [first] }) {
      if (first && first.type !== 'SpreadElement' && sqlMethod(callee, 'unsafe', 'raw')) {
        statements.push(render(first))
      }
    },
  }).visit(program)
  return statements
}

const relationTypes = new Set<ObjectType>(['OBJECT_TABLE', 'OBJECT_VIEW', 'OBJECT_MATVIEW', 'OBJECT_FOREIGN_TABLE'])

const staticName = (name: string | undefined) => {
  if (!name || name.includes(dynamic)) throw new StaticDdlError('Relation DDL must have a statically named identifier')
  return name
}

const migrationKey = (relation: RangeVar) =>
  relationKey(staticName(relation.schemaname ?? 'public'), staticName(relation.relname))

const createdRelation = (stmt: Node): RangeVar | undefined => {
  if ('CreateStmt' in stmt) return stmt.CreateStmt.relation
  if ('ViewStmt' in stmt) return stmt.ViewStmt.view
  if ('CreateTableAsStmt' in stmt) return stmt.CreateTableAsStmt.into?.rel
  if ('CreateForeignTableStmt' in stmt) return stmt.CreateForeignTableStmt.base?.relation
  if ('SelectStmt' in stmt) return stmt.SelectStmt.intoClause?.rel
}

function* procedureSql(node: unknown): Generator<string> {
  if (!node || typeof node !== 'object') return
  if ('PLpgSQL_expr' in node) {
    const expression = node.PLpgSQL_expr as { query?: unknown; parseMode?: unknown }
    // Mode 0 is a static SQL statement, not an expression building dynamically executed text.
    if (typeof expression.query === 'string' && expression.parseMode === 0) yield expression.query
  }
  for (const child of Object.values(node)) yield* procedureSql(child)
}

const updateRelations = (relations: Set<string>, sql: string) => {
  // PostgreSQL, not a text search, decides which statements define or remove relations.
  if (!/\b(?:table|view|schema|into)\b/i.test(sql)) return
  for (const { stmt, stmt_location: start = 0, stmt_len: length } of parseSync(sql).stmts ?? []) {
    if (!stmt) continue
    if ('DoStmt' in stmt) {
      // A migration can put static DDL behind a role-exists guard. Read its PL/pgSQL syntax without running it.
      const block = Buffer.from(sql)
        .subarray(start, length ? start + length : undefined)
        .toString()
      for (const nested of procedureSql(parsePlPgSQLSync(block))) updateRelations(relations, nested)
      continue
    }
    const created = createdRelation(stmt)
    if (created && created.relpersistence !== 't') relations.add(migrationKey(created))

    const drop = 'DropStmt' in stmt ? stmt.DropStmt : undefined
    if (drop?.removeType && (relationTypes.has(drop.removeType) || drop.removeType === 'OBJECT_SCHEMA')) {
      // A cascade can also remove views outside this schema; require explicit relation drops.
      if (drop.behavior === 'DROP_CASCADE')
        throw new StaticDdlError('Use explicit relation drops instead of DROP CASCADE')
      for (const object of drop.objects ?? []) {
        if (drop.removeType === 'OBJECT_SCHEMA') {
          const prefix = `${sqlIdentifier(staticName('String' in object ? object.String.sval : undefined))}.`
          for (const relation of relations) if (relation.startsWith(prefix)) relations.delete(relation)
        } else {
          const names =
            'List' in object
              ? (object.List.items?.map((part) => staticName('String' in part ? part.String.sval : undefined)) ?? [])
              : []
          const table = staticName(names.pop())
          relations.delete(relationKey(names.pop() ?? 'public', table))
        }
      }
    }

    const rename = 'RenameStmt' in stmt ? stmt.RenameStmt : undefined
    if (rename?.renameType === 'OBJECT_SCHEMA') {
      const before = `${sqlIdentifier(staticName(rename.subname))}.`
      const after = `${sqlIdentifier(staticName(rename.newname))}.`
      for (const relation of [...relations].filter((relation) => relation.startsWith(before))) {
        relations.delete(relation)
        relations.add(after + relation.slice(before.length))
      }
    } else if (rename?.renameType && relationTypes.has(rename.renameType) && rename.relation) {
      if (relations.delete(migrationKey(rename.relation))) {
        relations.add(relationKey(rename.relation.schemaname ?? 'public', staticName(rename.newname)))
      }
    }
    const move = 'AlterObjectSchemaStmt' in stmt ? stmt.AlterObjectSchemaStmt : undefined
    if (move?.objectType && relationTypes.has(move.objectType) && move.relation) {
      if (relations.delete(migrationKey(move.relation))) {
        relations.add(relationKey(staticName(move.newschema), staticName(move.relation.relname)))
      }
    }
  }
}

export const readMigrationRelations = async (directory: string): Promise<ReadonlySet<string>> => {
  let files: string[]
  try {
    files = (await readdir(directory)).filter((file) => /\.(?:sql|ts)$/.test(file)).sort()
  } catch {
    throw new Error('Could not read the configured migrations directory')
  }
  if (!files.length) throw new Error('The configured migrations directory contains no migrations')

  await loadModule()
  const relations = new Set<string>()
  for (const [index, file] of files.entries()) {
    try {
      const source = await readFile(join(directory, file), 'utf8')
      for (const sql of migrationSql(file, source)) updateRelations(relations, sql)
    } catch (error) {
      // Parser and filesystem errors can contain source text or an untrusted filename.
      const detail = error instanceof StaticDdlError ? `: ${error.message}` : ''
      throw new Error(`Could not read relation DDL from migration ${index + 1} in filename order${detail}`)
    }
  }
  return relations
}

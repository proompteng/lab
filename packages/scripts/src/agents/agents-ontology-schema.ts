import { readdir } from 'node:fs/promises'

import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { vector } from '@electric-sql/pglite/vector'
import {
  type CompiledQuery,
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely'

import type { AgentsDatabase } from '../../../../services/agents/src/server/db'
import type { KnowledgeBundle } from './ontology-deltas'
import { type OntologySqlSchema, validateOntologyAnalyses } from './ontology-sql'

const migrationDirectory = new URL('../../../../services/agents/src/server/migrations/', import.meta.url)

class MemoryPostgresDriver extends DummyDriver {
  constructor(private readonly postgres: PGlite) {
    super()
  }

  override async acquireConnection() {
    return {
      executeQuery: async <Row>({ sql, parameters }: CompiledQuery) => {
        const result = await this.postgres.query<Row>(sql, [...parameters])
        return { rows: result.rows, numAffectedRows: BigInt(result.affectedRows ?? 0) }
      },
      streamQuery(): AsyncIterableIterator<never> {
        throw new Error('Streaming is not available in the ontology schema fixture')
      },
    }
  }

  override async beginTransaction() {
    await this.postgres.exec('BEGIN')
  }

  override async commitTransaction() {
    await this.postgres.exec('COMMIT')
  }

  override async rollbackTransaction() {
    await this.postgres.exec('ROLLBACK')
  }
}

export const createAgentsOntologySchema = async (): Promise<PGlite> => {
  const { ensureMigrations, getRegisteredMigrationNames } =
    await import('../../../../services/agents/src/server/kysely-migrations')
  const files = (await readdir(migrationDirectory)).filter((name) => name.endsWith('.ts')).sort()
  const registered = getRegisteredMigrationNames()
  if (!files.length || files.join('\n') !== registered.map((name) => `${name}.ts`).join('\n')) {
    throw new Error('Agents migration directory does not match the registered migration list')
  }

  // This database has no production connection or data. Only checked-in migrations are executed here.
  const postgres = await PGlite.create({ extensions: { pgcrypto, vector } })
  try {
    await using database = new Kysely<AgentsDatabase>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new MemoryPostgresDriver(postgres),
        createIntrospector: (db) => new PostgresIntrospector(db),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
    })
    await postgres.exec('CREATE EXTENSION pgcrypto; CREATE EXTENSION vector; CREATE ROLE agents_audit_ro NOLOGIN;')
    await ensureMigrations(database)
    const result = await postgres.query<{ name: string }>(
      'SELECT name FROM public.agents_kysely_migration ORDER BY name',
    )
    if (result.rows.map(({ name }) => name).join('\n') !== registered.join('\n')) {
      throw new Error('Not all registered Agents migrations were applied')
    }
    await postgres.exec('SET search_path TO pg_catalog, public')
  } catch (error) {
    await postgres.close()
    throw new Error(`Could not build the local Agents migration schema: ${(error as Error).message}`)
  }
  return postgres
}

export const withAgentsOntologySchema = async <T>(use: (postgres: PGlite) => Promise<T>): Promise<T> => {
  await using postgres = await createAgentsOntologySchema()
  return await use(postgres)
}

export const readAgentsOntologyTables = async (postgres: PGlite): Promise<ReadonlySet<string>> => {
  const { rows } = await postgres.query<{ schema: string; name: string }>(`
    SELECT n.nspname AS schema, c.relname AS name
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p', 'v')
      AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
      AND (n.nspname, c.relname) NOT IN
        (('public', 'agents_kysely_migration'), ('public', 'agents_kysely_migration_lock'))
  `)
  return new Set(rows.map(({ schema, name }) => `${schema}.${name}`))
}

export const describeAgentsOntologySchema = async (postgres: PGlite): Promise<OntologySqlSchema> => ({
  tables: await readAgentsOntologyTables(postgres),
  describe: (sql) => postgres.describeQuery(sql),
})

export const validateAgentsOntologyAnalyses = async (
  analyses: KnowledgeBundle['customAnalyses'],
  schema?: OntologySqlSchema,
) => {
  if (!analyses.length) return
  if (schema) return await validateOntologyAnalyses(analyses, schema)
  await withAgentsOntologySchema(async (postgres) => {
    await validateOntologyAnalyses(analyses, await describeAgentsOntologySchema(postgres))
  })
}

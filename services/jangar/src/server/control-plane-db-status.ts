import { sql } from 'kysely'

import { getDb } from '~/server/db'
import { getRegisteredMigrationNames } from '~/server/kysely-migrations'
import { asString } from '~/server/primitives-http'
import type { DatabaseMigrationConsistency } from '~/data/agents-control-plane'
import type { DatabaseStatus } from './control-plane-status-types'

const MIGRATION_TABLE_CANDIDATES = ['kysely_migration', 'kysely_migrations'] as const

const normalizeMessage = (value: unknown) => (value instanceof Error ? value.message : String(value))

const buildMigrationConsistencyStatus = (input: {
  migrationTable: string | null
  status: DatabaseMigrationConsistency['status']
  registered: string[]
  applied: string[]
  message: string
}): DatabaseMigrationConsistency => {
  const registeredNames = [...new Set(input.registered.filter((value) => value.length > 0))]
  const appliedNames = [...new Set(input.applied.filter((value) => value.length > 0))]
  const registeredSet = new Set(registeredNames)
  const appliedSet = new Set(appliedNames)
  const missingMigrations = registeredNames.filter((name) => !appliedSet.has(name))
  const unexpectedMigrations = appliedNames.filter((name) => !registeredSet.has(name))

  return {
    status: input.status,
    migration_table: input.migrationTable,
    registered_count: registeredNames.length,
    applied_count: appliedNames.length,
    unapplied_count: missingMigrations.length,
    unexpected_count: unexpectedMigrations.length,
    latest_registered: registeredNames.at(-1) ?? null,
    latest_applied: appliedNames.at(-1) ?? null,
    missing_migrations: missingMigrations,
    unexpected_migrations: unexpectedMigrations,
    message: input.message,
  }
}

const getMigrationTable = async (db: NonNullable<ReturnType<typeof getDb>>): Promise<string | null> => {
  for (const tableName of MIGRATION_TABLE_CANDIDATES) {
    try {
      await sql.raw(`SELECT 1 FROM "${tableName}" LIMIT 1`).execute(db)
      return tableName
    } catch {
      // continue
    }
  }
  return null
}

const getAppliedMigrations = async (
  db: NonNullable<ReturnType<typeof getDb>>,
  tableName: string,
): Promise<string[]> => {
  const rows = await sql.raw<{ name: string | null }>(`SELECT name FROM "${tableName}" ORDER BY name`).execute(db)
  return rows.rows.map((row) => asString(row.name)).filter((name): name is string => name !== '')
}

const getMigrationConsistency = async (
  db: NonNullable<ReturnType<typeof getDb>>,
): Promise<DatabaseMigrationConsistency> => {
  const registeredMigrations = getRegisteredMigrationNames()

  const migrationTable = await getMigrationTable(db)
  if (!migrationTable) {
    return buildMigrationConsistencyStatus({
      migrationTable: null,
      status: 'degraded',
      registered: registeredMigrations,
      applied: [],
      message: 'migration table not found (expected kysely_migration or kysely_migrations)',
    })
  }

  try {
    const appliedMigrations = await getAppliedMigrations(db, migrationTable)
    const details = buildMigrationConsistencyStatus({
      migrationTable,
      status: 'healthy',
      registered: registeredMigrations,
      applied: appliedMigrations,
      message: '',
    })
    if (details.unapplied_count > 0 || details.unexpected_count > 0) {
      return {
        ...details,
        status: 'degraded',
        message:
          `migration drift detected: ${details.unapplied_count} unapplied, ${details.unexpected_count} unexpected migration(s). ` +
          'Run migrations to align DB with code.',
      }
    }
    return details
  } catch (error) {
    return {
      ...buildMigrationConsistencyStatus({
        migrationTable,
        status: 'unknown',
        registered: registeredMigrations,
        applied: [],
        message: normalizeMessage(error),
      }),
      message: `failed to evaluate migration state: ${normalizeMessage(error)}`,
    }
  }
}

const buildMigrationUnavailableStatus = (): DatabaseMigrationConsistency =>
  buildMigrationConsistencyStatus({
    migrationTable: null,
    status: 'unknown',
    registered: getRegisteredMigrationNames(),
    applied: [],
    message: 'DATABASE_URL not set',
  })

export const checkDatabase = async (): Promise<DatabaseStatus> => {
  const db = getDb()
  if (!db) {
    return {
      configured: false,
      connected: false,
      status: 'disabled',
      message: 'DATABASE_URL not set',
      latency_ms: 0,
      migration_consistency: buildMigrationUnavailableStatus(),
    }
  }

  const start = Date.now()
  try {
    await sql`select 1`.execute(db)
    const migrationConsistency = await getMigrationConsistency(db)
    return {
      configured: true,
      connected: true,
      status: migrationConsistency.status === 'healthy' ? 'healthy' : 'degraded',
      message: migrationConsistency.status === 'healthy' ? '' : migrationConsistency.message,
      latency_ms: Math.max(0, Date.now() - start),
      migration_consistency: migrationConsistency,
    }
  } catch (error) {
    const message = normalizeMessage(error)
    return {
      configured: true,
      connected: false,
      status: 'degraded',
      message,
      latency_ms: Math.max(0, Date.now() - start),
      migration_consistency: {
        ...buildMigrationUnavailableStatus(),
        status: 'unknown',
        message: `database ping failed: ${message}`,
      },
    }
  }
}

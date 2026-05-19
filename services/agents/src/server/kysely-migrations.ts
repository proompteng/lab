import { type Migration, type MigrationProvider, Migrator } from 'kysely'

import type { Db } from './db'
import { resolveAgentsMigrationsConfig } from './migrations-config'
import * as agentsPrimitivesMigration from './migrations/20260111_agents_primitives'
import * as agentsPrimitivesIndexesMigration from './migrations/20260111_agents_primitives_indexes'
import * as agentsAgentRunIdempotencyMigration from './migrations/20260208_agents_agentrun_idempotency'
import * as agentsControlPlaneCacheMigration from './migrations/20260205_agents_control_plane_cache'
import * as agentsWorkflowCommsAgentMessagesMigration from './migrations/20260212_agents_workflow_comms_agent_messages'

type MigrationMap = Record<string, Migration>

class StaticMigrationProvider implements MigrationProvider {
  constructor(private readonly migrations: MigrationMap) {}

  async getMigrations(): Promise<MigrationMap> {
    return this.migrations
  }
}

const migrations: MigrationMap = {
  '20260111_agents_primitives': agentsPrimitivesMigration,
  '20260111_agents_primitives_indexes': agentsPrimitivesIndexesMigration,
  '20260205_agents_control_plane_cache': agentsControlPlaneCacheMigration,
  '20260208_agents_agentrun_idempotency': agentsAgentRunIdempotencyMigration,
  '20260212_agents_workflow_comms_agent_messages': agentsWorkflowCommsAgentMessagesMigration,
}

const AGENTS_MIGRATION_TABLE = 'agents_kysely_migration'
const AGENTS_MIGRATION_LOCK_TABLE = 'agents_kysely_migration_lock'

export const getRegisteredMigrationNames = () => Object.keys(migrations).sort()

const migrationProvider = new StaticMigrationProvider(migrations)
const migrationPromises = new WeakMap<Db, Promise<void>>()

const resolveMigrationsMode = () => resolveAgentsMigrationsConfig(process.env).mode

const resolveAllowUnorderedMigrations = () => resolveAgentsMigrationsConfig(process.env).allowUnorderedMigrations

const runMigrations = async (db: Db) => {
  const migrator = new Migrator({
    db,
    provider: migrationProvider,
    migrationTableName: AGENTS_MIGRATION_TABLE,
    migrationLockTableName: AGENTS_MIGRATION_LOCK_TABLE,
    allowUnorderedMigrations: resolveAllowUnorderedMigrations(),
  })

  const { error, results } = await migrator.migrateToLatest()

  if (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`failed to run database migrations: ${message}`)
  }

  const failed = results?.find((result) => result.status === 'Error')
  if (failed) {
    throw new Error(`migration ${failed.migrationName} failed`)
  }
}

export const ensureMigrations = async (db: Db) => {
  if (resolveAgentsMigrationsConfig(process.env).skipMigrations || resolveMigrationsMode() === 'skip') {
    return
  }
  let ready = migrationPromises.get(db)
  if (!ready) {
    ready = runMigrations(db)
    migrationPromises.set(db, ready)
  }

  try {
    await ready
  } catch (error) {
    migrationPromises.delete(db)
    throw error
  }
}

export const __test__ = {
  AGENTS_MIGRATION_LOCK_TABLE,
  AGENTS_MIGRATION_TABLE,
  getRegisteredMigrations: getRegisteredMigrationNames,
  resolveAllowUnorderedMigrations,
}

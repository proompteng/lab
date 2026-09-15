import { type Migration, type MigrationProvider, Migrator, sql } from 'kysely'

import type { Db } from './db'
import { resolveAgentsMigrationsConfig } from './migrations-config'
import * as agentsPrimitivesMigration from './migrations/20260111_agents_primitives'
import * as agentsPrimitivesIndexesMigration from './migrations/20260111_agents_primitives_indexes'
import * as agentsAgentRunIdempotencyMigration from './migrations/20260208_agents_agentrun_idempotency'
import * as agentsControlPlaneCacheMigration from './migrations/20260205_agents_control_plane_cache'
import * as agentsWorkflowCommsAgentMessagesMigration from './migrations/20260212_agents_workflow_comms_agent_messages'
import * as agentsCommsAgentMessagesMigration from './migrations/20260519_agents_comms_agent_messages'
import * as agentsCommsAgentRunIdentityMigration from './migrations/20260520_agents_comms_agent_run_identity'
import * as agentsCommsAgentRunNameLookupMigration from './migrations/20260520_agents_comms_agent_run_name_lookup'
import * as agentsAgentRunRerunSubmissionsMigration from './migrations/20260520_agents_agentrun_rerun_submissions'
import * as agentsCodexRunProjectionMigration from './migrations/20260520_agents_codex_run_projection'
import * as agentsCodexLegacyBackfillMigration from './migrations/20260521_agents_codex_legacy_backfill'
import * as agentsMemoryNotesMigration from './migrations/20260521_agents_memory_notes'
import * as agentsMemoryProviderTablesMigration from './migrations/20260705_agents_memory_provider_tables'
import * as agentsLinearMcpMutationReceiptsMigration from './migrations/20260720_agents_linear_mcp_mutation_receipts'

type MigrationMap = Record<string, Migration>

const REQUIRED_EXTENSIONS = ['vector', 'pgcrypto'] as const

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
  '20260519_agents_comms_agent_messages': agentsCommsAgentMessagesMigration,
  '20260520_agents_agentrun_rerun_submissions': agentsAgentRunRerunSubmissionsMigration,
  '20260520_agents_codex_run_projection': agentsCodexRunProjectionMigration,
  '20260521_agents_codex_legacy_backfill': agentsCodexLegacyBackfillMigration,
  '20260521_agents_memory_notes': agentsMemoryNotesMigration,
  '20260705_agents_memory_provider_tables': agentsMemoryProviderTablesMigration,
  '20260720_agents_linear_mcp_mutation_receipts': agentsLinearMcpMutationReceiptsMigration,
  '20260520_agents_comms_agent_run_identity': agentsCommsAgentRunIdentityMigration,
  '20260520_agents_comms_agent_run_name_lookup': agentsCommsAgentRunNameLookupMigration,
}

const AGENTS_MIGRATION_TABLE = 'agents_kysely_migration'
const AGENTS_MIGRATION_LOCK_TABLE = 'agents_kysely_migration_lock'

export const getRegisteredMigrationNames = () => Object.keys(migrations).sort()

const migrationProvider = new StaticMigrationProvider(migrations)
const migrationPromises = new WeakMap<Db, Promise<void>>()

const resolveMigrationsMode = () => resolveAgentsMigrationsConfig(process.env).mode

const resolveAllowUnorderedMigrations = () => resolveAgentsMigrationsConfig(process.env).allowUnorderedMigrations

const ensureExtensions = async (db: Db) => {
  const { rows: extensionRows } = await sql<{ extname: string }>`
    SELECT extname FROM pg_extension WHERE extname IN ('vector', 'pgcrypto')
  `.execute(db)

  const installed = new Set(extensionRows.map((row) => row.extname))
  const missing = REQUIRED_EXTENSIONS.filter((ext) => !installed.has(ext))
  if (missing.length > 0) {
    throw new Error(
      `missing required Postgres extensions: ${missing.join(', ')}. ` +
        'Install them as a privileged user (e.g. `CREATE EXTENSION vector; CREATE EXTENSION pgcrypto;`) ' +
        'or configure CNPG bootstrap.initdb.postInitApplicationSQL to create them at cluster init.',
    )
  }
}

const runMigrations = async (db: Db) => {
  await ensureExtensions(db)

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

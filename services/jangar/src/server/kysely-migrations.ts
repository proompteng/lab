import { type Migration, type MigrationProvider, Migrator, sql } from 'kysely'

import type { Db } from '~/server/db'
import { resolveMigrationsConfig } from '~/server/migrations-config'
import { getRetiredMigrationEntries, RETIRED_MIGRATION_NAMES } from '~/server/retired-migrations'
import * as initMigration from '~/server/migrations/20251228_init'
import * as terminalSessionsMigration from '~/server/migrations/20260102_terminal_sessions'
import * as jangarGithubPrReviewMigration from '~/server/migrations/20260103_jangar_github_pr_review'
import * as jangarGithubWorktreesMigration from '~/server/migrations/20260104_jangar_github_worktrees'
import * as atlasChunkSearchMigration from '~/server/migrations/20260209_atlas_chunk_search'
import * as torghutQuantControlPlaneMigration from '~/server/migrations/20260212_torghut_quant_control_plane'
import * as torghutMarketContextAgentsMigration from '~/server/migrations/20260226_torghut_market_context_agents'
import * as torghutMarketContextRunLifecycleMigration from '~/server/migrations/20260228_torghut_market_context_run_lifecycle'
import * as jangarGithubWriteActionsAuditContextMigration from '~/server/migrations/20260303_jangar_github_write_actions_audit_context'
import * as jangarGithubWorktreeRefreshStateMigration from '~/server/migrations/20260304_jangar_github_worktree_refresh_state'
import * as torghutSimulationControlPlaneMigration from '~/server/migrations/20260312_torghut_simulation_control_plane'
import * as torghutSimulationControlPlaneV2Migration from '~/server/migrations/20260312_torghut_simulation_control_plane_v2'
import * as torghutQuantMetricsLatestAccountWindowIndexMigration from '~/server/migrations/20260505_torghut_quant_metrics_latest_account_window_index'
import * as torghutQuantPipelineHealthAccountWindowAsofIndexMigration from '~/server/migrations/20260505_torghut_quant_pipeline_health_account_window_asof_index'
import * as torghutQuantPipelineHealthWindowIndexMigration from '~/server/migrations/20260505_torghut_quant_pipeline_health_window_index'
import * as torghutQuantPipelineHealthAccountWindowCreatedAtIndexMigration from '~/server/migrations/20260508_torghut_quant_pipeline_health_account_window_created_at_index'
import * as atlasCodeSearchPerformanceIndexesMigration from '~/server/migrations/20260531_atlas_code_search_performance_indexes'

type MigrationMap = Record<string, Migration>

const REQUIRED_EXTENSIONS = ['vector', 'pgcrypto'] as const

class StaticMigrationProvider implements MigrationProvider {
  constructor(private readonly migrations: MigrationMap) {}

  async getMigrations(): Promise<MigrationMap> {
    return this.migrations
  }
}

const migrations: MigrationMap = {
  ...getRetiredMigrationEntries(),
  '20251228_init': initMigration,
  '20260102_terminal_sessions': terminalSessionsMigration,
  '20260103_jangar_github_pr_review': jangarGithubPrReviewMigration,
  '20260104_jangar_github_worktrees': jangarGithubWorktreesMigration,
  '20260209_atlas_chunk_search': atlasChunkSearchMigration,
  '20260212_torghut_quant_control_plane': torghutQuantControlPlaneMigration,
  '20260226_torghut_market_context_agents': torghutMarketContextAgentsMigration,
  '20260228_torghut_market_context_run_lifecycle': torghutMarketContextRunLifecycleMigration,
  '20260303_jangar_github_write_actions_audit_context': jangarGithubWriteActionsAuditContextMigration,
  '20260304_jangar_github_worktree_refresh_state': jangarGithubWorktreeRefreshStateMigration,
  '20260312_torghut_simulation_control_plane': torghutSimulationControlPlaneMigration,
  '20260312_torghut_simulation_control_plane_v2': torghutSimulationControlPlaneV2Migration,
  '20260505_torghut_quant_metrics_latest_account_window_index': torghutQuantMetricsLatestAccountWindowIndexMigration,
  '20260505_torghut_quant_pipeline_health_account_window_asof_index':
    torghutQuantPipelineHealthAccountWindowAsofIndexMigration,
  '20260505_torghut_quant_pipeline_health_window_index': torghutQuantPipelineHealthWindowIndexMigration,
  '20260508_torghut_quant_pipeline_health_account_window_created_at_index':
    torghutQuantPipelineHealthAccountWindowCreatedAtIndexMigration,
  '20260531_atlas_code_search_performance_indexes': atlasCodeSearchPerformanceIndexesMigration,
}

export const getRegisteredMigrationNames = () => Object.keys(migrations).sort()

const migrationProvider = new StaticMigrationProvider(migrations)
const migrationPromises = new WeakMap<Db, Promise<void>>()

const resolveMigrationsMode = () => resolveMigrationsConfig(process.env).mode

const resolveAllowUnorderedMigrations = () => resolveMigrationsConfig(process.env).allowUnorderedMigrations

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
    // Allow backfilled migration names to be applied safely instead of hard-failing startup.
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
  if (resolveMigrationsConfig(process.env).skipMigrations || resolveMigrationsMode() === 'skip') {
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
  getRegisteredMigrations: getRegisteredMigrationNames,
  getRetiredMigrationNames: () => [...RETIRED_MIGRATION_NAMES].sort(),
  resolveAllowUnorderedMigrations,
}

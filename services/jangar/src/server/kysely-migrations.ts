import { type Migration, type MigrationProvider, Migrator, sql } from 'kysely'

import type { Db } from '~/server/db'
import { resolveMigrationsConfig } from '~/server/migrations-config'
import * as initMigration from '~/server/migrations/20251228_init'
import * as codexJudgeRunMetadataMigration from '~/server/migrations/20251229_codex_judge_run_metadata'
import * as codexJudgeTimeoutsMigration from '~/server/migrations/20251229_codex_judge_timeouts'
import * as rerunSubmissionsMigration from '~/server/migrations/20251229_codex_rerun_submissions'
import * as workflowCommsAgentMessagesMigration from '~/server/migrations/20251229_workflow_comms_agent_messages'
import * as codexJudgeWebhookIndexesMigration from '~/server/migrations/20251230_codex_judge_webhook_indexes'
import * as terminalSessionsMigration from '~/server/migrations/20260102_terminal_sessions'
import * as jangarGithubPrReviewMigration from '~/server/migrations/20260103_jangar_github_pr_review'
import * as jangarGithubWorktreesMigration from '~/server/migrations/20260104_jangar_github_worktrees'
import * as codexJudgeIterationsMigration from '~/server/migrations/20260105_codex_judge_iterations'
import * as jangarPrimitivesMigration from '~/server/migrations/20260111_jangar_primitives'
import * as jangarPrimitivesIndexesMigration from '~/server/migrations/20260111_jangar_primitives_indexes'
import * as agentsControlPlaneCacheMigration from '~/server/migrations/20260205_agents_control_plane_cache'
import * as jangarAgentRunIdempotencyMigration from '~/server/migrations/20260208_jangar_agentrun_idempotency'
import * as atlasChunkSearchMigration from '~/server/migrations/20260209_atlas_chunk_search'
import * as torghutQuantControlPlaneMigration from '~/server/migrations/20260212_torghut_quant_control_plane'
import * as removePromptTuningMigration from '~/server/migrations/20260220_remove_prompt_tuning'
import * as torghutMarketContextAgentsMigration from '~/server/migrations/20260226_torghut_market_context_agents'
import * as torghutMarketContextRunLifecycleMigration from '~/server/migrations/20260228_torghut_market_context_run_lifecycle'
import * as jangarGithubWriteActionsAuditContextMigration from '~/server/migrations/20260303_jangar_github_write_actions_audit_context'
import * as jangarGithubWorktreeRefreshStateMigration from '~/server/migrations/20260304_jangar_github_worktree_refresh_state'
import * as agentsControlPlaneComponentHeartbeatsMigration from '~/server/migrations/20260308_agents_control_plane_component_heartbeats'
import * as torghutSimulationControlPlaneMigration from '~/server/migrations/20260312_torghut_simulation_control_plane'
import * as torghutSimulationControlPlaneV2Migration from '~/server/migrations/20260312_torghut_simulation_control_plane_v2'
import * as embeddingDimension4096Migration from '~/server/migrations/20260418_embedding_dimension_4096'

type MigrationMap = Record<string, Migration>

const REQUIRED_EXTENSIONS = ['vector', 'pgcrypto'] as const

class StaticMigrationProvider implements MigrationProvider {
  constructor(private readonly migrations: MigrationMap) {}

  async getMigrations(): Promise<MigrationMap> {
    return this.migrations
  }
}

const migrations: MigrationMap = {
  '20251228_init': initMigration,
  '20251229_codex_judge_run_metadata': codexJudgeRunMetadataMigration,
  '20251229_codex_judge_timeouts': codexJudgeTimeoutsMigration,
  '20251229_codex_rerun_submissions': rerunSubmissionsMigration,
  '20251229_workflow_comms_agent_messages': workflowCommsAgentMessagesMigration,
  '20251230_codex_judge_webhook_indexes': codexJudgeWebhookIndexesMigration,
  '20260102_terminal_sessions': terminalSessionsMigration,
  '20260103_jangar_github_pr_review': jangarGithubPrReviewMigration,
  '20260104_jangar_github_worktrees': jangarGithubWorktreesMigration,
  '20260105_codex_judge_iterations': codexJudgeIterationsMigration,
  '20260111_jangar_primitives': jangarPrimitivesMigration,
  '20260111_jangar_primitives_indexes': jangarPrimitivesIndexesMigration,
  '20260205_agents_control_plane_cache': agentsControlPlaneCacheMigration,
  '20260208_jangar_agentrun_idempotency': jangarAgentRunIdempotencyMigration,
  '20260209_atlas_chunk_search': atlasChunkSearchMigration,
  '20260212_torghut_quant_control_plane': torghutQuantControlPlaneMigration,
  '20260220_remove_prompt_tuning': removePromptTuningMigration,
  '20260226_torghut_market_context_agents': torghutMarketContextAgentsMigration,
  '20260228_torghut_market_context_run_lifecycle': torghutMarketContextRunLifecycleMigration,
  '20260303_jangar_github_write_actions_audit_context': jangarGithubWriteActionsAuditContextMigration,
  '20260304_jangar_github_worktree_refresh_state': jangarGithubWorktreeRefreshStateMigration,
  '20260308_agents_control_plane_component_heartbeats': agentsControlPlaneComponentHeartbeatsMigration,
  '20260312_torghut_simulation_control_plane': torghutSimulationControlPlaneMigration,
  '20260312_torghut_simulation_control_plane_v2': torghutSimulationControlPlaneV2Migration,
  '20260418_embedding_dimension_4096': embeddingDimension4096Migration,
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
  resolveAllowUnorderedMigrations,
}

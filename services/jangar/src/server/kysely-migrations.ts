import { type Migration, type MigrationProvider, Migrator, sql } from 'kysely'

import type { Db } from '~/server/db'
import * as initMigration from '~/server/migrations/20251228_init'
import * as codexJudgeTimeoutsMigration from '~/server/migrations/20251229_codex_judge_timeouts'
import * as rerunSubmissionsMigration from '~/server/migrations/20251229_codex_rerun_submissions'
import * as workflowCommsAgentMessagesMigration from '~/server/migrations/20251229_workflow_comms_agent_messages'
import * as codexJudgeWebhookIndexesMigration from '~/server/migrations/20251230_codex_judge_webhook_indexes'
import * as terminalSessionsMigration from '~/server/migrations/20260102_terminal_sessions'
import * as jangarGithubPrReviewMigration from '~/server/migrations/20260103_jangar_github_pr_review'
import * as jangarGithubWorktreesMigration from '~/server/migrations/20260104_jangar_github_worktrees'

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
  '20251229_codex_judge_timeouts': codexJudgeTimeoutsMigration,
  '20251229_codex_rerun_submissions': rerunSubmissionsMigration,
  '20251229_workflow_comms_agent_messages': workflowCommsAgentMessagesMigration,
  '20251230_codex_judge_webhook_indexes': codexJudgeWebhookIndexesMigration,
  '20260102_terminal_sessions': terminalSessionsMigration,
  '20260103_jangar_github_pr_review': jangarGithubPrReviewMigration,
  '20260104_jangar_github_worktrees': jangarGithubWorktreesMigration,
}

const migrationProvider = new StaticMigrationProvider(migrations)
const migrationPromises = new WeakMap<Db, Promise<void>>()

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
  if (process.env.JANGAR_SKIP_MIGRATIONS === '1') {
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

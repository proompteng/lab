import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from 'kysely'
import { describe, expect, it } from 'vitest'

import type { AgentsDatabase } from './db'
import { __test__ } from './kysely-migrations'
import { up as grantAuditReader } from './migrations/20261128_agents_audit_reader_grants'
import { up as createCiAuditProjection } from './migrations/20261128_ci_audit_projection'

const listTypeScriptFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) return listTypeScriptFiles(path)
    return entry.endsWith('.ts') && !entry.endsWith('.test.ts') ? [path] : []
  })

const migrationSql = async (up: (db: Kysely<AgentsDatabase>) => Promise<void>) => {
  const statements: string[] = []
  const db = new Kysely<AgentsDatabase>({
    dialect: {
      createDriver: () => new DummyDriver(),
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: ({ level, query }) => {
      if (level === 'query') statements.push(query.sql.replace(/\s+/g, ' ').trim())
    },
  })
  try {
    await up(db)
  } finally {
    await db.destroy()
  }
  return statements
}

describe('Agents migration registration', () => {
  it('keeps the migration provider registry in lockstep with migration files', () => {
    const migrationDir = new URL('./migrations', import.meta.url)
    const migrationFiles = readdirSync(fileURLToPath(migrationDir))
      .filter((name) => name.endsWith('.ts'))
      .map((name) => name.replace(/\.ts$/, ''))
      .sort()

    expect(__test__.getRegisteredMigrations()).toEqual(migrationFiles)
  })

  it('keeps Agents migrations isolated from host application migration history', () => {
    expect(__test__.AGENTS_MIGRATION_TABLE).toBe('agents_kysely_migration')
    expect(__test__.AGENTS_MIGRATION_LOCK_TABLE).toBe('agents_kysely_migration_lock')
    expect(__test__.AGENTS_MIGRATION_TABLE).not.toBe('kysely_migration')
    expect(__test__.AGENTS_MIGRATION_LOCK_TABLE).not.toBe('kysely_migration_lock')
  })

  it('does not reach back into the retired workflow_comms message store', () => {
    const serverDir = fileURLToPath(new URL('.', import.meta.url))
    const matches = listTypeScriptFiles(serverDir).filter((path) =>
      readFileSync(path, 'utf8').includes('workflow_comms.agent_messages'),
    )

    expect(matches).toEqual([])
  })

  it('creates the Codex projection schema before the retained legacy backfill marker', () => {
    const registered = __test__.getRegisteredMigrations()

    expect(registered.indexOf('20260520_agents_codex_run_projection')).toBeGreaterThanOrEqual(0)
    expect(registered.indexOf('20260521_agents_codex_legacy_backfill')).toBeGreaterThan(
      registered.indexOf('20260520_agents_codex_run_projection'),
    )
  })

  it('does not reach back into retired Codex judge storage from Agents server code', () => {
    const serverDir = fileURLToPath(new URL('.', import.meta.url))
    const codexJudgeMatches = listTypeScriptFiles(serverDir).filter((path) =>
      readFileSync(path, 'utf8').includes('codex_judge'),
    )
    const relativeMatches = codexJudgeMatches.map((path) => relative(serverDir, path)).sort()

    expect(relativeMatches).toEqual([])
  })

  it('keeps the retired legacy backfill migration as a no-op registry marker', () => {
    const migrationPath = new URL('./migrations/20260521_agents_codex_legacy_backfill.ts', import.meta.url)
    const normalized = readFileSync(fileURLToPath(migrationPath), 'utf8').toLowerCase().replace(/\s+/g, ' ')

    expect(normalized).not.toContain('codex_judge')
    expect(normalized).toContain('export const up = async')
    expect(normalized).toContain('retained only so already-applied production migration history remains stable')
  })
})

describe('Agents audit reader migration', () => {
  it('replays a guarded, replaceable projection with only the approved read grants', async () => {
    const statements = await migrationSql(async (db) => {
      await grantAuditReader(db)
      await grantAuditReader(db)
    })

    const [statement] = statements
    expect(statements).toEqual([statement, statement])
    expect(statement).toMatch(
      /^DO \$migration\$ BEGIN IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'agents_audit_ro'\) THEN CREATE SCHEMA IF NOT EXISTS agents_audit;/,
    )
    expect(statement).not.toMatch(/(?:THEN|;) CREATE (?!OR REPLACE VIEW|SCHEMA IF NOT EXISTS)/)
    expect(statement).toContain('REVOKE ALL PRIVILEGES ON SCHEMA')
    expect(statement).toContain('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA')
    expect(statement).toContain('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA')
    expect(statement).toContain('REVOKE CREATE, TEMPORARY ON DATABASE %I FROM PUBLIC, agents_audit_ro')
    expect(statement?.match(/\bGRANT [^;]+/g)).toEqual([
      'GRANT USAGE ON SCHEMA public, agents_audit TO agents_audit_ro',
      'GRANT SELECT ON TABLE agents_audit.agent_runs, agents_audit.agent_messages, agents_audit.memory_notes, ' +
        'agents_audit.codex_run_projection, agents_audit.relay_submissions, agents_audit.agent_run_rerun_submissions, ' +
        'agents_audit.agent_run_activity TO agents_audit_ro',
    ])
    expect(statement).not.toMatch(/\b(connection_secret|content|prompt|request_payload|response_payload)\b|SELECT \*/)
  })
})

describe('CI audit projection migration', () => {
  it('creates indexed facts even without login roles and grants only schema-scoped access', async () => {
    const [statement] = await migrationSql(createCiAuditProjection)

    expect(statement?.split('DO $grants$')[0]).toMatch(
      /^CREATE SCHEMA IF NOT EXISTS ci_audit; CREATE TABLE IF NOT EXISTS ci_audit\.workflow_runs \( run_id bigint PRIMARY KEY,/,
    )
    expect(statement).toContain('run_id bigint NOT NULL REFERENCES ci_audit.workflow_runs (run_id)')
    expect(statement).toContain(
      'CREATE TABLE IF NOT EXISTS ci_audit.failure_clusters ( cluster_key varchar(64) PRIMARY KEY',
    )
    expect(statement).toContain('ON ci_audit.workflow_runs (updated_at DESC, run_id)')
    expect(statement).toContain('ON ci_audit.job_runs (run_id, job_id)')
    expect(statement).toContain('ON ci_audit.job_runs (completed_at DESC) WHERE failure_category IS NOT NULL')
    expect(statement).toContain('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ci_audit FROM PUBLIC')
    expect(statement).toContain("IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agents_audit_ro') THEN")
    expect(statement).toContain("IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ci_audit_writer') THEN")
    expect(statement?.match(/(?:ALTER DEFAULT PRIVILEGES IN SCHEMA ci_audit )?\bGRANT [^;]+/g)).toEqual([
      'GRANT USAGE ON SCHEMA ci_audit TO agents_audit_ro',
      'GRANT SELECT ON ALL TABLES IN SCHEMA ci_audit TO agents_audit_ro',
      'ALTER DEFAULT PRIVILEGES IN SCHEMA ci_audit GRANT SELECT ON TABLES TO agents_audit_ro',
      'GRANT USAGE ON SCHEMA ci_audit TO ci_audit_writer',
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ci_audit TO ci_audit_writer',
    ])
  })
})

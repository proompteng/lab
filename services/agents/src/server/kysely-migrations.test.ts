import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { __test__ } from './kysely-migrations'

const listTypeScriptFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) return listTypeScriptFiles(path)
    return entry.endsWith('.ts') && !entry.endsWith('.test.ts') ? [path] : []
  })

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

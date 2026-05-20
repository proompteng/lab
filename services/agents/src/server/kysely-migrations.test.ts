import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
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
})

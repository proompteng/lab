import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { __test__ } from '../kysely-migrations'

describe('migration registration', () => {
  it('keeps the migration provider registry in lockstep with migration files', () => {
    const migrationDir = new URL('../migrations', import.meta.url)
    const migrationFiles = readdirSync(fileURLToPath(migrationDir))
      .filter((name) => name.endsWith('.ts'))
      .map((name) => name.replace(/\.ts$/, ''))
      .sort()

    expect(__test__.getRegisteredMigrations()).toEqual(migrationFiles)
  })
})

describe('resolveAllowUnorderedMigrations', () => {
  const previous = process.env.JANGAR_ALLOW_UNORDERED_MIGRATIONS

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.JANGAR_ALLOW_UNORDERED_MIGRATIONS
    } else {
      process.env.JANGAR_ALLOW_UNORDERED_MIGRATIONS = previous
    }
  })

  it('defaults to enabled', () => {
    delete process.env.JANGAR_ALLOW_UNORDERED_MIGRATIONS
    expect(__test__.resolveAllowUnorderedMigrations()).toBe(true)
  })

  it('disables unordered migrations for explicit false values', () => {
    process.env.JANGAR_ALLOW_UNORDERED_MIGRATIONS = 'false'
    expect(__test__.resolveAllowUnorderedMigrations()).toBe(false)

    process.env.JANGAR_ALLOW_UNORDERED_MIGRATIONS = '0'
    expect(__test__.resolveAllowUnorderedMigrations()).toBe(false)
  })

  it('enables unordered migrations for truthy values', () => {
    process.env.JANGAR_ALLOW_UNORDERED_MIGRATIONS = 'true'
    expect(__test__.resolveAllowUnorderedMigrations()).toBe(true)
  })
})

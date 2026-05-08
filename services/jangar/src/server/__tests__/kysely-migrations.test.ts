import { readFileSync, readdirSync } from 'node:fs'
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

  it('keeps the Torghut quant pipeline health account/window index registered', () => {
    const migrationPath = new URL(
      '../migrations/20260505_torghut_quant_pipeline_health_window_index.ts',
      import.meta.url,
    )
    const normalized = readFileSync(fileURLToPath(migrationPath), 'utf8').toLowerCase().replace(/\s+/g, ' ')

    expect(normalized).toContain('create index if not exists torghut_quant_pipeline_health_account_window_latest_idx')
    expect(normalized).toContain('on torghut_control_plane.quant_pipeline_health')
    expect(normalized).toContain("(account, ((details->>'window')), strategy_id, stage, as_of desc)")
  })

  it('keeps the Torghut quant pipeline health account/window/as-of index registered', () => {
    const migrationPath = new URL(
      '../migrations/20260505_torghut_quant_pipeline_health_account_window_asof_index.ts',
      import.meta.url,
    )
    const normalized = readFileSync(fileURLToPath(migrationPath), 'utf8').toLowerCase().replace(/\s+/g, ' ')

    expect(normalized).toContain('create index if not exists torghut_quant_pipeline_health_account_window_asof_idx')
    expect(normalized).toContain('on torghut_control_plane.quant_pipeline_health')
    expect(normalized).toContain("(account, ((details->>'window')), as_of desc)")
  })

  it('keeps the Torghut quant pipeline health created-at index out of startup migrations', () => {
    const migrationPath = new URL(
      '../migrations/20260508_torghut_quant_pipeline_health_account_window_created_at_index.ts',
      import.meta.url,
    )
    const normalized = readFileSync(fileURLToPath(migrationPath), 'utf8').toLowerCase().replace(/\s+/g, ' ')

    expect(normalized).toContain('performance-only index')
    expect(normalized).toContain('non-blocking')
    expect(normalized).not.toContain('create index')
  })

  it('keeps the Torghut latest quant metric account/window index registered', () => {
    const migrationPath = new URL(
      '../migrations/20260505_torghut_quant_metrics_latest_account_window_index.ts',
      import.meta.url,
    )
    const normalized = readFileSync(fileURLToPath(migrationPath), 'utf8').toLowerCase().replace(/\s+/g, ' ')

    expect(normalized).toContain('create index if not exists torghut_qm_latest_account_window_idx')
    expect(normalized).toContain('on torghut_control_plane.quant_metrics_latest(account, "window")')
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

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
    const expectedRegisteredMigrations = [...migrationFiles, ...__test__.getRetiredMigrationNames()].sort()

    expect(__test__.getRegisteredMigrations()).toEqual(expectedRegisteredMigrations)
  })

  it('keeps Agents-owned historical migrations registered only as central tombstones', () => {
    const migrationDir = new URL('../migrations', import.meta.url)
    const migrationFiles = new Set(
      readdirSync(fileURLToPath(migrationDir))
        .filter((name) => name.endsWith('.ts'))
        .map((name) => name.replace(/\.ts$/, '')),
    )

    for (const name of __test__.getRetiredMigrationNames()) {
      expect(__test__.getRegisteredMigrations()).toContain(name)
      expect(migrationFiles).not.toContain(name)
    }
  })

  it('does not create the retired Codex judge schema from Jangar bootstrap migrations', () => {
    const migrationPath = new URL('../migrations/20251228_init.ts', import.meta.url)
    const normalized = readFileSync(fileURLToPath(migrationPath), 'utf8').toLowerCase()

    expect(normalized).not.toContain('create schema if not exists codex_judge')
    expect(normalized).not.toContain("sql.ref('codex_judge.")
    expect(normalized).not.toContain('references codex_judge.')
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

  it('keeps the Torghut quant pipeline health created-at hotfix migration non-blocking', () => {
    const migrationPath = new URL(
      '../migrations/20260508_torghut_quant_pipeline_health_account_window_created_at_index.ts',
      import.meta.url,
    )
    const normalized = readFileSync(fileURLToPath(migrationPath), 'utf8').toLowerCase().replace(/\s+/g, ' ')

    expect(normalized).toContain('keep the migration name registered')
    expect(normalized).toContain('heavyweight ddl')
    expect(normalized).not.toContain('create index')
    expect(normalized).not.toContain('drop index')
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

  it('creates the constant-time pipeline-health latest-state replacement', () => {
    const migrationPath = new URL('../migrations/20260715_torghut_quant_pipeline_health_latest.ts', import.meta.url)
    const normalized = readFileSync(fileURLToPath(migrationPath), 'utf8').toLowerCase().replace(/\s+/g, ' ')

    expect(normalized).toContain('create table if not exists')
    expect(normalized).toContain('quant_pipeline_health_latest')
    expect(normalized).toContain('primary key (strategy_id, account, "window", stage)')
    expect(normalized).not.toContain('select distinct')
    expect(normalized).not.toContain('insert into')
    expect(normalized).not.toContain('quant_pipeline_health;')
  })

  it('keeps the no-copy quant-series active-store migration rollback-compatible', () => {
    const migrationPath = new URL('../migrations/20260715_torghut_quant_series_active.ts', import.meta.url)
    const normalized = readFileSync(fileURLToPath(migrationPath), 'utf8').toLowerCase().replace(/\s+/g, ' ')

    expect(normalized).toContain('partition_count = 16')
    expect(normalized).toContain('partition by hash (strategy_id)')
    expect(normalized).toContain('using brin (as_of)')
    expect(normalized).toContain('create view torghut_control_plane.quant_metrics_series as')
    expect(normalized).toContain('instead of insert on torghut_control_plane.quant_metrics_series')
    expect(normalized).toContain('on conflict (id) do nothing')
    expect(normalized).toContain(
      'lock table torghut_control_plane.quant_metrics_series, torghut_control_plane.quant_metrics_series_active in access exclusive mode',
    )
    expect(normalized).not.toContain('vacuum full')
    expect(normalized).not.toContain('reindex')
    expect(normalized).not.toContain('unlogged')
  })

  it('removes every unused quant-series relation without broad cascading', () => {
    const migrationPath = new URL('../migrations/20260715_torghut_quant_series_remove.ts', import.meta.url)
    const normalized = readFileSync(fileURLToPath(migrationPath), 'utf8').toLowerCase().replace(/\s+/g, ' ')

    expect(normalized).toContain('drop view if exists torghut_control_plane.quant_metrics_series')
    expect(normalized).toContain('drop function if exists torghut_control_plane.insert_quant_metrics_series_active()')
    expect(normalized).toContain('drop table if exists torghut_control_plane.quant_metrics_series_active')
    expect(normalized).toContain('drop table if exists torghut_control_plane.quant_metrics_series_legacy')
    expect(normalized).not.toContain('cascade')
    expect(normalized).not.toContain('insert into')
    expect(normalized).not.toContain('export const down')
  })

  it('makes rebuildable quant state unlogged without a compatibility path', () => {
    const migrationPath = new URL('../migrations/20260715_torghut_quant_state_cache_unlogged.ts', import.meta.url)
    const normalized = readFileSync(fileURLToPath(migrationPath), 'utf8').toLowerCase().replace(/\s+/g, ' ')

    expect(normalized).toContain('drop index torghut_control_plane.torghut_quant_pipeline_health_latest_freshness_idx')
    expect(normalized).toContain('alter table torghut_control_plane.quant_metrics_latest set (fillfactor = 70)')
    expect(normalized).toContain('alter table torghut_control_plane.quant_metrics_latest set unlogged')
    expect(normalized).toContain('alter table torghut_control_plane.quant_pipeline_health_latest set (fillfactor = 70)')
    expect(normalized).toContain('alter table torghut_control_plane.quant_pipeline_health_latest set unlogged')
    expect(normalized).not.toContain('if exists')
    expect(normalized).not.toContain('set logged')
    expect(normalized).not.toContain('export const down')
  })

  it('keeps the Codex judge AgentRun column migration registered as a retired Agents backfill handoff', () => {
    expect(__test__.getRegisteredMigrations()).toContain('20260520_codex_judge_agentrun_columns')
    expect(__test__.getRetiredMigrationNames()).toContain('20260520_codex_judge_agentrun_columns')
  })

  it('keeps the Atlas migration a destructive single-corpus 1024-dimensional HNSW reset without deleting history', () => {
    const migrationPath = new URL('../migrations/20260714_atlas_current_corpus.ts', import.meta.url)
    const normalized = readFileSync(fileURLToPath(migrationPath), 'utf8').toLowerCase().replace(/\s+/g, ' ')

    expect(normalized).toContain('truncate table atlas.file_keys, atlas.symbols cascade')
    expect(normalized).toContain("'indexstatus', 'maintenance'")
    expect(normalized).not.toContain('truncate table atlas.repositories')
    expect(normalized).toContain('alter column embedding type vector(${sql.raw(string(atlas_embedding_dimension))})')
    expect(normalized).toContain('const atlas_embedding_dimension = 1024')
    expect(normalized).toContain('using hnsw (embedding vector_cosine_ops)')
    expect(normalized).toContain('create unique index atlas_file_versions_file_key_id_unique_idx')
    expect(normalized).toContain('using gin (path gin_trgm_ops)')
    expect(normalized).toContain("check (jsonb_typeof(metadata) = 'object')")
    expect(normalized).not.toContain('backup')
    expect(normalized).not.toContain('create table')
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

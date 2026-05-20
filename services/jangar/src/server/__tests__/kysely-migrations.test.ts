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

  it('keeps Agents-owned historical migrations as no-op tombstones', () => {
    const tombstoneMigrationFiles = [
      '20251229_codex_judge_run_metadata',
      '20251229_codex_judge_timeouts',
      '20251229_codex_rerun_submissions',
      '20251229_workflow_comms_agent_messages',
      '20251230_codex_judge_webhook_indexes',
      '20260105_codex_judge_iterations',
      '20260111_jangar_primitives',
      '20260111_jangar_primitives_indexes',
      '20260205_agents_control_plane_cache',
      '20260208_jangar_agentrun_idempotency',
      '20260220_remove_prompt_tuning',
      '20260308_agents_control_plane_component_heartbeats',
      '20260520_codex_judge_agentrun_columns',
      '20260520_drop_codex_rerun_submissions',
    ]
    const ddlPatterns = [
      /\bsql`/i,
      /\bcreate\s+(schema|table|index|unique\s+index)\b/i,
      /\balter\s+table\b/i,
      /\binsert\s+into\b/i,
      /\bdelete\s+from\b/i,
      /\bdrop\s+(schema|table|index)\b/i,
    ]

    for (const name of tombstoneMigrationFiles) {
      expect(__test__.getRegisteredMigrations()).toContain(name)
      const migrationPath = new URL(`../migrations/${name}.ts`, import.meta.url)
      const content = readFileSync(fileURLToPath(migrationPath), 'utf8')

      for (const pattern of ddlPatterns) {
        expect(content).not.toMatch(pattern)
      }
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

  it('keeps the Codex judge AgentRun column migration registered as an Agents backfill handoff', () => {
    const migrationPath = new URL('../migrations/20260520_codex_judge_agentrun_columns.ts', import.meta.url)
    const normalized = readFileSync(fileURLToPath(migrationPath), 'utf8').toLowerCase().replace(/\s+/g, ' ')

    expect(__test__.getRegisteredMigrations()).toContain('20260520_codex_judge_agentrun_columns')
    expect(normalized).toContain('projection backfill')
    expect(normalized).not.toContain('rename column')
    expect(normalized).not.toContain('create unique index')
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

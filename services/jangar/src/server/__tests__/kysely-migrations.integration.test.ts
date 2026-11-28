import { randomUUID } from 'node:crypto'

import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'

import { createKyselyDb } from '../db'
import { ensureMigrations } from '../kysely-migrations'

const databaseUrl = process.env.ATLAS_INTEGRATION_DATABASE_URL?.trim()

describe.skipIf(!databaseUrl && process.env.ATLAS_REQUIRE_INTEGRATION_TESTS !== '1')('Jangar migrations', () => {
  it('requires explicit market context providers after migrating a fresh database', async () => {
    if (!databaseUrl) throw new Error('ATLAS_INTEGRATION_DATABASE_URL is required')

    const databaseName = `jangar_migrations_${randomUUID().replaceAll('-', '')}`
    const url = new URL(databaseUrl)
    url.pathname = `/${databaseName}`
    // Reproduce the Atlas CI search path regardless of the test login's name.
    url.searchParams.set('options', '-c search_path=atlas,public')

    const admin = createKyselyDb(databaseUrl)
    try {
      await sql`CREATE DATABASE ${sql.id(databaseName)} TEMPLATE template0`.execute(admin)
      try {
        const db = createKyselyDb(url.toString())
        try {
          await sql`CREATE EXTENSION vector WITH SCHEMA public`.execute(db)
          await sql`CREATE EXTENSION pgcrypto WITH SCHEMA public`.execute(db)
          await ensureMigrations(db)

          const { rows } = await sql<{ table_name: string; column_default: string | null; is_nullable: string }>`
            SELECT table_name, column_default, is_nullable
            FROM information_schema.columns
            WHERE table_schema = 'atlas'
              AND table_name IN ('torghut_market_context_runs', 'torghut_market_context_snapshots')
              AND column_name = 'provider'
            ORDER BY table_name
          `.execute(db)
          expect(rows).toEqual([
            { table_name: 'torghut_market_context_runs', column_default: null, is_nullable: 'NO' },
            { table_name: 'torghut_market_context_snapshots', column_default: null, is_nullable: 'NO' },
          ])
        } finally {
          await db.destroy()
        }
      } finally {
        await sql`DROP DATABASE ${sql.id(databaseName)}`.execute(admin)
      }
    } finally {
      await admin.destroy()
    }
  })
})

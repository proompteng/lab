import { sql } from 'kysely'

import type { Db } from '~/server/db'

export type TorghutAssetClass = 'equity' | 'crypto'

export type TorghutSymbol = {
  assetClass: TorghutAssetClass
  enabled: boolean
  symbol: string
  updatedAt: string
}

let schemaEnsured = false

const ensureSchema = async (db: Db) => {
  if (schemaEnsured) return

  await sql`
    create table if not exists torghut_symbols (
      symbol text primary key,
      enabled boolean not null default true,
      asset_class text not null default 'equity',
      updated_at timestamptz not null default now()
    )
  `.execute(db)
  await sql`create index if not exists torghut_symbols_enabled_idx on torghut_symbols (enabled)`.execute(db)
  await sql`create index if not exists torghut_symbols_asset_class_idx on torghut_symbols (asset_class)`.execute(db)

  schemaEnsured = true
}

export const normalizeTorghutSymbol = (raw: string) => raw.trim().toUpperCase()

const normalizeAssetClass = (raw: unknown): TorghutAssetClass => {
  if (raw === 'crypto') return 'crypto'
  return 'equity'
}

export const listTorghutSymbols = async ({
  db,
  assetClass,
  includeDisabled,
}: {
  assetClass: TorghutAssetClass
  db: Db
  includeDisabled: boolean
}): Promise<TorghutSymbol[]> => {
  await ensureSchema(db)

  let query = db
    .selectFrom('torghut_symbols')
    .select(['symbol', 'enabled', 'asset_class', 'updated_at'])
    .where('asset_class', '=', assetClass)

  if (!includeDisabled) {
    query = query.where('enabled', '=', true)
  }

  const rows = await query.orderBy('symbol', 'asc').execute()

  return rows.map((row) => ({
    assetClass: normalizeAssetClass(row.asset_class),
    enabled: row.enabled,
    symbol: row.symbol,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  }))
}

export const upsertTorghutSymbols = async ({
  db,
  symbols,
  enabled,
  assetClass,
}: {
  assetClass: TorghutAssetClass
  db: Db
  enabled: boolean
  symbols: string[]
}): Promise<{ insertedOrUpdated: number; symbols: string[] }> => {
  await ensureSchema(db)

  const normalizedSymbols = symbols.map(normalizeTorghutSymbol).filter((symbol) => symbol.length > 0)

  const deduped = [...new Set(normalizedSymbols)]
  if (deduped.length === 0) return { insertedOrUpdated: 0, symbols: [] }

  await db
    .insertInto('torghut_symbols')
    .values(
      deduped.map((symbol) => ({
        symbol,
        enabled,
        asset_class: assetClass,
        updated_at: sql`now()`,
      })),
    )
    .onConflict((oc) =>
      oc.column('symbol').doUpdateSet({
        enabled: sql`excluded.enabled`,
        asset_class: sql`excluded.asset_class`,
        updated_at: sql`excluded.updated_at`,
      }),
    )
    .execute()

  return { insertedOrUpdated: deduped.length, symbols: deduped }
}

export const setTorghutSymbolEnabled = async ({
  db,
  symbol,
  enabled,
  assetClass,
}: {
  assetClass?: TorghutAssetClass
  db: Db
  enabled: boolean
  symbol: string
}) => {
  await ensureSchema(db)

  const normalized = normalizeTorghutSymbol(symbol)
  const updatedRow = await db
    .updateTable('torghut_symbols')
    .set({
      enabled,
      updated_at: sql`now()`,
    })
    .where('symbol', '=', normalized)
    .returning(['asset_class'])
    .executeTakeFirst()

  if (updatedRow) return

  await db
    .insertInto('torghut_symbols')
    .values({
      symbol: normalized,
      enabled,
      asset_class: assetClass ?? 'equity',
      updated_at: sql`now()`,
    })
    .execute()
}

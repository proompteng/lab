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

  const rows = includeDisabled
    ? (
        await sql<{
          asset_class: string
          enabled: boolean
          symbol: string
          updated_at: Date
        }>`
          select symbol, enabled, asset_class, updated_at
          from torghut_symbols
          where asset_class = ${assetClass}
          order by symbol asc
        `.execute(db)
      ).rows
    : (
        await sql<{
          asset_class: string
          enabled: boolean
          symbol: string
          updated_at: Date
        }>`
          select symbol, enabled, asset_class, updated_at
          from torghut_symbols
          where asset_class = ${assetClass} and enabled = true
          order by symbol asc
        `.execute(db)
      ).rows

  return rows.map((row) => ({
    assetClass: normalizeAssetClass(row.asset_class),
    enabled: row.enabled,
    symbol: row.symbol,
    updatedAt: row.updated_at.toISOString(),
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

  const symbolsArray = sql`${deduped}::text[]`
  await sql`
    insert into torghut_symbols (symbol, enabled, asset_class, updated_at)
    select symbol, ${enabled}, ${assetClass}, now()
    from unnest(${symbolsArray}) as symbols(symbol)
    on conflict (symbol) do update
    set
      enabled = excluded.enabled,
      asset_class = excluded.asset_class,
      updated_at = excluded.updated_at
  `.execute(db)

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
  const updatedRows = (
    await sql<{ asset_class: string }>`
      update torghut_symbols
      set enabled = ${enabled}, updated_at = now()
      where symbol = ${normalized}
      returning asset_class
    `.execute(db)
  ).rows
  if (updatedRows.length > 0) return

  await sql`
    insert into torghut_symbols (symbol, enabled, asset_class, updated_at)
    values (${normalized}, ${enabled}, ${assetClass ?? 'equity'}, now())
  `.execute(db)
}

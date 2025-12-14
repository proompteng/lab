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

  await db`
    create table if not exists torghut_symbols (
      symbol text primary key,
      enabled boolean not null default true,
      asset_class text not null default 'equity',
      updated_at timestamptz not null default now()
    )
  `
  await db`create index if not exists torghut_symbols_enabled_idx on torghut_symbols (enabled)`
  await db`create index if not exists torghut_symbols_asset_class_idx on torghut_symbols (asset_class)`

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

  const rows: Array<{
    asset_class: string
    enabled: boolean
    symbol: string
    updated_at: Date
  }> = includeDisabled
    ? await db`
        select symbol, enabled, asset_class, updated_at
        from torghut_symbols
        where asset_class = ${assetClass}
        order by symbol asc
      `
    : await db`
        select symbol, enabled, asset_class, updated_at
        from torghut_symbols
        where asset_class = ${assetClass} and enabled = true
        order by symbol asc
      `

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

  const symbolsArray = db.array(deduped, 'TEXT')
  await db`
    insert into torghut_symbols (symbol, enabled, asset_class, updated_at)
    select symbol, ${enabled}, ${assetClass}, now()
    from unnest(${symbolsArray}) as symbols(symbol)
    on conflict (symbol) do update
    set
      enabled = excluded.enabled,
      asset_class = excluded.asset_class,
      updated_at = excluded.updated_at
  `

  return { insertedOrUpdated: deduped.length, symbols: deduped }
}

export const setTorghutSymbolEnabled = async ({
  db,
  symbol,
  enabled,
}: {
  db: Db
  enabled: boolean
  symbol: string
}) => {
  await ensureSchema(db)

  const normalized = normalizeTorghutSymbol(symbol)
  await db`
    insert into torghut_symbols (symbol, enabled, asset_class, updated_at)
    values (${normalized}, ${enabled}, 'equity', now())
    on conflict (symbol) do update
    set enabled = excluded.enabled, updated_at = excluded.updated_at
  `
}

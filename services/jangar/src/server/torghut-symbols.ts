import { sql } from 'kysely'

import type { Db } from '~/server/db'
import { ensureMigrations } from '~/server/kysely-migrations'

export type TorghutAssetClass = 'equity' | 'crypto'

export type TorghutSymbol = {
  assetClass: TorghutAssetClass
  enabled: boolean
  symbol: string
  updatedAt: string
}

const EQUITY_SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,11}$/
const CRYPTO_SYMBOL_PATTERN = /^[A-Z0-9]{2,15}(?:[-/][A-Z0-9]{2,15})$/

const ensureSchema = async (db: Db) => {
  await ensureMigrations(db)
}

export const normalizeTorghutSymbol = (raw: string) => raw.trim().toUpperCase()

export const isValidTorghutSymbol = (symbol: string, assetClass: TorghutAssetClass) => {
  if (assetClass === 'crypto') return CRYPTO_SYMBOL_PATTERN.test(symbol)
  return EQUITY_SYMBOL_PATTERN.test(symbol)
}

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
}): Promise<{ insertedOrUpdated: number; rejected: string[]; symbols: string[] }> => {
  await ensureSchema(db)

  const normalizedSymbols = symbols.map(normalizeTorghutSymbol).filter((symbol) => symbol.length > 0)

  const uniqueSymbols = [...new Set(normalizedSymbols)]
  const deduped = uniqueSymbols.filter((symbol) => isValidTorghutSymbol(symbol, assetClass))
  const rejected = uniqueSymbols.filter((symbol) => !isValidTorghutSymbol(symbol, assetClass))
  if (deduped.length === 0) return { insertedOrUpdated: 0, rejected, symbols: [] }

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

  return { insertedOrUpdated: deduped.length, rejected, symbols: deduped }
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

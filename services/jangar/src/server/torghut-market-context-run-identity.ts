import type { Db } from '~/server/db'
import { normalizeTorghutSymbol } from '~/server/torghut-symbols'

type MarketContextRunIdentityInput = {
  requestId: string
  storedSymbol: string
  storedDomain: 'news'
  symbol: unknown
  domain: unknown
}

export const parseMarketContextRunIdentifier = (value: unknown) => {
  const requestId = typeof value === 'string' ? value.trim() : ''
  if (!requestId) throw new Error('requestId is required')
  return requestId
}

export const resolveMarketContextRunIdentity = (input: MarketContextRunIdentityInput) => {
  const symbolInput = typeof input.symbol === 'string' ? input.symbol.trim() : ''
  const symbol = symbolInput === '*' ? '*' : symbolInput ? normalizeTorghutSymbol(symbolInput) : input.storedSymbol
  if (!symbol) throw new Error('symbol is required')

  const domainInput = typeof input.domain === 'string' ? input.domain.trim().toLowerCase() : ''
  const domain = domainInput ? (domainInput === 'news' ? 'news' : null) : input.storedDomain
  if (!domain) throw new Error('domain must be news; fundamentals market-context runs are retired')

  if (symbol !== input.storedSymbol || domain !== input.storedDomain) {
    throw new Error(
      `run identity mismatch for requestId ${input.requestId}: expected ${input.storedSymbol}/${input.storedDomain}, received ${symbol}/${domain}`,
    )
  }
  return { symbol, domain }
}

export const validateMarketContextIngestRunIdentity = async (input: {
  db: Db
  requestId: string | null
  symbol: unknown
  domain: 'news'
  batch: boolean
}) => {
  const symbolInput = typeof input.symbol === 'string' ? input.symbol.trim() : ''
  const symbol = input.batch ? '*' : normalizeTorghutSymbol(symbolInput)
  if (!symbol) throw new Error('symbol is required')
  if (!input.requestId) return symbol
  const stored = await input.db
    .selectFrom('torghut_market_context_runs')
    .select(['symbol', 'domain'])
    .where('request_id', '=', input.requestId)
    .executeTakeFirst()
  if (!stored) return symbol
  const storedDomain = stored.domain.trim().toLowerCase()
  if (storedDomain !== 'news') {
    throw new Error(`run domain is invalid for requestId ${input.requestId}`)
  }
  return resolveMarketContextRunIdentity({
    requestId: input.requestId,
    storedSymbol: stored.symbol,
    storedDomain,
    symbol,
    domain: input.domain,
  }).symbol
}

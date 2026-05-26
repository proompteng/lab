import { z } from 'zod'

import { normalizeCompanySymbol } from '~/lib/company-symbols'

export type CompanyMetric = {
  label: string
  value: string
}

export type CompanyAnalysis = {
  symbol: string
  identity: {
    name: string
    exchange: string | null
    sector: string | null
    industry: string | null
    description: string | null
  }
  fundamentals: CompanyMetric[]
  technicals: CompanyMetric[]
  financials: CompanyMetric[]
  source: string
  updatedAt: string
}

export type CompanyDataProvider = {
  getCompanyAnalysis(symbol: string): Promise<CompanyAnalysis>
}

const alphaVantageErrorSchema = z
  .object({
    Note: z.string().optional(),
    Information: z.string().optional(),
    'Error Message': z.string().optional(),
  })
  .passthrough()

const overviewSchema = z
  .object({
    Symbol: z.string().optional(),
    Name: z.string().optional(),
    Exchange: z.string().optional(),
    Sector: z.string().optional(),
    Industry: z.string().optional(),
    Description: z.string().optional(),
    MarketCapitalization: z.string().optional(),
    PERatio: z.string().optional(),
    EPS: z.string().optional(),
    DividendYield: z.string().optional(),
    Beta: z.string().optional(),
    AnalystTargetPrice: z.string().optional(),
    ProfitMargin: z.string().optional(),
    RevenueTTM: z.string().optional(),
    EBITDA: z.string().optional(),
    QuarterlyRevenueGrowthYOY: z.string().optional(),
    QuarterlyEarningsGrowthYOY: z.string().optional(),
    GrossProfitTTM: z.string().optional(),
    FiscalYearEnd: z.string().optional(),
    '52WeekHigh': z.string().optional(),
    '52WeekLow': z.string().optional(),
    '50DayMovingAverage': z.string().optional(),
    '200DayMovingAverage': z.string().optional(),
  })
  .passthrough()

const quoteSchema = z
  .object({
    'Global Quote': z
      .object({
        '05. price': z.string().optional(),
        '09. change': z.string().optional(),
        '10. change percent': z.string().optional(),
      })
      .optional(),
  })
  .passthrough()

const rsiSchema = z
  .object({
    'Technical Analysis: RSI': z.record(z.string(), z.object({ RSI: z.string().optional() })).optional(),
  })
  .passthrough()

const cleanValue = (value: string | null | undefined) => {
  if (!value || value === 'None' || value === '-' || value === '0') return null
  return value
}

const formatNumber = (value: string | null | undefined) => {
  const cleaned = cleanValue(value)
  if (!cleaned) return null
  const parsed = Number(cleaned)
  if (!Number.isFinite(parsed)) return cleaned
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(parsed)
}

const formatCurrency = (value: string | null | undefined) => {
  const cleaned = cleanValue(value)
  if (!cleaned) return null
  const parsed = Number(cleaned)
  if (!Number.isFinite(parsed)) return cleaned
  return new Intl.NumberFormat('en-US', {
    currency: 'USD',
    maximumFractionDigits: parsed >= 100 ? 0 : 2,
    style: 'currency',
  }).format(parsed)
}

const formatLargeCurrency = (value: string | null | undefined) => {
  const cleaned = cleanValue(value)
  if (!cleaned) return null
  const parsed = Number(cleaned)
  if (!Number.isFinite(parsed)) return cleaned
  return new Intl.NumberFormat('en-US', {
    currency: 'USD',
    maximumFractionDigits: 2,
    notation: 'compact',
    style: 'currency',
  }).format(parsed)
}

const formatPercent = (value: string | null | undefined) => {
  const cleaned = cleanValue(value)
  if (!cleaned) return null
  const withoutPercent = cleaned.replace(/%$/, '')
  const parsed = Number(withoutPercent)
  if (!Number.isFinite(parsed)) return cleaned
  const percent = cleaned.endsWith('%') || Math.abs(parsed) > 1 ? parsed : parsed * 100
  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(percent)}%`
}

const metric = (label: string, value: string | null | undefined): CompanyMetric | null => {
  const cleaned = cleanValue(value)
  return cleaned ? { label, value: cleaned } : null
}

const compactMetrics = (metrics: Array<CompanyMetric | null>) =>
  metrics.filter((item): item is CompanyMetric => Boolean(item))

const assertAlphaVantagePayload = (payload: unknown, symbol: string) => {
  const error = alphaVantageErrorSchema.parse(payload)
  if (error.Note || error.Information || error['Error Message']) {
    throw new Error(
      error.Note ?? error.Information ?? error['Error Message'] ?? `market data unavailable for ${symbol}`,
    )
  }
}

class AlphaVantageCompanyDataProvider implements CompanyDataProvider {
  private readonly apiKey: string
  private readonly fetchImpl: typeof fetch

  constructor(apiKey: string, fetchImpl: typeof fetch = fetch) {
    this.apiKey = apiKey
    this.fetchImpl = fetchImpl
  }

  async getCompanyAnalysis(symbol: string): Promise<CompanyAnalysis> {
    const normalized = normalizeCompanySymbol(symbol)
    if (!normalized) throw new Error(`unsupported company symbol: ${symbol}`)

    const [overviewPayload, quotePayload, rsiPayload] = await Promise.all([
      this.request({ function: 'OVERVIEW', symbol: normalized }),
      this.request({ function: 'GLOBAL_QUOTE', symbol: normalized }),
      this.request({ function: 'RSI', symbol: normalized, interval: 'daily', time_period: '14', series_type: 'close' }),
    ])

    const overview = overviewSchema.parse(overviewPayload)
    const quote = quoteSchema.parse(quotePayload)['Global Quote']
    const rsiEntries = rsiSchema.parse(rsiPayload)['Technical Analysis: RSI'] ?? {}
    const latestRsi = Object.keys(rsiEntries)
      .sort()
      .reverse()
      .map((key) => rsiEntries[key]?.RSI)
      .find(Boolean)

    if (!overview.Name) throw new Error(`market data unavailable for ${normalized}`)

    return {
      symbol: normalized,
      identity: {
        name: overview.Name,
        exchange: cleanValue(overview.Exchange),
        sector: cleanValue(overview.Sector),
        industry: cleanValue(overview.Industry),
        description: cleanValue(overview.Description),
      },
      fundamentals: compactMetrics([
        metric('Market cap', formatLargeCurrency(overview.MarketCapitalization)),
        metric('P/E ratio', formatNumber(overview.PERatio)),
        metric('EPS', formatCurrency(overview.EPS)),
        metric('Dividend yield', formatPercent(overview.DividendYield)),
        metric('Profit margin', formatPercent(overview.ProfitMargin)),
        metric('Beta', formatNumber(overview.Beta)),
        metric('Analyst target', formatCurrency(overview.AnalystTargetPrice)),
      ]),
      technicals: compactMetrics([
        metric('Last price', formatCurrency(quote?.['05. price'])),
        metric('Change', formatCurrency(quote?.['09. change'])),
        metric('Change %', formatPercent(quote?.['10. change percent'])),
        metric('RSI 14D', formatNumber(latestRsi)),
        metric('52W high', formatCurrency(overview['52WeekHigh'])),
        metric('52W low', formatCurrency(overview['52WeekLow'])),
        metric('50D average', formatCurrency(overview['50DayMovingAverage'])),
        metric('200D average', formatCurrency(overview['200DayMovingAverage'])),
      ]),
      financials: compactMetrics([
        metric('Revenue TTM', formatLargeCurrency(overview.RevenueTTM)),
        metric('EBITDA', formatLargeCurrency(overview.EBITDA)),
        metric('Gross profit TTM', formatLargeCurrency(overview.GrossProfitTTM)),
        metric('Revenue growth YoY', formatPercent(overview.QuarterlyRevenueGrowthYOY)),
        metric('Earnings growth YoY', formatPercent(overview.QuarterlyEarningsGrowthYOY)),
        metric('Fiscal year end', cleanValue(overview.FiscalYearEnd)),
      ]),
      source: 'Alpha Vantage',
      updatedAt: new Date().toISOString(),
    }
  }

  private async request(params: Record<string, string>) {
    const url = new URL('https://www.alphavantage.co/query')
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    url.searchParams.set('apikey', this.apiKey)

    const response = await this.fetchImpl(url)
    if (!response.ok) throw new Error(`Alpha Vantage request failed: ${response.status}`)
    const payload: unknown = await response.json()
    assertAlphaVantagePayload(payload, params.symbol ?? 'unknown')
    return payload
  }
}

let providerForTests: CompanyDataProvider | null = null

export const createCompanyDataProvider = (): CompanyDataProvider | null => {
  if (providerForTests) return providerForTests

  const apiKey = process.env.SYNTHESIS_ALPHA_VANTAGE_API_KEY?.trim()
  if (!apiKey) return null
  return new AlphaVantageCompanyDataProvider(apiKey)
}

export const setCompanyDataProviderForTests = (provider: CompanyDataProvider | null) => {
  providerForTests = provider
}

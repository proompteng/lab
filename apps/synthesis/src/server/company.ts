import { z } from 'zod'

import { normalizeCompanySymbol } from '~/lib/company-symbols'

export type CompanyDataSource = {
  name: string
  url: string | null
  retrievedAt: string
  fields: string[]
}

export type CompanyConfidence = {
  score: number
  level: 'high' | 'medium' | 'low'
  reasons: string[]
}

export type CompanyStaleness = {
  asOf: string
  staleAfter: string | null
  stale: boolean
}

export type CompanyQuoteContext = {
  source: string
  price: number | null
  bid: number | null
  ask: number | null
  timestamp: string | null
  retrievedAt: string
}

export type CompanyProfile = {
  symbol: string
  companyName: string
  exchange: string | null
  category: string | null
  sector: string | null
  industry: string | null
  ceo: string | null
  employees: number | null
  headquarters: string | null
  address: string | null
  establishedAt: string | null
  incorporatedAt: string | null
  description: string | null
  dataSources: CompanyDataSource[]
  quoteContext: CompanyQuoteContext | null
  updatedAt: string
  confidence: CompanyConfidence
  staleness: CompanyStaleness
}

export type CompanyProfileProvider = {
  getCompanyProfile(symbol: string): Promise<CompanyProfile | null>
}

export type CompanyQuoteContextProvider = {
  getQuoteContext(symbol: string): Promise<CompanyQuoteContext | null>
}

export const CompanyProfileHintSchema = z
  .object({
    symbol: z.string().trim().min(1).max(20),
    companyName: z.string().trim().min(1).max(240).optional(),
    exchange: z.string().trim().min(1).max(80).optional(),
    category: z.string().trim().min(1).max(120).optional(),
    sector: z.string().trim().min(1).max(160).optional(),
    industry: z.string().trim().min(1).max(200).optional(),
    ceo: z.string().trim().min(1).max(200).optional(),
    employees: z.coerce.number().int().positive().optional(),
    headquarters: z.string().trim().min(1).max(240).optional(),
    address: z.string().trim().min(1).max(400).optional(),
    establishedAt: z.string().trim().min(1).max(80).optional(),
    incorporatedAt: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().min(1).max(4_000).optional(),
    dataSources: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(160),
            url: z.string().trim().min(1).max(1_000).optional(),
            fields: z.array(z.string().trim().min(1).max(80)).max(32).default([]),
          })
          .strict(),
      )
      .max(12)
      .default([]),
  })
  .strict()

export type CompanyProfileHintInput = z.input<typeof CompanyProfileHintSchema>
export type CompanyProfileHint = z.infer<typeof CompanyProfileHintSchema>

const profilePayloadSchema = z.record(z.string(), z.unknown())

const cleanText = (value: unknown) => {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const text = String(value).replace(/\s+/g, ' ').trim()
  if (!text || text === '-' || /^n\/?a$/i.test(text) || /^none$/i.test(text)) return null
  return text
}

const cleanNumber = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.round(value)
  const text = cleanText(value)
  if (!text) return null
  const parsed = Number(text.replace(/,/g, ''))
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null
}

const pickText = (payload: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = cleanText(payload[key])
    if (value) return value
  }
  return null
}

const pickNumber = (payload: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = cleanNumber(payload[key])
    if (value) return value
  }
  return null
}

const toIso = (value: Date | string | null | undefined) => {
  if (!value) return null
  if (value instanceof Date) return value.toISOString()
  const parsed = new Date(value)
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
  return value
}

const nowIso = () => new Date().toISOString()

const staleAfterDays = (asOf: string, days: number) => {
  const parsed = Date.parse(asOf)
  if (Number.isNaN(parsed)) return null
  return new Date(parsed + days * 24 * 60 * 60 * 1000).toISOString()
}

const stalenessFor = (asOf: string, days = 30): CompanyStaleness => {
  const staleAfter = staleAfterDays(asOf, days)
  return {
    asOf,
    staleAfter,
    stale: staleAfter ? Date.now() > Date.parse(staleAfter) : false,
  }
}

const source = (name: string, url: string | null, fields: string[], retrievedAt = nowIso()): CompanyDataSource => ({
  name,
  url,
  retrievedAt,
  fields,
})

const compactSources = (sources: CompanyDataSource[]) => {
  const seen = new Set<string>()
  return sources.filter((entry) => {
    const key = `${entry.name}:${entry.url ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const confidenceFromSource = (provider: string, fields: Array<string | number | null>) => {
  const populated = fields.filter((value) => value != null && value !== '').length
  const sourceScore = provider === 'Webull' ? 0.52 : provider === 'manual' ? 0.45 : 0.34
  const score = Math.min(0.98, Number((sourceScore + Math.min(populated, 8) * 0.055).toFixed(2)))
  return {
    score,
    level: score >= 0.82 ? 'high' : score >= 0.62 ? 'medium' : 'low',
    reasons: [`${provider} profile source`, `${populated} normalized profile fields populated`],
  } satisfies CompanyConfidence
}

const fixtureProfiles: Record<string, Omit<CompanyProfile, 'quoteContext' | 'updatedAt' | 'staleness'>> = {
  NVDA: {
    symbol: 'NVDA',
    companyName: 'NVIDIA Corporation',
    exchange: 'NASDAQ',
    category: 'Common Stock',
    sector: 'Technology',
    industry: 'Semiconductors',
    ceo: 'Jensen Huang',
    employees: 42000,
    headquarters: 'Santa Clara, California, United States',
    address: '2788 San Tomas Expressway, Santa Clara, CA 95051',
    establishedAt: '1993',
    incorporatedAt: null,
    description:
      'NVIDIA is an accelerated computing and AI infrastructure company spanning GPUs, networking, systems, and software for data center, gaming, professional visualization, automotive, and edge workloads.',
    dataSources: [
      source(
        'NVIDIA in Brief',
        'https://www.nvidia.com/content/dam/en-zz/Solutions/about-nvidia/corporate-nvidia-in-brief.pdf',
        ['companyName', 'ceo', 'employees', 'establishedAt', 'description'],
      ),
      source('NVIDIA Investor Relations', 'https://investor.nvidia.com/governance/management-team/default.aspx', [
        'ceo',
      ]),
    ],
    confidence: {
      score: 0.78,
      level: 'medium',
      reasons: ['static fixture from issuer/investor sources', 'used when live Webull profile is unavailable'],
    },
  },
  AMD: {
    symbol: 'AMD',
    companyName: 'Advanced Micro Devices, Inc.',
    exchange: 'NASDAQ',
    category: 'Common Stock',
    sector: 'Technology',
    industry: 'Semiconductors',
    ceo: 'Lisa Su',
    employees: null,
    headquarters: 'Santa Clara, California, United States',
    address: '2485 Augustine Drive, Santa Clara, CA 95054',
    establishedAt: '1969',
    incorporatedAt: null,
    description:
      'AMD designs high-performance and adaptive computing products including CPUs, GPUs, accelerators, FPGAs, and embedded processors for data center, client, gaming, and embedded markets.',
    dataSources: [
      source('AMD Corporate', 'https://www.amd.com/en/corporate.html', ['companyName', 'establishedAt', 'description']),
      source('AMD Leadership', 'https://www.amd.com/en/corporate/leadership-lisa-su', ['ceo']),
      source('AMD Investor Relations', 'https://ir.amd.com/governance', ['ceo']),
    ],
    confidence: {
      score: 0.76,
      level: 'medium',
      reasons: ['static fixture from issuer/investor sources', 'used when live Webull profile is unavailable'],
    },
  },
}

export const normalizeWebullCompanyProfile = (symbol: string, payload: unknown): CompanyProfile | null => {
  const normalized = normalizeCompanySymbol(symbol)
  if (!normalized) throw new Error(`unsupported company symbol: ${symbol}`)
  const record = profilePayloadSchema.safeParse(payload)
  if (!record.success) return null
  const nestedProfile = profilePayloadSchema.safeParse(record.data.profile)
  const nestedData = profilePayloadSchema.safeParse(record.data.data)
  const data = nestedProfile.success ? nestedProfile.data : nestedData.success ? nestedData.data : record.data
  const companyName = pickText(data, ['companyName', 'name', 'shortName', 'enName', 'tickerName', 'securityName'])
  if (!companyName) return null

  const updatedAt = nowIso()
  const exchange = pickText(data, ['exchange', 'exchangeCode', 'exchangeName', 'market', 'marketName'])
  const category = pickText(data, ['category', 'securityType', 'type', 'instrumentType'])
  const sector = pickText(data, ['sector', 'sectorName'])
  const industry = pickText(data, ['industry', 'industryName'])
  const ceo = pickText(data, ['ceo', 'chiefExecutiveOfficer', 'chairman', 'leader'])
  const employees = pickNumber(data, ['employees', 'employeeTotal', 'fullTimeEmployees', 'numberOfEmployees'])
  const headquarters = pickText(data, ['headquarters', 'headquarter', 'hq', 'city'])
  const address = pickText(data, ['address', 'officeAddress', 'companyAddress'])
  const establishedAt = pickText(data, ['establishedAt', 'established', 'founded', 'foundedDate'])
  const incorporatedAt = pickText(data, ['incorporatedAt', 'incorporated', 'incorporationDate'])
  const description = pickText(data, ['description', 'profile', 'companyProfile', 'businessDescription', 'intro'])

  return {
    symbol: normalized,
    companyName,
    exchange,
    category,
    sector,
    industry,
    ceo,
    employees,
    headquarters,
    address,
    establishedAt,
    incorporatedAt,
    description,
    dataSources: [
      source('Webull', null, [
        'companyName',
        'exchange',
        'category',
        'sector',
        'industry',
        'ceo',
        'employees',
        'headquarters',
        'address',
        'establishedAt',
        'incorporatedAt',
        'description',
      ]),
    ],
    quoteContext: null,
    updatedAt,
    confidence: confidenceFromSource('Webull', [
      companyName,
      exchange,
      category,
      sector,
      industry,
      ceo,
      employees,
      headquarters,
      address,
      establishedAt,
      incorporatedAt,
      description,
    ]),
    staleness: stalenessFor(updatedAt),
  }
}

class WebullBridgeCompanyProfileProvider implements CompanyProfileProvider {
  private readonly endpoint: string
  private readonly fetchImpl: typeof fetch

  constructor(endpoint: string, fetchImpl: typeof fetch = fetch) {
    this.endpoint = endpoint
    this.fetchImpl = fetchImpl
  }

  async getCompanyProfile(symbol: string): Promise<CompanyProfile | null> {
    const normalized = normalizeCompanySymbol(symbol)
    if (!normalized) throw new Error(`unsupported company symbol: ${symbol}`)
    const url = new URL(this.endpoint)
    url.searchParams.set('symbol', normalized)
    const response = await this.fetchImpl(url)
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`Webull company profile bridge failed: ${response.status}`)
    const payload: unknown = await response.json()
    return normalizeWebullCompanyProfile(normalized, payload)
  }
}

class FixtureCompanyProfileProvider implements CompanyProfileProvider {
  async getCompanyProfile(symbol: string): Promise<CompanyProfile | null> {
    const normalized = normalizeCompanySymbol(symbol)
    if (!normalized) throw new Error(`unsupported company symbol: ${symbol}`)
    const fixture = fixtureProfiles[normalized]
    if (!fixture) return null
    const updatedAt = nowIso()
    return {
      ...fixture,
      dataSources: fixture.dataSources.map((entry) => ({ ...entry, retrievedAt: updatedAt })),
      quoteContext: null,
      updatedAt,
      staleness: stalenessFor(updatedAt),
    }
  }
}

class ChainedCompanyProfileProvider implements CompanyProfileProvider {
  private readonly providers: CompanyProfileProvider[]

  constructor(providers: CompanyProfileProvider[]) {
    this.providers = providers
  }

  async getCompanyProfile(symbol: string): Promise<CompanyProfile | null> {
    let lastError: Error | null = null
    for (const provider of this.providers) {
      try {
        const profile = await provider.getCompanyProfile(symbol)
        if (profile) return profile
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
      }
    }
    if (lastError && this.providers.length === 1) throw lastError
    return null
  }
}

class AlpacaQuoteContextProvider implements CompanyQuoteContextProvider {
  private readonly apiKeyId: string
  private readonly apiSecretKey: string
  private readonly feed: string | null
  private readonly fetchImpl: typeof fetch

  constructor(apiKeyId: string, apiSecretKey: string, feed: string | null, fetchImpl: typeof fetch = fetch) {
    this.apiKeyId = apiKeyId
    this.apiSecretKey = apiSecretKey
    this.feed = feed
    this.fetchImpl = fetchImpl
  }

  async getQuoteContext(symbol: string): Promise<CompanyQuoteContext | null> {
    const normalized = normalizeCompanySymbol(symbol)
    if (!normalized) throw new Error(`unsupported company symbol: ${symbol}`)
    const url = new URL(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(normalized)}/quotes/latest`)
    if (this.feed) url.searchParams.set('feed', this.feed)
    const response = await this.fetchImpl(url, {
      headers: {
        'APCA-API-KEY-ID': this.apiKeyId,
        'APCA-API-SECRET-KEY': this.apiSecretKey,
      },
    })
    if (response.status === 403 || response.status === 404) return null
    if (!response.ok) throw new Error(`Alpaca quote context failed: ${response.status}`)
    const payload = (await response.json()) as { quote?: Record<string, unknown> }
    const quote = payload.quote
    if (!quote) return null
    return {
      source: 'Alpaca Market Data',
      price: cleanNumber(quote.ap) ?? cleanNumber(quote.bp),
      ask: cleanNumber(quote.ap),
      bid: cleanNumber(quote.bp),
      timestamp: toIso(cleanText(quote.t)),
      retrievedAt: nowIso(),
    }
  }
}

let profileProviderForTests: CompanyProfileProvider | null = null
let quoteProviderForTests: CompanyQuoteContextProvider | null = null

export const createCompanyProfileProvider = (): CompanyProfileProvider => {
  if (profileProviderForTests) return profileProviderForTests

  const providers: CompanyProfileProvider[] = []
  const webullBridgeEndpoint = process.env.SYNTHESIS_WEBULL_PROFILE_ENDPOINT?.trim()
  if (webullBridgeEndpoint) providers.push(new WebullBridgeCompanyProfileProvider(webullBridgeEndpoint))
  providers.push(new FixtureCompanyProfileProvider())
  return new ChainedCompanyProfileProvider(providers)
}

export const createCompanyQuoteContextProvider = (): CompanyQuoteContextProvider | null => {
  if (quoteProviderForTests) return quoteProviderForTests
  const apiKeyId = process.env.SYNTHESIS_ALPACA_API_KEY_ID?.trim() ?? process.env.APCA_API_KEY_ID?.trim()
  const apiSecretKey = process.env.SYNTHESIS_ALPACA_API_SECRET_KEY?.trim() ?? process.env.APCA_API_SECRET_KEY?.trim()
  if (!apiKeyId || !apiSecretKey) return null
  return new AlpacaQuoteContextProvider(apiKeyId, apiSecretKey, process.env.SYNTHESIS_ALPACA_DATA_FEED?.trim() || null)
}

export const setCompanyProfileProviderForTests = (provider: CompanyProfileProvider | null) => {
  profileProviderForTests = provider
}

export const setCompanyQuoteContextProviderForTests = (provider: CompanyQuoteContextProvider | null) => {
  quoteProviderForTests = provider
}

export const companyProfileFromHints = (input: CompanyProfileHintInput): CompanyProfile => {
  const hints = CompanyProfileHintSchema.parse(input)
  const normalized = normalizeCompanySymbol(hints.symbol)
  if (!normalized) throw new Error(`unsupported company symbol: ${hints.symbol}`)
  if (!hints.companyName) throw new Error(`companyName is required when seeding ${normalized} without provider data`)
  const updatedAt = nowIso()
  const sources = hints.dataSources.length
    ? hints.dataSources.map((entry) => source(entry.name, entry.url ?? null, entry.fields, updatedAt))
    : [source('manual seed', null, ['companyName', 'description'], updatedAt)]

  return {
    symbol: normalized,
    companyName: hints.companyName,
    exchange: hints.exchange ?? null,
    category: hints.category ?? null,
    sector: hints.sector ?? null,
    industry: hints.industry ?? null,
    ceo: hints.ceo ?? null,
    employees: hints.employees ?? null,
    headquarters: hints.headquarters ?? null,
    address: hints.address ?? null,
    establishedAt: hints.establishedAt ?? null,
    incorporatedAt: hints.incorporatedAt ?? null,
    description: hints.description ?? null,
    dataSources: sources,
    quoteContext: null,
    updatedAt,
    confidence: confidenceFromSource('manual', [
      hints.companyName,
      hints.exchange,
      hints.category,
      hints.sector,
      hints.industry,
      hints.ceo,
      hints.employees ?? null,
      hints.headquarters,
      hints.address,
      hints.establishedAt,
      hints.incorporatedAt,
      hints.description,
    ]),
    staleness: stalenessFor(updatedAt),
  }
}

export const mergeCompanyProfileHints = (profile: CompanyProfile, input: CompanyProfileHintInput): CompanyProfile => {
  const hints = CompanyProfileHintSchema.parse(input)
  const updatedAt = nowIso()
  const dataSources = compactSources([
    ...profile.dataSources,
    ...hints.dataSources.map((entry) => source(entry.name, entry.url ?? null, entry.fields, updatedAt)),
  ])
  return {
    ...profile,
    companyName: profile.companyName || hints.companyName || profile.symbol,
    exchange: profile.exchange ?? hints.exchange ?? null,
    category: profile.category ?? hints.category ?? null,
    sector: profile.sector ?? hints.sector ?? null,
    industry: profile.industry ?? hints.industry ?? null,
    ceo: profile.ceo ?? hints.ceo ?? null,
    employees: profile.employees ?? hints.employees ?? null,
    headquarters: profile.headquarters ?? hints.headquarters ?? null,
    address: profile.address ?? hints.address ?? null,
    establishedAt: profile.establishedAt ?? hints.establishedAt ?? null,
    incorporatedAt: profile.incorporatedAt ?? hints.incorporatedAt ?? null,
    description: profile.description ?? hints.description ?? null,
    dataSources,
    updatedAt,
    staleness: stalenessFor(updatedAt),
  }
}

export const enrichCompanyProfile = async (
  input: CompanyProfileHintInput,
  provider = createCompanyProfileProvider(),
  quoteProvider = createCompanyQuoteContextProvider(),
): Promise<CompanyProfile> => {
  const hints = CompanyProfileHintSchema.parse(input)
  const normalized = normalizeCompanySymbol(hints.symbol)
  if (!normalized) throw new Error(`unsupported company symbol: ${hints.symbol}`)
  const providerProfile = await provider.getCompanyProfile(normalized)
  const baseProfile = providerProfile
    ? mergeCompanyProfileHints(providerProfile, hints)
    : companyProfileFromHints(hints)
  const quoteContext = quoteProvider ? await quoteProvider.getQuoteContext(normalized).catch(() => null) : null
  return {
    ...baseProfile,
    quoteContext,
    dataSources: quoteContext
      ? compactSources([
          ...baseProfile.dataSources,
          source(quoteContext.source, null, ['quoteContext'], quoteContext.retrievedAt),
        ])
      : baseProfile.dataSources,
  }
}

// Backward-compatible alias for older tests/imports from the alpha-analysis implementation.
export const setCompanyDataProviderForTests = setCompanyProfileProviderForTests

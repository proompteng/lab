import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { handleGetCompany, handlePrefillCompany, handleSubmitItem } from '../api'
import {
  enrichCompanyProfile,
  normalizeWebullCompanyProfile,
  setCompanyProfileProviderForTests,
  setCompanyQuoteContextProviderForTests,
} from '../company'
import { setSynthesisEmbeddingProviderForTests } from '../embeddings'
import { createInMemorySynthesisStore, setSynthesisStoreForTests } from '../store'

const token = 'test-synthesis-token'

describe('company profile prefill', () => {
  beforeEach(() => {
    process.env.SYNTHESIS_API_TOKEN = token
    process.env.SYNTHESIS_EMBEDDING_DIMENSION = '3'
    process.env.SYNTHESIS_EMBEDDING_MODEL = 'local-test-embedding'
    setSynthesisEmbeddingProviderForTests(async ({ config }) => ({
      embedding: [1, 0, 0],
      model: config.model,
      dimension: config.dimension,
    }))
    setSynthesisStoreForTests(createInMemorySynthesisStore())
  })

  afterEach(() => {
    delete process.env.SYNTHESIS_API_TOKEN
    delete process.env.SYNTHESIS_EMBEDDING_DIMENSION
    delete process.env.SYNTHESIS_EMBEDDING_MODEL
    setCompanyProfileProviderForTests(null)
    setCompanyQuoteContextProviderForTests(null)
    setSynthesisEmbeddingProviderForTests(null)
    setSynthesisStoreForTests(null)
  })

  test('normalizes Webull company profile payloads into Synthesis profile fields', () => {
    const profile = normalizeWebullCompanyProfile('nvda', {
      companyName: 'NVIDIA Corporation',
      exchangeCode: 'NASDAQ',
      securityType: 'Common Stock',
      sectorName: 'Technology',
      industryName: 'Semiconductors',
      chiefExecutiveOfficer: 'Jensen Huang',
      fullTimeEmployees: '42,000',
      headquarter: 'Santa Clara, California',
      companyAddress: '2788 San Tomas Expressway, Santa Clara, CA 95051',
      founded: '1993',
      businessDescription: 'Accelerated computing and AI infrastructure company.',
    })

    expect(profile).toMatchObject({
      symbol: 'NVDA',
      companyName: 'NVIDIA Corporation',
      exchange: 'NASDAQ',
      category: 'Common Stock',
      sector: 'Technology',
      industry: 'Semiconductors',
      ceo: 'Jensen Huang',
      employees: 42000,
      headquarters: 'Santa Clara, California',
    })
    expect(profile?.dataSources[0].name).toBe('Webull')
    expect(profile?.confidence.level).toBe('high')
  })

  test('prefers provider-backed profile data and attaches optional Alpaca quote context', async () => {
    setCompanyProfileProviderForTests({
      async getCompanyProfile(symbol) {
        return normalizeWebullCompanyProfile(symbol, {
          name: 'Advanced Micro Devices, Inc.',
          exchange: 'NASDAQ',
          sector: 'Technology',
          industry: 'Semiconductors',
          ceo: 'Lisa Su',
          description: 'Provider profile.',
        })
      },
    })
    setCompanyQuoteContextProviderForTests({
      async getQuoteContext(_symbol) {
        return {
          source: 'Alpaca Market Data',
          price: 123.45,
          bid: 123.4,
          ask: 123.5,
          timestamp: '2026-05-26T20:00:00.000Z',
          retrievedAt: '2026-05-26T20:00:01.000Z',
        }
      },
    })

    const profile = await enrichCompanyProfile({ symbol: 'AMD', companyName: 'Manual name should not override' })

    expect(profile.companyName).toBe('Advanced Micro Devices, Inc.')
    expect(profile.quoteContext).toMatchObject({ source: 'Alpaca Market Data', price: 123.45 })
    expect(profile.dataSources.map((source) => source.name)).toEqual(['Webull', 'Alpaca Market Data'])
  })

  test('GET prepopulates fixture-backed company profiles when live Webull is unavailable', async () => {
    const response = await handleGetCompany(new Request('http://synthesis.test/api/companies/NVDA'), 'NVDA')
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload.company).toMatchObject({
      symbol: 'NVDA',
      companyName: 'NVIDIA Corporation',
      exchange: 'NASDAQ',
      industry: 'Semiconductors',
    })
    expect(payload.company.dataSources[0].name).toContain('NVIDIA')
  })

  test('POST prefill stores manual official-source seed data when provider has no profile', async () => {
    setCompanyProfileProviderForTests({
      async getCompanyProfile() {
        return null
      },
    })
    const response = await handlePrefillCompany(
      new Request('http://synthesis.test/api/companies/ACME', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          companyName: 'Acme Robotics, Inc.',
          exchange: 'NYSE',
          sector: 'Industrials',
          dataSources: [{ name: 'NYSE issuer page', url: 'https://example.com/acme', fields: ['companyName'] }],
        }),
      }),
      'ACME',
    )
    const payload = await response.json()

    expect(response.status).toBe(201)
    expect(payload.company).toMatchObject({ symbol: 'ACME', companyName: 'Acme Robotics, Inc.', exchange: 'NYSE' })
  })

  test('submitted items derive company symbols and trigger profile association', async () => {
    const submitResponse = await handleSubmitItem(
      new Request('http://synthesis.test/api/items', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'NVDA and $AMD packaging notes matter for inference clusters',
          synthesis: 'Company mentions should become internal Synthesis company profile links.',
          takeaways: ['NVDA demand and AMD roadmap context both matter'],
          whyValuable: 'It keeps ticker/company context attached to the item.',
          sourcePosts: [
            {
              originalUrl: 'https://x.com/example/status/6101',
              observedText: 'NVDA and AMD supply-chain commentary',
            },
          ],
          dedupeKey: 'theme:company-prefill-association',
          score: 0.92,
          confidence: 0.84,
        }),
      }),
    )
    const submitPayload = await submitResponse.json()
    const profileResponse = await handleGetCompany(new Request('http://synthesis.test/api/companies/AMD'), 'AMD')
    const profilePayload = await profileResponse.json()

    expect(submitResponse.status).toBe(201)
    expect(submitPayload.item.companySymbols).toEqual(['NVDA', 'AMD'])
    expect(profileResponse.status).toBe(200)
    expect(profilePayload.company.companyName).toContain('Advanced Micro Devices')
  })
})

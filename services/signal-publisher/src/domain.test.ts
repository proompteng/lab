import { describe, expect, test } from 'bun:test'

import { Schema } from 'effect'

import {
  AlpacaBarsResponseSchema,
  buildPublication,
  missingRows,
  verifyPublication,
  type AlpacaBar,
  type BuildPublicationInput,
} from './domain'

const bar = (date: string, close: number): AlpacaBar => ({
  t: `${date}T04:00:00Z`,
  o: close - 1,
  h: close + 1,
  l: close - 2,
  c: close,
  v: 1_000_000,
  n: 10_000,
  vw: close - 0.25,
})

const input = (overrides: Partial<BuildPublicationInput> = {}): BuildPublicationInput => ({
  barsBySymbol: {
    SPY: [bar('2026-07-16', 620), bar('2026-07-17', 621)],
    TLT: [bar('2026-07-16', 89), bar('2026-07-17', 90)],
  },
  calendar: [
    { date: '2026-07-16', open: '09:30', close: '16:00' },
    { date: '2026-07-17', open: '09:30', close: '16:00' },
  ],
  symbols: ['SPY', 'TLT'],
  feed: 'iex',
  calendarVersion: 'alpaca-us-equity-calendar-v1',
  requestedStart: '2026-07-16',
  publicationAsOf: '2026-07-17',
  finalizedAt: '2026-07-17 22:30:00.000',
  provenance: {
    sourceRevision: 'a'.repeat(40),
    imageRepository: 'registry.ide-newton.ts.net/lab/signal-publisher',
    imageDigest: `sha256:${'b'.repeat(64)}`,
  },
  ...overrides,
})

describe('Adjusted-daily snapshot domain', () => {
  test('runtime-decodes provider pages', () => {
    expect(
      Schema.decodeUnknownSync(AlpacaBarsResponseSchema)({
        bars: { SPY: [bar('2026-07-17', 621)] },
        next_page_token: null,
      }).bars.SPY,
    ).toHaveLength(1)
    expect(() =>
      Schema.decodeUnknownSync(AlpacaBarsResponseSchema)({
        bars: { SPY: [{ ...bar('2026-07-17', 621), o: '621' }] },
        next_page_token: null,
      }),
    ).toThrow()
  })

  test('builds a content-addressed immutable manifest', () => {
    const first = buildPublication(input())
    const reordered = buildPublication(
      input({
        barsBySymbol: {
          TLT: [...input().barsBySymbol.TLT].reverse(),
          SPY: [...input().barsBySymbol.SPY].reverse(),
        },
        calendar: [...input().calendar].reverse(),
        symbols: ['TLT', 'SPY'],
        finalizedAt: '2026-07-17 22:35:00.000',
      }),
    )

    expect(first.manifest.snapshot_id).toBe(reordered.manifest.snapshot_id)
    expect(first.manifest.snapshot_id).toMatch(/^[a-f0-9]{64}$/)
    expect(first.manifest.manifest_content_hash).not.toBe(reordered.manifest.manifest_content_hash)
    expect(first.manifest).toMatchObject({
      schema_version: 'signal.adjusted-daily-snapshot.v1',
      symbol_count: 2,
      session_count: 2,
      bar_count: 4,
      publication_asof: '2026-07-17',
    })
    expect(first.bars[0].adjusted_close).toBe('620.00000000')
    verifyPublication(first, first.bars, first.sessions, [first.manifest])
  })

  test('rejects malformed, duplicate, non-session, and incomplete final bars', () => {
    expect(() =>
      buildPublication(
        input({ barsBySymbol: { ...input().barsBySymbol, SPY: [{ ...bar('2026-07-17', 621), l: 700 }] } }),
      ),
    ).toThrow('inconsistent OHLC')
    expect(() =>
      buildPublication(
        input({ barsBySymbol: { ...input().barsBySymbol, SPY: [bar('2026-07-17', 621), bar('2026-07-17', 621)] } }),
      ),
    ).toThrow('duplicate adjusted bar')
    expect(() =>
      buildPublication(
        input({
          requestedStart: '2026-07-15',
          barsBySymbol: { ...input().barsBySymbol, SPY: [bar('2026-07-15', 620), bar('2026-07-17', 621)] },
        }),
      ),
    ).toThrow('not an exchange session')
    expect(() =>
      buildPublication(input({ barsBySymbol: { ...input().barsBySymbol, TLT: [bar('2026-07-16', 89)] } })),
    ).toThrow('final session 2026-07-17 is incomplete')
    expect(() =>
      buildPublication(input({ calendar: [{ date: '2026-07-17', open: '16:00', close: '09:30' }] })),
    ).toThrow('invalid market hours')
  })

  test('detects every finalized mutation and only resumes exact partial rows', () => {
    const publication = buildPublication(input())
    expect(() =>
      verifyPublication(publication, [...publication.bars, publication.bars[0]], publication.sessions, [
        publication.manifest,
      ]),
    ).toThrow('bar cardinality is invalid')
    expect(() =>
      verifyPublication(
        publication,
        [{ ...publication.bars[0], adjusted_close: '999.00000000' }, ...publication.bars.slice(1)],
        publication.sessions,
        [publication.manifest],
      ),
    ).toThrow('bar content hash is invalid')
    expect(
      missingRows(publication.bars, publication.bars.slice(0, 1), (row) => `${row.symbol}:${row.session_date}`),
    ).toHaveLength(3)
    expect(() =>
      missingRows(
        publication.bars,
        [{ ...publication.bars[0], adjusted_close: '999.00000000' }],
        (row) => `${row.symbol}:${row.session_date}`,
      ),
    ).toThrow('staged row does not match publication')
  })
})

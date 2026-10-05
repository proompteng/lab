import { Result } from 'effect'
import { canonicalHashV1, sha256 } from '../hash'
import { gzipSync } from 'node:zlib'
import { validateBacktestSourceReceipt, type BacktestSourceManifest } from './source'
import { prepareGapRecoverySession, gapRecoveryDefinition } from './gap-recovery'
import { sixBarFixture, replaySixBarFixture, type SixBarFixtureInput } from './six-bar-features.test-support'

export const gapOpenMs = Date.parse('2026-09-04T13:30:00.000Z')
export const gapPriorOpenMs = Date.parse('2026-09-03T13:30:00.000Z')
export const gapPriorCloseMs = Date.parse('2026-09-03T20:00:00.000Z')
export const gapDecisionMs = gapOpenMs + 1_830_000

export const gapSessionInput = (close = '16:00') => {
  const calendar = [
    { date: '2026-09-03', open: '09:30', close: '16:00' },
    { date: '2026-09-04', open: '09:30', close },
  ]
  return {
    schemaVersion: 'bayn.gap-recovery-session.v1',
    sessionDate: '2026-09-04',
    calendar,
    calendarHash: canonicalHashV1(calendar),
  }
}

export const gapFixture = (
  options: {
    prices?: Readonly<Record<string, readonly [number, number, number]>>
    alter?: (kind: 'prior' | 'current', inputs: SixBarFixtureInput[]) => SixBarFixtureInput[]
    additional?: SixBarFixtureInput[]
    close?: string
  } = {},
) => {
  const session = Result.getOrThrow(prepareGapRecoverySession(gapSessionInput(options.close)))
  const symbols = [...gapRecoveryDefinition.candidates, 'SPY'].sort()
  const prior: SixBarFixtureInput[] = [],
    current: SixBarFixtureInput[] = []
  for (const symbol of symbols) {
    const [p, o, d] =
      options.prices?.[symbol] ??
      (symbol === 'SPY' ? [200, 200, 200.2] : symbol === 'AAPL' ? [100, 99, 99.3] : [100, 100, 100.1])
    const quote = (at: number, price: number): SixBarFixtureInput => ({
      availableAtMs: at,
      channel: 'quotes',
      symbol,
      eventAtMs: at,
      bid: price,
      ask: price,
      bidSize: 100,
      askSize: 100,
    })
    prior.push(quote(gapPriorCloseMs - 35_000, p))
    current.push(quote(gapOpenMs + 25_000, o))
    for (let i = 0; i < 6; i++) {
      const t = gapOpenMs + (24 + i) * 60_000
      current.push({ availableAtMs: t + 61_000, eventAtMs: t, channel: 'bars', symbol, close: d })
    }
    current.push(quote(gapDecisionMs - 5_000, d), {
      availableAtMs: gapDecisionMs - 5_000,
      eventAtMs: gapDecisionMs - 5_000,
      channel: 'trades',
      symbol,
      close: d,
    })
  }
  const previous = sixBarFixture(options.alter?.('prior', prior) ?? prior)
  const today = sixBarFixture([...(options.alter?.('current', current) ?? current), ...(options.additional ?? [])])
  return {
    previous,
    today,
    session,
    previousCursor: () => replaySixBarFixture(previous, session.priorAtMs),
    openingCursor: () => replaySixBarFixture(today, session.openingAtMs),
    decisionCursor: () => replaySixBarFixture(today, session.decisionAtMs),
    cursorAt: (at: number) => replaySixBarFixture(today, at),
  }
}

export const gapSourceFixture = (
  fixture: ReturnType<typeof sixBarFixture>,
  coverageStartMs: number,
  coverageEndMs: number,
) => {
  const body = fixture.events.map((e) => JSON.stringify(e)).join('\n') + '\n'
  const bytes = gzipSync(body)
  const partitions = Object.values(fixture.universe.topics)
    .sort()
    .map((topic) => ({ topic, partition: 0 }))
  const positions = partitions.map(({ topic, partition }) => {
    const events = fixture.events.filter((e) => e.record.topic === topic)
    return {
      topic,
      partition,
      startOffset: events[0]?.record.offset ?? '0',
      endOffsetExclusive: events.length === 0 ? '0' : String(BigInt(events.at(-1)?.record.offset ?? '0') + 1n),
    }
  })
  const manifest: BacktestSourceManifest = {
    schemaVersion: 'bayn.backtest-source.v1',
    encoding: 'ndjson-gzip',
    transport: 'original-capture',
    dataSha256: sha256(bytes),
    recordCount: fixture.events.length,
    coverageStartMs,
    coverageEndMs,
    firstAvailableAtMs: fixture.events[0]?.availableAtMs ?? coverageStartMs,
    lastAvailableAtMs: fixture.events.at(-1)?.availableAtMs ?? coverageEndMs,
    origin: 'SYNTHETIC gap-recovery command fixture, not a captured market session',
    positions,
    nativeVisiblePartitions: partitions,
    universe: fixture.universe,
    deliveryModel: fixture.source.deliveryModel,
  }
  const receiptText = JSON.stringify({
    schemaVersion: 'bayn.original-capture-replay-receipt.v1',
    recordedAt: new Date(coverageEndMs + 1).toISOString(),
    origin: manifest.origin,
    coverageStartMs,
    coverageEndMs,
    universe: fixture.universe,
    positions,
    nativeVisiblePartitions: partitions,
    deliveryModel: fixture.source.deliveryModel,
    sourceDataSha256: manifest.dataSha256,
  })
  const receiptHash = sha256(receiptText)
  return {
    bytes,
    manifest,
    receiptText,
    receiptHash,
    receipt: Result.getOrThrow(validateBacktestSourceReceipt(receiptText, receiptHash)),
  }
}

import { Effect } from 'effect'

import { makeRuntimeProvenance, type RuntimeProvenance } from './contracts'
import { canonicalHashV1 } from './hash'
import { hashParameters, loadDefaultProtocol } from './protocol'
import {
  DataFeed,
  DataSource,
  PriceAdjustment,
  PublicationSchema,
  type DailyBar,
  type InputManifest,
  type IsoDate,
  type Protocol,
} from './types'

export const fixtureProtocol = Effect.runSync(loadDefaultProtocol)

export const makeTestProvenance = (
  protocol: Protocol = fixtureProtocol,
  overrides: {
    readonly sourceRevision?: string
    readonly imageDigest?: string
    readonly behaviorHash?: string
  } = {},
): RuntimeProvenance =>
  makeRuntimeProvenance({
    sourceRevision: overrides.sourceRevision ?? 'a'.repeat(40),
    image: {
      repository: 'registry.ide-newton.ts.net/lab/bayn',
      digest: overrides.imageDigest ?? `sha256:${'b'.repeat(64)}`,
    },
    strategy: {
      name: 'risk-balanced-trend',
      behaviorHash: overrides.behaviorHash ?? 'd'.repeat(64),
      parameterHash: hashParameters(protocol),
      parameterSchemaVersion: protocol.schemaVersion,
    },
  })

export const makeBars = (sessionCount = 1_122): readonly DailyBar[] => {
  const bars: DailyBar[] = []
  const cursor = new Date(`${fixtureProtocol.historyStart}T00:00:00Z`)
  let session = 0
  while (session < sessionCount) {
    const day = cursor.getUTCDay()
    if (day !== 0 && day !== 6) {
      for (let symbolIndex = 0; symbolIndex < fixtureProtocol.universe.length; symbolIndex += 1) {
        const symbol = fixtureProtocol.universe[symbolIndex]
        const trend = symbolIndex % 3 === 0 ? -0.00005 : 0.00025 + symbolIndex * 0.00001
        const close =
          (50 + symbolIndex * 10) * (1 + trend * session) * (1 + 0.025 * Math.sin(session / 18 + symbolIndex))
        const open = close * (1 + 0.002 * Math.sin(session / 7 + symbolIndex))
        bars.push({
          symbol,
          sessionDate: cursor.toISOString().slice(0, 10) as IsoDate,
          open,
          high: Math.max(open, close) * 1.003,
          low: Math.min(open, close) * 0.997,
          close,
          volume: 1_000_000 + session * 10 + symbolIndex,
          source: DataSource.Alpaca,
          sourceFeed: DataFeed.Sip,
          adjustment: PriceAdjustment.All,
          publicationSchemaVersion: PublicationSchema.AdjustedDailySnapshotV2,
        })
      }
      session += 1
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return bars
}

export const makeSnapshot = (
  sessionCount = 1_122,
): { readonly bars: readonly DailyBar[]; readonly manifest: InputManifest } => {
  const bars = makeBars(sessionCount)
  const sessionDates = [...new Set(bars.map((bar) => bar.sessionDate))].sort()
  const firstSession = sessionDates.at(0)
  const lastSession = sessionDates.at(-1)
  if (
    firstSession === undefined ||
    lastSession === undefined ||
    !sessionDates.includes(fixtureProtocol.evaluationStart)
  ) {
    throw new RangeError('fixture session count must cover the strategy evaluation start')
  }
  const material: Omit<InputManifest, 'hash'> = {
    schemaVersion: 'bayn.input-manifest.v3',
    database: 'signal',
    tables: {
      bars: 'adjusted_daily_bars_v2',
      sessions: 'exchange_sessions_v1',
      manifests: 'snapshot_manifests_v2',
    },
    finalizedSnapshot: {
      schemaVersion: 'bayn.finalized-snapshot.v3',
      snapshotId: '7'.repeat(64),
      publicationId: '8'.repeat(64),
      publicationSchemaVersion: PublicationSchema.AdjustedDailySnapshotV2,
      universeId: fixtureProtocol.universeId,
      universeSymbolHash: fixtureProtocol.universeSymbolHash,
      source: DataSource.Alpaca,
      sourceFeed: DataFeed.Sip,
      adjustment: PriceAdjustment.All,
      calendarVersion: 'fixture-calendar-v2',
      publisherSourceRevision: '9'.repeat(40),
      publisherImage: {
        repository: 'registry.ide-newton.ts.net/lab/signal-publisher',
        digest: `sha256:${'a'.repeat(64)}`,
      },
      finalizedAt: '2026-07-21T00:00:00.000Z',
      requestedStart: firstSession,
      firstSession,
      lastSession,
      asOfSession: lastSession,
      symbols: fixtureProtocol.universe,
      rowCount: bars.length,
      sessionCount: sessionDates.length,
      contentHash: 'b'.repeat(64),
      sessionsContentHash: 'c'.repeat(64),
    },
    bounds: {
      schemaVersion: 'bayn.evaluation-bounds.v1',
      dataStart: firstSession,
      dataEnd: lastSession,
      lookbackStart: firstSession,
      evaluationStart: fixtureProtocol.evaluationStart,
      evaluationEnd: lastSession,
    },
    rowCount: bars.length,
    sessionCount: sessionDates.length,
    firstSession,
    lastSession,
    symbols: fixtureProtocol.universe.map((symbol) => ({
      symbol,
      rows: sessionDates.length,
      firstSession,
      lastSession,
    })),
  }
  return {
    bars,
    manifest: { ...material, hash: canonicalHashV1(material) },
  }
}

import { Effect } from 'effect'

import { makeRuntimeProvenance, type RuntimeProvenance } from './contracts'
import { canonicalHashV1 } from './hash'
import {
  hashRiskBalancedTrendParameters,
  hashTsmomParameters,
  loadDefaultProtocol,
  loadDefaultRiskBalancedTrendProtocol,
} from './protocol'
import {
  DataFeed,
  DataSource,
  PriceAdjustment,
  PublicationSchema,
  type DailyBar,
  type IsoDate,
  type LegacyInputManifest,
  type RiskBalancedTrendProtocol,
  type TsmomProtocol,
  type UniverseBoundInputManifest,
} from './types'

export const fixtureProtocol = Effect.runSync(loadDefaultProtocol)
export const riskBalancedTrendFixtureProtocol = Effect.runSync(loadDefaultRiskBalancedTrendProtocol)

export const makeTestProvenance = (
  protocol: TsmomProtocol = fixtureProtocol,
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
      name: 'tsmom',
      behaviorHash: overrides.behaviorHash ?? 'c'.repeat(64),
      parameterHash: hashTsmomParameters(protocol),
      parameterSchemaVersion: protocol.schemaVersion,
    },
  })

export const makeRiskBalancedTrendTestProvenance = (
  protocol: RiskBalancedTrendProtocol = riskBalancedTrendFixtureProtocol,
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
      parameterHash: hashRiskBalancedTrendParameters(protocol),
      parameterSchemaVersion: protocol.schemaVersion,
    },
  })

const makeBarsForUniverse = (
  universe: readonly string[],
  publicationSchemaVersion: PublicationSchema,
  start: IsoDate,
  sessionCount: number,
): readonly DailyBar[] => {
  const bars: DailyBar[] = []
  const cursor = new Date(`${start}T00:00:00Z`)
  let session = 0
  while (session < sessionCount) {
    const day = cursor.getUTCDay()
    if (day !== 0 && day !== 6) {
      for (let symbolIndex = 0; symbolIndex < universe.length; symbolIndex += 1) {
        const symbol = universe[symbolIndex]
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
          publicationSchemaVersion,
        })
      }
      session += 1
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return bars
}

export const makeBars = (sessionCount = 900): readonly DailyBar[] =>
  makeBarsForUniverse(fixtureProtocol.universe, PublicationSchema.AdjustedDailySnapshotV1, '2018-01-02', sessionCount)

export const makeRiskBalancedTrendBars = (sessionCount = 1_122): readonly DailyBar[] =>
  makeBarsForUniverse(
    riskBalancedTrendFixtureProtocol.universe,
    PublicationSchema.AdjustedDailySnapshotV2,
    riskBalancedTrendFixtureProtocol.historyStart,
    sessionCount,
  )

export const makeSnapshot = (
  sessionCount = 900,
): { readonly bars: readonly DailyBar[]; readonly manifest: LegacyInputManifest } => {
  const bars = makeBars(sessionCount)
  const sessionDates = [...new Set(bars.map((bar) => bar.sessionDate))].sort()
  const firstSession = sessionDates.at(0)
  const lastSession = sessionDates.at(-1)
  const evaluationStart = sessionDates[Math.max(...fixtureProtocol.lookbacks)]
  if (firstSession === undefined || lastSession === undefined || evaluationStart === undefined) {
    throw new RangeError('fixture session count must cover the strategy lookback')
  }
  const material: Omit<LegacyInputManifest, 'hash'> = {
    schemaVersion: 'bayn.input-manifest.v2',
    database: 'signal',
    tables: {
      bars: 'adjusted_daily_bars_v2',
      sessions: 'exchange_sessions_v1',
      manifests: 'snapshot_manifests_v1',
    },
    finalizedSnapshot: {
      schemaVersion: 'bayn.finalized-snapshot.v2',
      snapshotId: '1'.repeat(64),
      publicationId: '2'.repeat(64),
      publicationSchemaVersion: PublicationSchema.AdjustedDailySnapshotV1,
      source: DataSource.Alpaca,
      sourceFeed: DataFeed.Sip,
      adjustment: PriceAdjustment.All,
      calendarVersion: 'fixture-calendar-v1',
      publisherSourceRevision: '3'.repeat(40),
      publisherImage: {
        repository: 'registry.ide-newton.ts.net/lab/signal-publisher',
        digest: `sha256:${'4'.repeat(64)}`,
      },
      finalizedAt: '2026-07-20T00:00:00.000Z',
      requestedStart: firstSession,
      firstSession,
      lastSession,
      asOfSession: lastSession,
      symbols: fixtureProtocol.universe,
      rowCount: bars.length,
      sessionCount: sessionDates.length,
      contentHash: '5'.repeat(64),
      sessionsContentHash: '6'.repeat(64),
    },
    bounds: {
      schemaVersion: 'bayn.evaluation-bounds.v1',
      dataStart: firstSession,
      dataEnd: lastSession,
      lookbackStart: firstSession,
      evaluationStart,
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

export const makeRiskBalancedTrendSnapshot = (
  sessionCount = 1_122,
): { readonly bars: readonly DailyBar[]; readonly manifest: UniverseBoundInputManifest } => {
  const bars = makeRiskBalancedTrendBars(sessionCount)
  const sessionDates = [...new Set(bars.map((bar) => bar.sessionDate))].sort()
  const firstSession = sessionDates.at(0)
  const lastSession = sessionDates.at(-1)
  if (
    firstSession === undefined ||
    lastSession === undefined ||
    !sessionDates.includes(riskBalancedTrendFixtureProtocol.evaluationStart)
  ) {
    throw new RangeError('fixture session count must cover the strategy evaluation start')
  }
  const material: Omit<UniverseBoundInputManifest, 'hash'> = {
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
      universeId: riskBalancedTrendFixtureProtocol.universeId,
      universeSymbolHash: riskBalancedTrendFixtureProtocol.universeSymbolHash,
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
      symbols: riskBalancedTrendFixtureProtocol.universe,
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
      evaluationStart: riskBalancedTrendFixtureProtocol.evaluationStart,
      evaluationEnd: lastSession,
    },
    rowCount: bars.length,
    sessionCount: sessionDates.length,
    firstSession,
    lastSession,
    symbols: riskBalancedTrendFixtureProtocol.universe.map((symbol) => ({
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

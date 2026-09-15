import { canonicalHashV1 } from '../hash'
import type { MarketDataContract } from '../market-data'
import { DataFeed, DataSource, PriceAdjustment, PublicationSchema, type InputManifest } from '../types'
import { fixtureProtocol } from './runtime-fixtures'

export const persistedMarketDataContract: MarketDataContract = {
  universeId: 'cross-asset-taa-v1',
  universeSymbolHash: fixtureProtocol.universeSymbolHash,
  universe: fixtureProtocol.universe,
  historyStart: '2026-03-02',
  evaluationStart: '2026-03-06',
}

export const makePersistedSnapshotFixture = (): InputManifest => {
  const session = '2026-08-28' as const
  const symbols = [...fixtureProtocol.universe]
  const rowCount = symbols.length
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
      universeId: 'cross-asset-taa-v1',
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
      finalizedAt: '2026-08-29T00:00:00.000Z',
      requestedStart: session,
      firstSession: session,
      lastSession: session,
      asOfSession: session,
      symbols,
      rowCount,
      sessionCount: 1,
      contentHash: 'b'.repeat(64),
      sessionsContentHash: 'c'.repeat(64),
    },
    bounds: {
      schemaVersion: 'bayn.evaluation-bounds.v1',
      dataStart: session,
      dataEnd: session,
      lookbackStart: session,
      evaluationStart: session,
      evaluationEnd: session,
    },
    rowCount,
    sessionCount: 1,
    firstSession: session,
    lastSession: session,
    symbols: symbols.map((symbol) => ({
      symbol,
      rows: 1,
      firstSession: session,
      lastSession: session,
    })),
  }
  return { ...material, hash: canonicalHashV1(material) }
}

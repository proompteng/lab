import { Result } from 'effect'

import { normalizeMarketCalendarResult } from '../broker/alpaca/normalizers'
import { sha256 } from '../hash'
import {
  makeArchiveAvailabilityReceipts,
  type ArchiveReaderIdentity,
  type ArchiveAvailabilityReceipt,
} from '../market-data/intraday/availability'
import {
  IntradaySnapshotPurpose,
  type ArchiveVerifiedIntradayMarketSnapshot,
  type IntradaySnapshotRequest,
} from '../market-data/intraday/model'
import { persistIntradaySnapshotRows, verifyIntradaySnapshot } from '../market-data/intraday/verification'
import { decodeDefaultIntradayMomentumProtocol } from '../strategy/intraday-momentum/protocol'
import { makeIntradayMomentumTestSnapshot } from '../strategy/intraday-momentum/test-support'

export const availabilityReader: ArchiveReaderIdentity = {
  endpointHash: sha256('http://archive.test:8123'),
  sourceRevision: 'a'.repeat(40),
  imageDigest: `sha256:${'b'.repeat(64)}`,
  verification: 'embedded',
}

const protocol = Result.getOrThrow(decodeDefaultIntradayMomentumProtocol())
export const availabilityRequest: IntradaySnapshotRequest = {
  sessionDate: '2026-09-04',
  calendar: Result.getOrThrow(
    normalizeMarketCalendarResult([{ date: '2026-09-04', open: '09:30', close: '16:00' }], {
      start: '2026-09-04',
      end: '2026-09-04',
    }),
  ),
  rangeStartAt: '2026-09-04T14:29:00.000Z',
  rangeEndAt: '2026-09-04T14:30:00.000Z',
  observedAt: '2026-09-04T14:30:02.000Z',
  universeId: protocol.universeId,
  universeSymbolHash: protocol.universeSymbolHash,
  universe: protocol.universe,
  symbols: ['AAPL'],
  purpose: IntradaySnapshotPurpose.EntryPricing,
  feed: protocol.feed,
  delayClass: protocol.delayClass,
  sourceTopics: protocol.sourceTopics,
  maximumQuoteAgeMs: 2_000,
  minimumWatermarkLagMs: 0,
  archiveWatermarks: Object.values(protocol.sourceTopics)
    .toSorted()
    .map((sourceTopic) => ({
      sourceTopic,
      sourcePartition: 0,
      inclusiveLastOffset: '1000',
    })),
}

export const availabilitySnapshot = makeIntradayMomentumTestSnapshot(protocol, availabilityRequest)

export const reobserveAvailabilitySnapshot = (
  observedAt: string,
  snapshot: ArchiveVerifiedIntradayMarketSnapshot = availabilitySnapshot,
): ArchiveVerifiedIntradayMarketSnapshot =>
  Result.getOrThrow(
    verifyIntradaySnapshot(
      { ...availabilityRequest, observedAt },
      {
        ...Result.getOrThrow(persistIntradaySnapshotRows(snapshot)),
        archiveWatermarks: availabilityRequest.archiveWatermarks.map((watermark) => ({
          source_topic: watermark.sourceTopic,
          source_partition: watermark.sourcePartition,
          inclusive_last_offset: watermark.inclusiveLastOffset,
        })),
      },
    ),
  ) as ArchiveVerifiedIntradayMarketSnapshot

export const receiptHasSymbol = (receipt: ArchiveAvailabilityReceipt, symbol: string): boolean => {
  const record = receipt.record
  return record !== null && typeof record === 'object' && 'symbol' in record && record['symbol'] === symbol
}

export const makeAvailabilityDecisionFixture = (lateCandidateBar = false) => {
  const { purpose: _purpose, ...common } = availabilityRequest
  const request: IntradaySnapshotRequest = {
    ...common,
    rangeStartAt: '2026-09-04T14:00:00.000Z',
    symbols: [...protocol.candidateSymbols, protocol.benchmarkSymbol].toSorted(),
    candidateSymbols: protocol.candidateSymbols,
  }
  const source = makeIntradayMomentumTestSnapshot(protocol, request, { AAPL: 0.02, AMZN: 0.01 })
  const rows = Result.getOrThrow(
    persistIntradaySnapshotRows({
      ...source,
      bars: source.bars.map((bar) =>
        lateCandidateBar && bar.symbol === 'AAPL' && bar.eventAt === request.rangeStartAt
          ? { ...bar, ingestedAt: new Date(Date.parse(bar.eventAt) + 65_000).toISOString() }
          : bar,
      ),
    }),
  )
  const archiveRows = {
    ...rows,
    archiveWatermarks: request.archiveWatermarks.map((watermark) => ({
      source_topic: watermark.sourceTopic,
      source_partition: watermark.sourcePartition,
      inclusive_last_offset: watermark.inclusiveLastOffset,
    })),
  }
  const captured = Result.getOrThrow(
    verifyIntradaySnapshot(request, archiveRows),
  ) as ArchiveVerifiedIntradayMarketSnapshot
  const observedAt = '2026-09-04T14:30:02.500Z'
  const snapshot = Result.getOrThrow(
    verifyIntradaySnapshot({ ...request, observedAt }, archiveRows),
  ) as ArchiveVerifiedIntradayMarketSnapshot
  const receipts = Result.getOrThrow(
    makeArchiveAvailabilityReceipts(captured, availabilityReader, request.observedAt, observedAt),
  )
  return { snapshot, receipts }
}

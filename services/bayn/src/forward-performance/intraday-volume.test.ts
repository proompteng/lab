import { expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import { canonicalHashV1 } from '../hash'
import { IntradayCandidateEvidencePolicy } from '../market-data/intraday/model'
import { IntradayPerformanceVolumeEvidenceSchema } from './intraday-schema'
import {
  makeIntradayPerformanceFixture,
  makeStreamingPerformanceFixture,
  makeStreamingPartitionPerformanceFixture,
} from './intraday-cycle.test-support'
import {
  intradayPerformanceDecisionRequest,
  makeIntradayPerformanceVolumeEvidence,
  validIntradayPerformanceVolumeEvidence,
} from './intraday-volume'
import { bindForwardPerformanceTerminalReferencePrices } from './program'

test.each([
  ['streaming', makeStreamingPerformanceFixture],
  ['intraday', makeIntradayPerformanceFixture],
] as const)('retains the candidate policy through %s performance evidence decoding', (_kind, fixture) => {
  const { request, archive, bars } = fixture()
  const { contentHash: _contentHash, snapshotId: _snapshotId, ...original } = request.decisionManifest
  const material = {
    ...original,
    candidateEvidencePolicy: IntradayCandidateEvidencePolicy.QuoteWithWindowTrade,
  }
  const hashed = { ...material, contentHash: canonicalHashV1(material) }
  const decisionManifest = { ...hashed, snapshotId: canonicalHashV1(hashed) }
  const currentRequest = { ...request, decisionManifest, decisionSnapshotId: decisionManifest.snapshotId }
  const evidence = Result.getOrThrow(makeIntradayPerformanceVolumeEvidence(currentRequest, archive, bars))
  if (evidence === undefined) throw new Error('expected complete policy-bound performance evidence')
  const decoded = Schema.decodeUnknownSync(IntradayPerformanceVolumeEvidenceSchema)(evidence)
  expect(evidence).toEqual(decoded)
  expect(validIntradayPerformanceVolumeEvidence(decoded)).toBe(true)
  expect(Result.getOrThrow(intradayPerformanceDecisionRequest(decoded))).toMatchObject({
    candidateEvidencePolicy: IntradayCandidateEvidencePolicy.QuoteWithWindowTrade,
    candidateSymbols: decisionManifest.candidateSymbols,
  })
  const { candidateEvidencePolicy: _policy, ...stripped } = decisionManifest
  const tampered = intradayPerformanceDecisionRequest({ ...currentRequest, decisionManifest: stripped })
  expect(Result.isFailure(tampered)).toBe(true)
  if (Result.isFailure(tampered)) expect(tampered.failure.message).toContain('snapshot identity differs')
})

test('reads a complete native session with exact microshares and an explicit IEX terminal mark', () => {
  const { request, archive, bars } = makeIntradayPerformanceFixture()
  const evidence = Result.getOrThrow(makeIntradayPerformanceVolumeEvidence(request, archive, bars))
  expect(evidence).toMatchObject({
    quantityMicros: '39000000000',
    closePriceMicros: '218690000',
    barCount: 390,
    sourceFeed: 'iex',
    finalizedAt: '2026-09-11T20:00:02.000Z',
    volumeScope: 'IEX_RECORDED_SESSION_VOLUME',
  })
  if (evidence === undefined) throw new Error('expected complete native evidence')
  expect(validIntradayPerformanceVolumeEvidence(evidence)).toBe(true)
  const bound = Result.getOrThrow(
    bindForwardPerformanceTerminalReferencePrices(
      [
        {
          cycleId: request.cycleId,
          decisionDocumentHash: 'a'.repeat(64),
          decisionHash: 'b'.repeat(64),
          decisionCreatedAt: request.decisionManifest.observedAt,
          intentId: 'c'.repeat(64),
          accountId: 'test-account',
          symbol: 'NVDA',
          side: 'BUY',
          fills: [],
          terminalOrder: {
            eventId: 'd'.repeat(64),
            brokerOrderId: 'order',
            clientOrderId: 'client',
            intentId: 'c'.repeat(64),
            accountId: 'test-account',
            symbol: 'NVDA',
            side: 'BUY',
            quantityMicros: '45000000',
            filledQuantityMicros: '18000000',
            status: 'CANCELED',
            occurredAt: '2026-09-11T14:01:41.000Z',
            observedAt: '2026-09-11T14:01:42.000Z',
          },
        },
      ],
      [evidence],
    ),
  )
  expect(bound[0]?.terminalReferencePrice).toMatchObject({
    priceMicros: '218690000',
    sourceEvidenceHash: evidence.contentHash,
  })
})

test('binds a streaming partial fill to a verified session close without changing the decision manifest', () => {
  const { request, archive, bars } = makeStreamingPerformanceFixture()
  const evidence = Result.getOrThrow(makeIntradayPerformanceVolumeEvidence(request, archive, bars))
  expect(evidence).toMatchObject({
    decisionManifest: request.decisionManifest,
    decisionSnapshotId: request.decisionSnapshotId,
    quantityMicros: '39000000000',
    closePriceMicros: '218690000',
    missingMinutes: [],
  })
  if (evidence === undefined) throw new Error('expected streaming session evidence')
  expect(validIntradayPerformanceVolumeEvidence(evidence)).toBe(true)
  const original = Result.getOrThrow(intradayPerformanceDecisionRequest(request))
  expect(original.archiveWatermarks).toEqual(
    request.decisionManifest.lineage.map((source) => ({
      sourceTopic: source.sourceTopic,
      sourcePartition: source.sourcePartition,
      inclusiveLastOffset: source.lastOffset,
    })),
  )
  const execution = {
    cycleId: request.cycleId,
    decisionDocumentHash: 'b'.repeat(64),
    decisionHash: 'c'.repeat(64),
    decisionCreatedAt: request.decisionManifest.observedAt,
    intentId: 'd'.repeat(64),
    accountId: 'test-account',
    symbol: request.symbol,
    side: 'BUY' as const,
    fills: [],
    terminalOrder: {
      eventId: 'e'.repeat(64),
      brokerOrderId: 'streaming-order',
      clientOrderId: 'streaming-client',
      intentId: 'd'.repeat(64),
      accountId: 'test-account',
      symbol: request.symbol,
      side: 'BUY' as const,
      quantityMicros: '39000000',
      filledQuantityMicros: '18000000',
      status: 'CANCELED' as const,
      occurredAt: '2026-09-04T14:30:04.000Z',
      observedAt: '2026-09-04T14:30:05.000Z',
    },
  }
  const bound = Result.getOrThrow(bindForwardPerformanceTerminalReferencePrices([execution], [evidence]))
  expect(bound[0]?.terminalReferencePrice).toMatchObject({
    priceMicros: '218690000',
    sourceEvidenceHash: evidence.contentHash,
  })
  expect(Result.getOrThrow(makeIntradayPerformanceVolumeEvidence(request, archive, bars.slice(0, -1)))).toBeUndefined()
  const missing = Result.getOrThrow(makeIntradayPerformanceVolumeEvidence(request, archive, bars.slice(1)))
  expect(missing?.missingMinutes).toEqual([request.windowOpenedAt])
})

test('retains session archive partitions that supplied no decision-window records', () => {
  const { request, archive, bars } = makeStreamingPartitionPerformanceFixture()
  expect(request.decisionManifest.lineage.some((source) => source.sourcePartition === 1)).toBe(false)
  const evidence = Result.getOrThrow(makeIntradayPerformanceVolumeEvidence(request, archive, bars))
  if (evidence === undefined) throw new Error('expected a complete session across both bar partitions')
  expect(evidence).toMatchObject({ archiveRequest: archive, barCount: 390, quantityMicros: '39000000000' })
  expect(validIntradayPerformanceVolumeEvidence(evidence)).toBe(true)
  expect(
    Result.isFailure(
      makeIntradayPerformanceVolumeEvidence(
        request,
        { ...archive, archiveWatermarks: archive.archiveWatermarks.filter((item) => item.sourcePartition !== 1) },
        bars,
      ),
    ),
  ).toBe(true)
})

test('rejects streaming cut tampering and an archive that has not retained the consumed decision rows', () => {
  const { request, archive, bars } = makeStreamingPerformanceFixture()
  const manifest = request.decisionManifest
  if (manifest.schemaVersion !== 'bayn.streaming-market-snapshot.v1') throw new Error('expected streaming fixture')
  const { contentHash: _contentHash, snapshotId: _snapshotId, ...material } = manifest
  const changed = {
    ...material,
    streaming: {
      ...manifest.streaming,
      positions: manifest.streaming.positions.map((position) => ({ ...position, offset: '0' })),
    },
  }
  const withHash = { ...changed, contentHash: canonicalHashV1(changed) }
  const tampered = { ...withHash, snapshotId: canonicalHashV1(withHash) }
  expect(
    Result.isFailure(
      intradayPerformanceDecisionRequest({
        ...request,
        decisionManifest: tampered,
        decisionSnapshotId: tampered.snapshotId,
      }),
    ),
  ).toBe(true)
  expect(
    Result.isFailure(
      makeIntradayPerformanceVolumeEvidence(
        request,
        {
          ...archive,
          archiveWatermarks: archive.archiveWatermarks.map((watermark) => ({
            ...watermark,
            inclusiveLastOffset: '0',
          })),
        },
        bars,
      ),
    ),
  ).toBe(true)
})

test('preserves an observed closing mark while reporting missing minutes and withholding absent or provisional closes', () => {
  const { request, archive, bars } = makeIntradayPerformanceFixture()
  const incomplete = Result.getOrThrow(makeIntradayPerformanceVolumeEvidence(request, archive, bars.slice(1)))
  expect(incomplete).toMatchObject({
    barCount: 389,
    missingMinutes: [request.windowOpenedAt],
    quantityMicros: '38900000000',
  })
  expect(Result.getOrThrow(makeIntradayPerformanceVolumeEvidence(request, archive, bars.slice(0, -1)))).toBeUndefined()
  expect(
    Result.getOrThrow(
      makeIntradayPerformanceVolumeEvidence(
        request,
        archive,
        bars.map((bar, i) => (i === 4 ? { ...bar, is_final: '0' } : bar)),
      ),
    ),
  ).toBeUndefined()
})

test('rejects mixed feeds, duplicate minutes, premature bars, after-cutoff ingestion and out-of-watermark offsets', () => {
  const { request, archive, bars } = makeIntradayPerformanceFixture()
  const first = bars[0]
  if (first === undefined) throw new Error('expected synthetic bars')
  for (const bad of [
    { ...first, feed: 'sip' },
    { ...first, symbol: 'IWM' },
    { ...first, source_offset: '9223372036854775808' },
    { ...first, source_offset: '01' },
    { ...first, source_offset: '9000000' },
    { ...first, source_partition: '2147483648' },
    { ...first, ingested_at: first.event_at },
    { ...first, ingested_at: '2026-09-11T21:00:00.001Z' },
    { ...first, volume: '1.00000001' },
  ])
    expect(Result.isFailure(makeIntradayPerformanceVolumeEvidence(request, archive, [bad, ...bars.slice(1)]))).toBe(
      true,
    )
  expect(Result.isFailure(makeIntradayPerformanceVolumeEvidence(request, archive, [first, ...bars]))).toBe(true)
})

test('rejects tampered decision identity, shifted session or cutoff, and rehashed source substitutions', () => {
  const { request, archive, bars } = makeIntradayPerformanceFixture()
  expect(
    Result.isFailure(
      makeIntradayPerformanceVolumeEvidence({ ...request, decisionSnapshotId: '0'.repeat(64) }, archive, bars),
    ),
  ).toBe(true)
  expect(
    Result.isFailure(
      makeIntradayPerformanceVolumeEvidence(request, { ...archive, observedAt: '2026-09-11T22:00:00.000Z' }, bars),
    ),
  ).toBe(true)
  const evidence = Result.getOrThrow(makeIntradayPerformanceVolumeEvidence(request, archive, bars))
  if (evidence === undefined) throw new Error('expected evidence')
  const { contentHash: _hash, ...material } = evidence
  for (const change of [
    { ...material, windowOpenedAt: '2026-09-11T14:30:00.000Z' },
    { ...material, decisionManifest: { ...material.decisionManifest, universeId: 'another-universe' } },
    { ...material, barCount: 389 },
  ]) {
    expect(validIntradayPerformanceVolumeEvidence({ ...change, contentHash: canonicalHashV1(change) })).toBe(false)
  }
})

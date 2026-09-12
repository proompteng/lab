import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { canonicalHashV1 } from '../hash'
import { makeIntradayPerformanceFixture } from './intraday-cycle.test-support'
import { makeIntradayPerformanceVolumeEvidence, validIntradayPerformanceVolumeEvidence } from './intraday-volume'
import { bindForwardPerformanceTerminalReferencePrices } from './program'

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

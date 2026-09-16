import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { IntradaySnapshotFailure, type IntradaySnapshotRequest } from '../market-data/intraday/model'
import { decodeIntradayBarRows } from '../market-data/intraday/rows'
import { intradayInstantNanos } from '../market-data/intraday/time'
import { verifyIntradayArchiveWatermarks, verifyIntradaySnapshotRequest } from '../market-data/intraday/verification'
import { IntradayPerformanceManifestSchema, IntradayPerformanceVolumeEvidenceSchema } from './intraday-schema'
import type {
  ForwardPerformanceIntradayMarketVolumeEvidence,
  ForwardPerformanceIntradayMarketVolumeRequest,
} from './model'

const minuteNanos = 60_000_000_000n
const maxOffset = 9_223_372_036_854_775_807n
const failure = (message: string, cause?: unknown) =>
  new IntradaySnapshotFailure({ reason: 'rows', message, ...(cause === undefined ? {} : { cause }) })
const hash = (value: unknown) =>
  canonicalHashV1Result(value).pipe(
    Result.mapError((cause) => failure('intraday performance evidence could not be hashed', cause)),
  )
const canonicalOffset = (value: string): boolean => /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= maxOffset
const micros = (value: number | string): bigint | undefined => {
  const match = /^(0|[1-9][0-9]*)(?:[.]([0-9]*))?$/.exec(String(value))
  if (match?.[1] === undefined) return undefined
  const fraction = match[2] ?? ''
  if (fraction.slice(6).replaceAll('0', '') !== '') return undefined
  return BigInt(match[1]) * 1_000_000n + BigInt(fraction.slice(0, 6).padEnd(6, '0'))
}

export const intradayPerformanceDecisionRequest = (
  request: ForwardPerformanceIntradayMarketVolumeRequest,
): Result.Result<IntradaySnapshotRequest, IntradaySnapshotFailure> =>
  Result.gen(function* () {
    const manifest = yield* Schema.decodeUnknownResult(IntradayPerformanceManifestSchema)(
      request.decisionManifest,
    ).pipe(Result.mapError((cause) => failure('intraday performance decision manifest is invalid', cause)))
    const { snapshotId, contentHash, ...material } = manifest
    if (
      contentHash !== (yield* hash(material)) ||
      snapshotId !== (yield* hash({ ...material, contentHash })) ||
      snapshotId !== request.decisionSnapshotId
    ) {
      return yield* Result.fail(failure('intraday performance decision snapshot identity differs'))
    }
    const original = yield* verifyIntradaySnapshotRequest({
      sessionDate: manifest.sessionDate,
      calendar: manifest.calendar,
      rangeStartAt: manifest.rangeStartAt,
      rangeEndAt: manifest.rangeEndAt,
      observedAt: manifest.observedAt,
      universeId: manifest.universeId,
      universeSymbolHash: manifest.universeSymbolHash,
      universe: manifest.universe ?? manifest.symbols,
      symbols: manifest.symbols,
      ...(manifest.purpose === undefined ? {} : { purpose: manifest.purpose }),
      ...(manifest.candidateSymbols === undefined ? {} : { candidateSymbols: manifest.candidateSymbols }),
      feed: manifest.feed,
      delayClass: manifest.delayClass,
      sourceTopics: manifest.sourceTopics,
      maximumQuoteAgeMs: manifest.maximumQuoteAgeMs,
      minimumWatermarkLagMs: manifest.minimumWatermarkLagMs,
      archiveWatermarks: manifest.archiveWatermarks,
    })
    const session = original.calendar.sessions.find((item) => item.date === request.executionSessionDate)
    if (
      request.sourceFeed !== 'iex' ||
      request.decisionSnapshotAsOfSession !== manifest.sessionDate ||
      manifest.sessionDate !== request.executionSessionDate ||
      !original.universe.includes(request.symbol) ||
      session?.openAt !== request.windowOpenedAt ||
      session.closeAt !== request.windowClosedAt ||
      !Number.isFinite(Date.parse(request.evidenceCutoffAt)) ||
      request.evidenceCutoffAt < request.windowClosedAt ||
      request.evidenceCutoffAt < manifest.observedAt
    ) {
      return yield* Result.fail(
        failure('intraday performance request differs from its decision session, universe or cutoff'),
      )
    }
    return original
  })

// This query is retrospective: its observation time is the report cutoff. It is
// never passed to the decision snapshot loader or used as entry authorization.
export const intradayPerformanceSessionQuery = (
  request: ForwardPerformanceIntradayMarketVolumeRequest,
  original: IntradaySnapshotRequest,
): IntradaySnapshotRequest => ({
  sessionDate: original.sessionDate,
  calendar: original.calendar,
  rangeStartAt: request.windowOpenedAt,
  rangeEndAt: request.windowClosedAt,
  observedAt: request.evidenceCutoffAt,
  universeId: original.universeId,
  universeSymbolHash: original.universeSymbolHash,
  universe: original.universe,
  symbols: [request.symbol],
  feed: original.feed,
  delayClass: original.delayClass,
  sourceTopics: original.sourceTopics,
  maximumQuoteAgeMs: original.maximumQuoteAgeMs,
  minimumWatermarkLagMs: original.minimumWatermarkLagMs,
  archiveWatermarks: original.archiveWatermarks,
})

const verifyArchiveRequest = (
  request: ForwardPerformanceIntradayMarketVolumeRequest,
  archiveRequest: IntradaySnapshotRequest,
) =>
  Result.gen(function* () {
    const original = yield* intradayPerformanceDecisionRequest(request)
    const watermarks = yield* verifyIntradayArchiveWatermarks(
      original,
      archiveRequest.archiveWatermarks.map((item) => ({
        source_topic: item.sourceTopic,
        source_partition: item.sourcePartition,
        inclusive_last_offset: item.inclusiveLastOffset,
      })),
    )
    const expected = { ...intradayPerformanceSessionQuery(request, original), archiveWatermarks: watermarks }
    if ((yield* hash(expected)) !== (yield* hash(archiveRequest)))
      return yield* Result.fail(failure('intraday performance archive request is not bound to the completed session'))
    for (const watermark of original.archiveWatermarks) {
      const observed = watermarks.find(
        (item) => item.sourceTopic === watermark.sourceTopic && item.sourcePartition === watermark.sourcePartition,
      )
      if (observed === undefined || BigInt(observed.inclusiveLastOffset) < BigInt(watermark.inclusiveLastOffset))
        return yield* Result.fail(failure('intraday performance archive does not retain the decision watermarks'))
    }
    return expected
  })

export const makeIntradayPerformanceVolumeEvidence = (
  request: ForwardPerformanceIntradayMarketVolumeRequest,
  archiveRequest: IntradaySnapshotRequest,
  rawBars: readonly unknown[],
): Result.Result<ForwardPerformanceIntradayMarketVolumeEvidence | undefined, IntradaySnapshotFailure> =>
  Result.gen(function* () {
    const archive = yield* verifyArchiveRequest(request, archiveRequest)
    const bars = yield* decodeIntradayBarRows(rawBars)
    const open = intradayInstantNanos(request.windowOpenedAt)
    const close = intradayInstantNanos(request.windowClosedAt)
    const cutoff = intradayInstantNanos(request.evidenceCutoffAt)
    let lastEvent: bigint | undefined
    let quantity = 0n
    let finalizedAt = request.windowClosedAt
    for (const bar of bars) {
      const event = intradayInstantNanos(bar.event_at)
      const ingested = intradayInstantNanos(bar.ingested_at)
      const partition = Number(bar.source_partition)
      const watermark = archive.archiveWatermarks.find(
        (item) => item.sourceTopic === bar.source_topic && item.sourcePartition === partition,
      )
      if (
        bar.provider !== 'alpaca' ||
        bar.feed !== 'iex' ||
        bar.delay_class !== 'real_time_exchange_only' ||
        bar.universe_id !== archive.universeId ||
        bar.universe_symbol_hash !== archive.universeSymbolHash ||
        bar.symbol !== request.symbol ||
        bar.source_topic !== archive.sourceTopics.bars ||
        !Number.isSafeInteger(partition) ||
        partition < 0 ||
        partition > 2_147_483_647 ||
        !canonicalOffset(bar.source_offset) ||
        watermark === undefined ||
        BigInt(bar.source_offset) > BigInt(watermark.inclusiveLastOffset) ||
        event < open ||
        event >= close ||
        event % minuteNanos !== 0n ||
        (lastEvent !== undefined && event <= lastEvent) ||
        ingested < event + minuteNanos ||
        ingested > cutoff
      ) {
        return yield* Result.fail(
          failure('intraday performance bar violates identity, ordering, availability or watermark bounds'),
        )
      }
      const volume = micros(bar.volume)
      if (volume === undefined)
        return yield* Result.fail(failure('intraday performance volume cannot be represented exactly in microshares'))
      quantity += volume
      lastEvent = event
      if (ingested > intradayInstantNanos(finalizedAt))
        finalizedAt = new Date(Date.parse(bar.ingested_at)).toISOString()
    }
    // A missing minute is retained as an evidence gap, never a synthetic zero-volume bar.
    if (lastEvent !== close - minuteNanos || bars.some((bar) => String(bar.is_final) !== '1')) return undefined
    const observed = new Set(bars.map((bar) => intradayInstantNanos(bar.event_at)))
    const missingMinutes: string[] = []
    for (let minute = open; minute < close; minute += minuteNanos) {
      if (!observed.has(minute)) missingMinutes.push(new Date(Number(minute / 1_000_000n)).toISOString())
    }
    const last = bars.at(-1)
    const price = last === undefined ? undefined : micros(last.close)
    if (quantity <= 0n || price === undefined || price <= 0n) return undefined
    const material = {
      ...request,
      schemaVersion: 'bayn.forward-performance-intraday-volume-evidence.v1' as const,
      volumeScope: 'IEX_RECORDED_SESSION_VOLUME' as const,
      terminalPriceBasis: 'FINAL_MINUTE_BAR_CLOSE' as const,
      quantityMicros: quantity.toString(),
      closePriceMicros: price.toString(),
      finalizedAt,
      archiveRequest: archive,
      barCount: bars.length,
      missingMinutes,
      barsContentHash: yield* hash(bars),
    }
    return { ...material, contentHash: yield* hash(material) }
  })

export const validIntradayPerformanceVolumeEvidence = (
  evidence: ForwardPerformanceIntradayMarketVolumeEvidence,
): boolean => {
  if (!Schema.is(IntradayPerformanceVolumeEvidenceSchema)(evidence)) return false
  const expectedMinutes = (Date.parse(evidence.windowClosedAt) - Date.parse(evidence.windowOpenedAt)) / 60_000
  const missing = evidence.missingMinutes
  if (
    missing.some(
      (minute, i) =>
        Date.parse(minute) % 60_000 !== 0 ||
        minute < evidence.windowOpenedAt ||
        Date.parse(minute) >= Date.parse(evidence.windowClosedAt) - 60_000 ||
        (i > 0 && minute <= (missing[i - 1] ?? minute)),
    )
  )
    return false
  const { contentHash, ...material } = evidence
  const expected = canonicalHashV1Result(material)
  return (
    Result.isSuccess(expected) &&
    expected.success === contentHash &&
    Result.isSuccess(verifyArchiveRequest(evidence, evidence.archiveRequest)) &&
    evidence.schemaVersion === 'bayn.forward-performance-intraday-volume-evidence.v1' &&
    evidence.volumeScope === 'IEX_RECORDED_SESSION_VOLUME' &&
    evidence.terminalPriceBasis === 'FINAL_MINUTE_BAR_CLOSE' &&
    /^[a-f0-9]{64}$/.test(evidence.barsContentHash) &&
    /^[1-9][0-9]*$/.test(evidence.quantityMicros) &&
    /^[1-9][0-9]*$/.test(evidence.closePriceMicros) &&
    evidence.barCount > 0 &&
    evidence.barCount + missing.length === expectedMinutes &&
    evidence.finalizedAt >= evidence.windowClosedAt &&
    evidence.finalizedAt <= evidence.evidenceCutoffAt
  )
}

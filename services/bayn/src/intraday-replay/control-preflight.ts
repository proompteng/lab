import { Effect, Result, Schema } from 'effect'

import { normalizeMarketCalendarResult } from '../broker/alpaca/normalizers'
import type { MarketCalendarObservation, MarketCalendarSession } from '../broker/alpaca/model'
import { canonicalHashV1Result } from '../hash'
import type { JevProtocol } from '../jev/protocol'
import { IntradaySnapshotFailure } from '../market-data/intraday/model'
import { constructSimulatedSnapshot } from '../market-data/streaming/snapshot'
import { IsoDateSchema } from '../schemas'
import { ControlStudyFailure } from './control-portfolio'
import { makeControlEntryQuery, prepareControlStudy, type ControlMarket } from './control-study'
import { openBacktestSource, type BacktestSourceReceipt } from './source'

export enum ControlInputCoverage {
  Complete = 'COMPLETE',
  Incomplete = 'INCOMPLETE',
  NoEligiblePolls = 'NO_ELIGIBLE_POLLS',
}

const definition = {
  schemaVersion: 'bayn.control-input-preflight-definition.v1',
  scope: 'Every session-open anchored entry-eligible poll across the full native candidate universe and benchmark.',
  observations:
    'Use the same entry query and verified snapshot constructor as control replay. Do not consume repeated minute windows, simulate holdings, select signals, call models or evaluate returns.',
  coverage:
    'COMPLETE requires at least one eligible poll and no unavailable snapshot or candidate exclusion. This strict input-coverage result is not the production admission policy. Candidate exclusions remain distinct from whole-snapshot failures.',
  source:
    "Use one shared source cursor across sessions, retaining the source reader's whole-file verification and replay checks. Preserve the original receipt without upgrading its availability or completeness claims.",
  limitations:
    'Input compatibility only. No execution, capacity, latency, costs, profitability, prospective qualification or capital authority is established.',
} as const

export const scanControlInputs = (input: {
  readonly protocol: JevProtocol
  readonly session: MarketCalendarSession
  readonly calendar: MarketCalendarObservation
  readonly pollIntervalMs: number
  readonly market: Pick<ControlMarket, 'advanceTo' | 'snapshot'>
}) =>
  Effect.gen(function* () {
    const { protocol, session, market, pollIntervalMs } = input
    const sessionDate = yield* Schema.decodeUnknownEffect(IsoDateSchema)(session.date)
    const openMs = Date.parse(session.openAt)
    const closeMs = Date.parse(session.closeAt)
    if (
      !Number.isSafeInteger(openMs) ||
      !Number.isSafeInteger(closeMs) ||
      closeMs <= openMs ||
      !Number.isSafeInteger(pollIntervalMs) ||
      pollIntervalMs <= 0 ||
      pollIntervalMs > 60_000
    )
      return yield* new ControlStudyFailure({ message: 'Preflight requires a valid session and bounded poll cadence' })
    const warmupMs = openMs + protocol.lookbackMinutes * 60_000 + protocol.decisionDelaySeconds * 1000
    const cutoffMs = closeMs - protocol.entryCutoffMinutesBeforeClose * 60_000
    const scheduledPollCount = Math.ceil((closeMs - openMs) / pollIntervalMs)
    let warmupPollCount = 0
    let entryCutoffPollCount = 0
    let availableSnapshotCount = 0
    let unavailableSnapshotCount = 0
    const failures = new Map<string, { reason: string; count: number; firstObservedAt: string; firstMessage: string }>()
    const candidates = protocol.candidateSymbols.map((symbol) => ({
      symbol,
      availableCount: 0,
      excludedCount: 0,
      snapshotUnavailableCount: 0,
      exclusionCounts: {} as Partial<Record<'not-ready' | 'freshness', number>>,
    }))
    for (let ordinal = 0; ordinal < scheduledPollCount; ordinal++) {
      const atMs = openMs + ordinal * pollIntervalMs
      if (atMs < warmupMs) {
        warmupPollCount++
        continue
      }
      if (atMs >= cutoffMs) {
        entryCutoffPollCount++
        continue
      }
      yield* market.advanceTo(atMs)
      const query = makeControlEntryQuery({
        protocol,
        sessionDate,
        calendar: input.calendar,
        observedAtMs: atMs,
        candidates: protocol.candidateSymbols,
      })
      const observation = yield* market.snapshot(query)
      if (observation.status === 'UNAVAILABLE') {
        unavailableSnapshotCount++
        const native = observation.cause instanceof IntradaySnapshotFailure ? observation.cause : null
        const reason = native?.reason ?? 'unclassified'
        const previous = failures.get(reason)
        if (previous === undefined)
          failures.set(reason, {
            reason,
            count: 1,
            firstObservedAt: query.observedAt,
            firstMessage: native?.message ?? 'Snapshot failure without a native reason',
          })
        else previous.count++
        for (const candidate of candidates) candidate.snapshotUnavailableCount++
      } else {
        availableSnapshotCount++
        for (const candidate of candidates) {
          const exclusion = observation.snapshot.manifest.candidateExclusions?.find(
            (entry) => entry.symbol === candidate.symbol,
          )
          if (exclusion === undefined) candidate.availableCount++
          else {
            candidate.excludedCount++
            candidate.exclusionCounts[exclusion.reason] = (candidate.exclusionCounts[exclusion.reason] ?? 0) + 1
          }
        }
      }
    }
    const eligiblePollCount = availableSnapshotCount + unavailableSnapshotCount
    return {
      sessionDate,
      coverage:
        eligiblePollCount === 0
          ? ControlInputCoverage.NoEligiblePolls
          : unavailableSnapshotCount > 0 || candidates.some((candidate) => candidate.excludedCount > 0)
            ? ControlInputCoverage.Incomplete
            : ControlInputCoverage.Complete,
      schedule: { openAt: session.openAt, closeAtExclusive: session.closeAt, pollIntervalMs },
      scheduledPollCount,
      warmupPollCount,
      entryCutoffPollCount,
      eligiblePollCount,
      availableSnapshotCount,
      unavailableSnapshotCount,
      candidates,
      failures: [...failures.values()],
    }
  })

export const runControlPreflight = (raw: unknown, arrivalsPath: string, receipt: BacktestSourceReceipt) =>
  Effect.gen(function* () {
    const { input, prepared, definition: studyDefinition } = yield* Effect.fromResult(prepareControlStudy(raw, receipt))
    if (input.schemaVersion === 'bayn.control-study-input.v6')
      return yield* new ControlStudyFailure({
        message: 'Native snapshot preflight does not certify Ridge feature coverage',
      })
    const firstDate = prepared.input.sessionDates[0]
    const lastDate = prepared.input.calendar.at(-1)?.date
    if (firstDate === undefined || lastDate === undefined)
      return yield* new ControlStudyFailure({ message: 'Preflight calendar has no boundary sessions' })
    const calendar = yield* Effect.fromResult(
      normalizeMarketCalendarResult(prepared.input.calendar, { start: firstDate, end: lastDate }),
    )
    const runId = yield* Effect.fromResult(
      canonicalHashV1Result({ definition, studyDefinition, input, sourceReceiptHash: receipt.contentHash }),
    )
    const source = yield* openBacktestSource(arrivalsPath, prepared.input.source, runId, receipt)
    const market: Pick<ControlMarket, 'advanceTo' | 'snapshot'> = {
      advanceTo: (atMs) =>
        source
          .advanceTo(atMs)
          .pipe(
            Effect.mapError((cause) => new ControlStudyFailure({ message: 'Cannot advance preflight source', cause })),
          ),
      snapshot: (query) =>
        source.cursor.pipe(
          Effect.map((cursor) => {
            const result = constructSimulatedSnapshot(cursor, source.source, query)
            return Result.isSuccess(result)
              ? { status: 'AVAILABLE' as const, snapshot: result.success }
              : { status: 'UNAVAILABLE' as const, cause: result.failure }
          }),
        ),
    }
    const sessions = []
    for (const session of prepared.sessions)
      sessions.push(
        yield* scanControlInputs({
          protocol: prepared.protocol,
          session,
          calendar,
          pollIntervalMs: prepared.input.cadence.pollIntervalMs,
          market,
        }),
      )
    yield* source.finish
    const report = {
      schemaVersion: 'bayn.control-input-preflight.v1',
      classification: 'INPUT_COMPATIBILITY_ONLY',
      runId,
      definition,
      studyDefinitionHash: yield* Effect.fromResult(canonicalHashV1Result(studyDefinition)),
      input,
      sourceReceipt: receipt.value,
      sourceReceiptHash: receipt.contentHash,
      coverage: sessions.every((session) => session.coverage === ControlInputCoverage.Complete)
        ? ControlInputCoverage.Complete
        : sessions.every((session) => session.coverage === ControlInputCoverage.NoEligiblePolls)
          ? ControlInputCoverage.NoEligiblePolls
          : ControlInputCoverage.Incomplete,
      sessions,
    }
    return { ...report, reportHash: yield* Effect.fromResult(canonicalHashV1Result(report)) }
  }).pipe(Effect.scoped)

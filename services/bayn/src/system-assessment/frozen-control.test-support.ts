import { Effect, Result, Schema } from 'effect'
import protocol from './fixtures/frozen-control-protocol.json'
import { JevResearchPolicy } from '../jev/acceptance'
import { testHash } from './fixtures.test-support'
import {
  fullBatchLatencyFixture,
  latencyCalibrationDecisionFixture,
  calibrateNativeLatencyFixture,
  nativeLatencyBacktestFixture,
} from './latency.test-support'
import { prepareSystemLatencyReplay } from './latency-replay'
import { sha256 } from '../hash'
import { FrozenControlReplaySchema, frozenReplayReplica } from './frozen-control-replay'

import type { SystemRegistration } from './policy'
import { withRegistrationCommitments } from './fixtures.test-support'
import { nativeJevFixture } from '../jev/native.test-support'
import { normalizeMarketCalendarResult } from '../broker/alpaca/normalizers'
import { JevPurpose } from '../jev/portfolio'

export const frozenControlReplayFixture = async (
  sessions?: SystemRegistration['calendar']['sessions'],
  syntheticHistory?: string,
) => {
  let calibrationEffect = latencyCalibrationDecisionFixture
  if (sessions !== undefined) {
    const first = sessions[0]
    const last = sessions.at(-1)
    if (first === undefined || last === undefined) throw Error('Missing fixture sessions')
    const localTime = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
    const rows = sessions.map((session) => {
      const open = localTime.format(new Date(session.openAt))
      const close = localTime.format(new Date(session.closeAt))
      return {
        date: session.sessionDate,
        open,
        close,
        session_open: open.replace(':', ''),
        session_close: close.replace(':', ''),
      }
    })
    const calendar = Result.getOrThrow(
      normalizeMarketCalendarResult(rows, { start: first.sessionDate, end: last.sessionDate }),
    )
    const observedAt = new Date(Date.parse(first.openAt) + 31 * 60000 + 2000).toISOString()
    calibrationEffect = calibrateNativeLatencyFixture(
      nativeJevFixture(JevPurpose.Entry, observedAt, undefined, undefined, undefined, undefined, calendar),
    )
  }
  const native = await Effect.runPromise(calibrationEffect)
  const reference = nativeLatencyBacktestFixture(fullBatchLatencyFixture(native.document, native.native, sessions))
  const definition = reference.registration.policies.find((policy) => policy.policy === JevResearchPolicy.Deployed)!
  const first = reference.registration.calendar.sessions[0]!
  const last = reference.registration.calendar.sessions.at(-1)!
  const topics = { ...protocol.sourceTopics, features: protocol.streamingInput.featureTopic }
  const universe = {
    universeId: protocol.universeId,
    universeSymbolHash: protocol.universeSymbolHash,
    symbols: protocol.universe,
    topics,
  }
  const positions = Object.values(topics)
    .sort()
    .map((topic) => ({ topic, partition: 0, startOffset: '0', endOffsetExclusive: '1' }))
  const source = {
    schemaVersion: 'bayn.backtest-source.v1',
    encoding: 'ndjson-gzip',
    transport: 'captured-kafka',
    dataSha256: testHash('synthetic original-policy arrivals'),
    recordCount: positions.length,
    coverageStartMs: Date.parse(first.openAt),
    coverageEndMs: Date.parse(last.closeAt),
    firstAvailableAtMs: Date.parse(first.openAt),
    lastAvailableAtMs: Date.parse(last.closeAt),
    origin: 'Synthetic original-policy registration fixture; no execution or qualification claim',
    positions,
    universe,
    deliveryModel: {
      schemaVersion: 'bayn.supplied-arrival-times.v1',
      description: 'Synthetic recorded arrival fixture',
      tieBreak: 'availability-topic-partition-offset',
    },
  }
  const originalContext = reference.input.latencyStress!
  const registration =
    syntheticHistory === undefined
      ? reference.registration
      : withRegistrationCommitments({
          ...reference.registration,
          priorAttemptHash: testHash({ schemaVersion: 'bayn.synthetic-history.v1', origin: syntheticHistory }),
        })
  const context = {
    ...originalContext,
    registration,
    sourceCut: { ...originalContext.sourceCut, registrationHash: testHash(registration) },
  }
  const calibration = Result.getOrThrow(prepareSystemLatencyReplay(context))
  const capture = JSON.stringify({
    schemaVersion: 'bayn.replay-source-capture.v1',
    capturedAt: new Date(Date.parse(last.closeAt) + 1).toISOString(),
    origin: source.origin,
    coverageStartMs: source.coverageStartMs,
    coverageEndMs: source.coverageEndMs,
    universe,
    positions,
  })
  const input = Schema.decodeUnknownSync(FrozenControlReplaySchema)({
    schemaVersion: 'bayn.frozen-control-replay.v1',
    policy: JevResearchPolicy.Deployed,
    protocol,
    executionInstruments: reference.input.assumptions.instruments,
    backtest: {
      schemaVersion: 'bayn.backtest.v1',
      replicate: 'unsealed-fixture',
      sessionDates: reference.registration.calendar.sessions.map((session) => session.sessionDate),
      source,
      openingCashMicros: reference.input.openingCashMicros,
      fractionalTrading: reference.input.fractionalTrading,
      calendar: reference.input.calendar.map(({ date, open, close }) => ({ date, open, close })),
      assets: protocol.universe.map((symbol, index) => ({
        id: `12345678-1234-4234-8234-${String(index).padStart(12, '0')}`,
        symbol,
        class: 'us_equity',
        exchange: 'NASDAQ',
        status: 'active',
        tradable: true,
        fractionable: true,
      })),
      assetObservationAt: first.openAt,
      assetObservationPolicy: 'retained-as-of-session',
      build: {
        sourceRevision: definition.sourceRevision,
        imageRepository: reference.input.build.imageRepository,
        imageDigest: `sha256:${definition.imageDigest}`,
        strategyBehaviorHash: definition.strategyHash,
        strategyParameterHash: definition.parametersHash,
      },
      assumptions: {
        latencyMs: reference.input.assumptions.latencyMs,
        slippageBps: reference.input.assumptions.slippageBps,
        availableLiquidityPpm: reference.input.assumptions.availableLiquidityPpm,
        feeMultiplierPpm: reference.input.assumptions.feeMultiplierPpm,
      },
      cadence: reference.input.cadence,
    },
    latencyStress: { ...context, p95FullBatchMs: calibration.p95FullBatchMs },
  })
  const captureHash = sha256(capture)
  return {
    input: {
      ...input,
      backtest: { ...input.backtest, replicate: Result.getOrThrow(frozenReplayReplica(input, captureHash)) },
    },
    capture,
    captureHash,
  }
}

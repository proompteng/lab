import { readFileSync, writeFileSync } from 'node:fs'
import { Result, Schema } from 'effect'
import { normalizeMarketCalendarResult } from '../src/broker/alpaca/normalizers'
import { sha256 } from '../src/hash'
import { registeredReplayInferenceTariff } from '../src/intraday-replay/inference-costs'
import { JevResearchPolicy } from '../src/jev/acceptance'
import { IsoDateSchema } from '../src/schemas'
import { assessmentFixture } from '../src/system-assessment/fixtures.test-support'
import { frozenControlReplayFixture } from '../src/system-assessment/frozen-control.test-support'
import {
  FrozenControlBacktestSchema,
  FrozenControlReplaySchema,
  frozenReplayReplica,
  prepareFrozenControlReplay,
} from '../src/system-assessment/frozen-control-replay'
import { reproduceFrozenControlReport } from '../src/system-assessment/frozen-control-report'

const [mode, directory] = process.argv.slice(2)
if (process.versions.node !== '24.11.1' || directory === undefined || (mode !== 'prepare' && mode !== 'verify'))
  throw Error('Use pinned Node: <prepare|verify> <synthetic-scenario-directory>')
const capture = readFileSync(`${directory}/capture.json`, 'utf8')
const captureHash = sha256(capture)
if (mode === 'prepare') {
  const old = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ backtest: FrozenControlBacktestSchema })))(
    readFileSync(`${directory}/input.json`, 'utf8'),
  ).backtest
  const first = old.sessionDates[0],
    last = old.sessionDates.at(-1)
  if (first === undefined || last === undefined) throw Error('Missing original scenario sessions')
  const calendar = Result.getOrThrow(
    normalizeMarketCalendarResult(
      old.calendar
        .filter((day) => old.sessionDates.includes(day.date))
        .map((day) => ({ ...day, session_open: day.open.replace(':', ''), session_close: day.close.replace(':', '') })),
      { start: first, end: last },
    ),
  )
  const fixture = await frozenControlReplayFixture(
    calendar.providerSessions.map((session) => ({
      sessionDate: Schema.decodeUnknownSync(IsoDateSchema)(session.date),
      openAt: session.regularOpenAt,
      closeAt: session.regularCloseAt,
    })),
    old.replicate,
  )
  const initial = {
    ...fixture.input,
    backtest: {
      ...fixture.input.backtest,
      source: old.source,
      calendar: old.calendar,
      assets: old.assets,
      assetObservationAt: old.assetObservationAt,
    },
  }
  const input = {
    ...initial,
    backtest: { ...initial.backtest, replicate: Result.getOrThrow(frozenReplayReplica(initial, captureHash)) },
  }
  Result.getOrThrowWith(prepareFrozenControlReplay(input, capture, captureHash), (cause) => cause)
  writeFileSync(`${directory}/registered-input.json`, JSON.stringify(input) + '\n')
} else {
  const input = Schema.decodeUnknownSync(Schema.fromJsonString(FrozenControlReplaySchema))(
    readFileSync(`${directory}/registered-input.json`, 'utf8'),
  )
  const prepared = Result.getOrThrowWith(prepareFrozenControlReplay(input, capture, captureHash), (cause) => cause)
  const report: unknown = JSON.parse(readFileSync(`${directory}/output/report.json`, 'utf8'))
  const fixture = assessmentFixture(prepared.stress.registration)
  const policy = fixture.input.policies.find((policy) => policy.policy === JevResearchPolicy.Deployed)
  const sessions = prepared.stress.registration.calendar.sessions
  const first = sessions[0],
    last = sessions.at(-1)
  if (policy === undefined || first === undefined || last === undefined)
    throw Error('Missing original scenario registration')
  const costs = {
    policy: JevResearchPolicy.Deployed,
    allocationRuleHash: prepared.definition.costAllocationRuleHash,
    asOf: fixture.input.asOf,
    inferenceCalls: [],
    inferenceTariff: Result.getOrThrow(
      registeredReplayInferenceTariff(
        prepared.definition.inferenceRateCard,
        { startAt: first.openAt, endAt: last.closeAt },
        JevResearchPolicy.Deployed,
      ),
    ),
    sessions: policy.sessions.map((session) => ({ ...session.operatingCosts, trading: null })),
  }
  const value = Result.getOrThrowWith(
    reproduceFrozenControlReport(prepared, report, costs, fixture.verifiedSources),
    (cause) => cause,
  )
  const economics = value.economics
  if (
    economics?.complete !== true ||
    economics.sessions.length !== 20 ||
    value.report.brokerState.fills.length !== 40 ||
    value.report.frozenLatency.receipts.length !== 40
  )
    throw Error(
      'Original control did not retain all synthetic sessions, fills, release receipts and complete economics',
    )
  const execution = economics.sessions.reduce((sum, session) => sum + BigInt(session.executionPnlMicros), 0n)
  const qualification = economics.sessions.reduce(
    (sum, session) => sum + BigInt(session.qualificationPnlMicros ?? '0'),
    0n,
  )
  if (execution >= 0n || qualification >= execution)
    throw Error('Synthetic spread losses or operating charges were omitted')
  process.stdout.write(
    JSON.stringify({
      scenario: 'SYNTHETIC_FROZEN_CONTROL',
      sessions: 20,
      fills: 40,
      releases: 40,
      executionNetMicros: execution.toString(),
      qualificationNetMicros: qualification.toString(),
      qualified: false,
    }) + '\n',
  )
}

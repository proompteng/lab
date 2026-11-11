import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Effect, Exit, Result, Schema } from 'effect'

import { AccountStatus } from '../../src/broker/alpaca/model'
import { MutationOperation } from '../../src/broker/alpaca-mutations/model'
import { makeBrokerStateCache } from '../../src/execution/broker-state-cache'
import { cachedBrokerStateFixture, nativeBrokerStateFixture } from '../../src/execution/broker-state-cache.fixture'
import {
  allowsOutcomeEvent,
  decideMutationContainment,
  decideMutationOutcomeDefinition,
  decideMutationStartReplay,
  mutationIdResult,
} from '../../src/execution/mutations/decisions'
import { MutationEventType, type MutationEvent } from '../../src/execution/mutations/model'
import { strictParseOptions } from '../../src/schemas'

const directory = process.env['BAYN_TLA_STATE_DIRECTORY']
const State = Schema.Struct({
  phase: Schema.Union([Schema.Literal('NONE'), Schema.Enum(MutationEventType)]),
  receipt: Schema.Literals(['None', 'Pending', 'Granted', 'Consumed', 'Lost']),
  transaction: Schema.Literals(['None', 'Admission', 'Final', 'SecondFinal']),
  owner: Schema.Int,
  worker: Schema.Int,
  admissionWorker: Schema.Int,
  revoked: Schema.Boolean,
  revokePending: Schema.Boolean,
  sent: Schema.Int,
  broker: Schema.Literals(['None', 'Accepted', 'Filled']),
  visible: Schema.Boolean,
  response: Schema.Literals(['None', 'Accepted', 'Lost']),
  terminal: Schema.Boolean,
  secondStarted: Schema.Boolean,
  secondSent: Schema.Int,
  badSecondStart: Schema.Boolean,
  badSend: Schema.Boolean,
  badCache: Schema.Boolean,
  cacheA: Schema.Literals(['Empty', 'Current', 'Reserved', 'Stale']),
  cacheB: Schema.Literals(['Empty', 'Current', 'Reserved', 'Stale']),
  eventRelation: Schema.Literals(['Before', 'At', 'After']),
  cacheMayRecord: Schema.Boolean,
  unresolved: Schema.Boolean,
  allowsSecond: Schema.Boolean,
  newStart: Schema.Boolean,
  recoveryNotFound: Schema.Boolean,
})

const states = () => {
  if (directory === undefined) throw Error('Run verify:tla to produce the checked execution-boundary states')
  const dump = readFileSync(join(directory, 'ExecutionBoundary', 'ExecutionBoundary.dump'), 'utf8')
  const blocks = dump.split(/^State \d+:\s*$/m)
  if (blocks[0]?.trim() !== '' || blocks.length < 2) throw Error('Missing ExecutionBoundary TLC states')
  return Schema.decodeUnknownSync(
    Schema.Array(State),
    strictParseOptions,
  )(
    blocks.slice(1).map((block) => {
      const field = /(\w+) \|-> (TRUE|FALSE|-?\d+|"[^"\\]*")/g
      const entries = [...block.matchAll(field)].map((match) => {
        const [, key, value] = match
        if (key === undefined || value === undefined) throw Error('Invalid ExecutionBoundary TLC record')
        const decoded: unknown = value === 'TRUE' ? true : value === 'FALSE' ? false : JSON.parse(value)
        return [key, decoded] as const
      })
      if (block.replace(field, '').replace(/[\s,[\]]/g, '') !== '' || entries.length === 0)
        throw Error('Unsupported ExecutionBoundary TLC state encoding')
      if (new Set(entries.map(([key]) => key)).size !== entries.length)
        throw Error('Duplicate ExecutionBoundary TLC state fields')
      return Object.fromEntries(entries)
    }),
  )
}

const hash = 'a'.repeat(64)
const at = '2026-11-11T14:00:00.000Z'
const fixture = () =>
  nativeBrokerStateFixture(
    cachedBrokerStateFixture({
      id: 'execution-boundary-account',
      status: AccountStatus.Active,
      currency: 'USD',
      cashMicros: '100000000',
      equityMicros: '100000000',
      lastEquityMicros: '100000000',
      buyingPowerMicros: '100000000',
      cashReportingQuantumMicros: '1',
      nonMarginableBuyingPowerMicros: null,
      cryptoStatus: null,
      cryptoFeeTier: null,
      accountBlocked: false,
      tradingBlocked: false,
      tradeSuspendedByUser: false,
      observedAt: at,
    }),
  )

const conformance = directory === undefined ? describe.skip : describe
conformance('TLC execution boundary conforms to production', () => {
  test('independent broker truth, replay and two-intent uncertainty retain production containment', () => {
    const cases = states()
    expect(cases.some((s) => s.broker === 'Filled' && !s.visible && s.unresolved)).toBe(true)
    expect(cases.some((s) => s.phase === MutationEventType.RecoveryNotFound && s.broker === 'Accepted')).toBe(true)
    expect(cases.some((s) => s.receipt === 'Lost' && s.sent === 0 && s.phase !== 'NONE')).toBe(true)
    expect(cases.some((s) => s.worker === 2 && s.phase === MutationEventType.SubmitUnknown)).toBe(true)
    expect(cases.some((s) => s.secondSent > 0 && s.terminal)).toBe(true)
    expect(cases.some((s) => s.secondSent > 0 && s.unresolved && s.eventRelation === 'Before')).toBe(true)
    expect(cases.some((s) => s.transaction === 'Final' && s.revokePending && !s.revoked)).toBe(true)
    expect(cases.some((s) => s.secondStarted && s.unresolved && s.cacheB === 'Stale' && s.secondSent === 0)).toBe(true)
    const input = { intentId: hash, requestHash: hash, consistencyDelayMs: 1_000, occurredAt: at }
    for (const s of cases) {
      const unresolved =
        !s.terminal &&
        (s.phase === MutationEventType.SubmitStarted ||
          s.phase === MutationEventType.SubmitUnknown ||
          s.phase === MutationEventType.RecoveryNotFound)
      expect(unresolved).toBe(s.unresolved)
      expect(Result.isSuccess(decideMutationContainment(unresolved))).toBe(s.allowsSecond)
      const existing: MutationEvent | undefined =
        s.phase === 'NONE'
          ? undefined
          : {
              schemaVersion: 'bayn.paper-mutation-event.v1',
              eventId: hash,
              mutationId: Result.getOrThrow(mutationIdResult(hash, MutationOperation.Submit)),
              intentId: hash,
              sequence: 1,
              operation: MutationOperation.Submit,
              eventType: s.phase,
              requestHash: hash,
              consistencyDelayMs: 1_000,
              occurredAt: at,
            }
      const replay = decideMutationStartReplay(MutationOperation.Submit, input, existing)
      expect(Result.isSuccess(replay) && replay.success._tag === 'BeginMutation').toBe(s.newStart)
      expect(s.phase !== 'NONE' && allowsOutcomeEvent(s.phase, MutationEventType.RecoveryNotFound)).toBe(
        s.recoveryNotFound,
      )
      const notFound = decideMutationOutcomeDefinition({
        _tag: 'RecoveryNotFound',
        operation: MutationOperation.Submit,
      })
      expect(notFound.eventType).toBe(MutationEventType.RecoveryNotFound)
      expect(notFound.transition._tag).toBe('KeepIntentState')
    }
  })

  test('unknown mutations cannot publish a fresh native broker-state cache', async () => {
    const accepted = []
    for (const unknownMutationCount of [0, 1, 2]) {
      const result = fixture()
      const cache = makeBrokerStateCache(result.brokerState.account.accountId, '1'.repeat(64))
      const recorded = {
        ...result,
        riskContext: { ...result.riskContext, unknownMutationCount },
      }
      const taken = await Effect.runPromiseExit(cache.record(recorded).pipe(Effect.andThen(cache.take(at, 1_000))))
      accepted.push(Exit.isSuccess(taken))
    }
    expect(accepted).toEqual([true, false, false])
    for (const s of states()) {
      const unknownCount = Number(s.unresolved) + Number(s.secondStarted)
      expect(accepted[unknownCount]).toBe(s.cacheMayRecord)
    }
  })
})

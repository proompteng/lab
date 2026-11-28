import { expect, test } from 'bun:test'
import { Effect, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'

import { BrokerEnvironment } from '../src/broker/identity'
import { MarketCalendarObservationSchema } from '../src/broker/alpaca/model'
import { normalizeMarketCalendarResult } from '../src/broker/alpaca/normalizers'
import { DecisionConstruction } from '../src/decision-construction'
import { retryableOperationalError } from '../src/errors'
import { OrderStatus, type Position } from '../src/execution/contracts'
import { prepareClosingExecutionCycleDecision } from '../src/observe-composition/decision-builder'
import { constructExecutionDecision, constructObserveShadowDecision } from '../src/shadow-decision'
import { reconciledStateHash } from '../src/simulation-reconciliation/broker-model'
import { nativeAlphaDecisionFixture } from '../src/strategy/intraday-alpha/alpha-decision.test-support'
import { postgresQueryFixture } from '../src/testing/postgres-fixture.test-support'
import { analyzeProfitability, decodeAuditInput } from './live-profitability-audit-core'
import { readProfitability } from './live-profitability-audit-postgres'

test('sandbox audit uses only retained sandbox bindings inside a read-only transaction', async () => {
  const date = '2026-11-27'
  const queries: string[] = []
  const sql = postgresQueryFixture(
    Object.assign(
      (parts: TemplateStringsArray, ...values: readonly unknown[]) => {
        const statement = parts.join('?').trimStart()
        queries.push(statement)
        if (statement.includes('FROM authority_generations')) {
          expect(values).toEqual(['paper-account', BrokerEnvironment.Sandbox])
          return Effect.succeed([{ key: 'paper-fixture' }])
        }
        if (statement.startsWith('SET ') || statement.startsWith('WITH bounds')) return Effect.succeed([])
        return Effect.die('Unexpected sandbox audit query')
      },
      { withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect },
    ),
  )
  const result = await Effect.runPromise(readProfitability(sql, 'paper-account', [date], BrokerEnvironment.Sandbox))
  expect(queries[0]).toBe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
  expect(queries.some((query) => query.includes('live_capital_grants'))).toBe(false)
  expect(result.sessions).toEqual([])
})

test('measures timed and regular-close fills against separate benchmarks when a replan reuses the strategy hash', async () => {
  const date = '2026-11-27'
  const symbol = 'GOOGL'
  const calendar = Schema.decodeUnknownSync(MarketCalendarObservationSchema)(
    Result.getOrThrow(
      normalizeMarketCalendarResult(
        [{ date, open: '09:30', close: '13:00', session_open: '0400', session_close: '1700' }],
        { start: date, end: date },
      ),
    ),
  )
  const {
    document: entry,
    cycle,
    strategy,
    prepared,
    riskPolicy,
    reconciliation,
  } = await nativeAlphaDecisionFixture({
    calendar,
    snapshot: {
      minutesFromOpen: 32,
      spyProfile: { basePrice: 550, endReturnBps: -55 },
      profiles: {
        GOOGL: {
          basePrice: 274,
          endReturnBps: -60,
          openingRangeLow: 272,
          overridePrevClose: 272.1,
          overrideLatestClose: 271.08,
        },
      },
    },
  })
  const accountId = cycle.identity.accountId
  const [entryIntent] = entry.targetPlan.intentTargets
  if (entryIntent === undefined) throw new Error('Expected a planned entry')

  const quantityAtoms = BigInt(entryIntent.quantityAtoms)
  const partialFillAtoms = (quantityAtoms / 2_000_000_000n) * 1_000_000_000n
  const makeClose = async (
    observedAt: string,
    remainingAtoms: bigint,
    markMicros: bigint,
    replanGenerationHash?: string,
  ) => {
    const position: Position = {
      schemaVersion: 'bayn.position.v2',
      accountId,
      symbol,
      quantityAtoms: String(-remainingAtoms),
      averageEntryPriceMicros: '271080000',
      costBasisMicros: String((-remainingAtoms * 271_080_000n) / 1_000_000_000n),
      marketPriceMicros: String(markMicros),
      marketValueMicros: String((-remainingAtoms * markMicros) / 1_000_000_000n),
      unrealizedPnlMicros: String((remainingAtoms * (271_080_000n - markMicros)) / 1_000_000_000n),
      observedAt,
    }
    const state = {
      ...reconciliation.brokerState,
      account: { ...reconciliation.brokerState.account, observedAt },
      positions: [position],
      positionsObservedAt: observedAt,
      ordersObservedAt: observedAt,
    }
    const hash = Result.getOrThrow(reconciledStateHash(state))
    const cut = { ...state.reconciliation, reconciledAt: observedAt, expectedHash: hash, observedHash: hash }
    const { document: close } = await Effect.runPromise(
      TestClock.setTime(Date.parse(observedAt)).pipe(
        Effect.andThen(
          prepareClosingExecutionCycleDecision({
            input: {
              accountId,
              authorityGenerationHash: entry.bindings.authorityGenerationHash,
              reconciliationIntervalMs: 30_000,
              reconciliationPassTimeoutMs: 30_000,
              strategy,
              intradayMarketData: {
                check: Effect.void,
                verifyReference: () => Effect.die('Unexpected reference verification'),
                loadSnapshot: () =>
                  Effect.fail(
                    retryableOperationalError({
                      component: 'market-data',
                      operation: 'load',
                      message: 'archive unavailable',
                    }),
                  ),
              },
            },
            preparation: prepared,
            policy: riskPolicy,
            cycle,
            entryDocument: entry,
            closeExpiresAt: `${date}T18:00:00.000Z`,
            ...(replanGenerationHash === undefined ? {} : { replanGenerationHash }),
            reconcile: Effect.succeed({
              ...reconciliation,
              brokerState: { ...state, reconciliation: cut },
              report: { ...reconciliation.report, reconciliation: cut },
              riskContext: {
                ...reconciliation.riskContext,
                authority: { ...reconciliation.riskContext.authority, updatedAt: observedAt },
                authorityObservedAt: observedAt,
              },
            }),
          }),
        ),
        Effect.provideService(DecisionConstruction, {
          observe: constructObserveShadowDecision,
          execution: constructExecutionDecision,
        }),
        // @effect-diagnostics-next-line strictEffectProvide:off -- this test owns its virtual clock
        Effect.provide(TestClock.layer()),
      ),
    )
    expect(close.dispatchable).toBe(true)
    return close
  }
  const timed = await makeClose(`${date}T16:28:02.379Z`, quantityAtoms, 275_880_000n)
  const regular = await makeClose(
    `${date}T17:55:02.000Z`,
    quantityAtoms - partialFillAtoms,
    276_000_000n,
    'a'.repeat(64),
  )
  expect(timed.bindings.strategyDecisionHash).toBe(regular.bindings.strategyDecisionHash)
  expect(timed.contentHash).not.toBe(timed.bindings.strategyDecisionHash)
  expect(timed.orderedIntentIds[0]).not.toBe(regular.orderedIntentIds[0])

  const documents = [entry, timed, regular]
  const decisions = documents.map((document) => ({
    cycle_id: document.bindings.cycleId,
    decision_hash: document.contentHash,
    document_json: JSON.stringify(document),
    created_at: new Date(document.createdAt),
    entry: document === entry,
  }))
  const orders = documents.map((document) => {
    const [intent] = document.targetPlan.intentTargets
    if (intent === undefined) throw new Error('Expected a planned intent')
    return {
      id: document === entry ? 'entry-order' : document === timed ? 'timed-order' : 'regular-order',
      entryId: null,
      parentId: null,
      symbol,
      side: intent.side,
      type: intent.orderType,
      status: document === timed ? OrderStatus.Canceled : OrderStatus.Filled,
      quantityAtoms: intent.quantityAtoms,
      limitMicros: document.deltaRisk[0]?.limitPriceMicros,
      stopMicros: null,
      exitReferenceMicros: null,
      openedAt: document.createdAt,
      terminalAt: new Date(Date.parse(document.createdAt) + 1_000).toISOString(),
      protective: false,
      intentId: document.orderedIntentIds[0],
      strategyDecisionHash: intent.decisionHash,
      protectionEntryHash: null,
    }
  })
  const fills = orders.map(({ id, side, terminalAt, quantityAtoms }) => ({
    id: `${id}-fill`,
    orderId: id,
    symbol,
    side,
    at: terminalAt,
    quantityAtoms: id === 'timed-order' ? String(partialFillAtoms) : quantityAtoms,
    priceAtoms: id === 'entry-order' ? '271080000000' : id === 'timed-order' ? '275907588000' : '276027600000',
    feeMicros: '0',
    realizedMicros: null,
  }))
  const quote = {
    symbol,
    at: `${date}T15:02:02.000000001Z`,
    feed: 'iex' as const,
    bidMicros: '271080000',
    askMicros: '271090000',
  }
  const sql = postgresQueryFixture(
    Object.assign(
      (parts: TemplateStringsArray) => {
        const statement = parts.join('?').trimStart()
        if (statement.startsWith('SET ')) return Effect.succeed([])
        if (statement.includes('FROM authority_generations')) return Effect.succeed([])
        if (statement.includes('FROM live_capital_grants')) return Effect.succeed([{ key: 'live-fixture' }])
        if (statement.startsWith('WITH bounds'))
          return Effect.succeed([
            {
              startAt: new Date(`${date}T05:00:00.000Z`),
              endAt: new Date(`${date}T23:00:00.000Z`),
              missingFillEvents: 0,
            },
          ])
        if (statement.startsWith('WITH cycles')) return Effect.succeed(decisions)
        if (statement.includes('FROM fills f JOIN broker_events')) return Effect.succeed(fills)
        if (statement.startsWith('WITH history')) return Effect.succeed(orders)
        if (statement.includes("'{rows,quotes}'")) return Effect.succeed([quote])
        if (
          statement.includes('FROM intraday_alpha_baseline_preparations') ||
          statement.startsWith('WITH movements') ||
          statement.includes('FROM account_snapshots') ||
          statement.includes('FROM reconciliations') ||
          statement.startsWith('WITH passes') ||
          statement.includes('FROM broker_fee_accounting') ||
          statement.includes('JOIN intraday_candidate_observations')
        )
          return Effect.succeed([])
        return Effect.die(`Unexpected audit query: ${statement}`)
      },
      { withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect },
    ),
  )
  const evidence = Result.getOrThrow(
    decodeAuditInput(await Effect.runPromise(readProfitability(sql, accountId, [date], BrokerEnvironment.Live))),
  )
  expect(evidence.sessions[0]?.unverifiedDecisions).toBe(0)
  expect(evidence.sessions[0]?.market.quotes).toEqual([quote])
  expect(evidence.sessions[0]?.orders.map(({ exitReferenceMicros }) => exitReferenceMicros)).toEqual([
    null,
    '275880000',
    '276000000',
  ])
  expect(analyzeProfitability(evidence).sessions[0]?.metrics).toMatchObject({
    roundTrip: { samples: 1, meanBps: 1 },
    unmeasuredRoundTrips: 0,
  })
})

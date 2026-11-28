import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, ManagedRuntime, Redacted, Result } from 'effect'

import { decideJevExit, JevExitReason } from '../jev/exit'
import { nativeJevFixture } from '../jev/native.test-support'
import { JevPurpose } from '../jev/portfolio'
import { jevPricingQuery } from '../jev/runtime'
import { IntradaySnapshotPurpose } from '../market-data/intraday/model'
import { persistIntradayRecordRows } from '../market-data/intraday/verification'
import { makeIntradayMomentumTestSnapshot } from '../strategy/intraday-momentum/test-support'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import { streamingFixtureFromRaw } from '../testing/streaming-market-fixture'
import { readProtectionEvidence } from './jev-position-postgres'
import { PostgresClientLive } from './postgres-client'

const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const cycleId = 'a'.repeat(64)
const entryDecisionHash = 'b'.repeat(64)
const intentId = 'c'.repeat(64)
const eventId = 'd'.repeat(64)
const at = '2026-09-04T16:01:00.001Z'
const asOf = '2026-09-04T16:01:01.000Z'
const version = 'bayn.jev-protection-evidence.v2' as const
const scale = 1_000_000_000n

const profitRequest = () => {
  const native = nativeJevFixture(JevPurpose.Manage, at, 'account')
  if (native.portfolio.purpose !== JevPurpose.Manage) throw new Error('Expected held position')
  const query = Result.getOrThrow(
    jevPricingQuery(
      native.draft,
      native.protocol,
      native.snapshot.manifest.calendar,
      at,
      ['AAPL'],
      IntradaySnapshotPurpose.Liquidation,
    ),
  )
  const snapshot = streamingFixtureFromRaw(
    makeIntradayMomentumTestSnapshot(native.protocol, { ...query, archiveWatermarks: [] }, { AAPL: 0.051 }),
    query,
  ).snapshot
  return Result.getOrThrow(
    decideJevExit({
      cycleId,
      sessionDate: snapshot.manifest.sessionDate,
      protocol: native.protocol,
      portfolio: { ...native.portfolio, entryDecisionHash },
      observedAt: at,
      trigger: {
        reason: JevExitReason.ProfitTarget,
        manifest: snapshot.manifest,
        rows: Result.getOrThrow(persistIntradayRecordRows(snapshot)),
      },
    }),
  )
}

describePostgres('Native partial take-profit evidence', () => {
  const runtime = ManagedRuntime.make(
    PostgresClientLive({
      operationTimeoutMs: 5000,
      postgres: {
        url: Redacted.make(baynTestPostgresUrl ?? 'postgresql://unused/unused'),
        tls: false,
        caPath: '/unused',
      },
    }).pipe(Layer.provideMerge(NodeServices.layer)),
  )
  beforeAll(() => runtime.runPromise(Effect.void))
  afterAll(() => runtime.dispose())

  const fixture = (short: boolean, run: (sql: PgClient.PgClient) => Effect.Effect<void, unknown>) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql.withTransaction(
          Effect.gen(function* () {
            // These connection-local tables exercise the production SQL without changing shared fixtures.
            yield* sql`CREATE TEMP TABLE intents (
              intent_id text PRIMARY KEY, cycle_id text, account_id text, symbol text, side text,
              quantity_atoms numeric, client_order_id text, protection jsonb,
              state text, terminal_outcome text, updated_at timestamptz, created_at timestamptz
            ) ON COMMIT DROP`
            yield* sql`CREATE TEMP TABLE native_protection_cancel_commands (
              intent_id text, account_id text, broker_order_id text, requested_at timestamptz, exit_target jsonb, reanchor boolean NOT NULL DEFAULT false
            ) ON COMMIT DROP`
            yield* sql`CREATE TEMP TABLE autonomous_cycle_paper_closures (cycle_id text, document jsonb) ON COMMIT DROP`
            yield* sql`CREATE TEMP TABLE autonomous_cycle_paper_close_replans (cycle_id text, document jsonb) ON COMMIT DROP`
            yield* sql`CREATE TEMP TABLE autonomous_cycle_shadow_decisions (
              cycle_id text, decision_hash text, document jsonb
            ) ON COMMIT DROP`
            yield* sql`CREATE TEMP TABLE accounting_transactions (
              broker_event_id text, intent_id text, account_id text, symbol text, side text,
              quantity_atoms numeric, price_atoms numeric, quantity_delta_atoms numeric,
              cost_basis_delta_micros numeric, occurred_at timestamptz
            ) ON COMMIT DROP`
            yield* sql`CREATE TEMP TABLE accounting_receipts (
              broker_event_id text PRIMARY KEY, intent_id text, recorded_at timestamptz
            ) ON COMMIT DROP`
            yield* sql`CREATE TEMP TABLE broker_events (
              event_id text PRIMARY KEY, occurred_at timestamptz, observed_at timestamptz
            ) ON COMMIT DROP`
            yield* sql`CREATE TEMP TABLE fills (
              event_id text PRIMARY KEY, account_id text, intent_id text, symbol text, side text,
              quantity_atoms numeric, price_atoms numeric, broker_order_id text
            ) ON COMMIT DROP`
            yield* sql`CREATE TEMP TABLE orders (
              broker_order_id text, account_id text, intent_id text, symbol text, side text,
              order_type text, time_in_force text, stop_price_micros numeric, limit_price_micros numeric,
              quantity_atoms numeric, filled_quantity_atoms numeric, parent_broker_order_id text,
              client_order_id text, event_id text PRIMARY KEY
            ) ON COMMIT DROP`
            const protection = {
              _tag: short ? 'EquityShortBracket' : 'Bracket',
              stopPriceMicros: short ? '351400000' : '350220000',
              stopLimitPriceMicros: short ? '351600000' : '350040000',
              profitLimitPriceMicros: '350810000',
            }
            const entrySide = short ? 'SELL' : 'BUY'
            const exitSide = short ? 'BUY' : 'SELL'
            const quantity = (14n * scale).toString()
            const positionDelta = ((short ? 14n : -14n) * scale).toString()
            const costDelta = ((short ? 14n : -14n) * 350_000_000n).toString()
            yield* sql`INSERT INTO intents VALUES (
              ${intentId},${cycleId},'account','AAPL',${entrySide},53000000000,'entry-client',
              ${JSON.stringify(protection)}::jsonb,'TERMINAL','FILLED',${at}::timestamptz,${at}::timestamptz
            )`
            yield* sql`INSERT INTO orders VALUES (
              'parent','account',${intentId},'AAPL',${entrySide},'LIMIT','DAY',NULL,350500000,
              53000000000,53000000000,NULL,'entry-client',${'e'.repeat(64)}
            ),(
              'take-profit','account',${intentId},'AAPL',${exitSide},'LIMIT','DAY',NULL,350810000,
              53000000000,14000000000,'parent','take-profit-client',${'f'.repeat(64)}
            )`
            for (const id of [eventId, 'e'.repeat(64), 'f'.repeat(64)])
              yield* sql`INSERT INTO broker_events VALUES (${id},${at}::timestamptz,${at}::timestamptz)`
            yield* sql`INSERT INTO fills VALUES (
              ${eventId},'account',${intentId},'AAPL',${exitSide},${quantity},350810000000,'take-profit'
            )`
            yield* sql`INSERT INTO accounting_transactions VALUES (
              ${eventId},${intentId},'account','AAPL',${exitSide},${quantity},350810000000,
              ${positionDelta},${costDelta},${at}::timestamptz
            )`
            yield* sql`INSERT INTO accounting_receipts VALUES (${eventId},${intentId},${at}::timestamptz)`
            yield* run(sql)
          }),
        )
      }),
    )

  test.each([false, true])(
    'an accounted %s short partial target keeps native protection and legacy bytes',
    async (short) => {
      await fixture(short, (sql) =>
        Effect.gen(function* () {
          const legacy = yield* readProtectionEvidence(sql, cycleId, entryDecisionHash)
          const current = yield* readProtectionEvidence(sql, cycleId, entryDecisionHash, version, asOf)
          expect(legacy.exitRequestedAt).toBe(at)
          expect(legacy.profitExitRequested).toBe(false)
          expect(current.exitRequestedAt).toBe(null)
          expect(current.profitExitRequested).toBe(false)
          expect(current.protectionDisposals).toEqual(legacy.protectionDisposals)
          expect(current.protectionDisposals.quantityAtoms).toBe('14000000000')
          expect(current.protectionDisposals.costBasisMicros).toBe('4900000000')
          expect(current.protectionIntentIds).toEqual([intentId])
        }),
      )
    },
  )

  test.each([false, true])('a %s short native stop still requests the residual exit', async (short) => {
    await fixture(short, (sql) =>
      Effect.gen(function* () {
        yield* sql`UPDATE orders SET order_type='STOP_LIMIT',stop_price_micros=351400000,
          limit_price_micros=351600000 WHERE broker_order_id='take-profit'`
        const current = yield* readProtectionEvidence(sql, cycleId, entryDecisionHash, version, asOf)
        expect(current.exitRequestedAt).toBe(at)
        expect(current.profitExitRequested).toBe(false)
        expect(current.protectionDisposals.quantityAtoms).toBe('14000000000')
      }),
    )
  })

  test.each([false, true])('an accounted %s short OCO target retains its remaining stop coverage', async (short) => {
    await fixture(short, (sql) =>
      Effect.gen(function* () {
        yield* sql`UPDATE intents SET protection=jsonb_set(
          jsonb_set(protection,'{_tag}',to_jsonb(${short ? 'EquityShortOco' : 'Oco'}::text)),
          '{entryDecisionHash}',to_jsonb(${entryDecisionHash}::text)),side=${short ? 'BUY' : 'SELL'}`
        yield* sql`UPDATE orders SET parent_broker_order_id=NULL,client_order_id='entry-client'
          WHERE broker_order_id='take-profit'`
        yield* sql`DELETE FROM orders WHERE broker_order_id='parent'`
        const current = yield* readProtectionEvidence(sql, cycleId, entryDecisionHash, version, asOf)
        expect(current.exitRequestedAt).toBe(null)
        expect(current.protectionIntentIds).toEqual([intentId])
        expect(current.protectionDisposals.quantityAtoms).toBe('14000000000')
      }),
    )
  })

  test.each([
    'foreign-account',
    'foreign-intent',
    'foreign-symbol',
    'foreign-disposal-account',
    'foreign-disposal-symbol',
    'wrong-side',
    'wrong-limit',
    'invalid-fill-price',
    'wrong-duration',
    'unexpected-stop-price',
    'oversized-child',
    'wrong-parent-kind',
    'unknown-parent',
    'missing-order',
    'missing-fill',
  ])('unverified target evidence cannot suppress the exit latch: %s', async (mode) => {
    await fixture(false, (sql) =>
      Effect.gen(function* () {
        if (mode === 'foreign-account') yield* sql`UPDATE fills SET account_id='foreign'`
        if (mode === 'foreign-intent') yield* sql`UPDATE fills SET intent_id=${'e'.repeat(64)}`
        if (mode === 'foreign-symbol') yield* sql`UPDATE fills SET symbol='MSFT'`
        if (mode === 'foreign-disposal-account') {
          yield* sql`UPDATE fills SET account_id='foreign'`
          yield* sql`UPDATE accounting_transactions SET account_id='foreign'`
          yield* sql`UPDATE orders SET account_id='foreign' WHERE broker_order_id='take-profit'`
        }
        if (mode === 'foreign-disposal-symbol') {
          yield* sql`UPDATE fills SET symbol='MSFT'`
          yield* sql`UPDATE accounting_transactions SET symbol='MSFT'`
          yield* sql`UPDATE orders SET symbol='MSFT' WHERE broker_order_id='take-profit'`
        }
        if (mode === 'wrong-side') yield* sql`UPDATE fills SET side='BUY'`
        if (mode === 'wrong-limit')
          yield* sql`UPDATE orders SET limit_price_micros=350820000 WHERE broker_order_id='take-profit'`
        if (mode === 'invalid-fill-price') {
          yield* sql`UPDATE fills SET price_atoms=350800000000`
          yield* sql`UPDATE accounting_transactions SET price_atoms=350800000000`
        }
        if (mode === 'wrong-duration')
          yield* sql`UPDATE orders SET time_in_force='GTC' WHERE broker_order_id='take-profit'`
        if (mode === 'unexpected-stop-price')
          yield* sql`UPDATE orders SET stop_price_micros=350810000 WHERE broker_order_id='take-profit'`
        if (mode === 'oversized-child')
          yield* sql`UPDATE orders SET quantity_atoms=54000000000 WHERE broker_order_id='take-profit'`
        if (mode === 'wrong-parent-kind')
          yield* sql`UPDATE orders SET order_type='STOP_LIMIT' WHERE broker_order_id='parent'`
        if (mode === 'unknown-parent')
          yield* sql`UPDATE orders SET parent_broker_order_id='foreign' WHERE broker_order_id='take-profit'`
        if (mode === 'missing-order') yield* sql`DELETE FROM orders WHERE broker_order_id='take-profit'`
        if (mode === 'missing-fill') yield* sql`DELETE FROM fills`
        const current = yield* readProtectionEvidence(sql, cycleId, entryDecisionHash, version, asOf)
        expect(current.exitRequestedAt).toBe(at)
        expect(current.profitExitRequested).toBe(false)
      }),
    )
  })

  test('order history never multiplies a protective disposal', async () => {
    await fixture(false, (sql) =>
      Effect.gen(function* () {
        yield* sql`INSERT INTO broker_events VALUES (${'9'.repeat(64)},${at}::timestamptz,${at}::timestamptz)`
        yield* sql`INSERT INTO orders SELECT (jsonb_populate_record(NULL::orders,
          to_jsonb(orders) || jsonb_build_object('event_id',${'9'.repeat(64)}::text))).*
          FROM orders WHERE broker_order_id='take-profit'`
        const current = yield* readProtectionEvidence(sql, cycleId, entryDecisionHash, version, asOf)
        expect(current.exitRequestedAt).toBe(null)
        expect(current.protectionDisposals.quantityAtoms).toBe('14000000000')
        expect(current.protectionDisposals.costBasisMicros).toBe('4900000000')
      }),
    )
  })

  test('an unaccounted protective fill supplies neither a disposal nor an exit latch', async () => {
    await fixture(false, (sql) =>
      Effect.gen(function* () {
        yield* sql`DELETE FROM accounting_receipts`
        const current = yield* readProtectionEvidence(sql, cycleId, entryDecisionHash, version, asOf)
        expect(current.exitRequestedAt).toBe(null)
        expect(current.protectionDisposals).toEqual({ quantityAtoms: '0', costBasisMicros: '0' })
      }),
    )
  })

  test.each(['profit-before-command', 'stop-before-command', 'stop-tied-with-command'] as const)(
    'raw event order controls the new profit latch while legacy evidence reproduces: %s',
    async (mode) => {
      await fixture(false, (sql) =>
        Effect.gen(function* () {
          const target = profitRequest()
          yield* sql`INSERT INTO autonomous_cycle_shadow_decisions VALUES (
            ${cycleId},${entryDecisionHash},${JSON.stringify({ strategyDecision: { exitPolicy: target.evidence.portfolio.purpose === JevPurpose.Manage ? target.evidence.portfolio.exitPolicy : null } })}::jsonb
          )`
          const requestedAt = mode === 'stop-tied-with-command' ? at : '2026-09-04T16:01:00.001500Z'
          yield* sql`INSERT INTO native_protection_cancel_commands VALUES (
            ${intentId},'account','take-profit',${requestedAt}::timestamptz,${JSON.stringify(target)}::jsonb
          )`
          if (mode !== 'profit-before-command')
            yield* sql`UPDATE orders SET order_type='STOP_LIMIT',stop_price_micros=350220000,
              limit_price_micros=350040000 WHERE broker_order_id='take-profit'`
          const legacy = yield* readProtectionEvidence(sql, cycleId, entryDecisionHash)
          const current = yield* readProtectionEvidence(sql, cycleId, entryDecisionHash, version, asOf)
          expect(legacy.exitRequestedAt).toBe(at)
          expect(legacy.profitExitRequested).toBe(true)
          expect(current.exitRequestedAt).toBe(at)
          expect(current.profitExitRequested).toBe(mode === 'profit-before-command')
        }),
      )
    },
  )

  test.each([false, true])(
    'future native stop evidence preserves the old cut and releases the later %s short profit floor',
    async (short) => {
      await fixture(short, (sql) =>
        Effect.gen(function* () {
          const target = profitRequest()
          yield* sql`INSERT INTO autonomous_cycle_shadow_decisions VALUES (
          ${cycleId},${entryDecisionHash},${JSON.stringify({ strategyDecision: { exitPolicy: target.evidence.portfolio.purpose === JevPurpose.Manage ? target.evidence.portfolio.exitPolicy : null } })}::jsonb
        )`
          yield* sql`INSERT INTO native_protection_cancel_commands VALUES (
          ${intentId},'account','take-profit',${at}::timestamptz,${JSON.stringify(target)}::jsonb
        )`
          const original = yield* readProtectionEvidence(sql, cycleId, entryDecisionHash, version, asOf)
          expect(original.profitExitRequested).toBe(true)
          const later = '2026-09-04T16:01:02.000Z'
          const stopEvent = '7'.repeat(64)
          const stopOrderEvent = '8'.repeat(64)
          const side = short ? 'BUY' : 'SELL'
          const stop = short ? '351400000' : '350220000'
          const limit = short ? '351600000' : '350040000'
          for (const id of [stopEvent, stopOrderEvent])
            yield* sql`INSERT INTO broker_events VALUES (${id},${later}::timestamptz,${later}::timestamptz)`
          yield* sql`INSERT INTO orders VALUES (
          'stop','account',${intentId},'AAPL',${side},'STOP_LIMIT','DAY',${stop},${limit},
          39000000000,1000000000,'parent','stop-client',${stopOrderEvent}
        )`
          yield* sql`INSERT INTO fills VALUES (
          ${stopEvent},'account',${intentId},'AAPL',${side},1000000000,${BigInt(limit) * 1000n},'stop'
        )`
          yield* sql`INSERT INTO accounting_transactions VALUES (
          ${stopEvent},${intentId},'account','AAPL',${side},1000000000,${BigInt(limit) * 1000n},
          ${short ? '1000000000' : '-1000000000'},${short ? '350000000' : '-350000000'},${later}::timestamptz
        )`
          yield* sql`INSERT INTO accounting_receipts VALUES (${stopEvent},${intentId},${later}::timestamptz)`
          expect(yield* readProtectionEvidence(sql, cycleId, entryDecisionHash, version, asOf)).toEqual(original)
          const current = yield* readProtectionEvidence(
            sql,
            cycleId,
            entryDecisionHash,
            version,
            '2026-09-04T16:01:03.000Z',
          )
          expect(current.exitRequestedAt).toBe(at)
          expect(current.profitExitRequested).toBe(false)
          expect(current.protectionDisposals.quantityAtoms).toBe('15000000000')
          yield* sql`UPDATE orders SET parent_broker_order_id='unknown' WHERE broker_order_id='stop'`
          const unknown = yield* readProtectionEvidence(
            sql,
            cycleId,
            entryDecisionHash,
            version,
            '2026-09-04T16:01:03.000Z',
          )
          expect(unknown.profitExitRequested).toBe(true)
        }),
      )
    },
  )

  test.each(['receipt', 'order-observation', 'fill-observation', 'command', 'command-boundary'] as const)(
    'future evidence cannot change the original reconciliation cut: %s',
    async (mode) => {
      await fixture(false, (sql) =>
        Effect.gen(function* () {
          const later = '2026-09-04T16:01:02.000Z'
          if (mode === 'receipt') yield* sql`UPDATE accounting_receipts SET recorded_at=${later}::timestamptz`
          if (mode === 'order-observation')
            yield* sql`UPDATE broker_events SET observed_at=${later}::timestamptz WHERE event_id=${'f'.repeat(64)}`
          if (mode === 'fill-observation')
            yield* sql`UPDATE broker_events SET observed_at=${later}::timestamptz WHERE event_id=${eventId}`
          if (mode === 'command' || mode === 'command-boundary')
            yield* sql`INSERT INTO native_protection_cancel_commands VALUES (
              ${intentId},'account','take-profit',${mode === 'command' ? later : asOf}::timestamptz,NULL
            )`
          const original = yield* readProtectionEvidence(sql, cycleId, entryDecisionHash, version, asOf)
          const current = yield* readProtectionEvidence(
            sql,
            cycleId,
            entryDecisionHash,
            version,
            '2026-09-04T16:01:03.000Z',
          )
          expect(yield* readProtectionEvidence(sql, cycleId, entryDecisionHash, version, asOf)).toEqual(original)
          if (mode === 'receipt' || mode === 'fill-observation')
            expect(original.protectionDisposals.quantityAtoms).toBe('0')
          if (mode === 'order-observation') expect(original.exitRequestedAt).toBe(at)
          if (mode === 'command' || mode === 'command-boundary') {
            expect(original.exitRequestedAt).toBe(null)
            expect(current.exitRequestedAt).toBe(mode === 'command' ? later : asOf)
          } else {
            expect(current.exitRequestedAt).toBe(null)
            expect(current.protectionDisposals.quantityAtoms).toBe('14000000000')
          }
        }),
      )
    },
  )
})

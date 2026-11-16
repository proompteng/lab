import { expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, ManagedRuntime, Redacted } from 'effect'
import migration from '../../migrations/0198_equity_short_accounting'
import { AccountingInventorySide, prepareAccounting } from '../accounting/domain'
import type { AccountingTransaction } from '../accounting/schema'
import { OrderSide } from '../execution/contracts'
import { Result } from 'effect'
import { baynTestPostgresUrl } from '../test-environment.test-support'

const integration = baynTestPostgresUrl === undefined ? test.skip : test
const url = baynTestPostgresUrl ?? 'postgresql://agent@127.0.0.1:55432/bayn_short_test'
const parsed = new URL(url)
if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test'))
  throw new Error('Equity short migration test requires an isolated local _test database')

integration('short accounting migration retains long rows and enforces both inventory identities', async () => {
  const runtime = ManagedRuntime.make(
    PgClient.layer({ url: Redacted.make(url), maxConnections: 1 }).pipe(Layer.provideMerge(NodeServices.layer)),
  )
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`CREATE TEMP TABLE accounting_transactions (
      transaction_id text PRIMARY KEY,schema_version text NOT NULL,
      symbol text NOT NULL,side text NOT NULL,quantity_atoms numeric NOT NULL,
      notional_micros numeric NOT NULL,fee_micros numeric NOT NULL,cost_basis_micros numeric NOT NULL,
      realized_pnl_micros numeric NOT NULL,quantity_delta_atoms numeric NOT NULL,
      cost_basis_delta_micros numeric NOT NULL,cash_delta_micros numeric NOT NULL,
      content_hash text NOT NULL,
      CONSTRAINT accounting_transactions_schema_version_check CHECK(schema_version='bayn.accounting-transaction.v2'),
      CONSTRAINT accounting_transactions_check CHECK(
        (side='BUY' AND realized_pnl_micros=0) OR (side='SELL' AND realized_pnl_micros=notional_micros-cost_basis_micros))
    ) ON COMMIT DROP`
            const persist = (t: AccountingTransaction) =>
              sql`INSERT INTO accounting_transactions ${sql.insert({
                transaction_id: t.transactionId,
                schema_version: t.schemaVersion,
                symbol: t.symbol,
                side: t.side,
                quantity_atoms: t.quantityAtoms,
                notional_micros: t.notionalMicros,
                fee_micros: t.feeMicros,
                cost_basis_micros: t.costBasisMicros,
                realized_pnl_micros: t.realizedPnlMicros,
                quantity_delta_atoms: t.quantityDeltaAtoms,
                cost_basis_delta_micros: t.costBasisDeltaMicros,
                cash_delta_micros: t.cashDeltaMicros,
                content_hash: t.contentHash,
              })}`
            const f = {
              schemaVersion: 'bayn.fill.v2' as const,
              accountId: 'synthetic-short-account',
              fillId: 'fill',
              brokerOrderId: 'order',
              clientOrderId: 'client',
              symbol: 'AAPL',
              side: OrderSide.Buy,
              quantityAtoms: '1000000000',
              priceAtoms: '100000000000',
              feeMicros: '0',
              occurredAt: '2026-11-13T15:00:00.000Z',
            }
            const long = Result.getOrThrow(
              prepareAccounting('a'.repeat(64), f, { quantityAtoms: '0', costMicros: '0' }, 7001),
            )
            yield* persist(long.transaction)
            const before = yield* sql`SELECT to_jsonb(t)::text AS row FROM accounting_transactions t`
            yield* migration
            expect(yield* sql`SELECT to_jsonb(t)::text AS row FROM accounting_transactions t`).toEqual(before)
            const open = Result.getOrThrow(
              prepareAccounting(
                'b'.repeat(64),
                { ...f, side: OrderSide.Sell },
                { quantityAtoms: '0', costMicros: '0' },
                7001,
                AccountingInventorySide.Short,
              ),
            )
            yield* persist(open.transaction)
            const cover = Result.getOrThrow(
              prepareAccounting(
                'c'.repeat(64),
                { ...f, priceAtoms: '90000000000' },
                { quantityAtoms: '-1000000000', costMicros: '-100000000' },
                7001,
                AccountingInventorySide.Short,
              ),
            )
            yield* persist(cover.transaction)
            for (const changed of [
              { ...open.transaction, transactionId: 'd'.repeat(64), realizedPnlMicros: '100000000' },
              { ...open.transaction, transactionId: 'e'.repeat(64), symbol: 'BTC/USD' },
              { ...cover.transaction, transactionId: 'f'.repeat(64), costBasisDeltaMicros: '-100000000' },
              {
                ...cover.transaction,
                transactionId: '0'.repeat(64),
                schemaVersion: 'bayn.accounting-transaction.v2' as const,
              },
            ])
              expect(yield* sql.withTransaction(persist(changed)).pipe(Effect.result)).toMatchObject({
                _tag: 'Failure',
              })
            expect(yield* sql`SELECT count(*)::integer AS count FROM accounting_transactions`).toEqual([{ count: 3 }])
          }),
        )
      }),
    )
  } finally {
    await runtime.dispose()
  }
})

import { expect, test } from 'bun:test'
import { Result, Schema } from 'effect'
import { prepareAccounting, rebuildAccountingLedger } from '../accounting/domain'
import { OrderSide as DomainSide } from '../execution/contracts'
import { InstrumentSymbolSchema } from '../instruments'
import { normalizeFeeActivitiesResult, normalizeFillActivityResult } from './alpaca/normalizers'
import { FillActivityResponseSchema, FeeActivityResponseSchema } from './alpaca/model'

const accountId = 'a2c4c01a-2b96-4f46-a19f-c406635aa001'
const orderId = 'b2c4c01a-2b96-4f46-a19f-c406635aa001'
for (const symbol of ['BTC/USD', 'ETH/USD', 'SOL/USD']) {
  test(`${symbol} accounts the exact native fill price and nine-decimal coin quantity`, () => {
    const raw = Result.getOrThrow(
      Schema.decodeUnknownResult(FillActivityResponseSchema)({
        activity_type: 'FILL',
        id: `20261011000103000::${orderId}`,
        account_id: accountId,
        cum_qty: '0.031234567',
        leaves_qty: '0',
        qty: '0.031234567',
        price: '103.123456789',
        side: 'buy',
        symbol: symbol.replace('/', ''),
        transaction_time: '2026-10-11T00:01:03.000000001Z',
        order_id: orderId,
        type: 'fill',
        order_status: 'filled',
      }),
    )
    const normalized = Result.getOrThrow(normalizeFillActivityResult(raw, accountId))
    expect(normalized.symbol).toBe(symbol)
    expect(Schema.is(InstrumentSymbolSchema)(symbol.replace('/', ''))).toBe(false)
    expect(normalized.quantityAtoms).toBe('31234567')
    expect(normalized.priceAtoms).toBe('103123456789')
    const fill = {
      schemaVersion: 'bayn.fill.v2' as const,
      accountId,
      fillId: normalized.activityId,
      brokerOrderId: orderId,
      clientOrderId: 'bayn-crypto',
      symbol,
      side: DomainSide.Buy,
      quantityAtoms: normalized.quantityAtoms,
      priceAtoms: normalized.priceAtoms,
      feeMicros: '0',
      occurredAt: '2026-10-11T00:01:03.000Z',
    }
    const prepared = Result.getOrThrow(
      prepareAccounting('a'.repeat(64), fill, { quantityAtoms: '0', costMicros: '0' }, 7001),
    )
    const notional = (31_234_567n * 103_123_456_789n + 500_000_000_000n) / 1_000_000_000_000n
    expect(prepared.transaction.notionalMicros).toBe(notional.toString())
    expect(prepared.transaction.cashDeltaMicros).toBe((-notional).toString())
    expect(Result.getOrThrow(rebuildAccountingLedger(prepared.transaction, 7001))).toEqual(prepared.ledger)
  })

  test(`${symbol} normalizes a native coin fee once at the provider boundary`, () => {
    const raw = Result.getOrThrow(
      Schema.decodeUnknownResult(FeeActivityResponseSchema)({
        activity_type: 'CFEE',
        id: `20261011000000000::${orderId}`,
        date: '2026-10-11',
        created_at: '2026-10-10T23:59:58.123456Z',
        net_amount: '0',
        symbol: symbol.replace('/', ''),
        qty: '-0.000000001',
        price: '103.123456789',
      }),
    )
    if (raw.activity_type !== 'CFEE' || raw.qty === undefined) throw new Error('Expected a coin fee fixture')
    const fee = Result.getOrThrow(normalizeFeeActivitiesResult([raw], accountId))[0]
    expect(fee?.coinDebit).toEqual({ symbol, quantityAtoms: '1', priceAtoms: '103123456789' })
    expect(fee?.netAmountMicros).toBe('0')
    expect(fee).toMatchObject({ date: '2026-10-11', sourceCreatedAt: '2026-10-10T23:59:58.123456000Z' })
    expect(Result.isFailure(normalizeFeeActivitiesResult([{ ...raw, qty: '0.000000001' }], accountId))).toBe(true)
    expect(Result.isFailure(normalizeFeeActivitiesResult([{ ...raw, qty: '-0.0000000001' }], accountId))).toBe(true)
    expect(Result.isFailure(normalizeFeeActivitiesResult([{ ...raw, net_amount: '-1' }], accountId))).toBe(true)
  })
}

test('USD CFEE is a cash debit without coin fields and never retains provider descriptions', () => {
  const raw = {
    activity_type: 'CFEE',
    id: `20261015000000000::${orderId}`,
    date: '2026-10-15',
    created_at: '2026-10-14T23:59:58.123456Z',
    net_amount: '-0.2',
    description: 'private provider detail',
  }
  const decode = (value: unknown) =>
    Schema.decodeUnknownResult(FeeActivityResponseSchema)(value).pipe(
      Result.flatMap((activity) => normalizeFeeActivitiesResult([activity], accountId)),
    )
  expect(Result.getOrThrow(decode(raw))).toEqual([
    {
      accountId,
      activityId: raw.id,
      date: raw.date,
      sourceCreatedAt: '2026-10-14T23:59:58.123456000Z',
      netAmountMicros: '-200000',
      cryptoCashFee: true,
    },
  ])
  for (const value of [
    { ...raw, net_amount: '0' },
    { ...raw, net_amount: '0.2' },
    { ...raw, symbol: 'ETHUSD' },
    { ...raw, qty: '-0.0001' },
    { ...raw, price: '100' },
    { ...raw, created_at: undefined },
    { ...raw, created_at: '2026-02-30T00:00:00Z' },
  ])
    expect(Result.isFailure(decode(value))).toBe(true)
})

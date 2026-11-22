import { Result, Schema } from 'effect'

import { quantityFromDecimal } from '../../quantity'
import { IsoDateSchema } from '../../schemas'
import { contractFailure } from './failures'
import type { FeeActivity, Observed } from './model'
import { decimalToMicrosResult } from './normalizers'

const decodeFee = Schema.decodeUnknownResult(
  Schema.Struct({
    activity_type: Schema.Literals(['FEE', 'CFEE']),
    ref_id: Schema.String.check(Schema.isMinLength(1)),
    previous_id: Schema.optionalKey(Schema.String.check(Schema.isUUID())),
    status: Schema.Literal('executed'),
    currency: Schema.Literal('USD'),
    net_amount: Schema.String,
    qty: Schema.optionalKey(Schema.String),
    details: Schema.Struct({ system_date: IsoDateSchema }),
  }),
)

const invalidFee = () =>
  contractFailure({ reason: 'FEE_SHAPE', message: 'Alpaca fee activity has unsupported economics' })
const feeKey = (kind: 'FEE' | 'CFEE', date: string, netAmountMicros: string, coinQuantityAtoms: string) =>
  JSON.stringify([kind, date, netAmountMicros, coinQuantityAtoms])

export const decodeFeeActivityEffect = (raw: unknown) =>
  Result.gen(function* () {
    const activity = yield* decodeFee(raw).pipe(Result.mapError(invalidFee))
    const netAmountMicros = yield* decimalToMicrosResult(activity.net_amount, true, 'stream fee net amount')
    let coinQuantityAtoms = '0'
    if (activity.activity_type === 'CFEE') {
      const quantity = yield* quantityFromDecimal(activity.qty ?? '0').pipe(Result.mapError(invalidFee))
      if (quantity > 0n || (quantity === 0n ? BigInt(netAmountMicros) >= 0n : netAmountMicros !== '0'))
        return yield* Result.fail(invalidFee())
      coinQuantityAtoms = (-quantity).toString()
    }
    // PAPER sends the booking date under system_date. Its fee IDs, coin symbols and exact prices come from REST.
    return {
      refId: activity.ref_id,
      ...(activity.previous_id === undefined ? {} : { previousRefId: activity.previous_id }),
      key: feeKey(activity.activity_type, activity.details.system_date, netAmountMicros, coinQuantityAtoms),
    }
  })

export const decodeFeeActivityWitness = (raw: unknown) =>
  decodeFeeActivityEffect(raw).pipe(
    Result.flatMap((effect) =>
      effect.previousRefId === undefined ? Result.succeed(effect) : Result.fail(invalidFee()),
    ),
  )

const pendingCashFeeKey = Schema.decodeUnknownResult(
  Schema.fromJsonString(
    Schema.Tuple([
      Schema.Literal('FEE'),
      IsoDateSchema,
      Schema.String.check(Schema.isPattern(/^-[1-9][0-9]*$/)),
      Schema.Literal('0'),
    ]),
  ),
)

export const pendingCashFees = (
  expected: ReadonlyMap<string, number>,
  rows: readonly Observed<FeeActivity>[],
  capturedAt: string,
): number | undefined => {
  const remaining = new Map(expected)
  for (const { value: fee } of rows) {
    const kind = fee.coinDebit === undefined && fee.cryptoCashFee === undefined ? 'FEE' : 'CFEE'
    const key = feeKey(kind, fee.date, fee.netAmountMicros, fee.coinDebit?.quantityAtoms ?? '0')
    const count = remaining.get(key)
    if (count === undefined) return undefined
    if (count === 1) remaining.delete(key)
    else remaining.set(key, count - 1)
  }
  if (remaining.size === 0) return 0
  const today = capturedAt.slice(0, 10)
  let pending = 0
  for (const [key, count] of remaining) {
    const decoded = pendingCashFeeKey(key)
    if (Result.isFailure(decoded)) return undefined
    const [, date] = decoded.success
    if (date > today || !Number.isSafeInteger(count) || count <= 0) return undefined
    pending += count
  }
  return Number.isSafeInteger(pending) ? pending : undefined
}

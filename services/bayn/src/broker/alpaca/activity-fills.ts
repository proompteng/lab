import { Result, Schema } from 'effect'

import { contractFailure } from './failures'
import { FillActivityResponseSchema, TradeActivityType, type FillExecution } from './model'
import { normalizeFillActivityResult } from './normalizers'

const fillFields = FillActivityResponseSchema.fields
const trade = Schema.Struct({
  ref_id: fillFields.order_id,
  account_id: fillFields.account_id,
  executed_at: fillFields.transaction_time,
  previous_id: Schema.optionalKey(Schema.Never),
  qty: fillFields.qty,
  price: fillFields.price,
  details: Schema.Struct({
    order_id: fillFields.order_id,
    cum_qty: fillFields.cum_qty,
    leaves_qty: fillFields.leaves_qty,
    symbol: fillFields.symbol,
    side: fillFields.side,
    execution_type: fillFields.type,
    order_status: fillFields.order_status,
  }),
})
const decodeTrade = Schema.decodeUnknownResult(trade)

const replayFailure = (message: string) => contractFailure({ reason: 'FILL_SHAPE', message })

export const decodeFillExecution = (
  row: unknown,
  accountId: string,
): Result.Result<FillExecution, ReturnType<typeof replayFailure>> =>
  Result.gen(function* () {
    const event = yield* decodeTrade(row).pipe(
      Result.mapError(() => replayFailure('Alpaca trade activity cannot represent an ordinary execution')),
    )
    const { activityId: _discarded, ...fill } = yield* normalizeFillActivityResult(
      {
        activity_type: 'FILL',
        id: event.ref_id,
        ...(event.account_id === undefined ? {} : { account_id: event.account_id }),
        cum_qty: event.details.cum_qty,
        leaves_qty: event.details.leaves_qty,
        price: event.price,
        qty: event.qty,
        side: event.details.side,
        symbol: event.details.symbol,
        transaction_time: event.executed_at,
        order_id: event.details.order_id,
        // Some partial Activity SSE executions arrive with execution_type "fill".
        type:
          event.details.execution_type === TradeActivityType.Fill && /^0(?:\.0+)?$/.test(event.details.leaves_qty)
            ? TradeActivityType.Fill
            : TradeActivityType.PartialFill,
        ...(event.details.order_status === undefined ? {} : { order_status: event.details.order_status }),
      },
      accountId,
    )
    return { ...fill, executionId: event.ref_id }
  })

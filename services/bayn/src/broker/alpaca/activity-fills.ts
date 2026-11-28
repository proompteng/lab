import { Result, Schema } from 'effect'

import { contractFailure } from './failures'
import { FillActivityResponseSchema, TradeActivityType, type FillExecution } from './model'
import { normalizeFillActivityResult } from './normalizers'

const fillFields = FillActivityResponseSchema.fields
const trade = Schema.Struct({
  ref_id: fillFields.order_id,
  account_id: fillFields.account_id,
  executed_at: fillFields.transaction_time,
  previous_id: Schema.optionalKey(fillFields.order_id),
  qty: fillFields.qty,
  price: fillFields.price,
  details: Schema.Struct({
    order_id: fillFields.order_id,
    cum_qty: fillFields.cum_qty,
    leaves_qty: fillFields.leaves_qty,
    symbol: fillFields.symbol,
    side: fillFields.side,
    execution_type: Schema.Literals(['fill', 'partial_fill', 'trade_correct', 'trade_bust']),
    order_status: fillFields.order_status,
  }),
})
const decodeTrade = Schema.decodeUnknownResult(trade)

const replayFailure = (message: string) => contractFailure({ reason: 'FILL_SHAPE', message })

export type TradeActivityEffect =
  | {
      readonly _tag: 'Fill'
      readonly refId: string
      readonly previousRefId?: string
      readonly execution: FillExecution
    }
  | { readonly _tag: 'Bust'; readonly refId: string; readonly previousRefId: string }

export const decodeTradeActivityEffect = (
  row: unknown,
  accountId: string,
): Result.Result<TradeActivityEffect, ReturnType<typeof replayFailure>> =>
  Result.gen(function* () {
    const event = yield* decodeTrade(row).pipe(
      Result.mapError(() => replayFailure('Alpaca trade activity has an invalid financial shape')),
    )
    if (event.details.execution_type === 'trade_bust') {
      if (event.previous_id === undefined)
        return yield* Result.fail(replayFailure('Alpaca trade bust does not identify the reversed execution'))
      return { _tag: 'Bust', refId: event.ref_id, previousRefId: event.previous_id }
    }
    if (event.details.execution_type === 'trade_correct' && event.previous_id === undefined)
      return yield* Result.fail(replayFailure('Alpaca trade correction does not identify the reversed execution'))
    if (
      (event.details.execution_type === 'fill' || event.details.execution_type === 'partial_fill') &&
      event.previous_id !== undefined
    )
      return yield* Result.fail(replayFailure('Alpaca ordinary execution unexpectedly identifies a predecessor'))
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
        // Corrections carry the complete replacement execution. The order's leaves quantity still determines
        // whether this execution closes the order; the correction label is retained by the immutable source row.
        type: /^0(?:\.0+)?$/.test(event.details.leaves_qty) ? TradeActivityType.Fill : TradeActivityType.PartialFill,
        ...(event.details.order_status === undefined ? {} : { order_status: event.details.order_status }),
      },
      accountId,
    )
    return {
      _tag: 'Fill',
      refId: event.ref_id,
      ...(event.previous_id === undefined ? {} : { previousRefId: event.previous_id }),
      execution: { ...fill, executionId: event.ref_id },
    }
  })

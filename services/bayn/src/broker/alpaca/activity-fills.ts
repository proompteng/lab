import { Result, Schema } from 'effect'

import { contractFailure } from './failures'
import { FillActivityResponseSchema, type FillExecution } from './model'
import { normalizeFillActivityResult } from './normalizers'

// This is the earliest publication date Alpaca documents for Activity SSE replay.
export const activityReplayStart = '2026-02-11T00:00:00.000Z'

const activity = Schema.Struct({
  activity_type: Schema.String.check(Schema.isMinLength(1)),
})
const fillFields = FillActivityResponseSchema.fields
const trade = Schema.Struct({
  ref_id: fillFields.order_id,
  account_id: fillFields.account_id,
  executed_at: fillFields.transaction_time,
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
const decodeActivity = Schema.decodeUnknownResult(activity)
const decodeTrade = Schema.decodeUnknownResult(trade)

const replayFailure = (message: string) => contractFailure({ reason: 'FILL_SHAPE', message })

export const decodeActivityReplay = (
  body: string,
): Result.Result<readonly unknown[], ReturnType<typeof replayFailure>> =>
  Result.try({
    try: () => {
      const rows: unknown[] = []
      for (const line of body.split(/\r?\n/)) {
        if (line === '' || line === ': welcome to the Alpaca events') continue
        // Drop and server-error notices are SSE comments. A successful HTTP response can still lose events.
        if (!line.startsWith('data:')) throw new Error('unrecognized activity replay frame')
        rows.push(JSON.parse(line.slice(5)))
      }
      return rows
    },
    catch: () => replayFailure('Alpaca activity replay contains a malformed or incomplete frame'),
  })

export const decodeFillExecutions = (
  rows: readonly unknown[],
  accountId: string,
): Result.Result<readonly FillExecution[], ReturnType<typeof replayFailure>> =>
  Result.gen(function* () {
    const fills: FillExecution[] = []
    const executionIds = new Set<string>()
    for (const row of rows) {
      const header = yield* decodeActivity(row).pipe(Result.mapError(() => replayFailure('Invalid Alpaca activity')))
      if (header.activity_type !== 'TRD') continue
      const event = yield* decodeTrade(row).pipe(
        // Corrections and busts need the full REST recovery cut.
        Result.mapError(() => replayFailure('Alpaca trade activity cannot verify an ordinary execution')),
      )
      if (executionIds.has(event.ref_id))
        return yield* Result.fail(replayFailure('Alpaca replay repeated an execution'))
      executionIds.add(event.ref_id)
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
          type: event.details.execution_type,
          ...(event.details.order_status === undefined ? {} : { order_status: event.details.order_status }),
        },
        accountId,
      )
      fills.push({ ...fill, executionId: event.ref_id })
    }
    return fills
  })

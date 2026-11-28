import { dirname, join } from 'node:path'

import { Clock, Effect, FileSystem } from 'effect'

import { canonicalHashV1Result, canonicalJsonV1Result } from '../../src/hash'
import { utcInstantFromEpochMillis } from '../../src/time'
import type { Alpaca, OrderRequest } from './alpaca'
import { failure } from './contract'
import { assertSubmissionWindow, type Window } from './market'
import type { Snapshot } from './planner'

export const hashEvidence = (material: unknown) =>
  Effect.fromResult(canonicalHashV1Result(material)).pipe(
    Effect.mapError((cause) => failure('receipt', 'Evidence could not be canonically hashed', cause)),
  )

export const readSnapshot = Effect.fn('macro-rebalance.reconcile')(function* (
  alpaca: Alpaca,
  expectedAccountId?: string,
) {
  const account = yield* alpaca.account()
  if (expectedAccountId !== undefined && account.id !== expectedAccountId)
    return yield* failure('reconcile', 'Paper account ID does not match the expected account', {
      kind: 'AccountMismatch',
    })
  const positions = yield* alpaca.positions()
  const openOrders = yield* alpaca.orders()
  return {
    account,
    positions: positions.toSorted((a, b) => a.symbol.localeCompare(b.symbol)),
    openOrders: openOrders.toSorted((a, b) => a.id.localeCompare(b.id)),
  } satisfies Snapshot
})

export const newPrivateFile = { flag: 'wx', mode: 0o600, noFollow: true } as const
export const submissionJournalPath = (directory: string, prefix: string) =>
  join(directory, `${prefix}submissions.jsonl`)

const encoder = new TextEncoder()
export const writeRecord = Effect.fn('macro-rebalance.persist')(function* (file: FileSystem.File, value: object) {
  const text = yield* Effect.fromResult(canonicalJsonV1Result(value)).pipe(
    Effect.mapError((cause) => failure('receipt', 'Evidence could not be canonically serialized', cause)),
  )
  yield* file.writeAll(encoder.encode(`${text}\n`))
  yield* file.sync
})

export const submitPaperRebalance = Effect.fn('macro-rebalance.submit')(function* (input: {
  readonly alpaca: Alpaca
  readonly snapshot: Snapshot
  readonly window: Window
  readonly orders: readonly { readonly request: OrderRequest }[]
  readonly planSha256: string
  readonly output: string
  readonly journalPrefix: string
  readonly journalPlan?: object
}) {
  const { alpaca, snapshot, window, orders, planSha256, journalPlan } = input
  const fs = yield* FileSystem.FileSystem
  const fresh = yield* readSnapshot(alpaca, snapshot.account.id)
  if ((yield* hashEvidence(fresh)) !== (yield* hashEvidence(snapshot)))
    return yield* failure('paper-submit', 'Broker account or inventory changed after planning; no orders submitted')
  // Terminal orders from any writer in this interval also consume this account's next-open session.
  const history = yield* alpaca.orders(utcInstantFromEpochMillis(Date.parse(window.lastCloseAt) - 1))
  if (history.length > 0)
    return yield* failure('paper-submit', 'Paper account already has an order for this next-open session')

  const clock = yield* alpaca.clock()
  const checkedAt = yield* Clock.currentTimeMillis
  yield* Effect.fromResult(assertSubmissionWindow(window, clock, checkedAt))
  if (orders.length === 0) return

  const outputDirectory = dirname(input.output)
  const journal = yield* fs.open(submissionJournalPath(outputDirectory, input.journalPrefix), newPrivateFile)
  const directory = yield* fs.open(outputDirectory, { flag: 'r' })
  yield* directory.sync
  const dispatchDeadline = Math.min(checkedAt + 60_000, window.cutoff)
  if (journalPlan !== undefined) yield* writeRecord(journal, { planSha256, outcome: 'prepared', plan: journalPlan })
  for (const { request } of orders) {
    const dispatchMs = yield* Clock.currentTimeMillis
    if (dispatchMs >= dispatchDeadline)
      return yield* failure('paper-submit', 'Verified submission window expired; reconcile the journal and broker')
    yield* writeRecord(journal, {
      planSha256,
      outcome: 'dispatching',
      at: utcInstantFromEpochMillis(dispatchMs),
      request,
    })
    if ((yield* Clock.currentTimeMillis) >= dispatchDeadline)
      return yield* failure('paper-submit', 'Submission window expired after journaling; reconcile before retrying')

    const ack = yield* alpaca
      .submit(request)
      .pipe(
        Effect.mapError((cause) =>
          failure(
            'paper-submit',
            `No verified acknowledgement for ${request.client_order_id}; reconcile before retrying`,
            cause,
          ),
        ),
      )
    yield* writeRecord(journal, {
      planSha256,
      outcome: 'acknowledged',
      at: utcInstantFromEpochMillis(yield* Clock.currentTimeMillis),
      ack,
    })
  }
})

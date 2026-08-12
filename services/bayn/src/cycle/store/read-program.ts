import { Effect, Option } from 'effect'

import { failCycleStore, runCycleStore, type CycleStoreShape } from './model'
import type { CycleQueries } from './queries'
import { decodeCycleAuthoritySlot, decodeCycleId, decodeCycleRecoveryScope } from './rows'

export interface CycleReadPrograms {
  readonly read: CycleStoreShape['read']
  readonly readAuthoritySlot: CycleStoreShape['readAuthoritySlot']
  readonly readDecisionDocument: CycleStoreShape['readDecisionDocument']
  readonly readOldestUnfinished: CycleStoreShape['readOldestUnfinished']
}

export const makeCycleReadPrograms = (queries: CycleQueries): CycleReadPrograms => {
  const read: CycleStoreShape['read'] = (cycleId) =>
    runCycleStore(
      'read',
      decodeCycleId(cycleId).pipe(
        Effect.flatMap((decodedId) => queries.selectCycle(decodedId, false)),
        Effect.flatMap((rows) => {
          if (rows.length > 1) return failCycleStore('read', 'invariant', 'cycle identity returned multiple rows')
          return Effect.succeed(rows[0] === undefined ? Option.none() : Option.some(rows[0]))
        }),
      ),
    )

  const readAuthoritySlot: CycleStoreShape['readAuthoritySlot'] = (slot) =>
    runCycleStore(
      'read-authority-slot',
      decodeCycleAuthoritySlot(slot).pipe(
        Effect.flatMap(queries.selectCycleByAuthoritySlot),
        Effect.flatMap((rows) => {
          if (rows.length > 1) {
            return failCycleStore('read-authority-slot', 'invariant', 'cycle authority slot returned multiple rows')
          }
          return Effect.succeed(rows[0] === undefined ? Option.none() : Option.some(rows[0]))
        }),
      ),
    )

  const readDecisionDocument: CycleStoreShape['readDecisionDocument'] = (cycleId) =>
    runCycleStore(
      'read-decision-document',
      decodeCycleId(cycleId).pipe(
        Effect.flatMap(queries.selectDecisionDocuments),
        Effect.flatMap((documents) => {
          if (documents.length > 1) {
            return failCycleStore(
              'read-decision-document',
              'invariant',
              'cycle decision document returned multiple rows',
            )
          }
          return Effect.succeed(documents[0] === undefined ? Option.none() : Option.some(documents[0]))
        }),
      ),
    )

  const readOldestUnfinished: CycleStoreShape['readOldestUnfinished'] = (scope) =>
    runCycleStore(
      'read-oldest-unfinished',
      decodeCycleRecoveryScope(scope).pipe(
        Effect.flatMap(queries.selectOldestUnfinishedCycle),
        Effect.map((rows) => (rows[0] === undefined ? Option.none() : Option.some(rows[0]))),
      ),
    )

  return { read, readAuthoritySlot, readDecisionDocument, readOldestUnfinished }
}

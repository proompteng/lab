import { Effect } from 'effect'

import type { OperationalError } from '../errors'
import {
  LEDGER_BATCH_MAX,
  ledgerValidationError,
  type LedgerPlan,
  type LedgerQueryFilter,
  type LedgerValidationError,
} from '../ledger-plan'
import type { TigerBeetleRequestClient } from '../tigerbeetle-client'
import { accountReconciliationQueries } from './decisions'

export const readLedgerRecords = <A extends { readonly timestamp: bigint }>(
  query: LedgerQueryFilter,
  expectedCount: number,
  readPage: (filter: LedgerQueryFilter) => Effect.Effect<readonly A[], OperationalError>,
): Effect.Effect<readonly A[], OperationalError | LedgerValidationError> =>
  Effect.gen(function* () {
    const records: A[] = []
    let timestamp = 0n
    while (records.length <= expectedCount) {
      const limit = Math.min(LEDGER_BATCH_MAX, expectedCount + 1 - records.length)
      const page = yield* readPage({ ...query, timestamp_min: timestamp + 1n, limit })
      if (page.length > limit) {
        return yield* ledgerValidationError({
          operation: 'verify-account',
          reason: 'invalid-query-page',
          message: 'TigerBeetle account query exceeded its requested page size',
          material: { limit, actualCount: page.length },
        })
      }
      for (const record of page) {
        if (record.timestamp <= timestamp || record.timestamp >= (1n << 64n) - 1n) {
          return yield* ledgerValidationError({
            operation: 'verify-account',
            reason: 'invalid-query-page',
            message: 'TigerBeetle account query did not return strictly increasing timestamps',
            material: { previousTimestamp: timestamp, actualTimestamp: record.timestamp },
          })
        }
        if (query.timestamp_max !== 0n && record.timestamp > query.timestamp_max) {
          return yield* ledgerValidationError({
            operation: 'verify-account',
            reason: 'invalid-query-page',
            message: 'TigerBeetle account query returned a record after its pinned timestamp',
            material: { maximumTimestamp: query.timestamp_max, actualTimestamp: record.timestamp },
          })
        }
        timestamp = record.timestamp
        records.push(record)
      }
      if (page.length === 0 || timestamp === (1n << 64n) - 2n) break
    }
    return records
  })

export const readAccountLedger = (client: TigerBeetleRequestClient, plan: LedgerPlan, ledger: number) => {
  const queries = accountReconciliationQueries(plan, ledger)
  return Effect.all(
    {
      accounts: readLedgerRecords(queries.accounts, plan.accounts.length, (filter) =>
        client.request('verify-account-accounts', (active) => active.queryAccounts(filter)),
      ),
      transfers: readLedgerRecords(queries.transfers, plan.transfers.length, (filter) =>
        client.request('verify-account-transfers', (active) => active.queryTransfers(filter)),
      ),
    },
    { concurrency: 'unbounded' },
  )
}

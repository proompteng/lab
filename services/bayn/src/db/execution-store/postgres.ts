import { PgClient } from '@effect/sql-pg'
import { Effect } from 'effect'

import { Journal } from '../../ledger'
import { makeReconciliation, restrictAuthority } from '../reconciliation'
import { makeAccountingInterpreter } from './accounting'
import { makeAuthorityPostgres } from './authority-shared'
import { makeBrokerEventInterpreter } from './broker-events'
import type { ExecutionPersistence, ExecutionStoreRuntimeConfig } from './contract'
import { runExecutionOperation } from './errors'
import { makeObserveAuthorityInterpreter } from './observe-authority'
import { makeCapitalGrantInterpreter } from './capital-grant'
import { decodeAuthorityRestriction } from './rows'
import { makeValuationInterpreter } from './valuation'

export const makeExecutionPersistence = (config: ExecutionStoreRuntimeConfig) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const journal = yield* Journal
    const events = makeBrokerEventInterpreter(sql)
    const accounting = makeAccountingInterpreter(sql, journal, config, events)
    const valuation = makeValuationInterpreter(sql)
    const reconciliation = makeReconciliation(sql, journal, config)
    const authorityPostgres = makeAuthorityPostgres(sql)
    const observeAuthority = makeObserveAuthorityInterpreter(sql, authorityPostgres, config.execution.brokerIdentity)
    const capitalGrant = makeCapitalGrantInterpreter(sql, authorityPostgres, config)

    return {
      events,
      accounting,
      valuation,
      reconciliation: {
        bindings: (accountId) => runExecutionOperation('bindings', reconciliation.bindings(accountId)),
        reconcile: (snapshot) => runExecutionOperation('reconciliation', reconciliation.reconcile(snapshot)),
      },
      authorityGeneration: {
        ensureAuthorityGeneration: observeAuthority.ensureAuthorityGeneration,
        readAuthorityState: observeAuthority.readAuthorityState,
        readAuthorityGeneration: observeAuthority.readAuthorityGeneration,
      },
      capitalGrantLifecycle: {
        prepareCapitalGrant: capitalGrant.prepareCapitalGrant,
        activateCapitalGrant: capitalGrant.activateCapitalGrant,
      },
      authorityRestriction: {
        restrictAuthority: (reason, updatedAt) =>
          runExecutionOperation(
            'authority',
            decodeAuthorityRestriction({ reason, updatedAt }).pipe(
              Effect.flatMap((input) => restrictAuthority(sql, input.reason, input.updatedAt)),
            ),
          ),
      },
    } satisfies ExecutionPersistence
  })

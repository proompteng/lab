import { PgClient } from '@effect/sql-pg'
import { Effect } from 'effect'

import { Journal } from '../../ledger'
import { makeReconciliation, restrictAuthority } from '../reconciliation'
import { makeAccountingInterpreter } from './accounting'
import { makeAuthorityPostgres } from './authority-shared'
import { makeBrokerEventInterpreter } from './broker-events'
import type { PaperStoreRuntimeConfig, PaperStoreShape } from './contract'
import { runPaperOperation } from './errors'
import { makeObserveAuthorityInterpreter } from './observe-authority'
import { makePaperAuthorityInterpreter } from './paper-authority'
import { decodeAuthorityRestriction } from './rows'
import { makeValuationInterpreter } from './valuation'

export const makePaperStore = (config: PaperStoreRuntimeConfig) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const journal = yield* Journal
    const events = makeBrokerEventInterpreter(sql)
    const accounting = makeAccountingInterpreter(sql, journal, config, events)
    const valuation = makeValuationInterpreter(sql)
    const reconciliation = makeReconciliation(sql, journal, config)
    const authorityPostgres = makeAuthorityPostgres(sql)
    const observeAuthority = makeObserveAuthorityInterpreter(sql, authorityPostgres)
    const paperAuthority = makePaperAuthorityInterpreter(sql, authorityPostgres, config)

    return {
      ingest: events.ingest,
      ingestPositions: events.ingestPositions,
      account: accounting.account,
      value: valuation.value,
      hasAccountBaseline: valuation.hasAccountBaseline,
      bindings: (accountId) => runPaperOperation('bindings', reconciliation.bindings(accountId)),
      reconcile: (snapshot) => runPaperOperation('reconciliation', reconciliation.reconcile(snapshot)),
      ensureAuthorityGeneration: observeAuthority.ensureAuthorityGeneration,
      preparePaperGeneration: paperAuthority.preparePaperGeneration,
      activatePaperGeneration: paperAuthority.activatePaperGeneration,
      restrictAuthority: (reason, updatedAt) =>
        runPaperOperation(
          'authority',
          decodeAuthorityRestriction({ reason, updatedAt }).pipe(
            Effect.flatMap((input) => restrictAuthority(sql, input.reason, input.updatedAt)),
          ),
        ),
    } satisfies PaperStoreShape
  })

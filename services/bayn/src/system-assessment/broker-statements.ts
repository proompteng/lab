import { Config, Effect } from 'effect'

import { make as makeAlpacaRead } from '../broker/alpaca/http'
import { decodeBrokerConnection, type BrokerConnection } from '../broker/connection'
import { JevResearchPolicy } from '../jev/acceptance'
import { SystemAssessmentError } from './economics'

export const captureNativeBrokerStatements = (
  candidateConnection: BrokerConnection,
  policies: readonly {
    readonly policy: JevResearchPolicy
    readonly riskPolicy: { readonly accountId: string }
  }[],
  window: { readonly after: string; readonly until: string },
) =>
  Effect.gen(function* () {
    const connections = yield* Effect.forEach(policies, ({ policy, riskPolicy }) =>
      Effect.gen(function* () {
        if (policy === JevResearchPolicy.Candidate) {
          if (riskPolicy.accountId !== candidateConnection.expectedAccountId)
            return yield* new SystemAssessmentError({
              message: 'Candidate statement must use its registered PAPER account',
            })
          return { policy, connection: candidateConnection }
        }
        if (riskPolicy.accountId === candidateConnection.expectedAccountId)
          return yield* new SystemAssessmentError({ message: 'A control statement requires its own PAPER account' })
        const prefix = `BAYN_QUALIFICATION_${policy}_ALPACA`
        const key = yield* Config.Redacted(`${prefix}_KEY_ID`)
        const secret = yield* Config.Redacted(`${prefix}_SECRET_KEY`)
        const connection = yield* Effect.fromResult(
          decodeBrokerConnection({ ...candidateConnection, expectedAccountId: riskPolicy.accountId, key, secret }),
        ).pipe(
          Effect.mapError(
            () => new SystemAssessmentError({ message: `Invalid qualification broker connection for ${policy}` }),
          ),
        )
        return { policy, connection }
      }),
    )
    const statements = yield* Effect.forEach(
      connections,
      ({ policy, connection }) =>
        makeAlpacaRead(connection).pipe(
          Effect.flatMap((reader) => reader.nonTradeActivityStatement(window)),
          Effect.timeout('30 seconds'),
          Effect.map((statement) => [policy, statement] as const),
        ),
      { concurrency: 2 },
    )
    return new Map(statements)
  })

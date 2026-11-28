import { Effect } from 'effect'

import { postgresQueryFixture } from '../testing/postgres-fixture.test-support'

export const brokerObservationPostgresFixture = (query: NonNullable<Parameters<typeof postgresQueryFixture>[0]>) =>
  postgresQueryFixture(
    Object.assign(
      (strings: TemplateStringsArray, ...values: readonly unknown[]) =>
        strings[0].startsWith('SELECT account_id FROM broker_observations') && strings.at(-1)?.endsWith(' FOR UPDATE')
          ? Effect.succeed([{ account_id: values[0] }])
          : query(strings, ...values),
      { withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect },
    ),
  )

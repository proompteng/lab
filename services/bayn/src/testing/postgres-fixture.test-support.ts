import { PgClient } from '@effect/sql-pg'
import { Effect } from 'effect'
import { Reactivity } from 'effect/reactivity'
import { SqlClient } from 'effect/sql'

export const makePostgresFixture = (
  options: Omit<SqlClient.SqlClient.MakeOptions, 'driver'> = {
    acquirer: Effect.die('PostgreSQL fixture must not acquire a connection'),
    compiler: PgClient.makeCompiler(undefined, false),
    spanAttributes: [],
  },
) =>
  SqlClient.make({ ...options, driver: 'pg' }).pipe(
    Effect.map((sql): PgClient.PgClient & SqlClient.SqlClient =>
      Object.assign(sql, {
        [PgClient.TypeId]: PgClient.TypeId,
        config: {},
        json: () => {
          throw new Error('PostgreSQL fixture does not support JSON fragments')
        },
        listen: () => Effect.die('PostgreSQL fixture must not listen'),
        notify: () => Effect.die('PostgreSQL fixture must not notify'),
        poolStats: Effect.succeed({ idle: 0, used: 0, pending: 0, min: 0, max: 0 }),
      }),
    ),
  )

export const postgresQueryFixture = (
  query?: (strings: TemplateStringsArray, ...values: readonly unknown[]) => Effect.Effect<readonly unknown[], unknown>,
) => {
  const sql = Effect.runSync(makePostgresFixture().pipe(Effect.provide(Reactivity.layer)))
  return query === undefined
    ? sql
    : new Proxy(sql, {
        apply: (_target, self, args) => Reflect.apply(query, self, args),
        get: (target, key, receiver) =>
          Object.hasOwn(query, key) ? Reflect.get(query, key) : Reflect.get(target, key, receiver),
      })
}

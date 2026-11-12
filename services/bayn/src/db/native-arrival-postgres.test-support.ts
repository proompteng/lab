import { Duplex } from 'node:stream'
import { PgConnection } from '@effect/sql-pg'
import { Effect, Result } from 'effect'

export const nativeArrivalPostgresFailure = (code: string) =>
  Effect.gen(function* () {
    const fields = Buffer.from(`SFATAL\0C${code}\0Msynthetic PostgreSQL startup refusal\0\0`)
    const response = Buffer.alloc(5 + fields.length)
    response[0] = 0x45
    response.writeInt32BE(fields.length + 4, 1)
    fields.copy(response, 5)
    const stream = new Duplex({
      read() {},
      write(_chunk, _encoding, callback) {
        this.push(response)
        callback()
      },
    })
    const opened = yield* PgConnection.make({
      username: 'bayn',
      database: 'bayn_native_arrival_test',
      ssl: false,
      stream: () => stream,
    }).pipe(Effect.scoped, Effect.result)
    if (Result.isSuccess(opened)) return yield* Effect.die('The PostgreSQL refusal unexpectedly opened a connection')
    if (!stream.destroyed) return yield* Effect.die('The refused PostgreSQL connection was not closed')
    return opened.failure
  })

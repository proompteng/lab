import { randomUUID } from 'node:crypto'

import { NodeServices, NodeRuntime } from '@effect/platform-node'
import { Clock, Effect, Layer, Option, Schedule } from 'effect'

import { PgClient } from '@effect/sql-pg'
import { loadConfig } from './config/load'
import { makeBrokerObservationStore } from './db/broker-observations'
import { PostgresClientLive } from './db/postgres-client'
import { brokerSnapshotCacheConfig } from './broker/alpaca/snapshot-cache'

import { ValkeyCache, ValkeyCacheError, ValkeyCacheLive } from './valkey-cache'
import { makeConfiguredTelemetryRuntimeLayer } from './telemetry'

export const verifyValkeyClient = Effect.gen(function* () {
  const cache = yield* ValkeyCache
  const key = `bayn:client-acceptance:${randomUUID()}`
  const payload = 'verified'.repeat(131_072)
  yield* Effect.addFinalizer(() => cache.remove(key).pipe(Effect.orDie))
  const missing = yield* cache.get(key)
  if (Option.isSome(missing))
    return yield* new ValkeyCacheError({ operation: 'verify', message: 'Expected cache miss' })
  yield* cache.put({ key, value: payload, ttlMs: 300_000 })
  const value = yield* cache.get(key)
  if (Option.getOrNull(value) !== payload)
    return yield* new ValkeyCacheError({ operation: 'verify', message: 'Cache read did not match write' })
  yield* cache.remove(key)
  if (Option.isSome(yield* cache.get(key)))
    return yield* new ValkeyCacheError({ operation: 'verify', message: 'Deleted cache key remained readable' })
  yield* cache.put({ key, value: 'expires', ttlMs: 50 })
  yield* Effect.sleep('100 millis')
  if (Option.isSome(yield* cache.get(key)))
    return yield* new ValkeyCacheError({ operation: 'verify', message: 'Cache key outlived its TTL' })
  yield* Effect.logInfo('Bayn Valkey client acceptance passed').pipe(
    Effect.annotateLogs({
      writeBytes: Buffer.byteLength(payload),
      checks: ['miss', 'write', 'read', 'delete', 'expiry'],
    }),
  )
}).pipe(Effect.scoped)

export const verifyBrokerMaterializations = Effect.gen(function* () {
  const config = yield* loadConfig()
  if (config.alpaca === undefined)
    return yield* new ValkeyCacheError({
      operation: 'verify',
      message: 'Broker materialization acceptance requires an account binding',
    })
  const { expectedAccountId: accountId } = config.alpaca
  const maximumAgeMs = (yield* brokerSnapshotCacheConfig).maxAgeMs
  const program = Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const cache = yield* ValkeyCache
    const store = makeBrokerObservationStore(sql, accountId, config.build.sourceRevision, maximumAgeMs, cache)
    const measure = <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.gen(function* () {
        const start = yield* Clock.currentTimeNanos
        const value = yield* effect
        return { value, ms: Number((yield* Clock.currentTimeNanos) - start) / 1_000_000 }
      })
    const sample = Effect.gen(function* () {
      const snapshot = yield* measure(store.read)
      const state = yield* measure(store.readState)
      return {
        snapshotMs: snapshot.ms,
        stateMs: state.ms,
        snapshotBytes: Buffer.byteLength(JSON.stringify(snapshot.value)),
        stateBytes: Buffer.byteLength(JSON.stringify(state.value)),
      }
    }).pipe(Effect.retry({ times: 5, schedule: Schedule.spaced('1 second') }))
    const samples = yield* Effect.forEach(Array.from({ length: 20 }), () => sample)
    const percentile = (values: readonly number[], fraction: number) => {
      const ordered = [...values].sort((a, b) => a - b)
      return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))]
    }
    const latest = samples.at(-1)
    yield* Effect.logInfo('Bayn broker Valkey materialization acceptance passed').pipe(
      Effect.annotateLogs({
        samples: samples.length,
        sourceRevision: config.build.sourceRevision,
        fullP50Ms: percentile(
          samples.map((value) => value.snapshotMs),
          0.5,
        ),
        fullP95Ms: percentile(
          samples.map((value) => value.snapshotMs),
          0.95,
        ),
        stateP50Ms: percentile(
          samples.map((value) => value.stateMs),
          0.5,
        ),
        stateP95Ms: percentile(
          samples.map((value) => value.stateMs),
          0.95,
        ),
        fullBytes: latest?.snapshotBytes,
        stateBytes: latest?.stateBytes,
        checks: [
          'fresh-database-fence',
          'full-content-hash',
          'compact-content-hash',
          'parent-snapshot-binding',
          'account-and-age',
        ],
      }),
    )
  })
  return yield* program.pipe(
    // @effect-diagnostics-next-line strictEffectProvide:off -- finite command owns and releases its read-only PostgreSQL pool
    Effect.provide(
      PostgresClientLive(config, {
        maxConnections: 1,
        applicationName: 'bayn-cache-acceptance',
      }).pipe(Layer.provide(NodeServices.layer)),
    ),
  )
})

if (import.meta.main && process.argv.includes('--help')) {
  NodeRuntime.runMain(
    Effect.logInfo(
      'Usage: valkey-command.js; requires VALKEY_HOST, VALKEY_PASSWORD and mounted TLS client material. Verifies cache miss, write, read, deletion and expiry. Add --broker to verify the fenced production materializations and measure full versus compact reads.',
    ),
  )
} else if (import.meta.main) {
  NodeRuntime.runMain(
    verifyValkeyClient.pipe(
      Effect.andThen(process.argv.includes('--broker') ? verifyBrokerMaterializations : Effect.void),
      // @effect-diagnostics-next-line strictEffectProvide:off -- command entry point owns the scoped cache client
      Effect.provide(
        ValkeyCacheLive.pipe(Layer.provideMerge(makeConfiguredTelemetryRuntimeLayer('bayn-valkey-client'))),
      ),
    ),
  )
}

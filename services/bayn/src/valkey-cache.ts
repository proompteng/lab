import { isNativeError } from 'node:util/types'
import { NodeRedis, NodeServices } from '@effect/platform-node'
import { Config, Context, Data, Effect, FileSystem, Layer, Metric, Option, Redacted, Schema, Semaphore } from 'effect'
import { ConnectionTimeoutError, SocketClosedUnexpectedlyError, SocketTimeoutError, TimeoutError } from 'redis'
import { withObservedStage } from './telemetry'

const reads = Metric.counter('bayn_valkey_reads_total', { incremental: true })
const failures = Metric.counter('bayn_valkey_failures_total', { incremental: true })
const replicaWaits = Metric.counter('bayn_valkey_unacknowledged_waits_total', { incremental: true })
type CacheOperation = 'get' | 'put' | 'remove'

export enum ValkeyFailureCategory {
  ReplicaAcknowledgement = 'replica_acknowledgement',
  OperationDeadline = 'operation_deadline',
  NativeTimeout = 'native_timeout',
  Transport = 'transport',
  CommandFailed = 'command_failed',
}

class ReplicaAcknowledgementError extends Error {}

const commandFailureCategory = (cause: unknown): ValkeyFailureCategory => {
  // Native identity avoids reading messages, accessors or hostile prototype chains.
  if (!isNativeError(cause)) return ValkeyFailureCategory.CommandFailed
  const prototype = Object.getPrototypeOf(cause)
  if (prototype === ReplicaAcknowledgementError.prototype) return ValkeyFailureCategory.ReplicaAcknowledgement
  if (
    prototype === TimeoutError.prototype ||
    prototype === ConnectionTimeoutError.prototype ||
    prototype === SocketTimeoutError.prototype
  )
    return ValkeyFailureCategory.NativeTimeout
  if (prototype === SocketClosedUnexpectedlyError.prototype) return ValkeyFailureCategory.Transport
  return ValkeyFailureCategory.CommandFailed
}

export class ValkeyCacheError extends Data.TaggedError('ValkeyCacheError')<{
  readonly operation: string
  readonly category?: ValkeyFailureCategory
  readonly causeCategory?: ValkeyFailureCategory
  readonly message: string
  readonly cause?: unknown
}> {}

export class ValkeyCacheInputError extends Data.TaggedError('ValkeyCacheInputError')<{
  readonly operation: string
  readonly message: string
}> {}

export const ValkeyKey = Schema.String.check(Schema.isPattern(/^bayn:.{1,250}$/))
export const ValkeyWrite = Schema.Struct({
  key: ValkeyKey,
  value: Schema.String.check(Schema.isMaxLength(4_194_304)),
  ttlMs: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(300_000)),
})

export class ValkeyCache extends Context.Service<
  ValkeyCache,
  {
    readonly get: (key: string) => Effect.Effect<Option.Option<string>, ValkeyCacheError | ValkeyCacheInputError>
    readonly put: (input: typeof ValkeyWrite.Type) => Effect.Effect<void, ValkeyCacheError | ValkeyCacheInputError>
    readonly remove: (key: string) => Effect.Effect<void, ValkeyCacheError | ValkeyCacheInputError>
  }
>()('bayn/ValkeyCache') {}

export const valkeyConfig = Config.all({
  host: Config.NonEmptyString('VALKEY_HOST'),
  port: Config.Port('VALKEY_PORT').pipe(Config.withDefault(6379)),
  username: Config.NonEmptyString('VALKEY_USERNAME').pipe(Config.withDefault('default')),
  password: Config.Redacted('VALKEY_PASSWORD'),
  serverName: Config.NonEmptyString('VALKEY_TLS_SERVER_NAME'),
  tlsDirectory: Config.NonEmptyString('BAYN_VALKEY_TLS_DIRECTORY').pipe(
    Config.withDefault('/var/run/secrets/bayn/valkey'),
  ),
})

type ValkeyClientOptions = NonNullable<Parameters<typeof NodeRedis.layer>[0]>

export const makeValkeyCache = Effect.gen(function* () {
  const { client } = yield* NodeRedis.NodeRedis
  const commands = yield* Semaphore.make(1)
  const destroy = Effect.sync(() => {
    if (client.isOpen) client.destroy()
  })
  // Native close waits for replies; cache scope exit and cancellation must abort stalled sockets.
  yield* Effect.addFinalizer(() => destroy)
  const invoke = <A>(operation: CacheOperation, run: (signal: AbortSignal) => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) =>
        new ValkeyCacheError({
          operation,
          category: commandFailureCategory(cause),
          message: 'Valkey command failed',
          cause,
        }),
    })
  const command = <A>(
    operation: CacheOperation,
    run: Effect.Effect<A, ValkeyCacheError>,
    deadlineCause?: () => Error | undefined,
  ) =>
    commands
      .withPermit(
        invoke(operation, async () => {
          if (!client.isOpen) await client.connect()
        }).pipe(
          Effect.andThen(run),
          Effect.onInterrupt(() => destroy),
          Effect.tapError(() => destroy),
        ),
      )
      .pipe(
        Effect.timeoutOrElse({
          duration: '1 second',
          orElse: () => {
            const cause = deadlineCause?.()
            return Effect.fail(
              new ValkeyCacheError({
                operation,
                category: ValkeyFailureCategory.OperationDeadline,
                ...(cause === undefined ? {} : { causeCategory: commandFailureCategory(cause) }),
                message: 'Valkey command exceeded its deadline',
                cause,
              }),
            )
          },
        }),
        Effect.tapError((error) =>
          Metric.update(
            failures.pipe(
              Metric.withAttributes({
                namespace: 'bayn',
                operation,
                category: error.category ?? ValkeyFailureCategory.CommandFailed,
                cause_category: error.causeCategory ?? error.category ?? ValkeyFailureCategory.CommandFailed,
              }),
            ),
            1,
          ),
        ),
        withObservedStage(`bayn.valkey.${operation}`, { dependency: 'valkey', slowAfterMs: 250 }),
      )

  const key = (operation: string, input: string) =>
    Schema.decodeUnknownEffect(ValkeyKey)(input).pipe(
      Effect.mapError(() => new ValkeyCacheInputError({ operation, message: 'Cache keys must use the bayn: prefix' })),
    )

  return ValkeyCache.of({
    get: (input) =>
      key('get', input).pipe(
        Effect.flatMap((key) =>
          command(
            'get',
            invoke('get', (signal) => client.withAbortSignal(signal).get(key)),
          ),
        ),
        Effect.map(Option.fromNullishOr),
        Effect.tap((value) =>
          Metric.update(
            reads.pipe(
              Metric.withAttributes({
                namespace: 'bayn',
                outcome: Option.isSome(value) ? 'hit' : 'miss',
              }),
            ),
            1,
          ),
        ),
      ),
    put: (input) =>
      Schema.decodeUnknownEffect(ValkeyWrite)(input).pipe(
        Effect.mapError(
          () =>
            new ValkeyCacheInputError({
              operation: 'put',
              message: 'Cache writes require a bayn: key, bounded value and TTL of 1–300000 ms',
            }),
        ),
        Effect.flatMap(({ key, value, ttlMs }) => {
          let acknowledgementFailure: Error | undefined
          return command(
            'put',
            invoke('put', (signal) => client.withAbortSignal(signal).set(key, value, { PX: ttlMs })).pipe(
              withObservedStage('bayn.valkey.set', { dependency: 'valkey', slowAfterMs: 250 }),
              Effect.andThen(
                Effect.gen(function* () {
                  while ((yield* invoke('put', (signal) => client.withAbortSignal(signal).wait(1, 250))) < 1) {
                    acknowledgementFailure ??= new ReplicaAcknowledgementError(
                      'Valkey replica did not acknowledge publication',
                    )
                    yield* Metric.update(replicaWaits.pipe(Metric.withAttributes({ namespace: 'bayn' })), 1)
                  }
                }).pipe(withObservedStage('bayn.valkey.replica-ack', { dependency: 'valkey', slowAfterMs: 250 })),
              ),
            ),
            () => acknowledgementFailure,
          )
        }),
        Effect.asVoid,
      ),
    remove: (input) =>
      key('remove', input).pipe(
        Effect.flatMap((key) =>
          command(
            'remove',
            invoke('remove', (signal) => client.withAbortSignal(signal).del(key)),
          ),
        ),
        Effect.asVoid,
      ),
  })
})

const clientOptions = Effect.gen(function* () {
  const config = yield* valkeyConfig.pipe(
    Effect.mapError(
      (cause) =>
        new ValkeyCacheError({ operation: 'configure', message: 'Valkey configuration is unavailable', cause }),
    ),
  )
  const files = yield* FileSystem.FileSystem
  const readTls = (name: string) =>
    files
      .readFileString(`${config.tlsDirectory}/${name}`)
      .pipe(
        Effect.mapError(
          (cause) =>
            new ValkeyCacheError({ operation: 'configure', message: 'Cannot read Valkey TLS material', cause }),
        ),
      )
  const { ca, cert, key } = yield* Effect.all({
    ca: readTls('ca.crt'),
    cert: readTls('tls.crt'),
    key: readTls('tls.key'),
  })
  return {
    username: config.username,
    password: Redacted.value(config.password),
    disableOfflineQueue: true,
    commandOptions: { timeout: 500 },
    pingInterval: 1_000,
    socket: {
      host: config.host,
      port: config.port,
      tls: true,
      servername: config.serverName,
      ca,
      cert,
      key,
      connectTimeout: 1000,
      reconnectStrategy: false,
      socketTimeout: 2_000,
    },
  } satisfies ValkeyClientOptions
})

export const ValkeyRedisLive = Layer.unwrap(Effect.map(clientOptions, NodeRedis.layer)).pipe(
  Layer.provide(NodeServices.layer),
  Layer.catch((cause) =>
    Layer.effect(
      NodeRedis.NodeRedis,
      Effect.fail(
        cause instanceof ValkeyCacheError
          ? cause
          : new ValkeyCacheError({ operation: 'connect', message: 'Cannot acquire required Valkey connection', cause }),
      ),
    ),
  ),
)

export const ValkeyCacheLive = Layer.effect(ValkeyCache, makeValkeyCache).pipe(Layer.provide(ValkeyRedisLive))

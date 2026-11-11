import { NodeHttpClient, NodeRuntime, NodeServices } from '@effect/platform-node'
import { Config, Data, Effect, Layer, Option, Redacted, Result, Schedule, Schema, Stdio, Stream } from 'effect'
import { HttpClient, HttpClientRequest } from 'effect/http'

import { GitSourceRevisionSchema, Sha256Schema, strictParseOptions } from '../src/schemas'

const serviceName = 'BaynBrokerObservations'
const InvocationIdSchema = Schema.String.check(Schema.isPattern(/^inv_[A-Za-z0-9]+$/))
const DeploymentIdSchema = Schema.String.check(Schema.isPattern(/^dp_[A-Za-z0-9]+$/))
const PositiveIntSchema = Schema.Int.check(Schema.isGreaterThan(0))
const NonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const ServiceSchema = Schema.Struct({
  name: Schema.Literal(serviceName),
  ty: Schema.Literal('VirtualObject'),
  deployment_id: DeploymentIdSchema,
  revision: PositiveIntSchema,
  metadata: Schema.Record(Schema.String, Schema.String),
  handlers: Schema.Array(Schema.Struct({ name: Schema.String, public: Schema.Boolean })),
})
const DeploymentSchema = Schema.Struct({
  type: Schema.Literal('http'),
  id: DeploymentIdSchema,
  uri: Schema.String,
  services: Schema.Array(
    Schema.Struct({ name: Schema.String, revision: PositiveIntSchema, deployment_id: DeploymentIdSchema }),
  ),
})
const InvocationSchema = Schema.Struct({
  id: InvocationIdSchema,
  target_service_name: Schema.String,
  target_service_key: Schema.optionalKey(Schema.NullOr(Schema.String)),
  target_handler_name: Schema.String,
  scope: Schema.optionalKey(Schema.NullOr(Schema.String)),
  status: Schema.String,
  idempotency_key: Schema.optionalKey(Schema.NullOr(Schema.String)),
  invoked_by: Schema.String,
  invoked_by_service_name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  invoked_by_id: Schema.optionalKey(Schema.NullOr(InvocationIdSchema)),
})
const JournalRowSchema = Schema.Struct({
  entry_type: Schema.String,
  entry_json: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
const ByteArraySchema = Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 })))
const InputEntrySchema = Schema.Struct({
  Command: Schema.Struct({ Input: Schema.Struct({ payload: ByteArraySchema }) }),
})
const SendEntrySchema = Schema.Struct({
  Command: Schema.Struct({
    OneWayCall: Schema.Struct({
      request: Schema.Struct({
        invocation_id: InvocationIdSchema,
        invocation_target: Schema.Struct({
          VirtualObject: Schema.Struct({
            name: Schema.Literal(serviceName),
            key: Sha256Schema,
            handler: Schema.Literal('poll'),
            handler_ty: Schema.Literal('Exclusive'),
            scope: Schema.Null,
          }),
        }),
        parameter: ByteArraySchema,
        idempotency_key: Schema.String,
      }),
    }),
  }),
})
const PollSchema = Schema.Struct({
  sourceRevision: GitSourceRevisionSchema,
  epoch: PositiveIntSchema,
  sequence: NonNegativeIntSchema,
})
const LocksSchema = Schema.Struct({ rows: Schema.Array(Schema.Struct({ acquired_by: InvocationIdSchema })) })

type Invocation = typeof InvocationSchema.Type
type Service = typeof ServiceSchema.Type
export interface BrokerPollRetirementInput {
  readonly adminUrl: string
  readonly controllerKey: string
  readonly sourceRevision: string
  readonly obsoleteSourceRevisions: readonly string[]
  readonly apply: boolean
}
export class BrokerPollRetirementError extends Data.TaggedError('BrokerPollRetirementError')<{
  readonly operation: string
  readonly message: string
}> {}
class BrokerPollRetirementPending extends Data.TaggedError('BrokerPollRetirementPending')<{}> {}
const fail = (operation: string, message: string) => Effect.fail(new BrokerPollRetirementError({ operation, message }))
const decode = <A>(schema: Schema.Codec<A, unknown>, candidate: unknown, operation: string) =>
  Schema.decodeUnknownEffect(
    schema,
    strictParseOptions,
  )(candidate).pipe(
    Effect.mapError(() => new BrokerPollRetirementError({ operation, message: 'Evidence failed schema validation' })),
  )
// Admin response documents evolve independently; validate the fields this operation consumes.
const decodeResponse = <A>(schema: Schema.Codec<A, unknown>, candidate: unknown) =>
  Schema.decodeUnknownEffect(schema)(candidate).pipe(
    Effect.mapError(
      () =>
        new BrokerPollRetirementError({ operation: 'evidence', message: 'Restate evidence failed schema validation' }),
    ),
  )
const http = (input: BrokerPollRetirementInput, token: Redacted.Redacted<string> | undefined) => {
  const request = (path: string, method: 'GET' | 'POST' | 'PATCH', body?: unknown) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const url = `${input.adminUrl.replace(/\/$/, '')}${path}`
      let request = HttpClientRequest.make(method)(url, { headers: { accept: 'application/json' } })
      if (token !== undefined)
        request = HttpClientRequest.setHeader(request, 'authorization', `Bearer ${Redacted.value(token)}`)
      if (body !== undefined) request = HttpClientRequest.bodyJsonUnsafe(request, body)
      const response = yield* client.execute(request)
      if (response.status !== 200) return yield* fail(path, `Restate Admin returned HTTP ${response.status}`)
      return response
    }).pipe(
      Effect.timeout('10 seconds'),
      Effect.mapError((cause) =>
        cause instanceof BrokerPollRetirementError
          ? cause
          : new BrokerPollRetirementError({ operation: path, message: 'Restate Admin request failed or timed out' }),
      ),
    )
  const json = <A>(path: string, schema: Schema.Codec<A, unknown>, body?: unknown) =>
    Effect.gen(function* () {
      const response = yield* request(path, body === undefined ? 'GET' : 'POST', body)
      return yield* decodeResponse(schema, yield* response.json)
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof BrokerPollRetirementError
          ? cause
          : new BrokerPollRetirementError({ operation: path, message: 'Restate Admin returned invalid evidence' }),
      ),
    )
  const query = <A>(sql: string, schema: Schema.Codec<A, unknown>) =>
    json('/query', Schema.Struct({ rows: Schema.Array(schema) }), { query: sql })
  return { json, query, kill: (id: string) => request(`/invocations/${id}/kill`, 'PATCH') }
}

const validateService = (service: Service, input: BrokerPollRetirementInput) => {
  const handlers = new Set(service.handlers.map((handler) => handler.name))
  if (
    service.metadata['bayn.source-revision'] !== input.sourceRevision ||
    service.metadata['bayn.broker-identity-hash'] !== input.controllerKey
  )
    return fail('deployment', 'Current registered source revision or broker identity differs from the requested target')
  if (
    handlers.has('poll') ||
    !['notify', 'accept', 'capture', 'freshness', 'activate', 'status'].every((name) => handlers.has(name))
  )
    return fail('deployment', 'The streaming broker owner must be registered with no poll handler before retirement')
  if (service.handlers.some((handler) => handler.public !== (handler.name === 'notify')))
    return fail('deployment', 'The registered broker handler visibility differs from the streaming contract')
  return Effect.succeed(service)
}
const validateInvocation = (row: Invocation, input: BrokerPollRetirementInput) => {
  if (
    row.target_service_name !== serviceName ||
    row.target_service_key !== input.controllerKey ||
    row.target_handler_name !== 'poll' ||
    row.scope != null ||
    row.invoked_by !== 'service' ||
    row.invoked_by_service_name !== serviceName ||
    row.invoked_by_id == null ||
    row.idempotency_key == null
  )
    return fail(row.id, 'Invocation is not an unscoped broker owner polling timer for the exact account')
  return Effect.succeed(row)
}

export const retireBrokerPolls = (input: BrokerPollRetirementInput, token?: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const parsedUrl = yield* Effect.try({
      try: () => new URL(input.adminUrl),
      catch: () =>
        new BrokerPollRetirementError({ operation: 'arguments', message: 'Invalid explicit Restate Admin URL' }),
    })
    if (
      !['http:', 'https:'].includes(parsedUrl.protocol) ||
      parsedUrl.username !== '' ||
      parsedUrl.password !== '' ||
      parsedUrl.search !== '' ||
      parsedUrl.hash !== ''
    )
      return yield* fail('arguments', 'Admin URL must be HTTP(S), without embedded credentials, query or fragment')
    yield* decode(Sha256Schema, input.controllerKey, 'arguments')
    yield* decode(GitSourceRevisionSchema, input.sourceRevision, 'arguments')
    yield* decode(
      Schema.Array(GitSourceRevisionSchema).check(Schema.isMinLength(1), Schema.isMaxLength(10)),
      input.obsoleteSourceRevisions,
      'arguments',
    )
    if (input.obsoleteSourceRevisions.includes(input.sourceRevision))
      return yield* fail('arguments', 'Current source cannot be included in the explicit obsolete source allowlist')
    const admin = http(input, token)
    const readService = () =>
      admin
        .json(`/services/${serviceName}`, ServiceSchema)
        .pipe(Effect.flatMap((service) => validateService(service, input)))
    const service = yield* readService()
    const deployment = yield* admin.json(`/deployments/${service.deployment_id}`, DeploymentSchema)
    const registered = deployment.services.find((candidate) => candidate.name === serviceName)
    if (
      deployment.id !== service.deployment_id ||
      registered === undefined ||
      registered.revision !== service.revision ||
      registered.deployment_id !== service.deployment_id
    )
      return yield* fail('deployment', 'Current service and deployment revision evidence disagree')
    const candidateSql = `SELECT id, target_service_name, target_service_key, target_handler_name, scope, status, idempotency_key, invoked_by, invoked_by_service_name, invoked_by_id FROM sys_invocation WHERE target_service_name = '${serviceName}' AND target_service_key = '${input.controllerKey}' AND target_handler_name = 'poll' AND completed_at IS NULL LIMIT 101`
    const rows = (yield* admin.query(candidateSql, InvocationSchema)).rows
    if (rows.length > 100)
      return yield* fail('selection', 'More than 100 old timers; inspect the exact target before retirement')
    const candidates: Array<
      { readonly id: string; readonly sourceEvidence: 'invocation-input' | 'caller-send' } & typeof PollSchema.Type
    > = []
    for (const row of rows) {
      yield* validateInvocation(row, input)
      const entries = (yield* admin.query(
        `SELECT entry_type, entry_json FROM sys_journal WHERE id = '${row.id}' AND entry_type = 'Command: Input'`,
        JournalRowSchema,
      )).rows
      let bytes: readonly number[]
      let sourceEvidence: 'invocation-input' | 'caller-send'
      if (entries.length === 1 && entries[0]?.entry_json != null) {
        const entry = yield* decodeResponse(Schema.fromJsonString(InputEntrySchema), entries[0].entry_json)
        bytes = entry.Command.Input.payload
        sourceEvidence = 'invocation-input'
      } else if (entries.length === 0 && row.invoked_by_id !== undefined && row.invoked_by_id !== null) {
        // Scheduled invocations may have no input journal yet. Their caller's durable send is authoritative.
        const sends = (yield* admin.query(
          `SELECT entry_type, entry_json FROM sys_journal WHERE id = '${row.invoked_by_id}' AND invoked_id = '${row.id}' AND entry_type = 'Command: OneWayCall'`,
          JournalRowSchema,
        )).rows
        const send = sends[0]
        if (sends.length !== 1 || send?.entry_json == null)
          return yield* fail(
            row.id,
            'No retained invocation input or exact caller send is available; do not infer source from a timer label',
          )
        const entry = yield* decodeResponse(Schema.fromJsonString(SendEntrySchema), send.entry_json)
        const request = entry.Command.OneWayCall.request
        if (
          request.invocation_id !== row.id ||
          request.invocation_target.VirtualObject.key !== input.controllerKey ||
          request.idempotency_key !== row.idempotency_key
        )
          return yield* fail(
            row.id,
            'Caller send does not match the exact invocation, account and idempotency identity',
          )
        bytes = request.parameter
        sourceEvidence = 'caller-send'
      } else return yield* fail(row.id, 'Invocation input evidence is missing, duplicated or malformed')
      const poll = yield* decode(Schema.fromJsonString(PollSchema), Buffer.from(bytes).toString('utf8'), row.id)
      if (
        !input.obsoleteSourceRevisions.includes(poll.sourceRevision) ||
        row.idempotency_key !== `broker-observations:${poll.sourceRevision}:${poll.epoch}:${poll.sequence}`
      )
        return yield* fail(
          row.id,
          'Poll source is not explicitly obsolete or its timer identity disagrees with the recorded payload',
        )
      candidates.push({ id: row.id, ...poll, sourceEvidence })
    }
    const ensureSameService = () =>
      readService().pipe(
        Effect.flatMap((current) =>
          current.deployment_id === service.deployment_id && current.revision === service.revision
            ? Effect.void
            : fail('deployment', 'Service revision changed during retirement; prepare a fresh plan'),
        ),
      )
    yield* ensureSameService()
    const retired: string[] = []
    if (input.apply) {
      for (const candidate of candidates) {
        yield* ensureSameService()
        const current = (yield* admin.query(
          `SELECT id, target_service_name, target_service_key, target_handler_name, scope, status, idempotency_key, invoked_by, invoked_by_service_name, invoked_by_id FROM sys_invocation WHERE id = '${candidate.id}'`,
          InvocationSchema,
        )).rows
        if (current.length !== 1 || current[0] === undefined)
          return yield* fail(candidate.id, 'Invocation disappeared before its exact-ID retirement')
        yield* validateInvocation(current[0], input)
        if (current[0].status === 'completed') continue
        yield* admin.kill(candidate.id)
        retired.push(candidate.id)
      }
      yield* Effect.gen(function* () {
        const pending = (yield* admin.query(candidateSql, InvocationSchema)).rows
        const locks = yield* admin.json('/query', LocksSchema, {
          query: `SELECT locks.acquired_by FROM sys_locks AS locks JOIN sys_invocation AS invocation ON locks.acquired_by = invocation.id WHERE locks.lock_name = '${serviceName}/${input.controllerKey}' AND locks.scope IS NULL AND invocation.target_service_name = '${serviceName}' AND invocation.target_service_key = '${input.controllerKey}' AND invocation.target_handler_name = 'poll'`,
        })
        if (pending.length !== 0 || locks.rows.length !== 0) return yield* new BrokerPollRetirementPending()
      }).pipe(
        Effect.retry({
          while: (cause) => cause instanceof BrokerPollRetirementPending,
          schedule: Schedule.spaced('100 millis'),
          times: 20,
        }),
        Effect.mapError((cause) =>
          cause instanceof BrokerPollRetirementPending
            ? new BrokerPollRetirementError({
                operation: 'verification',
                message: 'Old polling invocations or their locks remain; no other invocations were selected',
              })
            : cause,
        ),
      )
      yield* ensureSameService()
    }
    return {
      apply: input.apply,
      controllerKey: input.controllerKey,
      sourceRevision: input.sourceRevision,
      obsoleteSourceRevisions: input.obsoleteSourceRevisions,
      deploymentId: service.deployment_id,
      serviceRevision: service.revision,
      endpoint: deployment.uri,
      candidates,
      retired,
    }
  })

export const brokerPollRetirementUsage =
  'Usage: bun tools/retire-broker-polls.ts --admin-url <url> --controller-key <sha256> --source-revision <git-sha> --obsolete-source-revisions <sha[,sha]> [--apply]'
export const parseBrokerPollRetirementArgs = (args: readonly string[]) => {
  if (
    (args.length !== 8 && args.length !== 9) ||
    args[0] !== '--admin-url' ||
    args[2] !== '--controller-key' ||
    args[4] !== '--source-revision' ||
    args[6] !== '--obsolete-source-revisions' ||
    (args.length === 9 && args[8] !== '--apply')
  )
    return Result.fail(new BrokerPollRetirementError({ operation: 'arguments', message: brokerPollRetirementUsage }))
  const adminUrl = args[1],
    controllerKey = args[3],
    sourceRevision = args[5],
    obsoleteSources = args[7]
  if (
    adminUrl === undefined ||
    controllerKey === undefined ||
    sourceRevision === undefined ||
    obsoleteSources === undefined
  )
    return Result.fail(new BrokerPollRetirementError({ operation: 'arguments', message: brokerPollRetirementUsage }))
  return Result.succeed({
    adminUrl,
    controllerKey,
    sourceRevision,
    obsoleteSourceRevisions: obsoleteSources.split(','),
    apply: args.length === 9,
  })
}
export const runBrokerPollRetirementCommand = (args: readonly string[]) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    if (args.length === 1 && args[0] === '--help')
      return yield* Stream.run(Stream.make(`${brokerPollRetirementUsage}\n`), stdio.stdout())
    const input = yield* Effect.fromResult(parseBrokerPollRetirementArgs(args))
    const token = yield* Config.option(Config.Redacted('RESTATE_AUTH_TOKEN'))
    const receipt = yield* retireBrokerPolls(input, Option.getOrUndefined(token))
    yield* Stream.run(Stream.make(`${JSON.stringify(receipt)}\n`), stdio.stdout())
    return receipt
  })
if (import.meta.main)
  NodeRuntime.runMain(
    runBrokerPollRetirementCommand(process.argv.slice(2)).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- this command owns its HTTP client and standard output
      Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp)),
    ),
  )

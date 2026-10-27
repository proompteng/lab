import { ReplayImagePlatform } from './replay-image-platform'
import { createHash } from 'node:crypto'
import { PgClient } from '@effect/sql-pg'
import { DateTime, Effect, FileSystem, Redacted, Result, Schema, SchemaIssue, Stream } from 'effect'

import { validateReplayDatabaseTargets } from '../intraday-replay/database-targets'
import { canonicalHashV1Result, canonicalJsonV1Result, sha256 } from '../hash'
import { BacktestInputSchema, prepareBacktest } from '../intraday-replay/backtest'
import { validateBacktestSourceReceipt } from '../intraday-replay/source'
import {
  ImageDigestSchema,
  Sha256Schema,
  UtcInstantSchema,
  UtcSourceTimestampSchema,
  strictParseOptions,
} from '../schemas'
import { intradayInstantNanos } from '../market-data/intraday/time'
import { SystemAssessmentError } from './economics'
import { ReplayImageReceiptSchema, VerifiedReplayImage, runReplayEvidenceCommand } from './replay-image'
import type { SystemRegistration } from './policy'
import type { SystemSourceCut } from './source-cut'
import { JevResearchPolicy } from '../jev/acceptance'
import { FrozenControlReplaySchema, prepareFrozenControlReplay } from './frozen-control-replay'

export const CaptureReplayExecutionSchema = Schema.Struct({
  registrationHash: Sha256Schema,
  sourceCutHash: Sha256Schema,
  containerId: Sha256Schema,
  imagePlatform: Schema.Enum(ReplayImagePlatform),
})

const ContainerConfig = Schema.Struct({
  Image: Schema.String,
  Entrypoint: Schema.NullOr(Schema.Array(Schema.String)),
  Cmd: Schema.NullOr(Schema.Array(Schema.String)),
  Env: Schema.NullOr(Schema.Array(Schema.String)),
  User: Schema.optionalKey(Schema.String),
  WorkingDir: Schema.optionalKey(Schema.String),
  Healthcheck: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
})
export const ReplayContainerInspectionSchema = Schema.Struct({
  Id: Sha256Schema,
  Image: ImageDigestSchema,
  ImageManifestDescriptor: Schema.Struct({ digest: ImageDigestSchema }),
  Created: UtcSourceTimestampSchema,
  RestartCount: Schema.Int,
  State: Schema.Struct({
    Status: Schema.String,
    Running: Schema.Boolean,
    Paused: Schema.Boolean,
    Restarting: Schema.Boolean,
    Dead: Schema.Boolean,
    OOMKilled: Schema.Boolean,
    ExitCode: Schema.Int,
    Error: Schema.String,
    StartedAt: UtcSourceTimestampSchema,
    FinishedAt: UtcSourceTimestampSchema,
  }),
  Config: ContainerConfig,
  HostConfig: Schema.Struct({
    ReadonlyRootfs: Schema.Boolean,
    Privileged: Schema.Boolean,
    CapDrop: Schema.NullOr(Schema.Array(Schema.String)),
    CapAdd: Schema.NullOr(Schema.Array(Schema.String)),
    SecurityOpt: Schema.NullOr(Schema.Array(Schema.String)),
    RestartPolicy: Schema.Struct({ Name: Schema.String }),
    Tmpfs: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
  }),
  Mounts: Schema.Array(Schema.Struct({ Type: Schema.String, Destination: Schema.String, RW: Schema.Boolean })),
})
const ImageInspectionSchema = Schema.Struct({
  Id: ImageDigestSchema,
  Descriptor: Schema.Struct({ digest: ImageDigestSchema }),
  Config: Schema.Struct({
    Env: Schema.NullOr(Schema.Array(Schema.String)),
    User: Schema.optionalKey(Schema.String),
    WorkingDir: Schema.optionalKey(Schema.String),
    Healthcheck: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  }),
})

export const replayExecutionAssumptions = [
  'The selected container daemon and its administrator report execution state truthfully.',
  'The host preserves mounted inputs and output files during execution and capture.',
  'Registered image source claims depend on the reviewed build and publication process.',
] as const

export const ReplayExecutionReceiptSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.replay-execution-receipt.v1'),
  registrationHash: Sha256Schema,
  sourceCutHash: Sha256Schema,
  policyDefinitionHash: Sha256Schema,
  containerId: Sha256Schema,
  daemonIdentityHash: Sha256Schema,
  inspectionHash: Sha256Schema,
  capturedAt: UtcInstantSchema,
  startedAt: UtcSourceTimestampSchema,
  finishedAt: UtcSourceTimestampSchema,
  runId: Sha256Schema,
  inputFileHash: Sha256Schema,
  captureFileHash: Sha256Schema,
  arrivalsFileHash: Sha256Schema,
  reportFileHash: Sha256Schema,
  reportHash: Sha256Schema,
  passLogFileHash: Sha256Schema,
  image: ReplayImageReceiptSchema,
  assurance: Schema.Literal('TRUSTED_CONTAINER_DAEMON_OBSERVATION'),
  assumptions: Schema.Tuple(replayExecutionAssumptions.map((value) => Schema.Literal(value))),
})

const fail = (message: string) => Result.fail(new SystemAssessmentError({ message }))

export const verifyReplayContainer = (
  container: typeof ReplayContainerInspectionSchema.Type,
  image: typeof ImageInspectionSchema.Type,
  expected: {
    containerId: string
    manifestDigest: string
    imageDigest: string
    repository: string
    configDigest: string
    captureFileHash: string
    capturedAt: string
    policy: JevResearchPolicy
  },
) =>
  Result.gen(function* () {
    const state = container.State
    const same = (a: unknown, b: unknown) =>
      canonicalHashV1Result(a).pipe(
        Result.flatMap((hash) => canonicalHashV1Result(b).pipe(Result.map((other) => hash === other))),
      )
    if (
      container.Id !== expected.containerId ||
      ![expected.imageDigest, expected.manifestDigest].includes(container.Image) ||
      container.ImageManifestDescriptor.digest !== expected.manifestDigest ||
      image.Id !== expected.manifestDigest ||
      image.Descriptor.digest !== expected.manifestDigest ||
      ![
        container.Image,
        `${expected.repository}@${expected.imageDigest}`,
        `${expected.repository}@${expected.manifestDigest}`,
      ].includes(container.Config.Image) ||
      state.Status !== 'exited' ||
      state.Running ||
      state.Paused ||
      state.Restarting ||
      state.Dead ||
      state.OOMKilled ||
      state.ExitCode !== 0 ||
      state.Error !== '' ||
      container.RestartCount !== 0 ||
      intradayInstantNanos(container.Created) > intradayInstantNanos(state.StartedAt) ||
      intradayInstantNanos(state.StartedAt) > intradayInstantNanos(state.FinishedAt) ||
      intradayInstantNanos(state.FinishedAt) > intradayInstantNanos(expected.capturedAt)
    )
      return yield* fail(
        'Replay container has not exited successfully under the verified image without automatic restarts',
      )
    const command = [
      expected.policy === JevResearchPolicy.Deployed
        ? '/app/services/bayn/dist/frozen-control-command.js'
        : '/app/services/bayn/dist/backtest-command.js',
      '--input',
      '/evidence/input.json',
      '--arrivals',
      '/evidence/arrivals.ndjson.gz',
      '--source-receipt',
      '/evidence/source-receipt.json',
      '--source-receipt-sha256',
      expected.captureFileHash,
      '--output',
      '/result/run',
    ]
    if (
      !(yield* same(container.Config.Entrypoint, ['node'])) ||
      !(yield* same(container.Config.Cmd, command)) ||
      (container.Config.User ?? '') !== (image.Config.User ?? '') ||
      (container.Config.WorkingDir ?? '') !== (image.Config.WorkingDir ?? '') ||
      !(yield* same(container.Config.Healthcheck ?? null, image.Config.Healthcheck ?? null)) ||
      !container.HostConfig.ReadonlyRootfs ||
      container.HostConfig.Privileged ||
      container.HostConfig.CapDrop?.includes('ALL') !== true ||
      (container.HostConfig.CapAdd?.length ?? 0) !== 0 ||
      container.HostConfig.SecurityOpt?.some(
        (option) => option === 'no-new-privileges' || option === 'no-new-privileges=true',
      ) !== true ||
      container.HostConfig.RestartPolicy.Name !== 'no' ||
      Object.keys(container.HostConfig.Tmpfs ?? {}).length !== 0 ||
      container.Mounts.length !== 2 ||
      container.Mounts.some(
        (mount) =>
          mount.Type !== 'bind' ||
          !((mount.Destination === '/evidence' && !mount.RW) || (mount.Destination === '/result' && mount.RW)),
      ) ||
      new Set(container.Mounts.map((mount) => mount.Destination)).size !== 2
    )
      return yield* fail(
        'Replay container command, filesystem isolation or restart policy differs from the capture contract',
      )
    const environment = (entries: readonly string[] | null) =>
      Result.gen(function* () {
        const values = new Map<string, string>()
        for (const entry of entries ?? []) {
          const at = entry.indexOf('=')
          const key = entry.slice(0, at)
          if (at < 1 || values.has(key)) return yield* fail('Replay environment has malformed or duplicate keys')
          values.set(key, entry.slice(at + 1))
        }
        return values
      })
    const base = yield* environment(image.Config.Env)
    const actual = yield* environment(container.Config.Env)
    const allowed = [
      'TMPDIR',
      'BAYN_BACKTEST_POSTGRES_URL',
      'BAYN_BACKTEST_TIGERBEETLE_ADDRESS',
      'BAYN_BACKTEST_TIGERBEETLE_CLUSTER_ID',
      'BAYN_BACKTEST_TIGERBEETLE_LEDGER',
    ]
    if (
      allowed.some((name) => base.has(name)) ||
      actual.size !== base.size + allowed.length ||
      actual.get('TMPDIR') !== '/result' ||
      [...base].some(([key, value]) => actual.get(key) !== value) ||
      allowed.some((key) => !actual.has(key))
    )
      return yield* fail('Replay environment differs from its isolated database targets and result-directory scratch')
    return {
      postgresUrl: actual.get('BAYN_BACKTEST_POSTGRES_URL') ?? '',
      tigerBeetleAddress: actual.get('BAYN_BACKTEST_TIGERBEETLE_ADDRESS') ?? '',
      clusterId: actual.get('BAYN_BACKTEST_TIGERBEETLE_CLUSTER_ID') ?? '',
      ledger: actual.get('BAYN_BACKTEST_TIGERBEETLE_LEDGER') ?? '',
    }
  })

/** A trusted private observer reads the stopped container, rather than importing a caller's execution assertion. */
export const observeReplayExecution = (
  request: typeof CaptureReplayExecutionSchema.Type,
  registration: SystemRegistration,
  cut: SystemSourceCut,
) =>
  Effect.gen(function* () {
    if (
      request.registrationHash !== (yield* Effect.fromResult(canonicalHashV1Result(registration))) ||
      request.sourceCutHash !== (yield* Effect.fromResult(canonicalHashV1Result(cut))) ||
      cut.registrationHash !== request.registrationHash
    )
      return yield* new SystemAssessmentError({
        message: 'Replay execution capture differs from its retained registration and source cut',
      })
    const decode = <S extends Schema.Top>(schema: S, bytes: Uint8Array) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(new TextDecoder().decode(bytes)).pipe(
        Effect.mapError(
          (cause) =>
            new SystemAssessmentError({
              message: 'Captured replay JSON does not match its schema',
              cause: SchemaIssue.makeFormatterStandardSchemaV1({
                leafHook: (issue) => issue._tag,
                checkHook: () => 'Invalid constraint',
              })(cause.issue),
            }),
        ),
      )
    const inspect = () =>
      Effect.gen(function* () {
        const rows = yield* decode(
          Schema.Array(ReplayContainerInspectionSchema),
          yield* runReplayEvidenceCommand('docker', ['container', 'inspect', request.containerId]),
        )
        if (rows.length !== 1 || rows[0] === undefined)
          return yield* new SystemAssessmentError({ message: 'Replay container inspection is ambiguous' })
        return rows[0]
      })
    const before = yield* inspect()
    if (before.Id !== request.containerId || before.State.Status !== 'exited')
      return yield* new SystemAssessmentError({ message: 'Replay capture requires the exact stopped container' })
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'bayn-replay-capture-' })
    const copy = (source: string, name: string) =>
      Effect.gen(function* () {
        const destination = `${directory}/${name}`
        yield* runReplayEvidenceCommand('docker', ['cp', `${request.containerId}:${source}`, destination])
        return destination
      })
    const inputBytes = yield* fs.readFile(yield* copy('/evidence/input.json', 'input.json'))
    const captureBytes = yield* fs.readFile(yield* copy('/evidence/source-receipt.json', 'source-receipt.json'))
    const reportBytes = yield* fs.readFile(yield* copy('/result/run/report.json', 'report.json'))
    const wire = yield* decode(Schema.Union([BacktestInputSchema, FrozenControlReplaySchema]), inputBytes)
    const input = wire.schemaVersion === 'bayn.frozen-control-replay.v1' ? wire.backtest : wire
    const context = wire.latencyStress
    const policy = registration.policies.find((p) => p.policy === wire.policy)
    if (policy === undefined) return yield* new SystemAssessmentError({ message: 'Missing registered replay policy' })
    if (
      context === null ||
      (wire.schemaVersion !== 'bayn.frozen-control-replay.v1' && wire.inference.mode !== 'retained-responses') ||
      (yield* Effect.fromResult(canonicalHashV1Result(context.registration))) !== request.registrationHash ||
      (yield* Effect.fromResult(canonicalHashV1Result(context.sourceCut))) !== request.sourceCutHash
    )
      return yield* new SystemAssessmentError({
        message: 'Captured replay did not execute the exact retained-response stress registration',
      })
    const prepared =
      wire.schemaVersion === 'bayn.frozen-control-replay.v1'
        ? yield* Effect.fromResult(
            prepareFrozenControlReplay(wire, new TextDecoder().decode(captureBytes), sha256(captureBytes)),
          )
        : yield* Effect.fromResult(
            prepareBacktest(
              wire,
              yield* Effect.fromResult(
                validateBacktestSourceReceipt(new TextDecoder().decode(captureBytes), sha256(captureBytes)),
              ),
            ),
          )
    const report = yield* decode(
      Schema.Struct({
        schemaVersion: Schema.Literals(['bayn.backtest-report.v9', 'bayn.frozen-control-latency-report.v1']),
        runId: Sha256Schema,
        reportHash: Sha256Schema,
        executableSha256: Sha256Schema,
        passLog: Schema.Struct({ file: Schema.Literals(['passes.ndjson.gz', 'passes.ndjson']), sha256: Sha256Schema }),
      }),
      reportBytes,
    )
    const raw = yield* decode(Schema.Record(Schema.String, Schema.Unknown), reportBytes)
    const { reportHash: _hash, ...body } = raw
    if (
      report.reportHash !== (yield* Effect.fromResult(canonicalHashV1Result(body))) ||
      report.runId !== prepared.runId ||
      (wire.policy === JevResearchPolicy.Deployed
        ? report.schemaVersion !== 'bayn.frozen-control-latency-report.v1' || report.passLog.file !== 'passes.ndjson'
        : report.schemaVersion !== 'bayn.backtest-report.v9' || report.passLog.file !== 'passes.ndjson.gz')
    )
      return yield* new SystemAssessmentError({ message: 'Captured report hash or run differs from its input' })
    const image = yield* VerifiedReplayImage.inspect(
      policy,
      input.build.imageRepository,
      request.imagePlatform,
      report.executableSha256,
    )
    const images = yield* decode(
      Schema.Array(ImageInspectionSchema),
      yield* runReplayEvidenceCommand('docker', [
        'image',
        'inspect',
        '--platform',
        request.imagePlatform,
        before.Image,
      ]),
    )
    if (images.length !== 1 || images[0] === undefined)
      return yield* new SystemAssessmentError({ message: 'Replay image inspection is ambiguous' })
    const hashFile = (path: string) =>
      Effect.gen(function* () {
        const hash = createHash('sha256')
        yield* fs.stream(path).pipe(Stream.runForEach((chunk) => Effect.sync(() => hash.update(chunk))))
        return hash.digest('hex')
      })
    const arrivalsFileHash = yield* hashFile(yield* copy('/evidence/arrivals.ndjson.gz', 'arrivals.ndjson.gz'))
    const passLogFileHash = yield* hashFile(yield* copy(`/result/run/${report.passLog.file}`, report.passLog.file))
    const after = yield* inspect()
    if (
      (yield* Effect.fromResult(canonicalHashV1Result(before))) !==
        (yield* Effect.fromResult(canonicalHashV1Result(after))) ||
      arrivalsFileHash !== input.source.dataSha256 ||
      passLogFileHash !== report.passLog.sha256
    )
      return yield* new SystemAssessmentError({
        message: 'Replay container state or retained file identities changed during capture',
      })
    const capturedAt = DateTime.formatIso(yield* DateTime.now)
    const targets = yield* Effect.fromResult(
      verifyReplayContainer(after, images[0], {
        ...image.receipt,
        containerId: request.containerId,
        captureFileHash: sha256(captureBytes),
        capturedAt,
        policy: wire.policy,
      }),
    )
    const numbers = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        clusterId: Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/)),
        ledger: Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/)),
      }),
    )({ clusterId: targets.clusterId, ledger: targets.ledger })
    if (!Number.isSafeInteger(Number(numbers.ledger)) || Number(numbers.ledger) > 4294967295)
      return yield* new SystemAssessmentError({ message: 'Replay ledger exceeds the native unsigned 32-bit domain' })
    yield* validateReplayDatabaseTargets({
      operationTimeoutMs: 30000,
      postgres: { url: Redacted.make(targets.postgresUrl), tls: false, caPath: '/unused' },
      tigerBeetle: {
        clusterId: BigInt(numbers.clusterId),
        ledger: Number(numbers.ledger),
        replicaAddresses: [targets.tigerBeetleAddress],
      },
    })
    const daemon = yield* decode(
      Schema.Struct({ ID: Schema.String.check(Schema.isMinLength(1)) }),
      yield* runReplayEvidenceCommand('docker', ['info', '--format', '{{json .}}']),
    )
    const receipt = yield* Schema.decodeUnknownEffect(
      ReplayExecutionReceiptSchema,
      strictParseOptions,
    )({
      schemaVersion: 'bayn.replay-execution-receipt.v1',
      registrationHash: request.registrationHash,
      sourceCutHash: request.sourceCutHash,
      containerId: request.containerId,
      policyDefinitionHash: image.receipt.policyDefinitionHash,
      daemonIdentityHash: yield* Effect.fromResult(canonicalHashV1Result(daemon.ID)),
      inspectionHash: yield* Effect.fromResult(canonicalHashV1Result({ container: after, image: images[0] })),
      capturedAt,
      startedAt: after.State.StartedAt,
      finishedAt: after.State.FinishedAt,
      runId: prepared.runId,
      inputFileHash: sha256(inputBytes),
      captureFileHash: sha256(captureBytes),
      arrivalsFileHash,
      reportFileHash: sha256(reportBytes),
      reportHash: report.reportHash,
      passLogFileHash,
      image: image.receipt,
      assurance: 'TRUSTED_CONTAINER_DAEMON_OBSERVATION',
      assumptions: replayExecutionAssumptions,
    })
    return receipt
  }).pipe(
    Effect.scoped,
    Effect.timeout('10 minutes'),
    Effect.mapError((cause) => new SystemAssessmentError({ message: 'Replay execution capture failed', cause })),
  )

export const captureReplayExecution = (
  request: typeof CaptureReplayExecutionSchema.Type,
  registration: SystemRegistration,
  cut: SystemSourceCut,
) =>
  Effect.gen(function* () {
    const receipt = yield* observeReplayExecution(request, registration, cut)
    const receiptHash = yield* Effect.fromResult(canonicalHashV1Result(receipt))
    const text = yield* Effect.fromResult(canonicalJsonV1Result(receipt))
    const sql = yield* PgClient.PgClient
    yield* sql`INSERT INTO system_replay_execution_receipts(receipt_hash, registration_hash, source_cut_hash, container_id, report_file_hash, payload_text)
    VALUES (${receiptHash}, ${receipt.registrationHash}, ${receipt.sourceCutHash}, ${receipt.containerId}, ${receipt.reportFileHash}, ${text})
    ON CONFLICT (receipt_hash) DO NOTHING`
    return { receiptHash, receipt }
  })

export const readReplayExecutionReceipt = (hash: string) =>
  Effect.gen(function* () {
    const receiptHash = yield* Schema.decodeUnknownEffect(Sha256Schema)(hash)
    const sql = yield* PgClient.PgClient
    const rows = yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ payload: ReplayExecutionReceiptSchema })),
    )(
      yield* sql`SELECT payload_text::jsonb AS payload FROM system_replay_execution_receipts WHERE receipt_hash = ${receiptHash}`,
    )
    const receipt = rows[0]?.payload
    if (receipt === undefined || (yield* Effect.fromResult(canonicalHashV1Result(receipt))) !== receiptHash)
      return yield* new SystemAssessmentError({
        message: 'Retained replay execution receipt is missing or differs from its hash',
      })
    return receipt
  })

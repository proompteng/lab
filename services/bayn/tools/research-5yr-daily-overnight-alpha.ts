import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { S3Client } from 'bun'
import { Config, Data, Effect, FileSystem, Redacted, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'

import { objectKey, readTape, sha256, tapeHash, universes } from './daily-alpha-data'
import { type Development, develop, encodeLedger, makeLedger, scoreHoldout } from './daily-alpha-study'

const root = resolve(import.meta.dir, '../../..')
const evidence = 'docs/bayn/evidence/2026-11-27-5yr-daily-overnight-alpha'
const frozenPath = `${evidence}/freeze.json`
const ledgerPath = `${evidence}/results.json`
const fingerprinted = [
  'daily-alpha-data.ts',
  'daily-alpha-metrics.ts',
  'daily-alpha-replay.ts',
  'daily-alpha-signals.ts',
  'daily-alpha-study.ts',
  'midday-research-statistics.ts',
  'research-5yr-daily-overnight-alpha.ts',
]

class DailyAlphaResearchError extends Data.TaggedError('DailyAlphaResearchError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

const step = <A>(message: string, tryRun: () => A) =>
  Effect.try({ try: tryRun, catch: (cause) => new DailyAlphaResearchError({ message, cause }) })

const receipt = (development: Development, ledger: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const protocol = yield* fs.readFile(join(root, evidence, 'protocol.md'))
    const source = yield* Effect.forEach(fingerprinted, (name) =>
      fs.readFile(join(import.meta.dir, name)).pipe(Effect.map((bytes) => [name, sha256(bytes)])),
    )
    return `${JSON.stringify(
      {
        type: 'bayn.daily-overnight-freeze.v1',
        objectKey,
        tapeSha256: tapeHash,
        protocolSha256: sha256(protocol),
        engineSha256: sha256(JSON.stringify([universes, ...source])),
        developmentLedgerSha256: sha256(ledger),
        ...development.selection,
      },
      null,
      2,
    )}\n`
  })

const git = (args: readonly string[]) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const child = yield* spawner.spawn(ChildProcess.make('git', args, { cwd: root, stdin: 'ignore' }))
    const [stdout, stderr, exit] = yield* Effect.all(
      [
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        child.exitCode,
      ],
      { concurrency: 'unbounded' },
    )
    if (Number(exit) !== 0) {
      return yield* new DailyAlphaResearchError({
        message: 'Git could not verify the committed freeze',
        cause: stderr.trim(),
      })
    }
    return stdout
  }).pipe(Effect.scoped)

interface DevelopmentBytes {
  frozen: string
  ledger: string
}
interface CommittedFreeze extends DevelopmentBytes {
  commit: string
  scoredLedger?: string
}

const committedFreeze = (requestedCommit: string | undefined) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const commits =
      requestedCommit === undefined
        ? (yield* git(['log', '--format=%H', '--diff-filter=A', '--', frozenPath])).trim().split('\n')
        : [requestedCommit]
    const [commit] = commits
    if (commits.length !== 1 || !/^[0-9a-f]{40}$/.test(commit)) {
      return yield* new DailyAlphaResearchError({
        message: 'Commit exactly one development-only freeze.json and results.json before opening Holdout',
      })
    }
    const frozen = yield* git(['show', `${commit}:${frozenPath}`])
    const currentFreeze = yield* fs.readFileString(join(root, frozenPath))
    if (frozen !== currentFreeze) {
      return yield* new DailyAlphaResearchError({ message: 'Working freeze.json differs from the committed freeze' })
    }
    const ledger = yield* git(['show', `${commit}:${ledgerPath}`])
    const current = yield* git(['show', `HEAD:${ledgerPath}`])
    if (current === ledger) return { commit, frozen, ledger } satisfies CommittedFreeze

    const recorded = yield* step('Parse the committed results.json', (): unknown => JSON.parse(current))
    if (
      typeof recorded !== 'object' ||
      recorded === null ||
      !('stage' in recorded) ||
      recorded.stage !== 'scored' ||
      !('freezeCommit' in recorded) ||
      recorded.freezeCommit !== commit
    ) {
      return yield* new DailyAlphaResearchError({
        message: 'Committed results.json is neither the frozen development ledger nor its scored result',
      })
    }
    return { commit, frozen, ledger, scoredLedger: current } satisfies CommittedFreeze
  })

const withoutEngineHash = (receipt: string) => receipt.replace(/^  "engineSha256": "[a-f0-9]{64}",\n/m, '')

export function verifyReproducedFreeze(
  committed: DevelopmentBytes & { scoredLedger?: string },
  reproduced: DevelopmentBytes,
) {
  // Never open a new holdout with a different engine. Once a result exists in Git, allow only
  // a read-only audit: every development byte and every previously scored byte must still agree.
  const sameReceipt =
    committed.frozen === reproduced.frozen ||
    (committed.scoredLedger !== undefined &&
      withoutEngineHash(committed.frozen) === withoutEngineHash(reproduced.frozen))
  if (!sameReceipt || committed.ledger !== reproduced.ledger) {
    throw new Error('Development replay changed since freeze; refusing to open Holdout')
  }
}

export function verifyReproducedScore(committed: string, reproduced: string) {
  if (committed !== reproduced)
    throw new Error('Holdout replay differs from the committed result; no artifacts written')
}

// Bun's S3 body methods don't accept AbortSignal. Use the SDK for signing and abortable fetch for transport.
export const downloadTape = (
  client: Pick<S3Client, 'presign'>,
  request: (url: string, options: RequestInit) => Promise<Response> = fetch,
) =>
  Effect.gen(function* () {
    const message = 'Download the frozen SIP gzip'
    const result = yield* Effect.tryPromise({
      try: async (signal) => {
        const url = client.presign(objectKey, { expiresIn: 60 })
        const response = await request(url, { signal, redirect: 'error' })
        if (!response.ok) {
          await response.body?.cancel()
          return { status: response.status, bytes: null }
        }
        return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) }
      },
      catch: (cause) =>
        new DailyAlphaResearchError({
          message,
          // Transport errors can include the signed URL. Keep the error kind, not its message.
          cause: cause instanceof Error ? cause.name : 'Transport failure',
        }),
    })
    if (result.bytes === null) return yield* new DailyAlphaResearchError({ message, cause: `HTTP ${result.status}` })
    return result.bytes
  }).pipe(Effect.timeout('60 seconds'))

const loadTape = (path: string | undefined) =>
  Effect.gen(function* () {
    if (path !== undefined) {
      const fs = yield* FileSystem.FileSystem
      return yield* fs.readFile(path)
    }
    const config = yield* Config.all({
      endpoint: Config.String('AGENTS_ARTIFACTS_ENDPOINT').pipe(Config.withDefault('')),
      bucket: Config.String('AGENTS_ARTIFACTS_BUCKET').pipe(Config.withDefault('')),
      accessKeyId: Config.Redacted('AWS_ACCESS_KEY_ID'),
      secretAccessKey: Config.Redacted('AWS_SECRET_ACCESS_KEY'),
    })
    const client = yield* step('Mount the agents-artifacts secret or supply the pinned gzip with --input', () => {
      const accessKeyId = Redacted.value(config.accessKeyId)
      const secretAccessKey = Redacted.value(config.secretAccessKey)
      if (accessKeyId === '' || secretAccessKey === '') throw new Error('Frozen artifact credentials are empty')
      return new S3Client({
        endpoint: config.endpoint === '' ? 'http://rook-ceph-rgw-objectstore.rook-ceph.svc:80' : config.endpoint,
        bucket: config.bucket === '' ? 'agents-artifacts' : config.bucket,
        accessKeyId,
        secretAccessKey,
        region: 'us-east-1',
      })
    })
    return yield* downloadTape(client)
  })

const run = (args: readonly string[]) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const {
      values: { freeze, score, input, 'freeze-commit': freezeCommit },
    } = yield* step('Read the study options', () =>
      parseArgs({
        args,
        options: {
          freeze: { type: 'boolean' },
          score: { type: 'boolean' },
          input: { type: 'string' },
          'freeze-commit': { type: 'string' },
        },
      }),
    )
    if (Boolean(freeze) === Boolean(score) || (freeze === true && freezeCommit !== undefined)) {
      return yield* new DailyAlphaResearchError({
        message:
          'Usage: bun services/bayn/tools/research-5yr-daily-overnight-alpha.ts (--freeze | --score) [--input pinned.tsv.gz] [--freeze-commit SHA]',
      })
    }
    if (freeze === true && (yield* fs.exists(join(root, frozenPath)))) {
      return yield* new DailyAlphaResearchError({ message: 'Refusing to overwrite an existing freeze receipt' })
    }
    const committed: CommittedFreeze | undefined = score === true ? yield* committedFreeze(freezeCommit) : undefined
    const bytes = yield* loadTape(input)
    const developmentTape = yield* step('Open the development window', () => readTape(bytes, 'freeze'))
    const development = yield* step('Replay the development grid', () => develop(developmentTape))
    const ledger = encodeLedger(makeLedger(developmentTape, development))
    const frozen = yield* receipt(development, ledger)
    if (committed === undefined) {
      yield* fs.writeFileString(join(root, ledgerPath), ledger, { flag: 'wx' })
      yield* fs.writeFileString(join(root, frozenPath), frozen, { flag: 'wx' })
      yield* Effect.logInfo(
        `Froze ${development.selection.finalists.length} development finalists from ${development.selection.trialCount} registered trials`,
      )
      return
    }
    yield* step('Verify the committed development freeze', () => verifyReproducedFreeze(committed, { frozen, ledger }))
    const scored = yield* step('Replay the registered Frozen Holdout', () => {
      const tape = readTape(bytes, 'score')
      return makeLedger(tape, development, scoreHoldout(tape, development))
    })
    const scoredLedger = encodeLedger({ ...scored, freezeCommit: committed.commit })
    const recorded = committed.scoredLedger
    if (recorded === undefined) yield* fs.writeFileString(join(root, ledgerPath), scoredLedger)
    else yield* step('Verify the committed Holdout result', () => verifyReproducedScore(recorded, scoredLedger))
    yield* Effect.logInfo(
      `${recorded === undefined ? 'Scored' : 'Reproduced'} ${development.selection.holdoutIds.length} frozen evaluations; ${scored.accepted.length} passed every gate`,
    )
  })

if (import.meta.main) {
  NodeRuntime.runMain(
    run(process.argv.slice(2)).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- the research entry point owns file and process services
      Effect.provide(NodeServices.layer),
    ),
  )
}

import { fileURLToPath } from 'node:url'

import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { S3Client } from 'bun'
import { Config, Data, Effect, FileSystem, Redacted } from 'effect'

import { dataName, decodeManifest, loadTape, manifestSha, prefix, sha256 } from './sp100-alpha-data'
import { assetClasses, splits } from './sp100-alpha-protocol'
import { develop, score } from './sp100-alpha-study'

const evidence = 'docs/bayn/evidence/2026-11-27-10yr-sp100-alpha'
const root = new URL('../../../', import.meta.url)
const files = [
  'services/bayn/tools/research-10yr-sp100-alpha.ts',
  'services/bayn/tools/sp100-alpha-data.ts',
  'services/bayn/tools/sp100-alpha-protocol.ts',
  'services/bayn/tools/sp100-alpha-replay.ts',
  'services/bayn/tools/sp100-alpha-signals.ts',
  'services/bayn/tools/sp100-alpha-study.ts',
  'services/bayn/tools/midday-research-statistics.ts',
  `${evidence}/PROTOCOL.md`,
]
const freezePath = `${evidence}/freeze.json`
const ledgerPath = `${evidence}/development.jsonl`
const resultsPath = `${evidence}/results.json`
const path = (relative: string) => fileURLToPath(new URL(relative, root))
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n'

class ResearchError extends Data.TaggedError('Sp100AlphaEvidenceError')<{ operation: string; cause: unknown }> {}
const checked = <T>(operation: string, run: () => T) =>
  Effect.try({ try: run, catch: (cause) => new ResearchError({ operation, cause }) })

export function argumentsFor(args: string[]) {
  const [stage, option, input, ...extra] = args
  if (
    (stage !== '--freeze' && stage !== '--score') ||
    extra.length > 0 ||
    (option !== undefined && (option !== '--input-dir' || input === undefined || input.startsWith('--')))
  )
    throw new Error('Usage: research-10yr-sp100-alpha.ts (--freeze | --score) [--input-dir PATH]')
  return { stage, input }
}

const inputs = (local?: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    if (local !== undefined) {
      return {
        manifest: yield* fs.readFile(`${local}/MANIFEST.json`),
        gzip: yield* fs.readFile(`${local}/${dataName}`),
      }
    }
    const endpoint = yield* Config.string('AGENTS_ARTIFACTS_ENDPOINT').pipe(
      Config.withDefault('http://rook-ceph-rgw-objectstore.rook-ceph.svc:80'),
    )
    const bucket = yield* Config.string('AGENTS_ARTIFACTS_BUCKET').pipe(Config.withDefault('agents-artifacts'))
    const access = yield* Config.redacted('AWS_ACCESS_KEY_ID')
    const secret = yield* Config.redacted('AWS_SECRET_ACCESS_KEY')
    const s3 = new S3Client({
      endpoint,
      bucket,
      region: 'us-east-1',
      accessKeyId: Redacted.value(access),
      secretAccessKey: Redacted.value(secret),
    })
    const fetchObject = (name: string) =>
      Effect.tryPromise({
        try: async (signal) => {
          const response = await fetch(s3.presign(`${prefix}/${name}`, { expiresIn: 300 }), {
            signal,
            redirect: 'error',
          })
          if (!response.ok) throw new Error(`S3 GET ${name}: HTTP ${response.status}`)
          return new Uint8Array(await response.arrayBuffer())
        },
        // Presigned URLs contain credential material; do not propagate transport exceptions with request URLs.
        catch: () => new ResearchError({ operation: `Read frozen S3 object ${name}`, cause: 'Request failed' }),
      })
    return { manifest: yield* fetchObject('MANIFEST.json'), gzip: yield* fetchObject(dataName) }
  })

const git = (args: string[]) => {
  const result = Bun.spawnSync(['git', ...args], { cwd: path('.') })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString().trim()}`)
  return result.stdout.toString()
}

function committedReceipt(receipt: string, ledger: string) {
  if (git(['show', `HEAD:${freezePath}`]) !== receipt || git(['show', `HEAD:${ledgerPath}`]) !== ledger) {
    throw new Error('Commit the reproduced development receipt and ledger before scoring')
  }
  const commit = git(['log', '-1', '--format=%H', '--', freezePath]).trim()
  if (!/^[0-9a-f]{40}$/.test(commit) || git(['show', `${commit}:${ledgerPath}`]) !== ledger) {
    throw new Error('Receipt and development ledger must be committed together')
  }
  return commit
}

const research = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const { stage, input } = yield* checked('Read CLI arguments', () => argumentsFor(process.argv.slice(2)))
  if (yield* fs.exists(path(resultsPath))) {
    return yield* new ResearchError({
      operation: stage,
      cause: 'Frozen results already exist; do not reopen the Holdout',
    })
  }
  const expected =
    stage === '--score'
      ? {
          receipt: yield* fs.readFileString(path(freezePath)),
          ledger: yield* fs.readFileString(path(ledgerPath)),
        }
      : null
  const sources = Object.fromEntries(
    yield* Effect.forEach(files, (file) =>
      fs.readFile(path(file)).pipe(Effect.map((bytes) => [file, sha256(bytes)] as const)),
    ),
  )
  if (expected === null) {
    if ((yield* fs.exists(path(freezePath))) || (yield* fs.exists(path(ledgerPath)))) {
      return yield* new ResearchError({ operation: stage, cause: 'Development receipt or ledger already exists' })
    }
    yield* checked('Require a committed protocol and engine before development', () => {
      for (const [file, hash] of Object.entries(sources)) {
        if (sha256(git(['show', `HEAD:${file}`])) !== hash) throw new Error(`Commit protocol source first: ${file}`)
      }
    })
  }
  const source = yield* inputs(input)
  const manifest = yield* checked('Verify frozen S3 manifest', () => decodeManifest(source.manifest))
  const tape = yield* checked('Read development bars through 2023 only', () =>
    loadTape(manifest, source.gzip, splits.validation[1], assetClasses),
  )
  const frozen = yield* checked('Evaluate all development trials', () => develop(tape))
  const { ledger, grid, ...selection } = frozen
  const trialSpecs = new Map(grid.map((trial) => [trial.id, trial]))
  const ledgerText = ledger.map((row) => JSON.stringify({ trial: trialSpecs.get(row.id), ...row })).join('\n') + '\n'
  const receipt = json({
    schema: 'bayn.sp100-alpha.freeze.v1',
    manifestSha256: manifestSha,
    sourceGzipSha256: manifest.files[0].gzipSha256,
    sources,
    developmentLedgerSha256: sha256(ledgerText),
    ...selection,
  })
  if (expected === null) {
    yield* fs.writeFileString(path(ledgerPath), ledgerText)
    yield* fs.writeFileString(path(freezePath), receipt)
    yield* Effect.logInfo(`Development frozen: ${frozen.trials} trials; commit receipt and ledger before --score`)
    return
  }

  const commit = yield* checked('Verify committed pre-Holdout freeze', () => {
    if (receipt !== expected.receipt || ledgerText !== expected.ledger)
      throw new Error('Development freeze did not reproduce')
    return committedReceipt(receipt, ledgerText)
  })
  const results = yield* checked('Score only frozen finalists and probes', () => {
    const full = loadTape(manifest, source.gzip, splits.holdout[1], assetClasses)
    return score(full, frozen)
  })
  yield* fs.writeFileString(
    path(resultsPath),
    json({
      schema: 'bayn.sp100-alpha.results.v1',
      freezeCommit: commit,
      freezeSha256: sha256(receipt),
      ...results,
    }),
    { flag: 'wx' },
  )
  yield* Effect.logInfo(
    `Frozen Holdout scored: ${results.passed.length} of ${results.results.length} candidates passed`,
  )
})

if (import.meta.main) NodeRuntime.runMain(research.pipe(Effect.provide(NodeServices.layer)))

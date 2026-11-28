import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

import { NodeRuntime } from '@effect/platform-node'
import { Data, Effect, Schema } from 'effect'

import { decodeUniverse, filename, gzipSha256, manifestSha256, readTape, sha256, splits } from './clean-factors-data'
import { priorTrials } from './clean-factors-grid'
import { bootstrapBlockMean, resamples } from './clean-factors-metrics'
import { develop, score } from './clean-factors-study'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const evidence = 'docs/bayn/evidence/2026-11-27-10yr-sp100-clean-factors'
const branch = 'refs/heads/codex/bayn-w4i-10yr-sp100-clean-factors'
const freezePath = `${evidence}/freeze.json`
const resultsPath = `${evidence}/results.json`
const sources = [
  ...['data', 'grid', 'signals', 'replay', 'metrics', 'study'].map(
    (name) => `services/bayn/tools/clean-factors-${name}.ts`,
  ),
  'services/bayn/tools/research-10yr-sp100-clean-factors.ts',
  'services/bayn/tools/midday-research-statistics.ts',
  `${evidence}/protocol.md`,
]

const pretty = (value: unknown) => JSON.stringify(value, null, 2) + '\n'
const FreezeIdentity = Schema.Struct({ protocolCommit: Schema.String })

export function parseArgs(args: readonly string[]) {
  const [mode, inputFlag, inputDir, ...rest] = args
  if (
    (mode !== '--freeze' && mode !== '--score') ||
    inputFlag !== '--input-dir' ||
    inputDir === undefined ||
    inputDir === '' ||
    rest.length > 0
  ) {
    throw new Error('Usage: research-10yr-sp100-clean-factors.ts (--freeze | --score) --input-dir <dataset directory>')
  }
  return { mode, inputDir }
}

function git(...args: string[]) {
  const result = Bun.spawnSync(['git', ...args], { cwd: root })
  if (!result.success) throw new Error(`git ${args[0]} failed: ${result.stderr.toString().trim()}`)
  return result.stdout.toString()
}

function remoteHead() {
  const origin = git('remote', 'get-url', 'origin').trim()
  if (!['https://github.com/proompteng/lab.git', 'git@github.com:proompteng/lab.git'].includes(origin)) {
    throw new Error('Expected the proompteng/lab origin')
  }
  const [commit, ref] = git('ls-remote', '--exit-code', 'origin', branch).trim().split('\t')
  if (ref !== branch || !/^[a-f0-9]{40}$/.test(commit)) throw new Error('Registered remote head is unavailable')
  return commit
}

class StudyFailure extends Data.TaggedError('CleanFactorsStudyFailure')<{ cause: unknown }> {}

async function run(args: readonly string[], signal: AbortSignal) {
  const { mode, inputDir } = parseArgs(args)
  const published = remoteHead()
  const freezeFile = join(root, freezePath)
  const resultsFile = join(root, resultsPath)
  if (git('ls-tree', published, '--', resultsPath).trim() !== '' || (await Bun.file(resultsFile).exists())) {
    throw new Error('Holdout has already been scored')
  }

  const sealed = mode === '--score' ? git('show', `${published}:${freezePath}`) : undefined
  const protocolCommit =
    sealed === undefined ? published : Schema.decodeUnknownSync(FreezeIdentity)(JSON.parse(sealed)).protocolCommit
  if (!/^[a-f0-9]{40}$/.test(protocolCommit)) throw new Error('Invalid protocol registration commit')
  git('merge-base', '--is-ancestor', protocolCommit, published)
  const sourceHashes = Object.fromEntries(
    await Promise.all(
      sources.map(async (path) => {
        const bytes = await readFile(join(root, path), { signal })
        const hash = sha256(bytes)
        if (
          hash !== sha256(git('show', `${protocolCommit}:${path}`)) ||
          hash !== sha256(git('show', `${published}:${path}`))
        ) {
          throw new Error(`Protocol source differs from the published registration: ${path}`)
        }
        return [path, hash]
      }),
    ),
  )

  const manifest = await readFile(join(inputDir, 'MANIFEST.json'), { signal, encoding: 'utf8' })
  const compressed = await readFile(join(inputDir, filename), { signal })
  if (sha256(compressed) !== gzipSha256) throw new Error('Unregistered SIP archive checksum')
  const universe = decodeUniverse(manifest)
  const raw = gunzipSync(compressed).toString('utf8')
  const development = readTape(raw, universe, splits.validation[1])
  if (development.sourceRows !== 330_646 || development.tape.dates.length !== 2_012) {
    throw new Error('Development tape counts differ from registration')
  }
  const { ledger, ...frozen } = develop(development.tape)
  const receipt = {
    schema: 'bayn.clean-sp100-factors.freeze.v1',
    protocolCommit,
    bunVersion: Bun.version,
    manifestSha256,
    gzipSha256,
    sourceHashes,
    development: {
      through: splits.validation[1],
      sourceRows: development.sourceRows,
      excludedMmcRows: development.mmcRows,
      sessions: development.tape.dates.length,
      ledgerSha256: sha256(JSON.stringify(ledger)),
    },
    trials: { wave3A: priorTrials, wave4I: frozen.grid.length, cumulative: priorTrials + frozen.grid.length },
    ...frozen,
  }
  if (mode === '--freeze') {
    await writeFile(freezeFile, pretty(receipt), { flag: 'wx', signal })
    return `Frozen ${frozen.grid.length} trials and ${frozen.candidates.length} finalist slots, Train and Validation only`
  }

  if (sealed !== pretty(receipt) || sealed !== (await readFile(freezeFile, { signal, encoding: 'utf8' }))) {
    throw new Error('Development does not reproduce the pushed freeze receipt byte for byte')
  }
  // This marker is acquired before the parser admits any Holdout bars. An interrupted score must not retry silently.
  const lock = `${resultsFile}.lock`
  const identity = { remoteFreezeCommit: published, freezeSha256: sha256(sealed) }
  await writeFile(lock, pretty(identity), { flag: 'wx', signal })
  const all = readTape(raw, universe, splits.holdout[1])
  if (all.sourceRows !== 450_712 || all.tape.dates.length !== 2_741)
    throw new Error('Frozen tape counts differ from registration')
  const finalists = score(all.tape, frozen)
  const result = {
    schema: 'bayn.clean-sp100-factors.results.v1',
    freeze: identity,
    tape: {
      splits,
      sourceRows: all.sourceRows,
      excludedMmcRows: all.mmcRows,
      sessions: all.tape.dates.length,
      coverage: all.coverage,
    },
    inference: { resamples, bootstrapBlockMean, trials: receipt.trials },
    finalists,
    developmentLedger: ledger,
  }
  // Write outside the published result path, then atomically finalize the one-shot marker.
  await writeFile(lock, JSON.stringify(result) + '\n', { signal })
  await rename(lock, resultsFile)
  return `Scored ${finalists.length} frozen slots; ${finalists.filter((f) => f.passesResearchGates).length} passed research gates`
}

if (import.meta.main) {
  NodeRuntime.runMain(
    Effect.tryPromise({
      try: (signal) => run(Bun.argv.slice(2), signal),
      catch: (cause) => new StudyFailure({ cause }),
    }).pipe(Effect.flatMap(Effect.logInfo)),
  )
}

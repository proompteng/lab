import { execFile } from 'node:child_process'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, FileSystem } from 'effect'

import { sha256 } from './research-orb-zab-data'
import { loadTape, SipResearchError } from './research-sip-momentum-data'
import { prepare } from './research-sip-momentum-replay'
import { canonical, development, precision, requireFreezeMatch, score } from './research-sip-momentum-study'

const protocolPath = '../../../docs/bayn/evidence/2026-11-27-3yr-sip-62sym-rvol-orb-etf/PROTOCOL.md'
const sourcePaths = [
  './research-3yr-sip-62sym-rvol-orb-etf.ts',
  './research-sip-momentum-data.ts',
  './research-sip-momentum-protocol.ts',
  './research-sip-momentum-replay.ts',
  './research-sip-momentum-statistics.ts',
  './research-sip-momentum-study.ts',
  './research-orb-zab-data.ts',
  './research-orb-zab-statistics.ts',
  '../src/broker/alpaca/model.ts',
  '../src/broker/alpaca/normalizers.ts',
  '../src/equity-hours.ts',
  '../../../bun.lock',
  protocolPath,
]

const freeze = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const sources = yield* Effect.forEach(sourcePaths, (path) =>
    fs
      .readFile(fileURLToPath(new URL(path, import.meta.url)))
      .pipe(Effect.map((file) => [path, sha256(file)] as const)),
  )
  const { days, provenance, coverage } = yield* loadTape(false)
  return {
    schemaVersion: 'bayn.sip-momentum-wave2d.freeze.v1',
    sources: Object.fromEntries(sources),
    provenance,
    coverage,
    development: development(prepare(days)),
  }
})

const git = promisify(execFile)
const repo = fileURLToPath(new URL('../../../', import.meta.url))

const checkCommittedFreeze = (path: string, stored: string) =>
  Effect.tryPromise({
    try: async (signal) => {
      const name = relative(repo, resolve(path))
      if (name.length === 0 || isAbsolute(name) || name === '..' || name.startsWith(`..${sep}`)) {
        throw new Error('Freeze receipt must be committed in this repository')
      }
      const { stdout } = await git('git', ['show', `HEAD:${name}`], { cwd: repo, signal })
      if (stdout !== stored) throw new Error('Working freeze receipt differs from the committed bytes')
      const { stdout: revision } = await git('git', ['log', '-1', '--format=%H', '--', name], { cwd: repo, signal })
      const commit = revision.trim()
      if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('No Git revision for freeze receipt')
      return commit
    },
    catch: (cause) => new SipResearchError({ message: 'Score requires a matching, committed freeze receipt', cause }),
  })

const run = (args: readonly string[]) =>
  Effect.gen(function* () {
    const [mode, freezePath, reportPath] = args
    if (
      freezePath === undefined ||
      (mode === '--freeze' ? args.length !== 2 : mode !== '--score' || args.length !== 3 || reportPath === undefined)
    ) {
      return yield* new SipResearchError({
        message: 'Usage: --freeze <new-freeze.json> | --score <committed-freeze.json> <new-results.json>',
      })
    }
    const output = reportPath ?? freezePath
    const fs = yield* FileSystem.FileSystem
    if (yield* fs.exists(output)) return yield* new SipResearchError({ message: 'Output already exists' })
    const receipt = yield* freeze
    const write = (value: unknown, compact: boolean) =>
      fs.writeFileString(
        output,
        JSON.stringify(value, compact ? precision : undefined, compact ? undefined : 2) + '\n',
        { flag: 'wx', mode: 0o600 },
      )
    if (mode === '--freeze') return yield* write(receipt, false)
    const stored = yield* fs.readFileString(freezePath)
    const freezeCommit = yield* checkCommittedFreeze(freezePath, stored)
    yield* Effect.try({
      try: () => requireFreezeMatch(JSON.parse(stored), receipt),
      catch: (cause) => new SipResearchError({ message: 'Invalid freeze receipt', cause }),
    })
    const { days, provenance, coverage } = yield* loadTape(true)
    const results = score(prepare(days), receipt.development)
    return yield* write(
      {
        schemaVersion: 'bayn.sip-momentum-wave2d.results.v1',
        purpose: 'Retrospective bar-model research, not broker or capital authority',
        freezeSha256: sha256(canonical(receipt)),
        freezeCommit,
        provenance,
        coverage,
        ...results,
      },
      true,
    )
  })

if (import.meta.main) {
  NodeRuntime.runMain(
    run(process.argv.slice(2)).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- offline CLI owns its platform boundary
      Effect.provide(NodeServices.layer),
    ),
  )
}

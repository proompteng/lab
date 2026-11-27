import { NodeServices, NodeRuntime } from '@effect/platform-node'
import { Data, Effect, FileSystem } from 'effect'

import { loadDataset, sha256 } from './multi-asset-risk-premia-data'
import { splits } from './multi-asset-risk-premia-protocol'
import { freezeStudy, scoreStudy } from './multi-asset-risk-premia-study'

const dir = 'docs/bayn/evidence/2026-11-27-10yr-multi-asset-risk-premia'
const freezePath = `${dir}/freeze.json`
const protocolPath = `${dir}/protocol.md`
const resultsPath = `${dir}/results.json`
const cohort = 'bayn.multi-asset-risk-premia.wave-3c.v1'
const runnerPaths = [
  'multi-asset-risk-premia-data.ts',
  'multi-asset-risk-premia-protocol.ts',
  'multi-asset-risk-premia-replay.ts',
  'multi-asset-risk-premia-signals.ts',
  'multi-asset-risk-premia-statistics.ts',
  'multi-asset-risk-premia-study.ts',
  'research-10yr-multi-asset-risk-premia.ts',
  'research-orb-zab-statistics.ts',
  'research-orb-zab-protocol.ts',
].map((name) => `services/bayn/tools/${name}`)
const inputs = [protocolPath, ...runnerPaths]
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

class ResearchError extends Data.TaggedError('MultiAssetResearchError')<{ readonly cause: unknown }> {}

const git = (...args: string[]) =>
  Effect.try({
    try: () => {
      const process = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' })
      if (!process.success) throw new Error(`git ${args.join(' ')}: ${process.stderr.toString().trim()}`)
      return process.stdout.toString()
    },
    catch: (cause) => new ResearchError({ cause }),
  })

export const stageFromArgs = (args: readonly string[]) => {
  if (args.length !== 1 || (args[0] !== '--freeze' && args[0] !== '--score')) {
    throw new Error(
      'Usage (from repo root): bun services/bayn/tools/research-10yr-multi-asset-risk-premia.ts --freeze|--score',
    )
  }
  return args[0] === '--freeze' ? 'freeze' : 'score'
}

export const verifyFreeze = (worktree: string, committed: string, reproduced: string) => {
  if (worktree !== committed) throw new Error('Freeze receipt must match a committed file')
  if (committed !== reproduced) throw new Error('Committed receipt does not reproduce from development-only data')
}

const program = Effect.gen(function* () {
  const stage = yield* Effect.try({
    try: () => stageFromArgs(Bun.argv.slice(2)),
    catch: (cause) => new ResearchError({ cause }),
  })
  const fs = yield* FileSystem.FileSystem
  const head = (yield* git('rev-parse', 'HEAD')).trim()
  const status = yield* git('status', '--porcelain', '--', ...inputs)
  if (status !== '')
    return yield* new ResearchError({ cause: 'Commit the protocol and runner before opening the research dataset.' })
  const inputTexts = yield* Effect.forEach(inputs, (path) => fs.readFileString(path))
  const fingerprint = sha256(json(inputs.map((path, i) => ({ path, sha256: sha256(inputTexts[i]) }))))
  if (stage === 'freeze' && (yield* fs.exists(freezePath))) {
    return yield* new ResearchError({ cause: 'Refusing to replace the freeze receipt.' })
  }
  const receipt = stage === 'score' ? yield* fs.readFileString(freezePath) : undefined
  const freezeCommit =
    stage === 'score' ? (yield* git('log', '--format=%H', '--diff-filter=A', '--', freezePath)).trim() : undefined
  const committed =
    freezeCommit !== undefined && freezeCommit !== '' ? yield* git('show', `${freezeCommit}:${freezePath}`) : undefined
  if (stage === 'score' && (committed === undefined || receipt !== committed)) {
    return yield* new ResearchError({ cause: 'Commit the unmodified freeze receipt before opening Holdout.' })
  }
  const { sessions: development, data } = yield* loadDataset('freeze')
  const study = yield* Effect.try({
    try: () => freezeStudy(development),
    catch: (cause) => new ResearchError({ cause }),
  })
  const frozen = json({
    cohort,
    fingerprint,
    data,
    splits: { train: splits.train, validation: splits.validation },
    study,
  })
  if (stage === 'freeze') {
    yield* fs.writeFileString(freezePath, frozen, { flag: 'wx' })
    yield* Effect.log(`Wrote development-only receipt for ${head}; commit before --score.`)
    return
  }
  if (receipt === undefined || committed === undefined)
    return yield* new ResearchError({ cause: 'Freeze receipt missing' })
  yield* Effect.try({
    try: () => verifyFreeze(receipt, committed, frozen),
    catch: (cause) => new ResearchError({ cause }),
  })
  const holdout = yield* loadDataset('score')
  if (holdout.data.manifestSha256 !== data.manifestSha256)
    return yield* new ResearchError({ cause: 'Dataset manifest changed after development.' })
  const results = yield* Effect.try({
    try: () => scoreStudy(holdout.sessions, study),
    catch: (cause) => new ResearchError({ cause }),
  })
  yield* fs.writeFileString(
    resultsPath,
    json({
      cohort,
      fingerprint,
      freezeCommit,
      freezeSha256: sha256(receipt),
      data,
      splits,
      ...results,
    }),
  )
  yield* Effect.log(
    `Scored only committed probes from ${freezeCommit}. ${results.candidates.filter((row) => row.qualified).length} qualified.`,
  )
})

if (import.meta.main) {
  NodeRuntime.runMain(
    program.pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- offline CLI owns the platform file boundary
      Effect.provide(NodeServices.layer),
    ),
  )
}

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'

import { NodeRuntime } from '@effect/platform-node'
import { Effect, Schema } from 'effect'

import {
  ArchiveError,
  loadTapes,
  readArchiveMetadata,
  replacementBlindSource,
  withArchive,
} from './8yr-unseen-intraday-data'
import {
  baselineNames,
  benchmark,
  blind,
  evidence,
  listingDates,
  noiseNames,
  parameters,
  prior,
  protocolFile,
  protocolSource,
  roster,
  stocks,
  universe,
} from './8yr-unseen-intraday-protocol'
import { evaluate } from './8yr-unseen-intraday-statistics'
import { sha256 } from './research-orb-zab-data'

export const freezeReceipt = () => ({
  schema: 'bayn.research.wave-4e.freeze.v1',
  registeredFiles: {
    [protocolFile]: sha256(readFileSync(protocolFile)),
    [protocolSource]: sha256(readFileSync(protocolSource)),
  },
  inputs: { blind, prior },
  universe,
  stocks,
  baseline: [...baselineNames, ...noiseNames, benchmark].sort(),
  listingDates,
  parameters,
  roster,
})

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', timeout: 15_000 })
const freezeCommit = '0ade8141ccba92cd20346579676ee2ca04e62a97'
const frozenDigest = '0fe346561ed3610336a82e812e4f1e4fe873cd60967c1d6af03a0e301f649d33'
const sourcePath = `${evidence}/blind-archive.json`
const freezePath = `${evidence}/freeze.json`
const studyHead = 'refs/heads/codex/bayn-w4e-8yr-unseen-intraday-oos'
const mainHead = 'refs/heads/main'
const resultsSchema = 'bayn.research.wave-4e.results.v1'
const decodeScoreReceipt = Schema.decodeUnknownSync(
  Schema.Struct({
    schema: Schema.Literal(resultsSchema),
    freezeSha256: Schema.Literal(frozenDigest),
    inputs: Schema.Struct({ blind: Schema.Struct({ bindingSha256: Schema.String }) }),
  }),
)

const committedBlindSource = (revision: string) => {
  if (git('ls-tree', '--name-only', '--full-tree', revision, '--', sourcePath).trim() === '') return undefined
  const bytes = git('show', `${revision}:${sourcePath}`)
  return { binding: replacementBlindSource(JSON.parse(bytes) as unknown), bindingSha256: sha256(bytes) }
}

export const verifyScorePublication = (revision: string, bindingSha256: string | undefined, readGit: typeof git) => {
  const refs = new Map(
    readGit('ls-remote', '--refs', 'origin', studyHead, mainHead)
      .trim()
      .split('\n')
      .map((line) => {
        const [sha, ref] = line.split('\t')
        return [ref, sha]
      }),
  )
  if (refs.get(studyHead) === revision) {
    // The original blind run must still be the exact published descendant of the preregistration.
    readGit('merge-base', '--is-ancestor', freezeCommit, revision)
    return
  }
  const main = refs.get(mainHead)
  if (main === undefined || bindingSha256 === undefined) {
    throw new Error('Push the exact scoring revision or reproduce the published scorecard from origin/main')
  }
  // Squash merges cannot retain the preregistration commit as an ancestor.
  readGit('merge-base', '--is-ancestor', revision, main)
  const published = decodeScoreReceipt(JSON.parse(readGit('show', `${revision}:${evidence}/results.json`)) as unknown)
  if (published.inputs.blind.bindingSha256 !== bindingSha256) {
    throw new Error('The archive binding does not match the published scorecard')
  }
}

const publishedRevision = () => {
  const revision = git('rev-parse', 'HEAD').trim()
  const committedFreeze = git('show', `${revision}:${freezePath}`)
  const freezeSha256 = sha256(committedFreeze)
  if (freezeSha256 !== frozenDigest) {
    throw new Error('The original published strategy freeze must remain byte-identical')
  }
  const receipt = JSON.parse(committedFreeze) as unknown
  if (JSON.stringify(receipt) !== JSON.stringify(freezeReceipt()))
    throw new Error('Committed strategy freeze does not match')
  git('diff', '--quiet', 'HEAD', '--')
  const source = committedBlindSource(revision)
  verifyScorePublication(revision, source?.bindingSha256, git)
  return { publication: { revision, freezeSha256 }, source }
}

const provenance = <A>(read: () => A) =>
  Effect.try({
    try: read,
    catch: (cause) => new ArchiveError({ message: `Cannot prove archive provenance: ${String(cause)}` }),
  })

if (import.meta.main) {
  NodeRuntime.runMain(
    Effect.gen(function* () {
      const [command, ...remaining] = process.argv.slice(2)
      if (remaining.length === 0 && command === '--freeze') {
        yield* Effect.sync(() => process.stdout.write(`${JSON.stringify(freezeReceipt(), null, 2)}\n`))
      } else if (remaining.length === 0 && command === '--audit') {
        const source = yield* provenance(() => committedBlindSource('HEAD'))
        const metadata = yield* withArchive((read) => readArchiveMetadata(read, source?.binding))
        yield* Effect.logInfo(
          `Validated metadata for ${metadata.blind.calendar.length} blind and ${metadata.prior.calendar.length} prior sessions`,
        )
      } else if (command === '--score' && remaining.length === 2 && remaining[0] === '--output') {
        const { publication, source } = yield* provenance(publishedRevision)
        yield* withArchive(async (read, open, signal) => {
          const { blind: blindTape, prior } = await loadTapes(read, open, source?.binding)
          const study = evaluate([...blindTape.days, ...prior.days], signal)
          const result = {
            schema: resultsSchema,
            ...publication,
            inputs: {
              blind: {
                binding: source?.binding ?? blind,
                bindingSha256: source?.bindingSha256 ?? null,
                coverage: blindTape.coverage,
                receipt: blindTape.receipt,
              },
              prior: { coverage: prior.coverage, receipt: prior.receipt },
            },
            ...study,
          }
          await writeFile(remaining[1], `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', signal })
        })
      } else {
        return yield* new ArchiveError({
          message: 'Usage: research-8yr-unseen-intraday-oos.ts --freeze | --audit | --score --output <new JSON file>',
        })
      }
    }),
  )
}

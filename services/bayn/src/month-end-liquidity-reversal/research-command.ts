import { NodeRuntime } from '@effect/platform-node'
import { Data, Effect, Result } from 'effect'
import { resolve } from 'node:path'

import { parseCandidate6DevelopmentCsv } from './development-data'
import { makeSealedCandidate6Preregistration } from './preregistration'
import { buildCandidate6DevelopmentReport } from './research'

const formatJsonArtifacts = async (paths: readonly string[]): Promise<boolean> => {
  const repositoryRoot = resolve(import.meta.dir, '../../../..')
  const formatterPath = resolve(repositoryRoot, 'node_modules/oxfmt/bin/oxfmt')
  const configPath = resolve(repositoryRoot, '.oxfmtrc.json')
  const formatter = Bun.spawn(
    [process.execPath, formatterPath, '--config', configPath, ...paths.map((path) => resolve(path))],
    {
      cwd: repositoryRoot,
      stdout: 'inherit',
      stderr: 'inherit',
    },
  )
  return (await formatter.exited) === 0
}

const main = async (arguments_: readonly string[]): Promise<number> => {
  const [barsInputPath, sessionsInputPath, manifestInputPath, outputPath, preregistrationOutputPath] = arguments_
  if (
    barsInputPath === undefined ||
    sessionsInputPath === undefined ||
    manifestInputPath === undefined ||
    outputPath === undefined ||
    preregistrationOutputPath === undefined
  ) {
    console.error(
      'usage: research-command.ts <bars-csv> <sessions-csv> <manifest-csv> <report-json> <preregistration-json>',
    )
    return 2
  }
  const [barsCsv, sessionsCsv, manifestCsv] = await Promise.all([
    Bun.file(barsInputPath).text(),
    Bun.file(sessionsInputPath).text(),
    Bun.file(manifestInputPath).text(),
  ])
  const dataset = parseCandidate6DevelopmentCsv(barsCsv, sessionsCsv, manifestCsv)
  if (Result.isFailure(dataset)) {
    console.error(JSON.stringify(dataset.failure))
    return 1
  }
  const report = buildCandidate6DevelopmentReport(dataset.success)
  if (Result.isFailure(report)) {
    console.error(JSON.stringify(report.failure))
    return 1
  }
  const preregistration = makeSealedCandidate6Preregistration()
  if (Result.isFailure(preregistration)) {
    console.error(JSON.stringify(preregistration.failure))
    return 1
  }
  await Bun.write(outputPath, `${JSON.stringify(report.success, null, 2)}\n`)
  await Bun.write(preregistrationOutputPath, `${JSON.stringify(preregistration.success, null, 2)}\n`)
  if (!(await formatJsonArtifacts([outputPath, preregistrationOutputPath]))) {
    console.error('failed to format candidate 6 JSON artifacts')
    return 1
  }
  return 0
}

class Candidate6ResearchCommandError extends Data.TaggedError('Candidate6ResearchCommandError')<{
  readonly operation: 'run'
  readonly message: string
  readonly cause?: unknown
}> {}

const program = Effect.tryPromise({
  try: async () => {
    const exitCode = await main(process.argv.slice(2))
    if (exitCode !== 0) {
      throw new Candidate6ResearchCommandError({
        operation: 'run',
        message: `candidate 6 research command failed with exit code ${exitCode}`,
      })
    }
  },
  catch: (cause) =>
    cause instanceof Candidate6ResearchCommandError
      ? cause
      : new Candidate6ResearchCommandError({
          operation: 'run',
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
})

if (import.meta.main) NodeRuntime.runMain(program)

import { Result } from 'effect'

import { parseCandidate6DevelopmentCsv } from './development-data'
import { makeSealedCandidate6Preregistration } from './preregistration'
import { buildCandidate6DevelopmentReport } from './research'

const main = async (arguments_: readonly string[]): Promise<number> => {
  const [inputPath, snapshotId, outputPath, preregistrationOutputPath] = arguments_
  if (
    inputPath === undefined ||
    snapshotId === undefined ||
    outputPath === undefined ||
    preregistrationOutputPath === undefined
  ) {
    console.error('usage: research-command.ts <csv> <snapshot-id> <report-json> <preregistration-json>')
    return 2
  }
  const csv = await Bun.file(inputPath).text()
  const dataset = parseCandidate6DevelopmentCsv(csv, snapshotId)
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
  return 0
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))

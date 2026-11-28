import { readFileSync, statSync } from 'node:fs'
import { Result } from 'effect'

import {
  auditNativeArrivalCoverage,
  nativeCoverageMaximumInputBytes,
} from '../src/intraday-replay/native-arrival-coverage'

const usage = 'Usage: node dist/research/native-arrival-coverage.js <private-json> | --help'

if (import.meta.main) {
  if (process.argv.length === 3 && process.argv[2] === '--help') process.stdout.write(`${usage}\n`)
  else {
    const path = process.argv[2]
    if (path === undefined || process.argv.length !== 3) throw new Error(usage)
    if (statSync(path).size > nativeCoverageMaximumInputBytes) throw new Error('Native coverage input exceeds 32 MiB')
    const input: unknown = JSON.parse(readFileSync(path, 'utf8'))
    process.stdout.write(JSON.stringify(Result.getOrThrow(auditNativeArrivalCoverage(input))) + '\n')
  }
}

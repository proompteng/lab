import { readFileSync } from 'node:fs'

import { NodeRuntime } from '@effect/platform-node'
import { Effect } from 'effect'

import { ArchiveError, readArchiveMetadata, withArchive } from './8yr-unseen-intraday-data'
import {
  baselineNames,
  benchmark,
  blind,
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

if (import.meta.main) {
  NodeRuntime.runMain(
    Effect.gen(function* () {
      const [command, ...remaining] = process.argv.slice(2)
      if (remaining.length === 0 && command === '--freeze') {
        yield* Effect.sync(() => process.stdout.write(`${JSON.stringify(freezeReceipt(), null, 2)}\n`))
      } else if (remaining.length === 0 && command === '--audit') {
        const metadata = yield* withArchive(readArchiveMetadata)
        yield* Effect.logInfo(
          `Validated metadata for ${metadata.blind.calendar.length} blind and ${metadata.prior.calendar.length} prior sessions`,
        )
      } else {
        return yield* new ArchiveError({ message: 'Usage: research-8yr-unseen-intraday-oos.ts --freeze | --audit' })
      }
    }),
  )
}

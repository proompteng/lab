import { Result, Schema } from 'effect'
import { buildEntryTimingExport } from '../intraday-replay/entry-timing-export'
import { Sha256Schema } from '../schemas'
import { SystemAssessmentError } from './economics'
import type { SystemSourceCut } from './source-cut'

export const EntryTimingSourcesSchema = Schema.Array(
  Schema.Struct({
    decisionHash: Sha256Schema,
    traceHash: Sha256Schema,
    decisionFileHash: Sha256Schema,
  }),
)

export const bindEntryTimings = (
  descriptors: typeof EntryTimingSourcesSchema.Type,
  cut: SystemSourceCut,
  sourceRevision: string,
  artifacts: ReadonlyMap<string, Uint8Array>,
) =>
  Result.gen(function* () {
    if (new Set(descriptors.map((d) => d.decisionHash)).size !== descriptors.length)
      return yield* Result.fail(new SystemAssessmentError({ message: 'Duplicate native entry timing evidence' }))
    const receipts = []
    for (const source of descriptors) {
      const traceBytes = artifacts.get(source.traceHash)
      const decisionBytes = artifacts.get(source.decisionFileHash)
      if (
        traceBytes === undefined ||
        decisionBytes === undefined ||
        !cut.decisions.some((d) => d.document.contentHash === source.decisionHash)
      )
        return yield* Result.fail(
          new SystemAssessmentError({
            message: 'Entry timing requires the original trace and captured decision bytes',
          }),
        )
      const verified = yield* buildEntryTimingExport({
        traceBytes,
        traceSha256: source.traceHash,
        decisionBytes,
        decisionSha256: source.decisionFileHash,
        sourceRevision,
      })
      if (verified.timing.decisionHash !== source.decisionHash || verified.timing.decisionCommittedAt > cut.asOf)
        return yield* Result.fail(
          new SystemAssessmentError({ message: 'Entry timing differs from this decision and evidence cut' }),
        )
      receipts.push(verified)
    }
    return receipts
  })

export type VerifiedEntryTiming = Result.Result.Success<ReturnType<typeof bindEntryTimings>>[number]

import { NodeRuntime } from '@effect/platform-node'
import { Effect, Result } from 'effect'

import {
  decodePaperProofCliEnvelopeResult,
  PaperProofError,
  runPaperProof,
  type PaperProofCliEnvelope,
  type PaperProofDependencies,
  type PaperProofReceipt,
} from './paper-proof'

export const runPaperProofCommand = (
  input: unknown,
  dependencies: PaperProofDependencies,
): Effect.Effect<PaperProofReceipt, PaperProofError> => {
  const decoded = decodePaperProofCliEnvelopeResult(input)
  if (Result.isFailure(decoded)) {
    return Effect.fail(
      new PaperProofError({
        operation: 'GATE',
        failure: 'contract',
        message: 'paper proof command envelope is invalid',
        cause: decoded.failure,
      }),
    )
  }
  const envelope: PaperProofCliEnvelope = decoded.success
  return runPaperProof(envelope.command, {
    ...dependencies,
    protectedEntryToken: envelope.protectedEntryToken,
  })
}

export const paperProofCommandEntryGate = Effect.fail(
  new PaperProofError({
    operation: 'GATE',
    failure: 'gate-closed',
    message:
      'PAPER proof CLI is source-ready but intentionally disabled: no reviewed source plan and protected sandbox entry binding are pinned',
  }),
)

if (import.meta.main) {
  NodeRuntime.runMain(paperProofCommandEntryGate)
}

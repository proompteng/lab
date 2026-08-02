import { NodeRuntime } from '@effect/platform-node'
import { Effect, Result } from 'effect'

import {
  containMalformedPaperProofCommand,
  decodePaperProofCliEnvelopeResult,
  hasPaperProofMutationAuthority,
  PaperProofError,
  runPaperProof,
  type PaperProofCliEnvelope,
  type PaperProofDependencies,
  type PaperProofReceipt,
} from './paper-proof'

const ownDataProperty = (value: unknown, property: string): unknown => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, property)
    return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

const malformedOperation = (input: unknown): PaperProofCliEnvelope['command']['operation'] | undefined => {
  const operation = ownDataProperty(ownDataProperty(input, 'command'), 'operation')
  return operation === 'PREPARE' || operation === 'SUBMIT' || operation === 'CANCEL' || operation === 'RECOVER'
    ? operation
    : undefined
}

export const runPaperProofCommand = (
  input: unknown,
  dependencies: PaperProofDependencies,
): Effect.Effect<PaperProofReceipt, PaperProofError> => {
  const decoded = decodePaperProofCliEnvelopeResult(input)
  if (Result.isFailure(decoded)) {
    const failure = new PaperProofError({
      operation: 'GATE',
      failure: 'contract',
      message: 'paper proof command envelope is invalid',
      cause: decoded.failure,
    })
    const operation = malformedOperation(input)
    return !hasPaperProofMutationAuthority(dependencies.runtime)
      ? Effect.fail(failure)
      : containMalformedPaperProofCommand(
          operation ?? 'GATE',
          dependencies.sourcePlan.accountId,
          dependencies.containment,
          failure,
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

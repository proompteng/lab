import { Result } from 'effect'

import { BrokerProvider } from '../broker/connection'
import { BrokerEnvironment } from '../broker/identity'
import { BrokerAccess, CapitalAuthorityKind } from '../execution/authority'
import type { PaperProofCommand, PaperProofRuntimeBinding, PaperProofSourcePlan } from './model'
import { PaperProofError, protectedEntryToken } from './model'

const containmentIoCount = 3

const mismatch = (message: string): Result.Result<never, PaperProofError> =>
  Result.fail(
    new PaperProofError({
      operation: 'GATE',
      failure: 'gate-closed',
      message,
    }),
  )

const sameStrategy = (left: PaperProofSourcePlan['strategy'], right: PaperProofRuntimeBinding['strategy']): boolean =>
  left.name === right.name &&
  left.behaviorHash === right.behaviorHash &&
  left.parameterHash === right.parameterHash &&
  left.parameterSchemaVersion === right.parameterSchemaVersion

export const hasPaperProofMutationAuthority = (runtime: PaperProofRuntimeBinding): boolean =>
  runtime.brokerAccess === BrokerAccess.Mutation || runtime.capitalAuthority === CapitalAuthorityKind.Sandbox

export const validatePaperProofEntry = (
  command: PaperProofCommand,
  source: PaperProofSourcePlan,
  runtime: PaperProofRuntimeBinding,
  entryToken: string,
): Result.Result<void, PaperProofError> => {
  const containmentReservationMs = command.containmentIoTimeoutMs * containmentIoCount
  if (command.timeoutMs <= containmentReservationMs) {
    return mismatch('paper proof timeout must reserve three separately bounded containment I/O windows')
  }
  if (command.operation !== 'PREPARE' && command.consistencyDelayMs >= command.timeoutMs - containmentReservationMs) {
    return mismatch('paper proof mutation timeout must reserve execution time after the consistency delay')
  }
  if (source.qualificationResult !== 'QUALIFIED' || source.qualificationPinned !== true) {
    return mismatch('paper proof requires a separately QUALIFIED and pinned strategy')
  }
  if (entryToken !== protectedEntryToken(source)) {
    return mismatch('paper proof protected entry token does not match the source-controlled plan')
  }
  if (
    command.proofPlanHash !== source.proofPlanHash ||
    command.riskPolicyHash !== source.riskPolicyHash ||
    command.qualificationRunId !== source.qualificationRunId
  ) {
    return mismatch('paper proof command does not match the pinned proof, policy, and qualification')
  }
  if (
    command.sourceRevision !== source.sourceRevision ||
    command.imageRepository !== source.imageRepository ||
    command.imageDigest !== source.imageDigest
  ) {
    return mismatch('paper proof command build binding does not match the source-controlled plan')
  }
  if (
    runtime.sourceRevision !== source.sourceRevision ||
    runtime.imageRepository !== source.imageRepository ||
    runtime.imageDigest !== source.imageDigest
  ) {
    return mismatch('paper proof runtime build does not match the source-controlled plan')
  }
  if (
    source.brokerProvider !== BrokerProvider.Alpaca ||
    source.brokerEnvironment !== BrokerEnvironment.Sandbox ||
    runtime.brokerProvider !== BrokerProvider.Alpaca ||
    runtime.brokerEnvironment !== BrokerEnvironment.Sandbox ||
    runtime.accountId !== source.accountId
  ) {
    return mismatch('paper proof requires the pinned Alpaca sandbox account')
  }
  if (
    runtime.authorityGenerationHash !== source.authorityGenerationHash ||
    !sameStrategy(source.strategy, runtime.strategy)
  ) {
    return mismatch('paper proof authority generation or strategy identity does not match the source plan')
  }
  if (command.operation === 'PREPARE') {
    if (runtime.brokerAccess === BrokerAccess.ReadOnly && runtime.capitalAuthority === CapitalAuthorityKind.None) {
      return Result.succeed(undefined)
    }
    return mismatch('PREPARE requires read-only broker access and no capital authority')
  }
  if (runtime.brokerAccess === BrokerAccess.Mutation && runtime.capitalAuthority === CapitalAuthorityKind.Sandbox) {
    return Result.succeed(undefined)
  }
  return mismatch('SUBMIT, CANCEL, and RECOVER require explicit sandbox mutation authority')
}

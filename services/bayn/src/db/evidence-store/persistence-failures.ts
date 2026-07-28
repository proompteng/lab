import { Result } from 'effect'

import type { ContractConstructionFailure } from '../../contracts'
import { canonicalHashV1Result, renderCanonicalJsonFailure } from '../../hash'
import { renderSimulationReconciliationIssues } from '../../simulation-reconciliation'
import { renderQualificationDecisionFailure } from './qualification'
import {
  persistencePlanInvariantMessages,
  type PersistenceCanonicalizationOperation,
  type PersistencePath,
  type PersistencePlanFailure,
  type PersistencePlanInvariant,
} from './persistence-model'

export const persistenceMismatch = (
  invariant: PersistencePlanInvariant,
  path: PersistencePath,
  observed: unknown,
  expected: unknown,
): Result.Result<never, PersistencePlanFailure> =>
  Result.fail({ _tag: 'PersistenceMismatch', invariant, path, observed, expected })

export const persistenceCanonicalHash = (
  operation: PersistenceCanonicalizationOperation,
  value: unknown,
  subject?: string,
): Result.Result<string, PersistencePlanFailure> =>
  Result.mapError(
    canonicalHashV1Result(value),
    (cause): PersistencePlanFailure => ({
      _tag: 'PersistenceCanonicalizationFailed',
      operation,
      ...(subject === undefined ? {} : { subject }),
      cause,
    }),
  )

const renderFact = (value: unknown): string => {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'number':
    case 'boolean':
    case 'bigint':
    case 'undefined':
      return String(value)
    case 'symbol':
      return value.description === undefined ? 'symbol' : `symbol(${value.description})`
    case 'function':
      return 'function'
    case 'object':
      return Array.isArray(value) ? `array(length=${value.length})` : 'object'
  }
  return 'unknown'
}

const renderContractConstructionFailure = (failure: ContractConstructionFailure): string => {
  switch (failure._tag) {
    case 'ContractCanonicalizationFailed':
      return `${failure.operation}: ${renderCanonicalJsonFailure(failure.cause)}`
    case 'ContractSchemaInvalid':
      return `${failure.operation}: ${failure.cause.message}`
  }
}

export const renderPersistencePlanFailure = (failure: PersistencePlanFailure): string => {
  switch (failure._tag) {
    case 'PersistenceMismatch':
      return `${persistencePlanInvariantMessages[failure.invariant]} at ${failure.path.join('.')}: observed ${renderFact(failure.observed)}, expected ${renderFact(failure.expected)}`
    case 'PersistenceCanonicalizationFailed':
      return `persistence ${failure.operation}${failure.subject === undefined ? '' : ` (${failure.subject})`} failed: ${renderCanonicalJsonFailure(failure.cause)}`
    case 'PersistenceContractConstructionFailed':
      return `persistence ${failure.operation} construction failed: ${renderContractConstructionFailure(failure.cause)}`
    case 'PersistenceQualificationInvalid':
      return `qualification evidence is invalid: ${renderQualificationDecisionFailure(failure.cause)}`
    case 'PersistenceQualificationResultInvalid':
      return `qualification result failed schema validation: ${failure.cause.message}`
    case 'SimulationReconciliationFailed':
      return `marked-equity reconciliation failed: ${renderSimulationReconciliationIssues(failure.issues)}`
  }
}

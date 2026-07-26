import type { ContractConstructionFailure } from '../../contracts'
import { renderCanonicalJsonFailure } from '../../hash'
import { renderSimulationReconciliationIssues } from '../../simulation-reconciliation'
import type { ArtifactSetProblem, EvidenceRecoveryIssue } from './model'

const renderArtifactSetProblem = (problem: ArtifactSetProblem): string => {
  switch (problem._tag) {
    case 'DuplicateArtifact':
      return `duplicate artifact ${problem.name}: observed ${problem.observedCount}, expected ${problem.expectedCount}`
    case 'MissingArtifact':
      return `missing artifact ${problem.name} at schema ${problem.expectedSchemaVersion}`
    case 'ExtraArtifact':
      return `unexpected artifact ${problem.name} at schema ${problem.observedSchemaVersion}`
    case 'WrongArtifactSchema':
      return `artifact ${problem.name} has schema ${problem.observedSchemaVersion}, expected ${problem.expectedSchemaVersion}`
  }
}

const renderContractConstructionFailure = (failure: ContractConstructionFailure): string => {
  switch (failure._tag) {
    case 'ContractCanonicalizationFailed':
      return `${failure.operation}: ${renderCanonicalJsonFailure(failure.cause)}`
    case 'ContractSchemaInvalid':
      return `${failure.operation}: ${failure.cause.message}`
  }
}

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

export const renderEvidenceRecoveryIssue = (issue: EvidenceRecoveryIssue): string => {
  switch (issue._tag) {
    case 'RecoveryMismatch':
      return `${issue.stage} mismatch at ${issue.path.join('.')}: observed ${renderFact(issue.observed)}, expected ${renderFact(issue.expected)}`
    case 'ArtifactSetFailure':
      return renderArtifactSetProblem(issue.problem)
    case 'DecodeFailure':
      return `${issue.artifactName} (${issue.schemaVersion}) failed decoding: ${issue.cause.message}`
    case 'CanonicalizationFailure':
      return `${issue.operation}${issue.subject === undefined ? '' : ` (${issue.subject})`} failed: ${renderCanonicalJsonFailure(issue.cause)}`
    case 'SimulationFailure':
      return `simulation reconciliation failed: ${renderSimulationReconciliationIssues(issue.issues)}`
    case 'ComputationFailure':
      return `${issue.operation} failed: ${issue.cause.message}`
    case 'ContractConstructionFailure':
      return `${issue.operation} failed: ${renderContractConstructionFailure(issue.cause)}`
  }
}

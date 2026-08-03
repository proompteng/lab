import { Result, Schema } from 'effect'

import {
  CandidateDevelopmentLocalSourceManifestBindingSchema,
  type CandidateDevelopmentLocalSourceManifestBinding,
} from '../candidate-development-local/domain'
import type {
  CandidateDevelopmentNextPreregistration,
  CandidateDevelopmentTrialHistory,
  CandidateDevelopmentTrialState,
  CandidateDevelopmentTrialStateIssue,
} from './model'
import {
  CandidateDevelopmentTrialLedgerSchema,
  type CandidateDevelopmentTrialLedgerEntry,
  type CandidateDevelopmentTrialLedgerState,
} from './ledger'
import { buildCandidateDevelopmentTrialState } from './lineage'
import { validateCandidateDevelopmentTrialState } from './validation'
import { canonicalHashV1Result } from '../hash'
import { strictParseOptions } from '../schemas'

export type QualificationDormancyDecision =
  | {
      readonly status: 'dormant'
      readonly reason: 'preregistration-missing'
      readonly candidateOrdinal: null
    }
  | {
      readonly status: 'dormant'
      readonly reason: 'precommit-invalid-unattempted' | 'development-rejected' | 'development-not-approved'
      readonly candidateOrdinal: number
    }
  | {
      readonly status: 'dormant'
      readonly reason: 'qualification-attempt-consumed'
      readonly candidateOrdinal: number
    }
  | {
      readonly status: 'ready'
      readonly reason: 'qualification-eligible'
      readonly candidateOrdinal: number
      readonly preregistrationSourceRevision: string
      readonly preregistrationBlobOid: string
    }

export interface QualificationDormancyIssue {
  readonly path: string
  readonly reason:
    | 'MALFORMED_HISTORY'
    | 'UNSUPPORTED_SCHEMA'
    | 'INVALID_ORDINAL_LINEAGE'
    | 'INVALID_PREREGISTRATION'
    | 'INVALID_INVALIDATION'
    | 'AMBIGUOUS_SUCCESSOR'
    | 'INVALID_STATE'
}

export type QualificationDormancyResult =
  | { readonly ok: true; readonly decision: QualificationDormancyDecision }
  | { readonly ok: false; readonly issue: QualificationDormancyIssue }

const mapStateIssue = (issue: CandidateDevelopmentTrialStateIssue): QualificationDormancyIssue => ({
  path: issue.path,
  reason:
    issue.reason === 'SCHEMA_VERSION_MISMATCH'
      ? 'UNSUPPORTED_SCHEMA'
      : issue.reason === 'ORDINAL_SEQUENCE_GAP' ||
          issue.reason === 'ORDINAL_OVERLAP' ||
          issue.reason === 'ORDINAL_REUSE' ||
          issue.reason === 'NEXT_ORDINAL_MISMATCH'
        ? 'INVALID_ORDINAL_LINEAGE'
        : issue.reason === 'INVALIDATION_NOT_IMMUTABLE' || issue.reason === 'INVALIDATION_BINDING_MISMATCH'
          ? 'INVALID_INVALIDATION'
          : issue.reason === 'SUCCESSOR_BINDING_MISMATCH' || issue.reason === 'SUCCESSOR_REQUIRED'
            ? 'AMBIGUOUS_SUCCESSOR'
            : issue.reason === 'MALFORMED_HISTORY'
              ? 'MALFORMED_HISTORY'
              : 'INVALID_STATE',
})

const decisionFromState = (state: CandidateDevelopmentTrialState): QualificationDormancyDecision => {
  const active = state.activeTrial
  if (active === null) {
    const lastClosed = state.closedTrials.at(-1)
    if (lastClosed?._tag === 'PRECOMMIT_INVALIDATED') {
      return {
        status: 'dormant',
        reason: 'precommit-invalid-unattempted',
        candidateOrdinal: lastClosed.candidateOrdinal,
      }
    }
    if (lastClosed?._tag === 'DEVELOPMENT_REJECTED') {
      return {
        status: 'dormant',
        reason: 'development-rejected',
        candidateOrdinal: lastClosed.candidateOrdinal,
      }
    }
    return { status: 'dormant', reason: 'preregistration-missing', candidateOrdinal: null }
  }
  switch (active._tag) {
    case 'DEVELOPMENT_PENDING':
    case 'DEVELOPMENT_OUTCOME_PENDING':
      return {
        status: 'dormant',
        reason: 'development-not-approved',
        candidateOrdinal: active.candidateOrdinal,
      }
    case 'QUALIFICATION_ELIGIBLE':
      return {
        status: 'ready',
        reason: 'qualification-eligible',
        candidateOrdinal: active.candidateOrdinal,
        preregistrationSourceRevision: active.preregistration.preregistration.sourceRevision,
        preregistrationBlobOid: active.preregistration.preregistration.blobOid,
      }
    case 'QUALIFICATION_ATTEMPTED':
      return {
        status: 'dormant',
        reason: 'qualification-attempt-consumed',
        candidateOrdinal: active.candidateOrdinal,
      }
  }
}

export const qualificationDormancyDecisionFromState = (
  state: CandidateDevelopmentTrialState,
): QualificationDormancyResult => {
  const validation = validateCandidateDevelopmentTrialState(state)
  return Result.isFailure(validation)
    ? { ok: false, issue: mapStateIssue(validation.failure) }
    : { ok: true, decision: decisionFromState(state) }
}

const invalidLedger = (path: string): QualificationDormancyResult => ({
  ok: false,
  issue: { path, reason: 'INVALID_STATE' },
})

const sameOrdinals = (left: readonly number[], right: readonly number[]): boolean =>
  left.length === right.length && left.every((ordinal, index) => ordinal === right[index])

const validateDevelopmentApprovalEvidence = (
  entry: Extract<CandidateDevelopmentTrialLedgerEntry, { readonly _tag: 'DEVELOPMENT_APPROVED' }>,
  preregistration: CandidateDevelopmentNextPreregistration,
  sourceManifestBinding: CandidateDevelopmentLocalSourceManifestBinding,
  strategyName: string,
): QualificationDormancyResult => {
  if (entry.terminalReport.status !== 'PASS') return invalidLedger('entries.DEVELOPMENT_APPROVED.terminalReport.status')

  const reportHash = canonicalHashV1Result(entry.terminalReport)
  if (Result.isFailure(reportHash) || reportHash.success !== entry.terminalReportHash) {
    return invalidLedger('entries.DEVELOPMENT_APPROVED.terminalReportHash')
  }

  const { bindingHash: _bindingHash, ...bindingMaterial } = entry.terminalReport.source
  const expectedBindingHash = canonicalHashV1Result(bindingMaterial)
  if (
    Result.isFailure(expectedBindingHash) ||
    expectedBindingHash.success !== entry.terminalReport.source.bindingHash
  ) {
    return invalidLedger('entries.DEVELOPMENT_APPROVED.terminalReport.source.bindingHash')
  }

  const source = entry.terminalReport.source
  const expected = [
    ['candidateOrdinal', preregistration.candidateOrdinal, source.candidateOrdinal],
    ['priorTrialCount', preregistration.priorTrialCount, source.priorTrialCount],
    ['strategyName', strategyName, source.strategyName],
    ['sourceRevision', preregistration.preregistration.sourceRevision, source.sourceRevision],
    ['sourceManifestPath', sourceManifestBinding.path, source.sourceManifestPath],
    ['sourceManifestBlobOid', sourceManifestBinding.blobOid, source.sourceManifestBlobOid],
    ['sourceManifestSha256', sourceManifestBinding.sha256, source.sourceManifestSha256],
    ['modulePath', preregistration.modulePath, source.modulePath],
    ['moduleSha256', preregistration.moduleSha256, source.moduleSha256],
    ['strategyProtocolHash', preregistration.strategyProtocolHash, source.strategyProtocolHash],
    ['trialHistoryHash', preregistration.priorTrialsHash, source.trialHistoryHash],
    ['snapshotId', preregistration.marketData.snapshotId, source.snapshotId],
    ['inputManifestHash', preregistration.marketData.inputManifestHash, source.inputManifestHash],
    ['boundedContentHash', preregistration.marketData.boundedContentHash, source.boundedContentHash],
  ] as const
  const mismatch = expected.find(
    ([, expectedValue, observed]) => expectedValue === undefined || expectedValue !== observed,
  )
  return mismatch === undefined
    ? {
        ok: true,
        decision: {
          status: 'ready',
          reason: 'qualification-eligible',
          candidateOrdinal: source.candidateOrdinal,
          preregistrationSourceRevision: source.sourceRevision,
          preregistrationBlobOid: preregistration.preregistration.blobOid,
        },
      }
    : invalidLedger(`entries.DEVELOPMENT_APPROVED.terminalReport.source.${mismatch[0]}`)
}

const validateLedger = (
  state: CandidateDevelopmentTrialLedgerState,
):
  | { readonly ok: true; readonly entries: readonly CandidateDevelopmentTrialLedgerEntry[] }
  | { readonly ok: false; readonly result: QualificationDormancyResult } => {
  const decoded = Schema.decodeUnknownResult(CandidateDevelopmentTrialLedgerSchema, strictParseOptions)(state.entries)
  if (Result.isFailure(decoded)) return { ok: false, result: invalidLedger('entries') }

  const entries = decoded.success
  if (entries.length < 20) return { ok: false, result: invalidLedger('entries') }
  for (const [index, entry] of entries.entries()) {
    const expectedOrdinal = index + 1
    if (entry.candidateOrdinal !== expectedOrdinal) {
      return { ok: false, result: invalidLedger(`entries[${index}].candidateOrdinal`) }
    }
    if (entry.priorTrialCount !== index) {
      return { ok: false, result: invalidLedger(`entries[${index}].priorTrialCount`) }
    }
  }

  const candidate20 = entries[19]
  if (candidate20?._tag !== 'PRECOMMIT_INVALID') return { ok: false, result: invalidLedger('entries[19]') }

  const completedCandidateOrdinals = entries
    .filter((entry) => entry._tag === 'QUALIFICATION_TERMINAL')
    .map((entry) => entry.candidateOrdinal)
  const developmentCandidateOrdinals = entries
    .filter((entry) => entry._tag === 'DEVELOPMENT_REJECTED' || entry._tag === 'DEVELOPMENT_APPROVED')
    .map((entry) => entry.candidateOrdinal)
  if (!sameOrdinals(state.completedCandidateOrdinals, completedCandidateOrdinals)) {
    return { ok: false, result: invalidLedger('completedCandidateOrdinals') }
  }
  if (!sameOrdinals(state.developmentCandidateOrdinals, developmentCandidateOrdinals)) {
    return { ok: false, result: invalidLedger('developmentCandidateOrdinals') }
  }

  const invalidPrecommit = entries.find((entry) => entry._tag === 'PRECOMMIT_INVALID')
  const projectedInvalidPrecommit = state.latestInvalidPrecommit
  if (
    (invalidPrecommit === undefined) !== (projectedInvalidPrecommit === null) ||
    (invalidPrecommit !== undefined &&
      (projectedInvalidPrecommit === null ||
        projectedInvalidPrecommit.candidateOrdinal !== invalidPrecommit.candidateOrdinal ||
        projectedInvalidPrecommit.priorTrialCount !== invalidPrecommit.priorTrialCount ||
        projectedInvalidPrecommit.status !== 'PRECOMMIT_INVALID'))
  ) {
    return { ok: false, result: invalidLedger('latestInvalidPrecommit') }
  }

  const approvals = entries.filter((entry) => entry._tag === 'DEVELOPMENT_APPROVED')
  if (approvals.length > 1 || (approvals.length === 1 && entries.at(-1)?._tag !== 'DEVELOPMENT_APPROVED')) {
    return { ok: false, result: invalidLedger('entries.DEVELOPMENT_APPROVED') }
  }

  return { ok: true, entries }
}

/**
 * Qualification reads the append-only ledger, while the older history reducer remains available for immutable
 * archived evidence. Only a development approval entry can make the single active registration runnable.
 */
export const qualificationDormancyDecisionFromLedgerState = (
  state: CandidateDevelopmentTrialLedgerState,
): QualificationDormancyResult => {
  if (
    !Array.isArray(state.entries) ||
    !Array.isArray(state.completedCandidateOrdinals) ||
    !Array.isArray(state.developmentCandidateOrdinals)
  ) {
    return invalidLedger('ledger')
  }

  const validatedLedger = validateLedger(state)
  if (!validatedLedger.ok) return validatedLedger.result
  const entries = validatedLedger.entries

  const active = state.activeCandidate
  if (active === null) {
    const last = entries.at(-1)
    if (last?._tag === 'DEVELOPMENT_APPROVED') return invalidLedger('activeCandidate')
    if (state.latestInvalidPrecommit !== null) {
      return {
        ok: true,
        decision: {
          status: 'dormant',
          reason: 'precommit-invalid-unattempted',
          candidateOrdinal: state.latestInvalidPrecommit.candidateOrdinal,
        },
      }
    }
    if (last?._tag === 'DEVELOPMENT_REJECTED') {
      return {
        ok: true,
        decision: { status: 'dormant', reason: 'development-rejected', candidateOrdinal: last.candidateOrdinal },
      }
    }
    return { ok: true, decision: { status: 'dormant', reason: 'preregistration-missing', candidateOrdinal: null } }
  }

  const candidateOrdinal = active.preregistration.candidateOrdinal
  const lastEntry = entries.at(-1)
  const activeApproval = lastEntry?._tag === 'DEVELOPMENT_APPROVED' ? lastEntry : undefined
  const closedEntryCount = activeApproval === undefined ? entries.length : entries.length - 1
  if (candidateOrdinal !== closedEntryCount + 1 || active.preregistration.priorTrialCount !== closedEntryCount) {
    return invalidLedger('activeCandidate.preregistration.candidateOrdinal')
  }
  if (
    activeApproval !== undefined &&
    (activeApproval.candidateOrdinal !== candidateOrdinal ||
      activeApproval.priorTrialCount !== active.preregistration.priorTrialCount ||
      activeApproval.sourceRevision !== active.preregistration.preregistration.sourceRevision)
  ) {
    return invalidLedger('entries.DEVELOPMENT_APPROVED.binding')
  }
  if (activeApproval === undefined) {
    return { ok: true, decision: { status: 'dormant', reason: 'development-not-approved', candidateOrdinal } }
  }
  const strategyName = active.application?.definition?.name
  if (typeof strategyName !== 'string') return invalidLedger('activeCandidate.application.definition.name')
  const sourceManifest = Schema.decodeUnknownResult(
    CandidateDevelopmentLocalSourceManifestBindingSchema,
    strictParseOptions,
  )(active.sourceManifest)
  return Result.isFailure(sourceManifest)
    ? invalidLedger('activeCandidate.sourceManifest')
    : validateDevelopmentApprovalEvidence(activeApproval, active.preregistration, sourceManifest.success, strategyName)
}

export const decideQualificationDormancy = (value: unknown): QualificationDormancyResult => {
  const state = buildCandidateDevelopmentTrialState(value as CandidateDevelopmentTrialHistory)
  return Result.isFailure(state)
    ? { ok: false, issue: mapStateIssue(state.failure) }
    : qualificationDormancyDecisionFromState(state.success)
}

export const qualificationDormancyDecisionFromHistory = (
  history: CandidateDevelopmentTrialHistory,
): QualificationDormancyResult => decideQualificationDormancy(history)

export type { CandidateDevelopmentNextPreregistration }

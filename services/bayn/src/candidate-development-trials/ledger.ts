import { Schema } from 'effect'

import {
  candidate20PrecommitInvalidation,
  candidate17Preregistration,
  candidate18Preregistration,
  candidate19Preregistration,
} from './frozen-lineage'
import {
  CandidateDevelopmentLocalSourceManifestBindingSchema,
  CandidateDevelopmentLocalTerminalReportSchema,
} from '../candidate-development-local/domain'
import {
  CandidateDevelopmentNextPreregistrationSchema,
  type CandidateDevelopmentInvalidPrecommit,
  type CandidateDevelopmentNextPreregistration,
} from './model'
import {
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  Sha256Schema,
  StrictNonEmptyStringSchema,
  strictParseOptions,
} from '../schemas'
import type { StrategyApplication } from '../strategy'

const TrialLedgerEntrySchema = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal('QUALIFICATION_TERMINAL'),
    candidateOrdinal: PositiveIntegerSchema,
    priorTrialCount: NonNegativeIntegerSchema,
  }),
  Schema.Struct({
    _tag: Schema.Literal('DEVELOPMENT_REJECTED'),
    candidateOrdinal: PositiveIntegerSchema,
    priorTrialCount: NonNegativeIntegerSchema,
    sourceRevision: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.Literal('DEVELOPMENT_APPROVED'),
    candidateOrdinal: PositiveIntegerSchema,
    priorTrialCount: NonNegativeIntegerSchema,
    sourceRevision: Schema.String,
    terminalReportHash: Sha256Schema,
    terminalReport: CandidateDevelopmentLocalTerminalReportSchema,
  }),
  Schema.Struct({
    _tag: Schema.Literal('PRECOMMIT_INVALID'),
    candidateOrdinal: Schema.Literal(20),
    priorTrialCount: Schema.Literal(19),
    attemptStatus: Schema.Literal('UNATTEMPTED'),
    metricBearingAttemptsConsumed: Schema.Literal(0),
    qualificationAttemptConsumed: Schema.Literal(false),
  }),
  Schema.Struct({
    _tag: Schema.Literal('DEVELOPMENT_PENDING'),
    candidateOrdinal: PositiveIntegerSchema,
    priorTrialCount: NonNegativeIntegerSchema,
    strategyName: StrictNonEmptyStringSchema,
    preregistration: CandidateDevelopmentNextPreregistrationSchema,
    sourceManifest: CandidateDevelopmentLocalSourceManifestBindingSchema,
  }),
])

const TrialLedgerSchema = Schema.Array(TrialLedgerEntrySchema)

export const CandidateDevelopmentTrialLedgerSchema = TrialLedgerSchema

export type CandidateDevelopmentTrialLedgerEntry = typeof TrialLedgerEntrySchema.Type

const historicalLedger = [
  ...Array.from({ length: 16 }, (_, index) => ({
    _tag: 'QUALIFICATION_TERMINAL' as const,
    candidateOrdinal: index + 1,
    priorTrialCount: index,
  })),
  {
    _tag: 'DEVELOPMENT_REJECTED' as const,
    candidateOrdinal: 17,
    priorTrialCount: 16,
    sourceRevision: candidate17Preregistration.preregistration.sourceRevision,
  },
  {
    _tag: 'DEVELOPMENT_REJECTED' as const,
    candidateOrdinal: 18,
    priorTrialCount: 17,
    sourceRevision: candidate18Preregistration.preregistration.sourceRevision,
  },
  {
    _tag: 'DEVELOPMENT_REJECTED' as const,
    candidateOrdinal: 19,
    priorTrialCount: 18,
    sourceRevision: candidate19Preregistration.preregistration.sourceRevision,
  },
  {
    _tag: 'PRECOMMIT_INVALID' as const,
    candidateOrdinal: 20 as const,
    priorTrialCount: 19 as const,
    attemptStatus: 'UNATTEMPTED' as const,
    metricBearingAttemptsConsumed: 0 as const,
    qualificationAttemptConsumed: false as const,
  },
] as const

/** One append-only source-controlled ledger. Candidate 20 is represented once as the terminal tombstone entry. */
export const candidateDevelopmentTrialLedger: readonly CandidateDevelopmentTrialLedgerEntry[] = Object.freeze(
  Schema.decodeUnknownSync(TrialLedgerSchema, strictParseOptions)(historicalLedger),
)

export interface ActiveCandidateDevelopmentRegistration {
  readonly preregistration: CandidateDevelopmentNextPreregistration
  readonly strategyName?: string
  /** The exact reviewed source-manifest object consumed by both local development and qualification. */
  readonly sourceManifest: typeof CandidateDevelopmentLocalSourceManifestBindingSchema.Type
  /** Compatibility projection for archived fixtures; production adapters load the registered module export. */
  readonly application?: StrategyApplication<any, any, any>
}

const activeRegistrationFromLedger = (
  entries: readonly CandidateDevelopmentTrialLedgerEntry[],
): ActiveCandidateDevelopmentRegistration | null => {
  const pending = [...entries].reverse().find((entry) => entry._tag === 'DEVELOPMENT_PENDING')
  if (pending === undefined) return null
  const latest = entries.at(-1)
  if (
    latest !== undefined &&
    latest.candidateOrdinal === pending.candidateOrdinal &&
    (latest._tag === 'DEVELOPMENT_REJECTED' || latest._tag === 'QUALIFICATION_TERMINAL')
  ) {
    return null
  }
  return Object.freeze({
    preregistration: pending.preregistration,
    strategyName: pending.strategyName,
    sourceManifest: pending.sourceManifest,
  })
}

/** The active registration is derived from one append-only pending entry; its application is the module export. */
export const activeCandidateDevelopmentRegistration = activeRegistrationFromLedger(candidateDevelopmentTrialLedger)

export interface CandidateDevelopmentTrialLedgerState {
  readonly entries: readonly CandidateDevelopmentTrialLedgerEntry[]
  readonly completedCandidateOrdinals: readonly number[]
  readonly developmentCandidateOrdinals: readonly number[]
  readonly latestInvalidPrecommit: CandidateDevelopmentInvalidPrecommit | null
  readonly activeCandidate: ActiveCandidateDevelopmentRegistration | null
}

export const deriveCandidateDevelopmentTrialLedgerState = (): CandidateDevelopmentTrialLedgerState => ({
  entries: candidateDevelopmentTrialLedger,
  completedCandidateOrdinals: candidateDevelopmentTrialLedger
    .filter((entry) => entry._tag === 'QUALIFICATION_TERMINAL')
    .map((entry) => entry.candidateOrdinal),
  developmentCandidateOrdinals: candidateDevelopmentTrialLedger
    .filter((entry) => entry._tag === 'DEVELOPMENT_REJECTED' || entry._tag === 'DEVELOPMENT_APPROVED')
    .map((entry) => entry.candidateOrdinal),
  latestInvalidPrecommit: candidateDevelopmentTrialLedger.some((entry) => entry._tag === 'PRECOMMIT_INVALID')
    ? candidate20PrecommitInvalidation
    : null,
  activeCandidate: activeCandidateDevelopmentRegistration,
})

export const candidateDevelopmentTrialLedgerState = deriveCandidateDevelopmentTrialLedgerState()

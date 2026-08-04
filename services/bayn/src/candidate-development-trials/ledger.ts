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
  {
    _tag: 'DEVELOPMENT_PENDING' as const,
    candidateOrdinal: 21,
    priorTrialCount: 20,
    strategyName: 'candidate-21-six-month-rotation',
    preregistration: {
      schemaVersion: 'bayn.candidate-development-next-preregistration.v1' as const,
      candidateOrdinal: 21,
      priorTrialCount: 20,
      strategyProtocolHash: 'fd0a271c22691770246e16ca5aa38ba5b9c546d4070ae5382e8a79f40d5c2bd5',
      candidateDevelopmentProtocolHash: '05c4f3247252d4c3d724593b5c2f654c5b9a11974f865f5d68dac44a792b1b61',
      calendarHash: '4b2f519f336e4e730c1f0d69e860f25a8d4d0cfbd8e93c6b333ea83623d87237',
      priorTrialsHash: '295eff4120c4d3deb33e09e3948bc5a670b55a836dc6be6849b2eea979e60008',
      modulePath: 'services/bayn/src/strategy/candidate-21.ts',
      moduleSha256: 'e77081c2c6904a67b293334b6e051d76dd634974ec0055dd099e5c4d84985b06',
      marketData: {
        schemaVersion: 'bayn.candidate-development-market-data-source.v1' as const,
        snapshotId: '2a91f0177684f7022f746207333e510c8268f9b77a04b778a04220a33ccf79e0',
        finalizedSnapshotContentHash: '8e376546f6a6cc1dbe2e910db3d68f584fc0bd9c4858166042ce32aa077eed0d',
        inputManifestHash: '1e5377336f2e6feb751000114b81cc89aee5be7542e213c320f2cfbb4185bb2b',
        boundedContentHash: 'b6052c8ebdca855973adf4e41efafb5028fd8dbbaa70809331f6017519b1c995',
      },
      preregistration: {
        sourceRevision: 'f9c90e5158212d862ca4b64cf9624fe424f09ba6',
        path: 'services/bayn/candidates/ordinal-21-six-month-rotation-preregistration.json',
        blobOid: 'f61534e914c854aec0c19c28cfd24490e59f36c7',
      },
    },
    sourceManifest: {
      path: 'services/bayn/candidates/ordinal-21-source-manifest.json',
      blobOid: '623a59e183a6700fbde8600629f87ea2b14b59fd',
      sha256: '0613547be32377af4431b87476b7cee15af107f7860fbc5cff346763c5b9150c',
    },
  },
  {
    _tag: 'DEVELOPMENT_REJECTED' as const,
    candidateOrdinal: 21,
    priorTrialCount: 20,
    sourceRevision: 'd98164a2df566c6181fb6ea9580b6273f68c57e7',
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

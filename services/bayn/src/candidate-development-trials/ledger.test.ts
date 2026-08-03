import { describe, expect, test } from 'bun:test'

import { candidate20Preregistration } from './frozen-lineage'
import {
  candidateDevelopmentTrialLedger,
  candidateDevelopmentTrialLedgerState,
  type CandidateDevelopmentTrialLedgerState,
} from './ledger'
import { qualificationDormancyDecisionFromLedgerState } from './qualification-dormancy'

describe('Bayn candidate development trial ledger', () => {
  test('keeps Candidate 20 as one immutable invalid and unattempted tombstone', () => {
    const candidate20 = candidateDevelopmentTrialLedger.filter((entry) => entry.candidateOrdinal === 20)

    expect(candidate20).toEqual([
      {
        _tag: 'PRECOMMIT_INVALID',
        candidateOrdinal: 20,
        priorTrialCount: 19,
        attemptStatus: 'UNATTEMPTED',
        metricBearingAttemptsConsumed: 0,
        qualificationAttemptConsumed: false,
      },
    ])
    expect(candidateDevelopmentTrialLedgerState.completedCandidateOrdinals).toEqual(
      Array.from({ length: 16 }, (_, index) => index + 1),
    )
    expect(candidateDevelopmentTrialLedgerState.developmentCandidateOrdinals).toEqual([17, 18, 19])
    expect(candidateDevelopmentTrialLedgerState.latestInvalidPrecommit?.status).toBe('PRECOMMIT_INVALID')
    expect(candidateDevelopmentTrialLedgerState.activeCandidate).toBeNull()
  })

  test('keeps an active registration dormant until its one terminal development approval is appended', () => {
    const activeCandidate = {
      preregistration: {
        ...candidate20Preregistration,
        candidateOrdinal: 21,
        priorTrialCount: 20,
        preregistration: {
          ...candidate20Preregistration.preregistration,
          sourceRevision: 'a'.repeat(40),
          blobOid: 'b'.repeat(40),
        },
      },
      application: {},
    }
    const pending = {
      ...candidateDevelopmentTrialLedgerState,
      activeCandidate,
    } as unknown as CandidateDevelopmentTrialLedgerState
    expect(qualificationDormancyDecisionFromLedgerState(pending)).toEqual({
      ok: true,
      decision: { status: 'dormant', reason: 'development-not-approved', candidateOrdinal: 21 },
    })

    const approved = {
      ...pending,
      entries: [
        ...pending.entries,
        {
          _tag: 'DEVELOPMENT_APPROVED' as const,
          candidateOrdinal: 21,
          priorTrialCount: 20,
          sourceRevision: 'a'.repeat(40),
          terminalReportHash: 'c'.repeat(64),
        },
      ],
    }
    expect(qualificationDormancyDecisionFromLedgerState(approved)).toMatchObject({
      ok: true,
      decision: {
        status: 'ready',
        reason: 'qualification-eligible',
        candidateOrdinal: 21,
      },
    })
  })

  test('fails closed when development approval does not bind the active preregistration', () => {
    const activeCandidate = {
      preregistration: {
        ...candidate20Preregistration,
        candidateOrdinal: 21,
        priorTrialCount: 20,
        preregistration: {
          ...candidate20Preregistration.preregistration,
          sourceRevision: 'a'.repeat(40),
          blobOid: 'b'.repeat(40),
        },
      },
      application: {},
    }
    const base = {
      ...candidateDevelopmentTrialLedgerState,
      activeCandidate,
    } as unknown as CandidateDevelopmentTrialLedgerState
    const mismatched = {
      ...base,
      entries: [
        ...base.entries,
        {
          _tag: 'DEVELOPMENT_APPROVED' as const,
          candidateOrdinal: 21,
          priorTrialCount: 19,
          sourceRevision: 'c'.repeat(40),
          terminalReportHash: 'd'.repeat(64),
        },
      ],
    }
    expect(qualificationDormancyDecisionFromLedgerState(mismatched)).toEqual({
      ok: false,
      issue: { path: 'entries.DEVELOPMENT_APPROVED.binding', reason: 'INVALID_STATE' },
    })

    const duplicate = {
      ...base,
      entries: [
        ...base.entries,
        {
          _tag: 'DEVELOPMENT_APPROVED' as const,
          candidateOrdinal: 21,
          priorTrialCount: 20,
          sourceRevision: 'a'.repeat(40),
          terminalReportHash: 'd'.repeat(64),
        },
        {
          _tag: 'DEVELOPMENT_APPROVED' as const,
          candidateOrdinal: 21,
          priorTrialCount: 20,
          sourceRevision: 'a'.repeat(40),
          terminalReportHash: 'e'.repeat(64),
        },
      ],
    }
    expect(qualificationDormancyDecisionFromLedgerState(duplicate)).toEqual({
      ok: false,
      issue: { path: 'entries.DEVELOPMENT_APPROVED', reason: 'INVALID_STATE' },
    })
  })
})

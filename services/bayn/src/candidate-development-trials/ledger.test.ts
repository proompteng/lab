import { describe, expect, test } from 'bun:test'

import {
  makeCandidateDevelopmentLocalTerminalReport,
  type CandidateDevelopmentLocalSourceManifestBinding,
} from '../candidate-development-local/domain'
import { canonicalHashV1 } from '../hash'
import { candidate20Preregistration } from './frozen-lineage'
import {
  candidateDevelopmentTrialLedger,
  candidateDevelopmentTrialLedgerState,
  type CandidateDevelopmentTrialLedgerState,
} from './ledger'
import type { CandidateDevelopmentNextPreregistration } from './model'
import { qualificationDormancyDecisionFromLedgerState } from './qualification-dormancy'

const candidate21EntryIndex = candidateDevelopmentTrialLedgerState.entries.findIndex(
  (entry) => entry.candidateOrdinal === 21,
)
const preCandidate21LedgerState: CandidateDevelopmentTrialLedgerState =
  candidate21EntryIndex >= 0
    ? {
        ...candidateDevelopmentTrialLedgerState,
        entries: candidateDevelopmentTrialLedgerState.entries.slice(0, candidate21EntryIndex),
        developmentCandidateOrdinals: candidateDevelopmentTrialLedgerState.developmentCandidateOrdinals.filter(
          (ordinal) => ordinal < 21,
        ),
        activeCandidate: null,
      }
    : candidateDevelopmentTrialLedgerState

const approvalEvidence = (
  preregistration: CandidateDevelopmentNextPreregistration,
  sourceManifestBinding: CandidateDevelopmentLocalSourceManifestBinding,
  evaluatedSourceRevision = preregistration.preregistration.sourceRevision,
  status: 'PASS' | 'HOLD_REJECT' = 'PASS',
) => {
  if (preregistration.priorTrialsHash === undefined) throw new Error('approval fixture requires a trial history hash')
  const sourceMaterial = {
    candidateOrdinal: preregistration.candidateOrdinal,
    priorTrialCount: preregistration.priorTrialCount,
    trialHistoryHash: preregistration.priorTrialsHash,
    strategyName: 'risk-balanced-trend',
    strategyProtocolHash: preregistration.strategyProtocolHash,
    snapshotId: preregistration.marketData.snapshotId,
    inputManifestHash: preregistration.marketData.inputManifestHash,
    boundedContentHash: preregistration.marketData.boundedContentHash,
    sourceRevision: evaluatedSourceRevision,
    modulePath: preregistration.modulePath,
    moduleBlobOid: '3'.repeat(40),
    moduleSha256: preregistration.moduleSha256,
    sourceManifestPath: sourceManifestBinding.path,
    sourceManifestBlobOid: sourceManifestBinding.blobOid,
    sourceManifestSha256: sourceManifestBinding.sha256,
  }
  const source = { ...sourceMaterial, bindingHash: canonicalHashV1(sourceMaterial) }
  const terminalReport = makeCandidateDevelopmentLocalTerminalReport(
    source,
    status,
    '6'.repeat(64),
    '7'.repeat(64),
    '8'.repeat(64),
  )
  return {
    sourceRevision: evaluatedSourceRevision,
    terminalReport,
    terminalReportHash: canonicalHashV1(terminalReport),
  }
}

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
    expect(candidateDevelopmentTrialLedgerState.developmentCandidateOrdinals).toEqual([17, 18, 19, 21])
    expect(candidateDevelopmentTrialLedgerState.latestInvalidPrecommit?.status).toBe('PRECOMMIT_INVALID')
    expect(candidateDevelopmentTrialLedgerState.activeCandidate).toBeNull()
    expect(qualificationDormancyDecisionFromLedgerState(candidateDevelopmentTrialLedgerState)).toEqual({
      ok: true,
      decision: { status: 'dormant', reason: 'development-rejected', candidateOrdinal: 21 },
    })
  })

  test('binds the terminal rejection to its report hash, status, and source revision', () => {
    const rejection = candidateDevelopmentTrialLedgerState.entries.at(-1)
    const pending = candidateDevelopmentTrialLedgerState.entries.at(-2)
    if (rejection?._tag !== 'DEVELOPMENT_REJECTED' || rejection.terminalReport === undefined) {
      throw new Error('expected the terminal Candidate 21 rejection')
    }
    if (pending?._tag !== 'DEVELOPMENT_PENDING') throw new Error('expected the pending Candidate 21 registration')
    const withRejection = (replacement: typeof rejection) =>
      qualificationDormancyDecisionFromLedgerState({
        ...candidateDevelopmentTrialLedgerState,
        entries: [...candidateDevelopmentTrialLedgerState.entries.slice(0, -1), replacement],
      })

    expect(withRejection({ ...rejection, terminalReportHash: '0'.repeat(64) })).toEqual({
      ok: false,
      issue: { path: 'entries.DEVELOPMENT_REJECTED.terminalReportHash', reason: 'INVALID_STATE' },
    })
    expect(
      withRejection({
        ...rejection,
        terminalReport: { ...rejection.terminalReport, status: 'PASS' },
      }),
    ).toEqual({
      ok: false,
      issue: { path: 'entries.DEVELOPMENT_REJECTED.terminalReport.status', reason: 'INVALID_STATE' },
    })
    const alteredReport = {
      ...rejection.terminalReport,
      source: { ...rejection.terminalReport.source, sourceRevision: 'a'.repeat(40) },
    }
    expect(
      withRejection({
        ...rejection,
        terminalReport: alteredReport,
        terminalReportHash: canonicalHashV1(alteredReport),
      }),
    ).toEqual({
      ok: false,
      issue: { path: 'entries.DEVELOPMENT_REJECTED.terminalReport.source.bindingHash', reason: 'INVALID_STATE' },
    })

    const successorPreregistration = {
      ...pending.preregistration,
      candidateOrdinal: 22,
      priorTrialCount: 21,
      modulePath: 'services/bayn/src/strategy/candidate-22.ts',
      preregistration: {
        sourceRevision: 'b'.repeat(40),
        path: 'services/bayn/candidates/ordinal-22-preregistration.json',
        blobOid: 'c'.repeat(40),
      },
    }
    const successorSourceManifest = {
      path: 'services/bayn/candidates/ordinal-22-source-manifest.json',
      blobOid: 'd'.repeat(40),
      sha256: 'e'.repeat(64),
    }
    const successorPending = {
      _tag: 'DEVELOPMENT_PENDING' as const,
      candidateOrdinal: 22,
      priorTrialCount: 21,
      strategyName: 'candidate-22',
      preregistration: successorPreregistration,
      sourceManifest: successorSourceManifest,
    }
    const withSuccessor = (replacement: typeof rejection) =>
      qualificationDormancyDecisionFromLedgerState({
        ...candidateDevelopmentTrialLedgerState,
        entries: [...candidateDevelopmentTrialLedgerState.entries.slice(0, -1), replacement, successorPending],
        activeCandidate: {
          preregistration: successorPreregistration,
          strategyName: successorPending.strategyName,
          sourceManifest: successorSourceManifest,
        },
      })

    expect(withSuccessor(rejection)).toEqual({
      ok: true,
      decision: { status: 'dormant', reason: 'development-not-approved', candidateOrdinal: 22 },
    })
    expect(
      qualificationDormancyDecisionFromLedgerState({
        ...candidateDevelopmentTrialLedgerState,
        entries: [...candidateDevelopmentTrialLedgerState.entries.slice(0, -2), rejection, successorPending],
        activeCandidate: {
          preregistration: successorPreregistration,
          strategyName: successorPending.strategyName,
          sourceManifest: successorSourceManifest,
        },
      }),
    ).toEqual({
      ok: false,
      issue: { path: 'entries.DEVELOPMENT_REJECTED.binding', reason: 'INVALID_STATE' },
    })
    expect(withSuccessor({ ...rejection, terminalReportHash: '0'.repeat(64) })).toEqual({
      ok: false,
      issue: { path: 'entries.DEVELOPMENT_REJECTED.terminalReportHash', reason: 'INVALID_STATE' },
    })
    expect(
      withSuccessor({
        ...rejection,
        terminalReport: { ...rejection.terminalReport, status: 'PASS' },
      }),
    ).toEqual({
      ok: false,
      issue: { path: 'entries.DEVELOPMENT_REJECTED.terminalReport.status', reason: 'INVALID_STATE' },
    })
    expect(
      withSuccessor({
        ...rejection,
        terminalReport: alteredReport,
        terminalReportHash: canonicalHashV1(alteredReport),
      }),
    ).toEqual({
      ok: false,
      issue: { path: 'entries.DEVELOPMENT_REJECTED.terminalReport.source.bindingHash', reason: 'INVALID_STATE' },
    })
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
      application: { definition: { name: 'risk-balanced-trend' } },
      sourceManifest: {
        path: 'services/bayn/candidates/ordinal-21-source-manifest.json',
        blobOid: 'c'.repeat(40),
        sha256: 'e'.repeat(64),
      },
    }
    const pending = {
      ...preCandidate21LedgerState,
      activeCandidate,
    } as unknown as CandidateDevelopmentTrialLedgerState
    expect(qualificationDormancyDecisionFromLedgerState(pending)).toEqual({
      ok: true,
      decision: { status: 'dormant', reason: 'development-not-approved', candidateOrdinal: 21 },
    })

    const approved = {
      ...pending,
      developmentCandidateOrdinals: [...pending.developmentCandidateOrdinals, 21],
      entries: [
        ...pending.entries,
        {
          _tag: 'DEVELOPMENT_APPROVED' as const,
          candidateOrdinal: 21,
          priorTrialCount: 20,
          ...approvalEvidence(activeCandidate.preregistration, activeCandidate.sourceManifest),
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

    const terminalized = {
      ...approved,
      activeCandidate: null,
      completedCandidateOrdinals: [...approved.completedCandidateOrdinals, 21],
      entries: [
        ...approved.entries,
        { _tag: 'QUALIFICATION_TERMINAL' as const, candidateOrdinal: 21, priorTrialCount: 20 },
      ],
    }
    expect(qualificationDormancyDecisionFromLedgerState(terminalized)).toEqual({
      ok: true,
      decision: { status: 'dormant', reason: 'preregistration-missing', candidateOrdinal: null },
    })

    const successorCandidate = {
      ...activeCandidate,
      preregistration: {
        ...activeCandidate.preregistration,
        candidateOrdinal: 22,
        priorTrialCount: 21,
      },
    }
    const successorApproved = {
      ...terminalized,
      activeCandidate: successorCandidate,
      developmentCandidateOrdinals: [...approved.developmentCandidateOrdinals, 22],
      entries: [
        ...terminalized.entries,
        {
          _tag: 'DEVELOPMENT_APPROVED' as const,
          candidateOrdinal: 22,
          priorTrialCount: 21,
          ...approvalEvidence(successorCandidate.preregistration, successorCandidate.sourceManifest),
        },
      ],
    }
    expect(
      qualificationDormancyDecisionFromLedgerState(
        successorApproved as unknown as CandidateDevelopmentTrialLedgerState,
      ),
    ).toMatchObject({
      ok: true,
      decision: { status: 'ready', reason: 'qualification-eligible', candidateOrdinal: 22 },
    })

    const approval = approved.entries.at(-1)
    if (approval?._tag !== 'DEVELOPMENT_APPROVED') throw new Error('expected a development approval entry')
    expect(
      qualificationDormancyDecisionFromLedgerState({
        ...approved,
        entries: [...approved.entries.slice(0, -1), { ...approval, terminalReportHash: 'd'.repeat(64) }],
      }),
    ).toEqual({
      ok: false,
      issue: { path: 'entries.DEVELOPMENT_APPROVED.terminalReportHash', reason: 'INVALID_STATE' },
    })

    const holdRejectedReport = { ...approval.terminalReport, status: 'HOLD_REJECT' as const }
    expect(
      qualificationDormancyDecisionFromLedgerState({
        ...approved,
        entries: [
          ...approved.entries.slice(0, -1),
          {
            ...approval,
            terminalReport: holdRejectedReport,
            terminalReportHash: canonicalHashV1(holdRejectedReport),
          },
        ],
      }),
    ).toEqual({
      ok: false,
      issue: { path: 'entries.DEVELOPMENT_APPROVED.terminalReport.status', reason: 'INVALID_STATE' },
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
      application: { definition: { name: 'risk-balanced-trend' } },
      sourceManifest: {
        path: 'services/bayn/candidates/ordinal-21-source-manifest.json',
        blobOid: 'c'.repeat(40),
        sha256: 'e'.repeat(64),
      },
    }
    const base = {
      ...preCandidate21LedgerState,
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
          ...approvalEvidence(
            {
              ...activeCandidate.preregistration,
              preregistration: {
                ...activeCandidate.preregistration.preregistration,
                sourceRevision: 'c'.repeat(40),
              },
            },
            activeCandidate.sourceManifest,
          ),
        },
      ],
    }
    expect(qualificationDormancyDecisionFromLedgerState(mismatched)).toEqual({
      ok: false,
      issue: { path: 'entries[20].priorTrialCount', reason: 'INVALID_STATE' },
    })

    const duplicate = {
      ...base,
      developmentCandidateOrdinals: [...base.developmentCandidateOrdinals, 21],
      entries: [
        ...base.entries,
        {
          _tag: 'DEVELOPMENT_APPROVED' as const,
          candidateOrdinal: 21,
          priorTrialCount: 20,
          ...approvalEvidence(activeCandidate.preregistration, activeCandidate.sourceManifest),
        },
        {
          _tag: 'DEVELOPMENT_APPROVED' as const,
          candidateOrdinal: 21,
          priorTrialCount: 20,
          ...approvalEvidence(activeCandidate.preregistration, activeCandidate.sourceManifest),
        },
      ],
    }
    expect(qualificationDormancyDecisionFromLedgerState(duplicate)).toEqual({
      ok: false,
      issue: { path: 'entries[21].candidateOrdinal', reason: 'INVALID_STATE' },
    })
  })

  test('closes a pending candidate after its one-shot development rejection', () => {
    const preregistration = {
      ...candidate20Preregistration,
      candidateOrdinal: 21,
      priorTrialCount: 20,
      preregistration: {
        ...candidate20Preregistration.preregistration,
        sourceRevision: 'a'.repeat(40),
        blobOid: 'b'.repeat(40),
      },
    }
    const sourceManifest = {
      path: 'services/bayn/candidates/ordinal-21-source-manifest.json',
      blobOid: 'c'.repeat(40),
      sha256: 'e'.repeat(64),
    }
    const pending = {
      _tag: 'DEVELOPMENT_PENDING' as const,
      candidateOrdinal: 21,
      priorTrialCount: 20,
      strategyName: 'risk-balanced-trend',
      preregistration,
      sourceManifest,
    }
    expect(
      qualificationDormancyDecisionFromLedgerState({
        ...preCandidate21LedgerState,
        entries: [
          ...preCandidate21LedgerState.entries,
          pending,
          {
            _tag: 'DEVELOPMENT_REJECTED' as const,
            candidateOrdinal: 21,
            priorTrialCount: 20,
            ...approvalEvidence(preregistration, sourceManifest, 'd'.repeat(40), 'HOLD_REJECT'),
          },
        ],
        developmentCandidateOrdinals: [...preCandidate21LedgerState.developmentCandidateOrdinals, 21],
        activeCandidate: null,
      }),
    ).toEqual({
      ok: true,
      decision: { status: 'dormant', reason: 'development-rejected', candidateOrdinal: 21 },
    })
  })

  test('preserves the evaluated descendant revision in development approval evidence', () => {
    const preregistration = {
      ...candidate20Preregistration,
      candidateOrdinal: 21,
      priorTrialCount: 20,
      preregistration: {
        ...candidate20Preregistration.preregistration,
        sourceRevision: 'a'.repeat(40),
        blobOid: 'b'.repeat(40),
      },
    }
    const sourceManifest = {
      path: 'services/bayn/candidates/ordinal-21-source-manifest.json',
      blobOid: 'c'.repeat(40),
      sha256: 'e'.repeat(64),
    }
    const pending = {
      _tag: 'DEVELOPMENT_PENDING' as const,
      candidateOrdinal: 21,
      priorTrialCount: 20,
      strategyName: 'risk-balanced-trend',
      preregistration,
      sourceManifest,
    }
    const approval = {
      _tag: 'DEVELOPMENT_APPROVED' as const,
      candidateOrdinal: 21,
      priorTrialCount: 20,
      ...approvalEvidence(preregistration, sourceManifest, 'd'.repeat(40)),
    }
    expect(
      qualificationDormancyDecisionFromLedgerState({
        ...preCandidate21LedgerState,
        entries: [...preCandidate21LedgerState.entries, pending, approval],
        developmentCandidateOrdinals: [...preCandidate21LedgerState.developmentCandidateOrdinals, 21],
        activeCandidate: { preregistration, strategyName: 'risk-balanced-trend', sourceManifest },
      }),
    ).toMatchObject({
      ok: true,
      decision: { status: 'ready', reason: 'qualification-eligible', candidateOrdinal: 21 },
    })
  })

  test('fails closed for an incomplete predecessor ledger and derives the active prior count from it', () => {
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
      ...preCandidate21LedgerState,
      activeCandidate,
    } as unknown as CandidateDevelopmentTrialLedgerState

    expect(
      qualificationDormancyDecisionFromLedgerState({
        ...base,
        entries: base.entries.filter((entry) => entry.candidateOrdinal !== 19),
      }),
    ).toEqual({ ok: false, issue: { path: 'entries', reason: 'INVALID_STATE' } })

    expect(
      qualificationDormancyDecisionFromLedgerState({
        ...base,
        entries: base.entries.map((entry) =>
          entry.candidateOrdinal === 19 ? { ...entry, priorTrialCount: 0 } : entry,
        ),
      }),
    ).toEqual({ ok: false, issue: { path: 'entries[18].priorTrialCount', reason: 'INVALID_STATE' } })

    expect(
      qualificationDormancyDecisionFromLedgerState({
        ...base,
        activeCandidate: {
          ...activeCandidate,
          preregistration: { ...activeCandidate.preregistration, priorTrialCount: 19 },
        },
      } as unknown as CandidateDevelopmentTrialLedgerState),
    ).toEqual({
      ok: false,
      issue: { path: 'activeCandidate.preregistration.candidateOrdinal', reason: 'INVALID_STATE' },
    })
  })
})

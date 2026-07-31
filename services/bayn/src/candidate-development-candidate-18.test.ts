import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import {
  candidate17DevelopmentEligibility,
  candidate18DevelopmentEligibility,
  candidate18DevelopmentFailureEvidenceExpectation,
  candidate18LegacyPriorTrialsMaterial,
  candidate18PriorTrialsMaterial,
  candidate18Preregistration,
  deriveCandidateDevelopmentLegacyPriorTrialsHash,
  deriveCandidateDevelopmentPriorTrialsHash,
  frozenCandidateDevelopmentSessions,
  frozenCandidateDevelopmentTrialHistory,
} from './candidate-development-calendar'
import {
  candidate18DevelopmentFailureEvidenceResult,
  validateCandidate18DevelopmentFailureEvidence,
} from './candidate-development-candidate-18-evidence'
import { preregisterCandidateDevelopmentAttempt } from './candidate-development-command'
import { canonicalHashV1 } from './hash'
import {
  candidate18Planner as untypedCandidate18Planner,
  candidateDevelopmentArtifact as untypedCandidateDevelopmentArtifact,
} from './strategy/dual-momentum-global-equity/candidate-18'

type Candidate18Symbol = 'DBC' | 'EFA' | 'IEF' | 'SPY' | 'VNQ'

interface Candidate18Bar {
  readonly symbol: Candidate18Symbol
  readonly sessionDate: string
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  readonly volume: number
  readonly source: 'alpaca'
  readonly sourceFeed: 'sip'
  readonly adjustment: 'all'
  readonly publicationSchemaVersion: 'signal.adjusted-daily-snapshot.v2'
}

interface Candidate18Session {
  readonly date: string
  readonly bars: Readonly<Record<Candidate18Symbol, Candidate18Bar>>
}

type Candidate18Result<A> =
  | { readonly _tag: 'Success'; readonly success: A }
  | { readonly _tag: 'Failure'; readonly failure: unknown }

interface Candidate18Decision {
  readonly signalDate: string
  readonly executionDate: string
  readonly feature: {
    readonly totalReturns: Readonly<Record<Candidate18Symbol, number>>
    readonly relativeMomentumWinner: 'SPY' | 'EFA'
    readonly selectedRiskAssetPositive: boolean
    readonly defensiveAssetPositive: boolean
    readonly selectedSymbol: 'SPY' | 'EFA' | 'IEF' | null
  }
  readonly weights: Readonly<Record<Candidate18Symbol, number>>
}

interface Candidate18PlannerContract {
  readonly specification: {
    readonly id: 'global-equity-dual-momentum-252-spy-efa-ief-cash'
    readonly lookbackSessions: 252
    readonly riskAssets: readonly ['SPY', 'EFA']
    readonly defensiveAsset: 'IEF'
    readonly absoluteMomentumThreshold: 0
    readonly selectedAssetWeight: 1
    readonly relativeMomentumTieBreak: 'SPY'
  }
  readonly decisionAtSignal: (
    sessions: readonly Candidate18Session[],
    signalIndex: number,
    terminal: boolean,
  ) => Candidate18Result<Candidate18Decision>
}

interface Candidate18ArtifactContract {
  readonly schemaVersion: 'bayn.candidate-development-artifact.v1'
  readonly input: {
    readonly candidateOrdinal: 18
    readonly priorTrialCount: 17
    readonly expectedStrategyProtocolHash: string
    readonly officialSessions: readonly string[]
    readonly signalSessionDates: readonly string[]
    readonly featureLookbackSessions: 252
  }
  readonly strategyProtocol: {
    readonly strategyIdentity: unknown
  }
  readonly buildEvaluation: (source: unknown) => unknown
}

const candidate18Planner = untypedCandidate18Planner as unknown as Candidate18PlannerContract
const candidateDevelopmentArtifact = untypedCandidateDevelopmentArtifact as unknown as Candidate18ArtifactContract
const symbols = ['DBC', 'EFA', 'IEF', 'SPY', 'VNQ'] as const satisfies readonly Candidate18Symbol[]

const successOf = <A>(result: Candidate18Result<A>): A => {
  expect(result._tag).toBe('Success')
  if (result._tag === 'Failure') throw new Error('expected Candidate 18 planner success')
  return result.success
}

const syntheticSessions = (returns: Readonly<Record<'SPY' | 'EFA' | 'IEF', number>>): readonly Candidate18Session[] =>
  frozenCandidateDevelopmentSessions()
    .slice(0, 254)
    .map((date, index) => {
      const bars = {} as Record<Candidate18Symbol, Candidate18Bar>
      for (const symbol of symbols) {
        const terminalReturn = symbol === 'SPY' || symbol === 'EFA' || symbol === 'IEF' ? returns[symbol] : 0
        const close = 100 * Math.pow(1 + terminalReturn, Math.min(index, 252) / 252)
        bars[symbol] = {
          symbol,
          sessionDate: date,
          open: close,
          high: close * 1.001,
          low: close * 0.999,
          close,
          volume: 1_000_000 + index,
          source: 'alpaca',
          sourceFeed: 'sip',
          adjustment: 'all',
          publicationSchemaVersion: 'signal.adjusted-daily-snapshot.v2',
        }
      }
      return { date, bars }
    })

const selectedWeight = (decision: Candidate18Decision): readonly [Candidate18Symbol | 'CASH', number] => {
  const selected = Object.entries(decision.weights).find(([, weight]) => weight !== 0)
  return selected === undefined ? ['CASH', 1] : [selected[0] as Candidate18Symbol, selected[1]]
}

describe('Candidate 18 dual momentum preregistration', () => {
  test('binds the exact result-blind ordinal, lineage, protocol, and strategy identity', () => {
    expect(candidateDevelopmentArtifact.schemaVersion).toBe('bayn.candidate-development-artifact.v1')
    expect(candidateDevelopmentArtifact.input).toMatchObject({
      candidateOrdinal: 18,
      priorTrialCount: 17,
      expectedStrategyProtocolHash: candidate18Preregistration.strategyProtocolHash,
      featureLookbackSessions: 252,
    })
    expect(candidateDevelopmentArtifact.input.officialSessions).toHaveLength(1_762)
    expect(canonicalHashV1(candidateDevelopmentArtifact.strategyProtocol)).toBe(
      candidate18Preregistration.strategyProtocolHash,
    )
    expect(canonicalHashV1(candidateDevelopmentArtifact.strategyProtocol.strategyIdentity)).toBe(
      candidate18Preregistration.strategyIdentityHash!,
    )
    expect(candidate18Planner.specification).toMatchObject({
      id: 'global-equity-dual-momentum-252-spy-efa-ief-cash',
      lookbackSessions: 252,
      riskAssets: ['SPY', 'EFA'],
      defensiveAsset: 'IEF',
      absoluteMomentumThreshold: 0,
      selectedAssetWeight: 1,
      relativeMomentumTieBreak: 'SPY',
    })
    expect(frozenCandidateDevelopmentTrialHistory.completedCandidateOrdinals).toEqual(
      Array.from({ length: 16 }, (_, index) => index + 1),
    )
    expect(frozenCandidateDevelopmentTrialHistory.developmentCandidateOrdinals).toEqual([17, 18])
    expect(frozenCandidateDevelopmentTrialHistory.latestDevelopmentEvidence).toMatchObject({
      candidateOrdinal: 18,
      priorTrialCount: 17,
      status: 'DEVELOPMENT_REJECTED',
      evidenceContentHash: candidate18DevelopmentFailureEvidenceExpectation.evidenceContentHash,
      evaluatedSourceRevision: candidate18DevelopmentFailureEvidenceExpectation.evaluatedSourceRevision,
      failureStage: 'buildEvaluation-preflight',
      developmentMetricsObserved: false,
      qualificationAttemptConsumed: false,
    })
    expect(candidate17DevelopmentEligibility.nextCandidatePreregistration).toBeNull()
    expect(candidate18DevelopmentEligibility).toMatchObject({
      status: 'DEVELOPMENT_REJECTED',
      evidenceContentHash: candidate18DevelopmentFailureEvidenceExpectation.evidenceContentHash,
      nextCandidatePreregistration: null,
    })
    expect(frozenCandidateDevelopmentTrialHistory.nextCandidatePreregistration).toBeNull()
    expect(typeof candidateDevelopmentArtifact.buildEvaluation).toBe('function')
  })

  test('fails closed because the immutable prior-trials hash omitted Candidate 16 qualification lineage', () => {
    const legacy = deriveCandidateDevelopmentLegacyPriorTrialsHash(candidate18LegacyPriorTrialsMaterial)
    expect(legacy).toEqual(Result.succeed(candidate18Preregistration.priorTrialsHash!))

    const complete = deriveCandidateDevelopmentPriorTrialsHash(candidate18PriorTrialsMaterial)
    expect(Result.isSuccess(complete)).toBe(true)
    if (Result.isFailure(complete)) throw new Error('expected complete prior-trial material to hash')
    expect(complete.success).not.toBe(candidate18Preregistration.priorTrialsHash)

    const alteredEvidence = deriveCandidateDevelopmentPriorTrialsHash({
      ...candidate18PriorTrialsMaterial,
      latestDevelopmentEvidence: {
        ...candidate18PriorTrialsMaterial.latestDevelopmentEvidence,
        evidenceContentHash: '0'.repeat(64),
      },
    })
    expect(Result.isSuccess(alteredEvidence)).toBe(true)
    if (Result.isFailure(alteredEvidence)) throw new Error('expected altered prior-trial material to hash')
    expect(alteredEvidence.success).not.toBe(complete.success)

    const alteredQualificationEvidence = deriveCandidateDevelopmentPriorTrialsHash({
      ...candidate18PriorTrialsMaterial,
      latestQualificationEvidence: {
        ...candidate18PriorTrialsMaterial.latestQualificationEvidence,
        sourceRevision: '0'.repeat(40),
      },
    })
    expect(Result.isSuccess(alteredQualificationEvidence)).toBe(true)
    if (Result.isFailure(alteredQualificationEvidence)) {
      throw new Error('expected altered qualification evidence to hash')
    }
    expect(alteredQualificationEvidence.success).not.toBe(complete.success)

    const alteredQualificationPreregistration = deriveCandidateDevelopmentPriorTrialsHash({
      ...candidate18PriorTrialsMaterial,
      latestQualificationPreregistration: {
        ...candidate18PriorTrialsMaterial.latestQualificationPreregistration,
        blobOid: '0'.repeat(40),
      },
    })
    expect(Result.isSuccess(alteredQualificationPreregistration)).toBe(true)
    if (Result.isFailure(alteredQualificationPreregistration)) {
      throw new Error('expected altered qualification preregistration to hash')
    }
    expect(alteredQualificationPreregistration.success).not.toBe(complete.success)
  })

  test('records the sole fail-closed attempt and blocks every rerun before evaluation', async () => {
    expect(Result.isSuccess(candidate18DevelopmentFailureEvidenceResult)).toBe(true)
    if (Result.isFailure(candidate18DevelopmentFailureEvidenceResult)) {
      throw new Error('expected Candidate 18 failure evidence to be valid')
    }
    const evidence = candidate18DevelopmentFailureEvidenceResult.success
    expect(evidence).toMatchObject({
      candidateOrdinal: 18,
      priorTrialCount: 17,
      status: 'DEVELOPMENT_REJECTED',
      qualificationAttemptConsumed: false,
      nextCandidatePreregistration: null,
      attempt: {
        stage: 'buildEvaluation-preflight',
        developmentMetricsObserved: false,
        developmentReportWritten: false,
        evaluationRerunAuthorized: false,
      },
    })
    expect(preregisterCandidateDevelopmentAttempt(evidence.verifiedSource)).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-program-binding',
        cause: {
          field: 'trialHistory.nextCandidatePreregistration',
          observed: null,
        },
      },
    })

    const tampered = structuredClone(evidence) as Record<string, unknown>
    tampered.contentHash = '0'.repeat(64)
    expect(validateCandidate18DevelopmentFailureEvidence(tampered)).toMatchObject({
      failure: { _tag: 'Candidate18DevelopmentFailureEvidenceContentHashMismatch' },
    })

    expect(candidateDevelopmentArtifact.input.expectedStrategyProtocolHash).toBe(
      evidence.protocolBindings.strategyProtocolHash,
    )
    expect(canonicalHashV1(candidateDevelopmentArtifact.strategyProtocol)).toBe(
      evidence.protocolBindings.strategyProtocolHash,
    )
    expect(evidence.attempt.failure.cause.reason).toBe(
      'strategy protocol hash fa25d8c16bc4f4fde3bab99409ae60a6fd23332d295b3557231796cebb911390 differs from Candidate 18',
    )
    expect(evidence.protocolBindings.embeddedEvaluationProtocolHash).not.toBe(
      evidence.protocolBindings.strategyProtocolHash,
    )
  })

  test('uses relative momentum, then absolute momentum, then defensive momentum or cash', () => {
    const riskOnSpy = successOf(
      candidate18Planner.decisionAtSignal(syntheticSessions({ SPY: 0.2, EFA: 0.1, IEF: 0.05 }), 252, false),
    )
    expect(riskOnSpy.feature.relativeMomentumWinner).toBe('SPY')
    expect(selectedWeight(riskOnSpy)).toEqual(['SPY', 1])

    const riskOnEfa = successOf(
      candidate18Planner.decisionAtSignal(syntheticSessions({ SPY: 0.1, EFA: 0.2, IEF: 0.05 }), 252, false),
    )
    expect(selectedWeight(riskOnEfa)).toEqual(['EFA', 1])

    const defensive = successOf(
      candidate18Planner.decisionAtSignal(syntheticSessions({ SPY: -0.1, EFA: -0.2, IEF: 0.05 }), 252, false),
    )
    expect(defensive.feature.selectedRiskAssetPositive).toBe(false)
    expect(selectedWeight(defensive)).toEqual(['IEF', 1])

    const cash = successOf(
      candidate18Planner.decisionAtSignal(syntheticSessions({ SPY: -0.1, EFA: -0.2, IEF: -0.05 }), 252, false),
    )
    expect(cash.feature.selectedSymbol).toBeNull()
    expect(selectedWeight(cash)).toEqual(['CASH', 1])

    const tie = successOf(
      candidate18Planner.decisionAtSignal(syntheticSessions({ SPY: 0.1, EFA: 0.1, IEF: 0.05 }), 252, false),
    )
    expect(selectedWeight(tie)).toEqual(['SPY', 1])
  })

  test('is causal and liquidates the frozen terminal decision', () => {
    const sessions = syntheticSessions({ SPY: 0.2, EFA: 0.1, IEF: 0.05 })
    const original = successOf(candidate18Planner.decisionAtSignal(sessions, 252, false))
    const futureMutated = sessions.map((session, index) =>
      index <= 252
        ? session
        : {
            ...session,
            bars: Object.fromEntries(
              symbols.map((symbol) => [
                symbol,
                {
                  ...session.bars[symbol],
                  open: session.bars[symbol].open * 100,
                  high: session.bars[symbol].high * 100,
                  low: session.bars[symbol].low * 100,
                  close: session.bars[symbol].close * 100,
                },
              ]),
            ) as Readonly<Record<Candidate18Symbol, Candidate18Bar>>,
          },
    )
    expect(successOf(candidate18Planner.decisionAtSignal(futureMutated, 252, false))).toEqual(original)

    const terminal = successOf(candidate18Planner.decisionAtSignal(sessions, 252, true))
    expect(Object.values(terminal.weights).every((weight) => weight === 0)).toBe(true)
  })
})

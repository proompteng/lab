import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { Effect, Result } from 'effect'

import rawDevelopmentEvidence from '../candidates/ordinal-19-inverse-volatility-risk-diversification-development-evidence.json' with { type: 'json' }
import rawPreregistration from '../candidates/ordinal-19-inverse-volatility-risk-diversification-preregistration.json' with { type: 'json' }
import rawSourceManifest from '../candidates/ordinal-19-inverse-volatility-risk-diversification-source-manifest.json' with { type: 'json' }
import {
  candidate19DevelopmentEligibility,
  candidate19Preregistration,
  candidate19PriorTrialsMaterial,
  candidate20Preregistration,
  deriveCandidateDevelopmentPriorTrialsHash,
  frozenCandidateDevelopmentSessions,
  frozenCandidateDevelopmentTrialHistory,
} from './candidate-development-calendar'
import type { CandidateDevelopmentPreflightInput } from './candidate-development'
import {
  candidate19DevelopmentFailureEvidenceExpectation,
  candidate19DevelopmentFailureEvidenceResult,
  validateCandidate19DevelopmentFailureEvidence,
} from './candidate-development-candidate-19-evidence'
import {
  evaluateCandidateDevelopmentArtifact,
  preregisterCandidateDevelopmentAttempt,
  validateCandidateDevelopmentArtifactStructure,
  type CandidateDevelopmentSourceManifest,
  type CandidateDevelopmentStrategyProtocol,
  type CandidateDevelopmentVerifiedSource,
  type CandidateDevelopmentVerifiedSourceFiles,
} from './candidate-development-command'
import { canonicalHashV1 } from './hash'
import {
  candidate19Planner as untypedCandidate19Planner,
  candidateDevelopmentArtifact as untypedCandidateDevelopmentArtifact,
} from './strategy/inverse-volatility-risk-diversification/candidate-19'

type Candidate19Symbol = 'DBC' | 'EFA' | 'IEF' | 'SPY' | 'VNQ'

interface Candidate19Bar {
  readonly symbol: Candidate19Symbol
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

interface Candidate19Session {
  readonly date: string
  readonly bars: Readonly<Record<Candidate19Symbol, Candidate19Bar>>
}

type Candidate19Result<A> =
  | { readonly _tag: 'Success'; readonly success: A }
  | { readonly _tag: 'Failure'; readonly failure: unknown }

interface Candidate19Decision {
  readonly feature: {
    readonly totalReturns: Readonly<Record<Candidate19Symbol, number>>
    readonly annualizedVolatilities: Readonly<Record<Candidate19Symbol, number>>
    readonly normalizedInverseVolatilityWeights: Readonly<Record<'SPY' | 'DBC', number>>
    readonly unscaledAnnualizedPortfolioVolatility: number
    readonly exposureScale: number
  }
  readonly weights: Readonly<Record<Candidate19Symbol, number>>
}

interface Candidate19PlannerContract {
  readonly specification: {
    readonly id: 'inverse-volatility-63-spy-dbc-ten-percent-target-risk-cash'
    readonly lookbackSessions: 63
    readonly annualizationSessions: 252
    readonly riskAssets: readonly ['SPY', 'DBC']
    readonly covarianceEstimator: 'sample'
    readonly targetAnnualizedVolatility: 0.1
    readonly maximumGrossExposure: 1
  }
  readonly decisionAtSignal: (
    sessions: readonly Candidate19Session[],
    signalIndex: number,
    terminal: boolean,
  ) => Candidate19Result<Candidate19Decision>
}

interface Candidate19ArtifactContract {
  readonly schemaVersion: 'bayn.candidate-development-artifact.v1'
  readonly input: {
    readonly candidateOrdinal: 19
    readonly priorTrialCount: 18
    readonly expectedStrategyProtocolHash: string
    readonly officialSessions: readonly string[]
    readonly signalSessionDates: readonly string[]
    readonly featureLookbackSessions: 63
  }
  readonly strategyProtocol: CandidateDevelopmentStrategyProtocol
  readonly structuralBindings: CandidateDevelopmentArtifactStructuralBindings
  readonly buildEvaluation: (source: unknown) => unknown
}

const candidate19Planner = untypedCandidate19Planner as unknown as Candidate19PlannerContract
const candidateDevelopmentArtifact = untypedCandidateDevelopmentArtifact as unknown as Candidate19ArtifactContract
const candidate19Input = candidateDevelopmentArtifact.input as unknown as CandidateDevelopmentPreflightInput
const candidate19SourceManifest = rawSourceManifest as CandidateDevelopmentSourceManifest
const symbols = ['DBC', 'EFA', 'IEF', 'SPY', 'VNQ'] as const satisfies readonly Candidate19Symbol[]
const sourceManifestPath =
  'services/bayn/candidates/ordinal-19-inverse-volatility-risk-diversification-source-manifest.json'

const successOf = <A>(result: Candidate19Result<A>): A => {
  expect(result._tag).toBe('Success')
  if (result._tag === 'Failure') throw new Error('expected Candidate 19 planner success')
  return result.success
}

const syntheticSessions = (): readonly Candidate19Session[] =>
  frozenCandidateDevelopmentSessions()
    .slice(0, 65)
    .map((date, index) => {
      const bars = {} as Record<Candidate19Symbol, Candidate19Bar>
      for (const symbol of symbols) {
        const [drift, amplitude, frequency] =
          symbol === 'SPY'
            ? [-0.0002, 0.001, 0.71]
            : symbol === 'DBC'
              ? [0.0005, 0.01, 0.83]
              : symbol === 'EFA'
                ? [0.0001, 0.004, 0.59]
                : symbol === 'IEF'
                  ? [0.00005, 0.002, 0.47]
                  : [0.00015, 0.006, 0.67]
        const close = 100 * Math.exp(drift * index + amplitude * Math.sin(frequency * index))
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

const verifiedSource = (
  sourceManifest: CandidateDevelopmentSourceManifest = candidate19SourceManifest,
): CandidateDevelopmentVerifiedSource => ({
  schemaVersion: 'bayn.candidate-development-verified-source.v1',
  sourceRevision: 'a'.repeat(40),
  modulePath: candidate19Preregistration.modulePath,
  moduleBlobOid: 'b'.repeat(40),
  moduleSha256: candidate19Preregistration.moduleSha256,
  sourceManifestPath,
  sourceManifestBlobOid: 'c'.repeat(40),
  sourceManifestSha256: 'd'.repeat(64),
  sourceManifest,
  baselineRunId: 'e'.repeat(64),
  stressedRunId: 'f'.repeat(64),
})

const verifiedSourceFiles: CandidateDevelopmentVerifiedSourceFiles = {
  schemaVersion: 'bayn.candidate-development-verified-source-files.v1',
  sourceRevision: 'a'.repeat(40),
  modulePath: candidate19Preregistration.modulePath,
  moduleBlobOid: 'b'.repeat(40),
  moduleSha256: candidate19Preregistration.moduleSha256,
  sourceManifestPath,
  sourceManifestBlobOid: 'c'.repeat(40),
  sourceManifestSha256: 'd'.repeat(64),
  sourceManifest: candidate19SourceManifest,
}

describe('Candidate 19 inverse-volatility preregistration', () => {
  test('binds the immutable result-blind artifact, complete lineage, and source identities', () => {
    expect(candidateDevelopmentArtifact.schemaVersion).toBe('bayn.candidate-development-artifact.v1')
    expect(candidateDevelopmentArtifact.input).toMatchObject({
      candidateOrdinal: 19,
      priorTrialCount: 18,
      expectedStrategyProtocolHash: candidate19Preregistration.strategyProtocolHash,
      featureLookbackSessions: 63,
    })
    expect(candidateDevelopmentArtifact.input.officialSessions).toHaveLength(1_762)
    expect(canonicalHashV1(candidateDevelopmentArtifact.strategyProtocol)).toBe(
      candidate19Preregistration.strategyProtocolHash,
    )
    expect(canonicalHashV1(candidateDevelopmentArtifact.strategyProtocol.strategyIdentity)).toBe(
      candidate19Preregistration.strategyIdentityHash!,
    )
    expect(candidateDevelopmentArtifact.structuralBindings).toEqual({
      schemaVersion: 'bayn.candidate-development-artifact-structural-bindings.v1',
      candidateOrdinal: 19,
      priorTrialCount: 18,
      strategyProtocolHash: candidate19Preregistration.strategyProtocolHash,
      strategyIdentityHash: candidate19Preregistration.strategyIdentityHash!,
      candidateDevelopmentProtocolHash: candidate19Preregistration.candidateDevelopmentProtocolHash!,
      calendarHash: candidate19Preregistration.calendarHash!,
      priorTrialsHash: candidate19Preregistration.priorTrialsHash!,
      modulePath: candidate19Preregistration.modulePath,
      sourceManifestPath,
    })
    const { preregistration: _gitPreregistration, ...preregistrationDocument } = candidate19Preregistration
    expect(rawPreregistration).toEqual(preregistrationDocument as typeof rawPreregistration)
    expect(candidate19SourceManifest).toMatchObject({
      candidateOrdinal: 19,
      priorTrialCount: 18,
      modulePath: candidate19Preregistration.modulePath,
      moduleSha256: candidate19Preregistration.moduleSha256,
    })
    expect(frozenCandidateDevelopmentTrialHistory.completedCandidateOrdinals).toEqual(
      Array.from({ length: 16 }, (_, index) => index + 1),
    )
    expect(frozenCandidateDevelopmentTrialHistory.developmentCandidateOrdinals).toEqual([17, 18, 19])
    expect(frozenCandidateDevelopmentTrialHistory.latestDevelopmentEvidence).toMatchObject({
      candidateOrdinal: 19,
      priorTrialCount: 18,
      evidenceContentHash: candidate19DevelopmentFailureEvidenceExpectation.contentHash,
      developmentMetricsObserved: true,
      qualificationAttemptConsumed: false,
    })
    expect(frozenCandidateDevelopmentTrialHistory.latestReviewedCandidatePreregistration).toEqual(
      candidate20Preregistration,
    )
    expect(frozenCandidateDevelopmentTrialHistory.nextCandidatePreregistration).toEqual(candidate20Preregistration)
    expect(candidate19Planner.specification).toEqual({
      id: 'inverse-volatility-63-spy-dbc-ten-percent-target-risk-cash',
      lookbackSessions: 63,
      annualizationSessions: 252,
      riskAssets: ['SPY', 'DBC'],
      covarianceEstimator: 'sample',
      targetAnnualizedVolatility: 0.1,
      maximumGrossExposure: 1,
    })
    expect(typeof candidateDevelopmentArtifact.buildEvaluation).toBe('function')
  })

  test('allocates only by causal inverse volatility and covariance risk without momentum filtering', () => {
    const sessions = syntheticSessions()
    const decision = successOf(candidate19Planner.decisionAtSignal(sessions, 63, false))
    const grossExposure = Object.values(decision.weights).reduce((sum, weight) => sum + weight, 0)

    expect(decision.feature.totalReturns.SPY).toBeLessThan(0)
    expect(decision.feature.totalReturns.DBC).toBeGreaterThan(0)
    expect(decision.feature.annualizedVolatilities.SPY).toBeLessThan(decision.feature.annualizedVolatilities.DBC)
    expect(decision.feature.normalizedInverseVolatilityWeights.SPY).toBeGreaterThan(
      decision.feature.normalizedInverseVolatilityWeights.DBC,
    )
    expect(decision.weights.SPY).toBeGreaterThan(0)
    expect(decision.weights.DBC).toBeGreaterThan(0)
    expect(decision.weights.EFA).toBe(0)
    expect(decision.weights.IEF).toBe(0)
    expect(decision.weights.VNQ).toBe(0)
    expect(grossExposure).toBeGreaterThan(0)
    expect(grossExposure).toBeLessThanOrEqual(1)
    expect(decision.feature.exposureScale).toBeLessThanOrEqual(1)
    expect(decision.feature.unscaledAnnualizedPortfolioVolatility).toBeGreaterThan(0)

    const terminal = successOf(candidate19Planner.decisionAtSignal(sessions, 63, true))
    expect(Object.values(terminal.weights).every((weight) => weight === 0)).toBe(true)
  })

  test('derives the exact complete v2 prior-trials hash and binds both qualification and development history', () => {
    expect(deriveCandidateDevelopmentPriorTrialsHash(candidate19PriorTrialsMaterial)).toEqual(
      Result.succeed(candidate19Preregistration.priorTrialsHash!),
    )
    expect(
      deriveCandidateDevelopmentPriorTrialsHash({
        ...candidate19PriorTrialsMaterial,
        latestDevelopmentEvidence: {
          ...candidate19PriorTrialsMaterial.latestDevelopmentEvidence,
          evidenceContentHash: '0'.repeat(64),
        },
      }),
    ).not.toEqual(Result.succeed(candidate19Preregistration.priorTrialsHash!))
    expect(
      deriveCandidateDevelopmentPriorTrialsHash({
        ...candidate19PriorTrialsMaterial,
        latestQualificationEvidence: {
          ...candidate19PriorTrialsMaterial.latestQualificationEvidence,
          sourceRevision: '0'.repeat(40),
        },
      }),
    ).not.toEqual(Result.succeed(candidate19Preregistration.priorTrialsHash!))
  })

  test('records the sole terminal attempt and blocks registration before any rerun', () => {
    expect(Result.isSuccess(candidate19DevelopmentFailureEvidenceResult)).toBe(true)
    if (Result.isFailure(candidate19DevelopmentFailureEvidenceResult)) {
      throw new Error('expected Candidate 19 failure evidence to be valid')
    }
    const evidence = candidate19DevelopmentFailureEvidenceResult.success
    expect(evidence).toMatchObject({
      candidateOrdinal: 19,
      priorTrialCount: 18,
      status: 'DEVELOPMENT_REJECTED',
      qualificationAttemptConsumed: false,
      nextCandidatePreregistration: null,
      verifiedSource: {
        sourceRevision: candidate19DevelopmentFailureEvidenceExpectation.sourceRevision,
        moduleBlobOid: 'cc06d8506ba408aa8e24436a6b60faeadfb96d23',
        sourceManifestBlobOid: '4c34e00d3b9e695cf5b7977ddc635b522fc14e31',
      },
      attempt: {
        stage: 'development-evaluation',
        developmentMetricsObserved: true,
        developmentReportWritten: false,
        evaluationRerunAuthorized: false,
        exitCode: 1,
      },
      contentHash: candidate19DevelopmentFailureEvidenceExpectation.contentHash,
    })
    expect(candidate19DevelopmentEligibility).toEqual({
      status: 'DEVELOPMENT_REJECTED',
      evidenceContentHash: candidate19DevelopmentFailureEvidenceExpectation.contentHash,
      nextCandidatePreregistration: null,
    })
    expect(preregisterCandidateDevelopmentAttempt(evidence.verifiedSource)).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-program-binding',
        cause: {
          field: 'trialHistory.nextCandidatePreregistration.source.candidateOrdinal',
          expected: 20,
          observed: 19,
        },
      },
    })

    const attemptOutput = readFileSync(
      new URL(
        '../candidates/ordinal-19-inverse-volatility-risk-diversification-development-attempt.log',
        import.meta.url,
      ),
      'utf8',
    )
    expect(
      validateCandidate19DevelopmentFailureEvidence(rawDevelopmentEvidence, `${attemptOutput}tampered`),
    ).toMatchObject({
      failure: {
        _tag: 'Candidate19DevelopmentFailureEvidenceBindingMismatch',
        field: 'attempt.failure.capturedOutputSha256',
      },
    })
    expect(
      validateCandidate19DevelopmentFailureEvidence(
        { ...rawDevelopmentEvidence, contentHash: '0'.repeat(64) },
        attemptOutput,
      ),
    ).toMatchObject({ failure: { _tag: 'Candidate19DevelopmentFailureEvidenceContentHashMismatch' } })
  })

  test('rejects the terminal Candidate 19 artifact before metric evaluation after Candidate 20 precommit', async () => {
    expect(
      validateCandidateDevelopmentArtifactStructure(
        candidateDevelopmentArtifact.structuralBindings,
        candidate19Input,
        candidateDevelopmentArtifact.strategyProtocol,
        verifiedSource(),
      ),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-program-binding',
        cause: {
          field: 'artifact.structuralBindings.priorTrialsHash',
          expected: candidate20Preregistration.priorTrialsHash,
          observed: candidate19Preregistration.priorTrialsHash,
        },
      },
    })

    const source = `
      export const candidateDevelopmentArtifact = {
        schemaVersion: 'bayn.candidate-development-artifact.v1',
        input: ${JSON.stringify(candidateDevelopmentArtifact.input)},
        strategyProtocol: ${JSON.stringify(candidateDevelopmentArtifact.strategyProtocol)},
        structuralBindings: ${JSON.stringify(candidateDevelopmentArtifact.structuralBindings)},
        buildEvaluation: () => { throw new Error('metric-attempt-entered') },
      }
    `
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
    const failure = await Effect.runPromise(
      Effect.flip(evaluateCandidateDevelopmentArtifact(moduleUrl, verifiedSourceFiles)),
    )
    expect(failure).toMatchObject({
      _tag: 'CandidateDevelopmentCommandModuleLoadFailed',
      cause: {
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-program-binding',
        cause: {
          field: 'trialHistory.latestReviewedCandidatePreregistration.input.candidateOrdinal',
          expected: 20,
          observed: 19,
        },
      },
    })
    expect(JSON.stringify(failure)).not.toContain('metric-attempt-entered')
  })
})

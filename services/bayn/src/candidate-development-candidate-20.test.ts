import { describe, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Effect, Result } from 'effect'

import rawPreregistration from '../candidates/ordinal-20-cross-sectional-short-term-reversal-preregistration.json' with { type: 'json' }
import rawSourceManifest from '../candidates/ordinal-20-cross-sectional-short-term-reversal-source-manifest.json' with { type: 'json' }
import type { CandidateDevelopmentPreflightInput } from './candidate-development'
import {
  candidate19DevelopmentFailureEvidenceExpectation,
  candidate20Preregistration,
  candidate20PriorTrialsMaterial,
  deriveCandidateDevelopmentPriorTrialsHash,
  frozenCandidateDevelopmentSessions,
  frozenCandidateDevelopmentTrialHistory,
} from './candidate-development-calendar'
import {
  preregisterCandidateDevelopmentAttempt,
  validateCandidateDevelopmentArtifactStructure,
  verifyCandidateDevelopmentPreregistrationLineage,
  verifyCandidateDevelopmentPreregistrationModuleNovelty,
  verifyCandidateDevelopmentRepositoryIntegrity,
  type CandidateDevelopmentArtifactStructuralBindings,
  type CandidateDevelopmentSourceManifest,
  type CandidateDevelopmentStrategyProtocol,
  type CandidateDevelopmentVerifiedSource,
} from './candidate-development-command'
import { canonicalHashV1 } from './hash'
import {
  candidate20Planner as untypedCandidate20Planner,
  candidateDevelopmentArtifact as untypedCandidateDevelopmentArtifact,
} from './strategy/cross-sectional-short-term-reversal/candidate-20'

type Candidate20Symbol = 'DBC' | 'EFA' | 'IEF' | 'SPY' | 'VNQ'

interface Candidate20Bar {
  readonly symbol: Candidate20Symbol
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

interface Candidate20Session {
  readonly date: string
  readonly bars: Readonly<Record<Candidate20Symbol, Candidate20Bar>>
}

type Candidate20Result<A> =
  | { readonly _tag: 'Success'; readonly success: A }
  | { readonly _tag: 'Failure'; readonly failure: unknown }

interface Candidate20Feature {
  readonly totalReturns: Readonly<Record<Candidate20Symbol, number>>
  readonly annualizedVolatilities: Readonly<Record<Candidate20Symbol, number>>
  readonly rankedSymbols: readonly Candidate20Symbol[]
  readonly selectedSymbols: readonly Candidate20Symbol[]
}

interface Candidate20Decision {
  readonly feature: Candidate20Feature
  readonly weights: Readonly<Record<Candidate20Symbol, number>>
}

interface Candidate20PlannerContract {
  readonly specification: {
    readonly id: 'cross-sectional-short-term-reversal-21-two-losers-half-weight-cash'
    readonly lookbackSessions: 21
    readonly annualizationSessions: 252
    readonly rankedAssets: readonly ['DBC', 'EFA', 'IEF', 'SPY', 'VNQ']
    readonly maximumSelections: 2
    readonly weightPerSelection: 0.5
    readonly requireNegativeReturn: true
    readonly tieBreak: 'symbol-ascending'
    readonly maximumGrossExposure: 1
  }
  readonly decisionAtSignal: (
    sessions: readonly Candidate20Session[],
    signalIndex: number,
    terminal: boolean,
  ) => Candidate20Result<Candidate20Decision>
}

interface Candidate20ArtifactContract {
  readonly schemaVersion: 'bayn.candidate-development-artifact.v1'
  readonly input: {
    readonly candidateOrdinal: 20
    readonly priorTrialCount: 19
    readonly expectedStrategyProtocolHash: string
    readonly officialSessions: readonly string[]
    readonly signalSessionDates: readonly string[]
    readonly featureLookbackSessions: 21
  }
  readonly strategyProtocol: CandidateDevelopmentStrategyProtocol
  readonly structuralBindings: CandidateDevelopmentArtifactStructuralBindings
  readonly buildEvaluation: (source: unknown) => unknown
}

const candidate20Planner = untypedCandidate20Planner as unknown as Candidate20PlannerContract
const candidateDevelopmentArtifact = untypedCandidateDevelopmentArtifact as unknown as Candidate20ArtifactContract
const candidate20Input = candidateDevelopmentArtifact.input as unknown as CandidateDevelopmentPreflightInput
const candidate20SourceManifest = rawSourceManifest as CandidateDevelopmentSourceManifest
const symbols = ['DBC', 'EFA', 'IEF', 'SPY', 'VNQ'] as const satisfies readonly Candidate20Symbol[]
const modulePath = 'services/bayn/src/strategy/cross-sectional-short-term-reversal/candidate-20.ts'
const sourceManifestPath =
  'services/bayn/candidates/ordinal-20-cross-sectional-short-term-reversal-source-manifest.json'
const sourceManifestSha256 = createHash('sha256')
  .update(
    readFileSync(
      new URL(`../candidates/ordinal-20-cross-sectional-short-term-reversal-source-manifest.json`, import.meta.url),
    ),
  )
  .digest('hex')

const successOf = <A>(result: Candidate20Result<A>): A => {
  expect(result._tag).toBe('Success')
  if (result._tag === 'Failure') throw new Error('expected Candidate 20 planner success')
  return result.success
}

const syntheticSessions = (
  terminalRatios: Readonly<Record<Candidate20Symbol, number>>,
  amplitudes: Readonly<Record<Candidate20Symbol, number>> = {
    DBC: 0.004,
    EFA: 0.006,
    IEF: 0.003,
    SPY: 0.005,
    VNQ: 0.007,
  },
): readonly Candidate20Session[] =>
  frozenCandidateDevelopmentSessions()
    .slice(0, 23)
    .map((date, index) => {
      const bars = {} as Record<Candidate20Symbol, Candidate20Bar>
      for (const symbol of symbols) {
        const close =
          100 *
          Math.exp(
            Math.log(terminalRatios[symbol]) * (index / 21) + amplitudes[symbol] * Math.sin((2 * Math.PI * index) / 21),
          )
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
  sourceManifest: CandidateDevelopmentSourceManifest = candidate20SourceManifest,
): CandidateDevelopmentVerifiedSource => ({
  schemaVersion: 'bayn.candidate-development-verified-source.v1',
  sourceRevision: 'a'.repeat(40),
  modulePath,
  moduleBlobOid: 'b'.repeat(40),
  moduleSha256: candidate20Preregistration.moduleSha256,
  sourceManifestPath,
  sourceManifestBlobOid: 'c'.repeat(40),
  sourceManifestSha256,
  sourceManifest,
  baselineRunId: 'd'.repeat(64),
  stressedRunId: 'e'.repeat(64),
})

const execFilePromise = promisify(execFile)
const cleanGitEnvironment = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')))

describe('Candidate 20 cross-sectional short-term reversal preregistration', () => {
  test('binds one immutable result-blind next candidate while preserving Candidate 19 terminal state', () => {
    expect(candidateDevelopmentArtifact.schemaVersion).toBe('bayn.candidate-development-artifact.v1')
    expect(candidateDevelopmentArtifact.input).toMatchObject({
      candidateOrdinal: 20,
      priorTrialCount: 19,
      expectedStrategyProtocolHash: candidate20Preregistration.strategyProtocolHash,
      featureLookbackSessions: 21,
    })
    expect(candidateDevelopmentArtifact.input.officialSessions).toHaveLength(1_762)
    expect(canonicalHashV1(candidateDevelopmentArtifact.strategyProtocol)).toBe(
      candidate20Preregistration.strategyProtocolHash,
    )
    expect(canonicalHashV1(candidateDevelopmentArtifact.strategyProtocol.strategyIdentity)).toBe(
      candidate20Preregistration.strategyIdentityHash!,
    )
    expect(candidateDevelopmentArtifact.strategyProtocol.strategyIdentity).toEqual({
      schemaVersion: 'bayn.candidate-development-strategy-identity.v2',
      family: 'inverse-volatility-risk-diversification',
      identifier: 'candidate-20-cross-sectional-short-term-reversal-21-session-etf-losers',
      researchSources: [
        'https://doi.org/10.1111/j.1540-6261.1990.tb05110.x',
        'https://doi.org/10.2307/2937816',
        'https://doi.org/10.1093/rfs/3.2.175',
      ],
      parameters: {
        id: 'cross-sectional-short-term-reversal-21-two-losers-half-weight-cash',
        lookbackSessions: 21,
        annualizationSessions: 252,
        riskAssets: ['DBC', 'SPY'],
        covarianceEstimator: 'sample',
        targetAnnualizedVolatility: 0.1,
        maximumGrossExposure: 1,
      },
      input: '22-adjusted-closes-ending-at-each-finalized-month-end-for-dbc-efa-ief-spy-vnq',
      weighting:
        'rank-all-five-etfs-by-ascending-21-session-return-select-at-most-two-strictly-negative-losers-at-fixed-half-weight',
      riskScaling:
        'none-covariance-and-target-volatility-fields-are-v2-schema-compatibility-metadata-and-do-not-affect-strategy-weights',
      allocation: 'long-only-up-to-two-assets-with-unallocated-capital-held-as-cash-no-leverage-no-shorting',
      schedule: 'official-month-end-finalized-close-to-next-session-open',
      terminal: '2022-11-30-signal-liquidates-at-2022-12-01-open-and-remains-cash',
      missingData: 'fail-closed-no-imputation-and-no-nonfinite-return-or-volatility',
      doubledCost: 'fixed-baseline-signal-and-ordered-requested-filled-quantity-path-repriced-at-two-times-cost',
    })
    expect(candidateDevelopmentArtifact.structuralBindings).toEqual({
      schemaVersion: 'bayn.candidate-development-artifact-structural-bindings.v1',
      candidateOrdinal: 20,
      priorTrialCount: 19,
      strategyProtocolHash: candidate20Preregistration.strategyProtocolHash,
      strategyIdentityHash: candidate20Preregistration.strategyIdentityHash!,
      candidateDevelopmentProtocolHash: candidate20Preregistration.candidateDevelopmentProtocolHash!,
      calendarHash: candidate20Preregistration.calendarHash!,
      priorTrialsHash: candidate20Preregistration.priorTrialsHash!,
      modulePath,
      sourceManifestPath,
    })

    const { preregistration: _gitPreregistration, ...preregistrationDocument } = candidate20Preregistration
    expect(rawPreregistration).toEqual(preregistrationDocument as typeof rawPreregistration)
    expect(candidate20SourceManifest).toMatchObject({
      candidateOrdinal: 20,
      priorTrialCount: 19,
      modulePath,
      moduleSha256: candidate20Preregistration.moduleSha256,
      moduleFormat: 'self-contained-esm-v1',
    })
    const moduleSha256 = createHash('sha256')
      .update(readFileSync(new URL('./strategy/cross-sectional-short-term-reversal/candidate-20.ts', import.meta.url)))
      .digest('hex')
    expect(moduleSha256).toBe(candidate20Preregistration.moduleSha256)

    expect(frozenCandidateDevelopmentTrialHistory.completedCandidateOrdinals).toEqual(
      Array.from({ length: 16 }, (_, index) => index + 1),
    )
    expect(frozenCandidateDevelopmentTrialHistory.developmentCandidateOrdinals).toEqual([17, 18, 19])
    expect(frozenCandidateDevelopmentTrialHistory.developmentCandidateOrdinals).not.toContain(20)
    expect(frozenCandidateDevelopmentTrialHistory.latestDevelopmentEvidence).toMatchObject({
      candidateOrdinal: 19,
      priorTrialCount: 18,
      status: 'DEVELOPMENT_REJECTED',
      evidenceContentHash: candidate19DevelopmentFailureEvidenceExpectation.evidenceContentHash,
      developmentMetricsObserved: true,
      qualificationAttemptConsumed: false,
    })
    expect(frozenCandidateDevelopmentTrialHistory.latestReviewedCandidatePreregistration).toEqual(
      candidate20Preregistration,
    )
    expect(frozenCandidateDevelopmentTrialHistory.nextCandidatePreregistration).toEqual(candidate20Preregistration)
    expect(frozenCandidateDevelopmentTrialHistory.nextCandidatePreregistration?.candidateOrdinal).toBe(20)
    expect(typeof candidateDevelopmentArtifact.buildEvaluation).toBe('function')
  })

  test('selects only the two lowest negative returns with fixed weights and no risk-estimate weighting', () => {
    const sessions = syntheticSessions({ DBC: 0.9, EFA: 1.03, IEF: 0.97, SPY: 0.84, VNQ: 1.08 })
    const decision = successOf(candidate20Planner.decisionAtSignal(sessions, 21, false))

    expect(decision.feature.rankedSymbols).toEqual(['SPY', 'DBC', 'IEF', 'EFA', 'VNQ'])
    expect(decision.feature.selectedSymbols).toEqual(['SPY', 'DBC'])
    expect(decision.weights).toEqual({ DBC: 0.5, EFA: 0, IEF: 0, SPY: 0.5, VNQ: 0 })

    const changedRisk = syntheticSessions(
      { DBC: 0.9, EFA: 1.03, IEF: 0.97, SPY: 0.84, VNQ: 1.08 },
      { DBC: 0.001, EFA: 0.08, IEF: 0.12, SPY: 0.16, VNQ: 0.2 },
    )
    const changedRiskDecision = successOf(candidate20Planner.decisionAtSignal(changedRisk, 21, false))
    expect(changedRiskDecision.feature.selectedSymbols).toEqual(decision.feature.selectedSymbols)
    expect(changedRiskDecision.weights).toEqual(decision.weights)
    expect(changedRiskDecision.feature.annualizedVolatilities.SPY).not.toBe(decision.feature.annualizedVolatilities.SPY)
  })

  test('uses deterministic symbol ties, leaves residual cash, ignores future bars, and fails closed', () => {
    const tied = syntheticSessions({ DBC: 0.9, EFA: 0.9, IEF: 1.02, SPY: 0.9, VNQ: 1.04 })
    const tiedDecision = successOf(candidate20Planner.decisionAtSignal(tied, 21, false))
    expect(tiedDecision.feature.rankedSymbols.slice(0, 3)).toEqual(['DBC', 'EFA', 'SPY'])
    expect(tiedDecision.feature.selectedSymbols).toEqual(['DBC', 'EFA'])

    const oneLoser = syntheticSessions({ DBC: 1.02, EFA: 1.03, IEF: 1.01, SPY: 0.92, VNQ: 1.04 })
    const oneLoserDecision = successOf(candidate20Planner.decisionAtSignal(oneLoser, 21, false))
    expect(oneLoserDecision.feature.selectedSymbols).toEqual(['SPY'])
    expect(oneLoserDecision.weights).toEqual({ DBC: 0, EFA: 0, IEF: 0, SPY: 0.5, VNQ: 0 })

    const allPositive = syntheticSessions({ DBC: 1.02, EFA: 1.03, IEF: 1.01, SPY: 1.04, VNQ: 1.05 })
    const cashDecision = successOf(candidate20Planner.decisionAtSignal(allPositive, 21, false))
    expect(Object.values(cashDecision.weights).every((weight) => weight === 0)).toBe(true)

    const futureMutated = structuredClone(tied)
    const futureBar = futureMutated[22]!.bars.SPY
    futureMutated[22]!.bars.SPY = { ...futureBar, close: futureBar.close * 10 }
    expect(JSON.stringify(candidate20Planner.decisionAtSignal(futureMutated, 21, false))).toBe(
      JSON.stringify(candidate20Planner.decisionAtSignal(tied, 21, false)),
    )

    const malformed = structuredClone(tied)
    malformed[21]!.bars.SPY = { ...malformed[21]!.bars.SPY, close: Number.NaN }
    expect(candidate20Planner.decisionAtSignal(malformed, 21, false)).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'Candidate20InvalidInput', operation: 'feature-window' },
    })

    const terminal = successOf(candidate20Planner.decisionAtSignal(tied, 21, true))
    expect(Object.values(terminal.weights).every((weight) => weight === 0)).toBe(true)
  })

  test('binds the complete Candidate 19 terminal prior-trials hash and rejects structural drift', () => {
    expect(deriveCandidateDevelopmentPriorTrialsHash(candidate20PriorTrialsMaterial)).toEqual(
      Result.succeed(candidate20Preregistration.priorTrialsHash!),
    )
    expect(
      deriveCandidateDevelopmentPriorTrialsHash({
        ...candidate20PriorTrialsMaterial,
        latestDevelopmentEvidence: {
          ...candidate20PriorTrialsMaterial.latestDevelopmentEvidence,
          evidenceContentHash: '0'.repeat(64),
        },
      }),
    ).not.toEqual(Result.succeed(candidate20Preregistration.priorTrialsHash!))

    const exactSource = verifiedSource()
    expect(
      validateCandidateDevelopmentArtifactStructure(
        candidateDevelopmentArtifact.structuralBindings,
        candidate20Input,
        candidateDevelopmentArtifact.strategyProtocol,
        exactSource,
      ),
    ).toEqual(Result.succeed(candidateDevelopmentArtifact.structuralBindings))
    expect(preregisterCandidateDevelopmentAttempt(exactSource)).toEqual(Result.succeed(sourceManifestSha256))

    const drifts: readonly [keyof CandidateDevelopmentArtifactStructuralBindings, unknown][] = [
      ['candidateOrdinal', 19],
      ['priorTrialCount', 18],
      ['strategyProtocolHash', '0'.repeat(64)],
      ['strategyIdentityHash', '1'.repeat(64)],
      ['candidateDevelopmentProtocolHash', '2'.repeat(64)],
      ['calendarHash', '3'.repeat(64)],
      ['priorTrialsHash', '4'.repeat(64)],
      ['modulePath', 'services/bayn/src/strategy/stale/candidate-20.ts'],
      ['sourceManifestPath', 'services/bayn/candidates/stale-source-manifest.json'],
    ]
    for (const [field, observed] of drifts) {
      expect(
        validateCandidateDevelopmentArtifactStructure(
          { ...candidateDevelopmentArtifact.structuralBindings, [field]: observed },
          candidate20Input,
          candidateDevelopmentArtifact.strategyProtocol,
          exactSource,
        ),
      ).toMatchObject({
        failure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-program-binding',
        },
      })
    }

    expect(
      preregisterCandidateDevelopmentAttempt(verifiedSource({ ...candidate20SourceManifest, candidateOrdinal: 21 })),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-program-binding',
        cause: {
          field: 'trialHistory.nextCandidatePreregistration.source.candidateOrdinal',
          expected: 20,
          observed: 21,
        },
      },
    })
  })

  test('requires raw proper ancestry, novel module bytes, and replacement-disabled repositories', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'bayn-candidate-20-source-'))
    const git = async (...args: readonly string[]): Promise<string> => {
      const result = await execFilePromise('git', args, {
        cwd: repository,
        encoding: 'utf8',
        env: cleanGitEnvironment(),
      })
      return result.stdout.trim()
    }
    try {
      await git('init', '-q')
      await git('config', 'user.name', 'Candidate Test')
      await git('config', 'user.email', 'candidate@example.test')
      await writeFile(join(repository, 'preregistration.json'), '{"candidateOrdinal":20}\n')
      await git('add', 'preregistration.json')
      await git('commit', '-q', '-m', 'preregister')
      const preregistrationRevision = await git('rev-parse', 'HEAD')
      const preregistrationBlob = await git('rev-parse', 'HEAD:preregistration.json')

      await writeFile(join(repository, 'candidate-20.ts'), 'export const candidate = 20\n')
      await git('add', 'candidate-20.ts')
      await git('commit', '-q', '-m', 'source')
      const sourceRevision = await git('rev-parse', 'HEAD')
      const moduleBlob = await git('rev-parse', 'HEAD:candidate-20.ts')

      await Effect.runPromise(
        verifyCandidateDevelopmentPreregistrationLineage(repository, preregistrationRevision, sourceRevision),
      )
      await Effect.runPromise(
        verifyCandidateDevelopmentPreregistrationModuleNovelty(
          repository,
          preregistrationRevision,
          'candidate-20.ts',
          moduleBlob,
        ),
      )

      expect(
        await Effect.runPromise(
          Effect.flip(verifyCandidateDevelopmentPreregistrationLineage(repository, sourceRevision, sourceRevision)),
        ),
      ).toMatchObject({
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-preregistration-lineage',
      })
      expect(
        await Effect.runPromise(
          Effect.flip(
            verifyCandidateDevelopmentPreregistrationModuleNovelty(
              repository,
              preregistrationRevision,
              'candidate-20.ts',
              preregistrationBlob,
            ),
          ),
        ),
      ).toMatchObject({
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-preregistration-module-novelty',
      })

      await git('replace', preregistrationRevision, sourceRevision)
      expect(
        await Effect.runPromise(Effect.flip(verifyCandidateDevelopmentRepositoryIntegrity(repository))),
      ).toMatchObject({
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-repository-integrity',
        cause: { field: 'replaceRefs' },
      })
    } finally {
      await rm(repository, { recursive: true, force: true })
    }
  })
})

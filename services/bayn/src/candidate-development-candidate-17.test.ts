import { describe, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'

import {
  frozenCandidateDevelopmentSessions,
  frozenCandidateDevelopmentTrialHistory,
} from './candidate-development-calendar'
import {
  verifyCandidateDevelopmentPreregistrationLineage,
  verifyCandidateDevelopmentPreregistrationModuleNovelty,
} from './candidate-development-command'
import { canonicalHashV1 } from './hash'
import {
  candidate17Planner as untypedCandidate17Planner,
  candidateDevelopmentArtifact as untypedCandidateDevelopmentArtifact,
} from './strategy/volatility-managed-trend-overlay/candidate-17'

type Candidate17Symbol = 'DBC' | 'EFA' | 'IEF' | 'SPY' | 'VNQ'

interface Candidate17Bar {
  readonly symbol: Candidate17Symbol
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

interface Candidate17Session {
  readonly date: string
  readonly bars: Readonly<Record<Candidate17Symbol, Candidate17Bar>>
}

type Candidate17Result<A> =
  | { readonly _tag: 'Success'; readonly success: A }
  | { readonly _tag: 'Failure'; readonly failure: unknown }

interface Candidate17Feature {
  readonly windowStart: string
  readonly windowEnd: string
  readonly totalReturns: Readonly<Record<Candidate17Symbol, number>>
  readonly eligibleSymbols: readonly Exclude<Candidate17Symbol, 'SPY'>[]
  readonly activeBasketAnnualizedVariance: number
  readonly activeSleeveWeight: number
}

interface Candidate17Decision {
  readonly signalDate: string
  readonly executionDate: string
  readonly feature: Candidate17Feature
  readonly weights: Readonly<Record<Candidate17Symbol, number>>
  readonly decisionPlan: unknown
}

interface Candidate17PlannerContract {
  readonly specification: {
    readonly id: 'spy70-active-trend252-basket-variance21-target10-cap29p5-cash0p5'
    readonly lookbackSessions: 252
    readonly activeVolatilityWindowSessions: 21
    readonly annualizationSessions: 252
    readonly fixedSpyCoreWeight: 0.7
    readonly maximumActiveSleeveWeight: 0.295
    readonly minimumCashReserveWeight: 0.005
    readonly targetActiveAnnualizedVolatility: 0.1
  }
  readonly featureAtSignal: (
    sessions: readonly Candidate17Session[],
    signalIndex: number,
  ) => Candidate17Result<Candidate17Feature>
  readonly decisionAtSignal: (
    sessions: readonly Candidate17Session[],
    signalIndex: number,
    terminal: boolean,
  ) => Candidate17Result<Candidate17Decision>
}

interface Candidate17ArtifactContract {
  readonly schemaVersion: 'bayn.candidate-development-artifact.v1'
  readonly input: {
    readonly candidateOrdinal: 17
    readonly priorTrialCount: 16
    readonly expectedStrategyProtocolHash: string
    readonly officialSessions: readonly string[]
    readonly signalSessionDates: readonly string[]
    readonly featureLookbackSessions: 252
  }
  readonly strategyProtocol: unknown
  readonly buildEvaluation: (source: unknown) => unknown
}

const candidate17Planner = untypedCandidate17Planner as unknown as Candidate17PlannerContract
const candidateDevelopmentArtifact = untypedCandidateDevelopmentArtifact as unknown as Candidate17ArtifactContract

const modulePath = 'services/bayn/src/strategy/volatility-managed-trend-overlay/candidate-17.ts'
const moduleSha256 = '2e98bc55eae1901ccdde41978b7b32d746dc2ef6afcebbff1de0ed54574065da'
const preregistrationRevision = '890d8f5801cf7c7576ed7a0cee387a4e79b98877'
const preregistrationBlobOid = 'c1d07233df53cc0379b1dfae9f1caffbd6b7abd6'
const strategyProtocolHash = 'fa25d8c16bc4f4fde3bab99409ae60a6fd23332d295b3557231796cebb911390'
const symbols = ['DBC', 'EFA', 'IEF', 'SPY', 'VNQ'] as const satisfies readonly Candidate17Symbol[]

const successOf = <A>(result: Candidate17Result<A>): A => {
  expect(result._tag).toBe('Success')
  if (result._tag === 'Failure') throw new Error('expected Candidate 17 planner success')
  return result.success
}

const execFilePromise = (file: string, args: readonly string[], cwd: string): Promise<void> =>
  new Promise((resolveExecution, rejectExecution) => {
    execFile(file, [...args], { cwd }, (error) => {
      if (error === null) resolveExecution()
      else rejectExecution(error)
    })
  })

const execFileTextPromise = (file: string, args: readonly string[], cwd: string): Promise<string> =>
  new Promise((resolveExecution, rejectExecution) => {
    execFile(file, [...args], { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error === null) resolveExecution(stdout.trim())
      else rejectExecution(error)
    })
  })

const initializeRepository = async (repository: string): Promise<void> => {
  await execFilePromise('git', ['init', '-q'], repository)
  await execFilePromise('git', ['config', 'user.name', 'Candidate 17 Test'], repository)
  await execFilePromise('git', ['config', 'user.email', 'candidate-17@example.test'], repository)
}

const commitAll = async (repository: string, message: string): Promise<string> => {
  await execFilePromise('git', ['add', '-A'], repository)
  await execFilePromise('git', ['commit', '-qm', message], repository)
  return execFileTextPromise('git', ['rev-parse', 'HEAD'], repository)
}

const syntheticSessions = (): readonly Candidate17Session[] =>
  frozenCandidateDevelopmentSessions()
    .slice(0, 320)
    .map((date, index) => {
      const bars = {} as Record<Candidate17Symbol, Candidate17Bar>
      for (const [ordinal, symbol] of symbols.entries()) {
        const drift = symbol === 'DBC' ? 0.0015 : symbol === 'IEF' ? 0.0007 : symbol === 'SPY' ? 0.001 : -0.0004
        const cycle = 0.008 * Math.sin(index / (3 + ordinal) + ordinal)
        const close = 100 * Math.exp(drift * index + cycle)
        const open = close * (1 + 0.001 * Math.cos(index + ordinal))
        bars[symbol] = {
          symbol,
          sessionDate: date,
          open,
          high: Math.max(open, close) * 1.002,
          low: Math.min(open, close) * 0.998,
          close,
          volume: 1_000_000 + index * 10 + ordinal,
          source: 'alpaca',
          sourceFeed: 'sip',
          adjustment: 'all',
          publicationSchemaVersion: 'signal.adjusted-daily-snapshot.v2',
        }
      }
      return { date, bars }
    })

const mutateFutureBars = (
  sessions: readonly Candidate17Session[],
  signalIndex: number,
): readonly Candidate17Session[] =>
  sessions.map((session, index) => {
    if (index <= signalIndex) return session
    const bars = {} as Record<Candidate17Symbol, Candidate17Bar>
    for (const [ordinal, symbol] of symbols.entries()) {
      const original = session.bars[symbol]
      const multiplier = 100 + index + ordinal
      bars[symbol] = {
        ...original,
        open: original.open * multiplier,
        high: original.high * multiplier,
        low: original.low * multiplier,
        close: original.close * multiplier,
        volume: original.volume * multiplier,
      }
    }
    return { date: session.date, bars }
  })

describe('Candidate 17 preregistration', () => {
  test('binds the exact complete artifact and reviewed two-stage preregistration', () => {
    expect(candidateDevelopmentArtifact.schemaVersion).toBe('bayn.candidate-development-artifact.v1')
    expect(candidateDevelopmentArtifact.input).toMatchObject({
      candidateOrdinal: 17,
      priorTrialCount: 16,
      expectedStrategyProtocolHash: strategyProtocolHash,
      featureLookbackSessions: 252,
    })
    expect(candidateDevelopmentArtifact.input.officialSessions).toHaveLength(1_762)
    expect(candidateDevelopmentArtifact.input.officialSessions.at(0)).toBe('2016-01-04')
    expect(candidateDevelopmentArtifact.input.officialSessions.at(-1)).toBe('2022-12-30')
    expect(typeof candidateDevelopmentArtifact.buildEvaluation).toBe('function')
    expect(canonicalHashV1(candidateDevelopmentArtifact.strategyProtocol)).toBe(strategyProtocolHash)

    expect(candidate17Planner.specification).toMatchObject({
      id: 'spy70-active-trend252-basket-variance21-target10-cap29p5-cash0p5',
      lookbackSessions: 252,
      activeVolatilityWindowSessions: 21,
      annualizationSessions: 252,
      fixedSpyCoreWeight: 0.7,
      maximumActiveSleeveWeight: 0.295,
      minimumCashReserveWeight: 0.005,
      targetActiveAnnualizedVolatility: 0.1,
    })
    expect(frozenCandidateDevelopmentTrialHistory.nextCandidatePreregistration).toEqual({
      schemaVersion: 'bayn.candidate-development-next-preregistration.v1',
      candidateOrdinal: 17,
      priorTrialCount: 16,
      strategyProtocolHash,
      modulePath,
      moduleSha256,
      marketData: {
        schemaVersion: 'bayn.candidate-development-market-data-source.v1',
        snapshotId: '2a91f0177684f7022f746207333e510c8268f9b77a04b778a04220a33ccf79e0',
        finalizedSnapshotContentHash: '8e376546f6a6cc1dbe2e910db3d68f584fc0bd9c4858166042ce32aa077eed0d',
        inputManifestHash: 'b606cf57fb076f5bd2875206973e7c512817430d5cfbbeac8a99396f9983cab4',
        boundedContentHash: 'e0e7b283de187d8ccaf8a449dacc538f00049cfe446dcf153b558e92bf0e17ed',
      },
      preregistration: {
        sourceRevision: preregistrationRevision,
        path: 'services/bayn/candidates/ordinal-17-volatility-managed-trend-overlay-preregistration.json',
        blobOid: preregistrationBlobOid,
      },
    })
  })

  test('keeps future observations out of the causal signal and preserves the financing reserve', () => {
    const sessions = syntheticSessions()
    const signalIndex = 260
    const original = successOf(candidate17Planner.decisionAtSignal(sessions, signalIndex, false))
    const futureMutated = successOf(
      candidate17Planner.decisionAtSignal(mutateFutureBars(sessions, signalIndex), signalIndex, false),
    )

    expect(futureMutated).toEqual(original)
    expect(original.weights.SPY).toBe(0.7)
    const grossExposure = Object.values(original.weights).reduce((sum, weight) => sum + weight, 0)
    const activeExposure = grossExposure - original.weights.SPY
    expect(activeExposure).toBeGreaterThanOrEqual(0)
    expect(activeExposure).toBeLessThanOrEqual(0.295 + 1e-12)
    expect(1 - grossExposure).toBeGreaterThanOrEqual(0.005 - 1e-12)

    const terminal = successOf(candidate17Planner.decisionAtSignal(sessions, signalIndex, true))
    expect(Object.values(terminal.weights).every((weight) => weight === 0)).toBe(true)
  })

  test('accepts only a proper descendant whose executable blob first appears after preregistration', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'bayn-candidate-17-two-stage-'))
    const candidateDirectory = join(repository, 'candidate')
    const fixtureModulePath = join(candidateDirectory, 'program.mjs')
    const fixturePreregistrationPath = join(candidateDirectory, 'preregistration.json')
    const fixtureModule = 'export const candidateDevelopmentArtifact = {}\n'
    try {
      await mkdir(candidateDirectory, { recursive: true })
      await initializeRepository(repository)
      await writeFile(join(repository, 'base.txt'), 'base\n')
      await commitAll(repository, 'test: initialize candidate lineage')

      await writeFile(fixturePreregistrationPath, '{"moduleSha256":"frozen-before-source"}\n')
      const fixturePreregistrationRevision = await commitAll(repository, 'test: preregister candidate hash')

      await writeFile(fixtureModulePath, fixtureModule)
      const fixtureSourceRevision = await commitAll(repository, 'test: add executable after preregistration')
      const fixtureModuleBlobOid = await execFileTextPromise(
        'git',
        ['rev-parse', `${fixtureSourceRevision}:candidate/program.mjs`],
        repository,
      )

      await Effect.runPromise(
        verifyCandidateDevelopmentPreregistrationLineage(
          repository,
          fixturePreregistrationRevision,
          fixtureSourceRevision,
        ),
      )
      await Effect.runPromise(
        verifyCandidateDevelopmentPreregistrationModuleNovelty(
          repository,
          fixturePreregistrationRevision,
          'candidate/program.mjs',
          fixtureModuleBlobOid,
        ),
      )
    } finally {
      await rm(repository, { recursive: true, force: true })
    }
  })

  test('rejects an executable blob that existed before its claimed preregistration', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'bayn-candidate-17-prior-blob-'))
    const candidateDirectory = join(repository, 'candidate')
    const fixtureModulePath = join(candidateDirectory, 'program.mjs')
    const fixturePreregistrationPath = join(candidateDirectory, 'preregistration.json')
    const fixtureModule = 'export const candidateDevelopmentArtifact = {}\n'
    try {
      await mkdir(candidateDirectory, { recursive: true })
      await initializeRepository(repository)
      await writeFile(fixtureModulePath, fixtureModule)
      await commitAll(repository, 'test: commit executable before preregistration')

      await unlink(fixtureModulePath)
      await writeFile(fixturePreregistrationPath, '{"moduleSha256":"claimed-later"}\n')
      const fixturePreregistrationRevision = await commitAll(repository, 'test: claim preregistration after source')

      await writeFile(fixtureModulePath, fixtureModule)
      const fixtureSourceRevision = await commitAll(repository, 'test: restore prior executable')
      const fixtureModuleBlobOid = await execFileTextPromise(
        'git',
        ['rev-parse', `${fixtureSourceRevision}:candidate/program.mjs`],
        repository,
      )

      const failure = await Effect.runPromise(
        Effect.flip(
          verifyCandidateDevelopmentPreregistrationModuleNovelty(
            repository,
            fixturePreregistrationRevision,
            'candidate/program.mjs',
            fixtureModuleBlobOid,
          ),
        ),
      )
      expect(failure).toMatchObject({
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-preregistration-module-novelty',
        cause: {
          preregistrationRevision: fixturePreregistrationRevision,
          modulePath: 'candidate/program.mjs',
          expected: 'evaluated module blob created after preregistration',
          observed: fixtureModuleBlobOid,
        },
      })
    } finally {
      await rm(repository, { recursive: true, force: true })
    }
  })
})

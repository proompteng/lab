import { Result } from 'effect'

import { canonicalHashV1Result } from '../../hash'
import {
  OpeningDriveQualificationFailure,
  type OpeningDriveQualificationBinding,
  type OpeningDriveQualificationGate,
  type OpeningDriveQualificationPolicy,
  type OpeningDriveQualificationReceipt,
  type OpeningDriveSessionReplay,
} from './qualification-model'

interface QualificationHashes {
  readonly protocolHash: string
  readonly policyHash: string
  readonly costModelHash: string
}

interface BootstrapResult {
  readonly adjustedOneSidedAlpha: number
  readonly tailSamples: number
  readonly seedHash: string
  readonly samplesHash: string
  readonly candidateAnnualizedReturnLowerBound: number
  readonly excessAnnualizedReturnLowerBound: number
}

const failure = (
  reason: OpeningDriveQualificationFailure['reason'],
  message: string,
  cause?: unknown,
): OpeningDriveQualificationFailure =>
  new OpeningDriveQualificationFailure({ reason, message, ...(cause === undefined ? {} : { cause }) })

const canonicalHash = (value: unknown, message: string): Result.Result<string, OpeningDriveQualificationFailure> =>
  Result.mapError(canonicalHashV1Result(value), (cause) => failure('canonicalization', message, cause))

const round = (value: number): Result.Result<number, OpeningDriveQualificationFailure> =>
  Number.isFinite(value)
    ? Result.succeed(Number.parseFloat(value.toFixed(12)))
    : Result.fail(failure('statistic', 'opening-drive qualification produced a non-finite statistic'))

const compoundedReturn = (returns: readonly number[]): number =>
  returns.reduce((growth, value) => growth * (1 + value), 1) - 1

const maximumDrawdown = (returns: readonly number[]): number =>
  returns.reduce(
    (state, value) => {
      const equity = state.equity * (1 + value)
      const peak = Math.max(state.peak, equity)
      return { equity, peak, maximum: Math.max(state.maximum, 1 - equity / peak) }
    },
    { equity: 1, peak: 1, maximum: 0 },
  ).maximum

const lowerQuantile = (values: readonly number[], probability: number): number => {
  if (values.length === 0) return 0
  const sorted = values.toSorted((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(probability * sorted.length) - 1)] ?? 0
}

interface RandomState {
  readonly value: number
}

const nextRandom = (state: RandomState): RandomState => {
  const left = state.value ^ (state.value << 13)
  const right = left ^ (left >>> 17)
  return { value: (right ^ (right << 5)) >>> 0 }
}

const drawIndex = (state: RandomState, maximum: number): readonly [number, RandomState] => {
  const limit = Math.floor(0x1_0000_0000 / maximum) * maximum
  let next = nextRandom(state)
  while (next.value >= limit) next = nextRandom(next)
  return [next.value % maximum, next]
}

const samplePairedCircularBlocks = (
  candidateReturns: readonly number[],
  benchmarkReturns: readonly number[],
  blockSessions: number,
  initial: RandomState,
  annualizationSessions: number,
): readonly [number, number, RandomState] => {
  let candidateGrowth = 1
  let benchmarkGrowth = 1
  let sampled = 0
  let random = initial
  while (sampled < candidateReturns.length) {
    const [start, next] = drawIndex(random, candidateReturns.length)
    random = next
    for (let offset = 0; offset < blockSessions && sampled < candidateReturns.length; offset += 1) {
      const index = (start + offset) % candidateReturns.length
      candidateGrowth *= 1 + (candidateReturns[index] ?? 0)
      benchmarkGrowth *= 1 + (benchmarkReturns[index] ?? 0)
      sampled += 1
    }
  }
  const exponent = annualizationSessions / candidateReturns.length
  const candidateAnnualized = candidateGrowth <= 0 ? -1 : candidateGrowth ** exponent - 1
  const benchmarkAnnualized = benchmarkGrowth <= 0 ? -1 : benchmarkGrowth ** exponent - 1
  return [candidateAnnualized, candidateAnnualized - benchmarkAnnualized, random]
}

const bootstrap = (
  candidateReturns: readonly number[],
  benchmarkReturns: readonly number[],
  policy: OpeningDriveQualificationPolicy,
  candidateOrdinal: number,
  seedHash: string,
): Result.Result<BootstrapResult, OpeningDriveQualificationFailure> => {
  const adjustedOneSidedAlpha = policy.bootstrap.familyOneSidedAlpha / candidateOrdinal
  const tailSamples = Math.floor(policy.bootstrap.samples * adjustedOneSidedAlpha)
  let random: RandomState = { value: Number.parseInt(seedHash.slice(0, 8), 16) || 0x9e3779b9 }
  const candidateSamples: number[] = []
  const excessSamples: number[] = []
  for (let sample = 0; sample < policy.bootstrap.samples; sample += 1) {
    const [candidate, excess, next] = samplePairedCircularBlocks(
      candidateReturns,
      benchmarkReturns,
      policy.bootstrap.blockSessions,
      random,
      policy.annualizationSessions,
    )
    if (!Number.isFinite(candidate) || !Number.isFinite(excess)) {
      return Result.fail(failure('statistic', 'opening-drive bootstrap produced a non-finite sample'))
    }
    candidateSamples.push(Number.parseFloat(candidate.toFixed(12)))
    excessSamples.push(Number.parseFloat(excess.toFixed(12)))
    random = next
  }
  return Result.gen(function* () {
    const samplesHash = yield* canonicalHash(
      {
        schemaVersion: 'bayn.opening-drive.bootstrap-samples.v1',
        candidateAnnualizedReturns: candidateSamples,
        excessAnnualizedReturns: excessSamples,
      },
      'opening-drive bootstrap samples are not canonically hashable',
    )
    return {
      adjustedOneSidedAlpha: yield* round(adjustedOneSidedAlpha),
      tailSamples,
      seedHash,
      samplesHash,
      candidateAnnualizedReturnLowerBound: yield* round(lowerQuantile(candidateSamples, adjustedOneSidedAlpha)),
      excessAnnualizedReturnLowerBound: yield* round(lowerQuantile(excessSamples, adjustedOneSidedAlpha)),
    }
  })
}

const chronologicalPositiveFraction = (
  candidateReturns: readonly number[],
  benchmarkReturns: readonly number[],
  foldCount: number,
): Result.Result<
  { readonly availableFolds: number; readonly positiveFraction: number },
  OpeningDriveQualificationFailure
> => {
  if (candidateReturns.length < foldCount)
    return Result.succeed({ availableFolds: candidateReturns.length, positiveFraction: 0 })
  const baseSize = Math.floor(candidateReturns.length / foldCount)
  const remainder = candidateReturns.length % foldCount
  let start = 0
  let positive = 0
  for (let ordinal = 0; ordinal < foldCount; ordinal += 1) {
    const size = baseSize + (ordinal < remainder ? 1 : 0)
    const end = start + size
    if (compoundedReturn(candidateReturns.slice(start, end)) > compoundedReturn(benchmarkReturns.slice(start, end))) {
      positive += 1
    }
    start = end
  }
  return Result.map(round(positive / foldCount), (positiveFraction) => ({
    availableFolds: foldCount,
    positiveFraction,
  }))
}

const sumMicros = (
  sessions: readonly OpeningDriveSessionReplay[],
  field: keyof OpeningDriveSessionReplay['candidate'],
): bigint =>
  sessions.reduce((total, session) => {
    const value = session.candidate[field]
    return typeof value === 'string' && /^-?[0-9]+$/.test(value) ? total + BigInt(value) : total
  }, 0n)

const sumBenchmarkMicros = (
  sessions: readonly OpeningDriveSessionReplay[],
  field: keyof OpeningDriveSessionReplay['benchmark'],
): bigint =>
  sessions.reduce((total, session) => {
    const value = session.benchmark[field]
    return typeof value === 'string' && /^-?[0-9]+$/.test(value) ? total + BigInt(value) : total
  }, 0n)

const gate = (
  name: string,
  passed: boolean,
  actual: number | string,
  required: number | string,
): OpeningDriveQualificationGate => Object.freeze({ name, passed, actual, required })

export const analyzeOpeningDriveQualification = (
  sessions: readonly OpeningDriveSessionReplay[],
  policy: OpeningDriveQualificationPolicy,
  binding: OpeningDriveQualificationBinding,
  hashes: QualificationHashes,
): Result.Result<OpeningDriveQualificationReceipt, OpeningDriveQualificationFailure> =>
  Result.gen(function* () {
    const first = sessions[0]
    const last = sessions.at(-1)
    if (first === undefined || last === undefined) {
      return yield* Result.fail(failure('input', 'opening-drive qualification requires at least one replay session'))
    }
    if (!/^[0-9a-f]{40}$/.test(binding.sourceRevision) || !/^[0-9a-f]{64}$/.test(binding.strategyBehaviorHash)) {
      return yield* Result.fail(
        failure('input', 'opening-drive qualification requires exact lowercase source and strategy hashes'),
      )
    }
    if (
      binding.priorTrialReceiptHashes.some((hash) => !/^[0-9a-f]{64}$/.test(hash)) ||
      new Set(binding.priorTrialReceiptHashes).size !== binding.priorTrialReceiptHashes.length ||
      binding.priorTrialReceiptHashes.some(
        (hash, index) => index > 0 && hash <= (binding.priorTrialReceiptHashes[index - 1] ?? ''),
      )
    ) {
      return yield* Result.fail(
        failure(
          'trial-lineage',
          'opening-drive prior trial receipt hashes must be unique lowercase SHA-256 values in canonical order',
        ),
      )
    }
    const candidateOrdinal = binding.priorTrialReceiptHashes.length + 1
    const priorTrialsHash = yield* canonicalHash(
      binding.priorTrialReceiptHashes,
      'opening-drive prior trial lineage is not canonically hashable',
    )
    const sessionsHash = yield* canonicalHash(
      sessions.map((session) => session.receiptHash),
      'opening-drive session lineage is not canonically hashable',
    )
    const bootstrapSeedHash = yield* canonicalHash(
      {
        schemaVersion: 'bayn.opening-drive.bootstrap-seed.v1',
        namespace: policy.bootstrap.seedNamespace,
        sourceRevision: binding.sourceRevision,
        strategyBehaviorHash: binding.strategyBehaviorHash,
        protocolHash: hashes.protocolHash,
        policyHash: hashes.policyHash,
        costModelHash: hashes.costModelHash,
        priorTrialsHash,
        sessionsHash,
      },
      'opening-drive bootstrap seed is not canonically hashable',
    )
    const candidateReturns = sessions.map((session) => session.candidate.return)
    const benchmarkReturns = sessions.map((session) => session.benchmark.return)
    const bootstrapResult = yield* bootstrap(
      candidateReturns,
      benchmarkReturns,
      policy,
      candidateOrdinal,
      bootstrapSeedHash,
    )
    const folds = yield* chronologicalPositiveFraction(
      candidateReturns,
      benchmarkReturns,
      policy.chronologicalFolds.count,
    )
    const statistics = yield* Result.all({
      candidateCompoundedReturn: round(compoundedReturn(candidateReturns)),
      benchmarkCompoundedReturn: round(compoundedReturn(benchmarkReturns)),
      maximumDrawdown: round(maximumDrawdown(candidateReturns)),
    })
    const tradeSessionCount = sessions.filter((session) => session.candidate.executedSymbols.length > 0).length
    const candidateNetPnl = sumMicros(sessions, 'netPnlMicros')
    const gates = Object.freeze([
      gate('session-count', sessions.length >= policy.minimumSessions, sessions.length, policy.minimumSessions),
      gate(
        'trade-session-count',
        tradeSessionCount >= policy.minimumTradeSessions,
        tradeSessionCount,
        policy.minimumTradeSessions,
      ),
      gate(
        'bootstrap-tail-resolution',
        bootstrapResult.tailSamples >= policy.bootstrap.minimumTailSamples,
        bootstrapResult.tailSamples,
        policy.bootstrap.minimumTailSamples,
      ),
      gate(
        'chronological-fold-count',
        folds.availableFolds >= policy.chronologicalFolds.count,
        folds.availableFolds,
        policy.chronologicalFolds.count,
      ),
      gate(
        'candidate-annualized-return-lower-bound',
        bootstrapResult.candidateAnnualizedReturnLowerBound > 0,
        bootstrapResult.candidateAnnualizedReturnLowerBound,
        '> 0',
      ),
      gate(
        'paired-excess-annualized-return-lower-bound',
        bootstrapResult.excessAnnualizedReturnLowerBound > 0,
        bootstrapResult.excessAnnualizedReturnLowerBound,
        '> 0',
      ),
      gate(
        'maximum-drawdown',
        statistics.maximumDrawdown <= policy.maximumDrawdown,
        statistics.maximumDrawdown,
        `<= ${policy.maximumDrawdown}`,
      ),
      gate(
        'positive-chronological-fold-fraction',
        folds.positiveFraction >= policy.chronologicalFolds.minimumPositiveFraction,
        folds.positiveFraction,
        `>= ${policy.chronologicalFolds.minimumPositiveFraction}`,
      ),
      gate('candidate-total-net-pnl', candidateNetPnl > 0n, String(candidateNetPnl), '> 0'),
    ])
    const sufficiencyGateNames = new Set([
      'session-count',
      'trade-session-count',
      'bootstrap-tail-resolution',
      'chronological-fold-count',
    ])
    const insufficient = gates.some((item) => sufficiencyGateNames.has(item.name) && !item.passed)
    const verdict = insufficient ? 'INSUFFICIENT' : gates.every((item) => item.passed) ? 'QUALIFIED' : 'REJECTED'
    const reasonCodes = Object.freeze(gates.filter((item) => !item.passed).map((item) => item.name))
    const material = Object.freeze({
      schemaVersion: 'bayn.opening-drive.qualification-receipt.v1' as const,
      protocolHash: hashes.protocolHash,
      policyHash: hashes.policyHash,
      costModelHash: hashes.costModelHash,
      sourceRevision: binding.sourceRevision,
      strategyBehaviorHash: binding.strategyBehaviorHash,
      priorTrialsHash,
      sessionsHash,
      firstSession: first.sessionDate,
      lastSession: last.sessionDate,
      sessionCount: sessions.length,
      tradeSessionCount,
      priorTrialCount: binding.priorTrialReceiptHashes.length,
      candidateOrdinal,
      adjustedOneSidedAlpha: bootstrapResult.adjustedOneSidedAlpha,
      bootstrapTailSamples: bootstrapResult.tailSamples,
      bootstrapSeedHash: bootstrapResult.seedHash,
      bootstrapSamplesHash: bootstrapResult.samplesHash,
      candidateNetPnlMicros: String(candidateNetPnl),
      candidateQuotedSpreadCostMicros: String(sumMicros(sessions, 'quotedSpreadCostMicros')),
      candidateSlippageCostMicros: String(sumMicros(sessions, 'slippageCostMicros')),
      candidateFeeCostMicros: String(sumMicros(sessions, 'feeCostMicros')),
      benchmarkNetPnlMicros: String(sumBenchmarkMicros(sessions, 'netPnlMicros')),
      benchmarkQuotedSpreadCostMicros: String(sumBenchmarkMicros(sessions, 'quotedSpreadCostMicros')),
      benchmarkSlippageCostMicros: String(sumBenchmarkMicros(sessions, 'slippageCostMicros')),
      benchmarkFeeCostMicros: String(sumBenchmarkMicros(sessions, 'feeCostMicros')),
      candidateCompoundedReturn: statistics.candidateCompoundedReturn,
      benchmarkCompoundedReturn: statistics.benchmarkCompoundedReturn,
      candidateAnnualizedReturnLowerBound: bootstrapResult.candidateAnnualizedReturnLowerBound,
      excessAnnualizedReturnLowerBound: bootstrapResult.excessAnnualizedReturnLowerBound,
      maximumDrawdown: statistics.maximumDrawdown,
      positiveChronologicalFoldFraction: folds.positiveFraction,
      gates,
      verdict,
      reasonCodes,
    })
    const receiptHash = yield* canonicalHash(
      material,
      'opening-drive qualification receipt is not canonically hashable',
    )
    return Object.freeze({ ...material, receiptHash })
  })

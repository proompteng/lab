import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

import { NodeRuntime } from '@effect/platform-node'
import { Data, Effect, pipe, Result, Schema } from 'effect'

import {
  candidateDevelopmentComparisonSemantics,
  candidateDevelopmentStatisticsPolicy,
  runCandidateDevelopment,
  type CandidateDevelopmentEffects,
  type CandidateDevelopmentEvaluation,
  type CandidateDevelopmentPreflightInput,
  type CandidateDevelopmentReport,
  type CandidateDevelopmentRunFailure,
} from './candidate-development'
import { microsToNumber } from './execution-model'
import { canonicalHashV1Result, type CanonicalHashFailure } from './hash'
import {
  IsoDateSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  Sha256Schema,
  strictParseOptions,
} from './schemas'
import { TRADING_DAYS } from './simulation/metrics'
import type { EvaluationResult } from './types'

export const candidateDevelopmentExecutableProgramSchemaVersion =
  'bayn.candidate-development-executable-program.v1' as const

export interface CandidateDevelopmentExecutableProgram<Registration, DevelopmentData, Error, Requirements> {
  readonly schemaVersion: typeof candidateDevelopmentExecutableProgramSchemaVersion
  readonly input: CandidateDevelopmentPreflightInput
  readonly effects: CandidateDevelopmentEffects<Registration, DevelopmentData, Error, Requirements>
}

type CandidateDevelopmentComparisonGateName =
  (typeof candidateDevelopmentComparisonSemantics.gates)[keyof typeof candidateDevelopmentComparisonSemantics.gates]['name']

export interface CandidateDevelopmentCommandGate {
  readonly name:
    | CandidateDevelopmentComparisonGateName
    | 'double_cost_return'
    | 'economic_verdict'
    | 'baseline_terminal_cash'
    | 'stressed_terminal_cash'
  readonly passed: boolean
  readonly actual: number | boolean
  readonly required: number | boolean
}

export interface CandidateDevelopmentCommandDecision {
  readonly status: 'PASS' | 'HOLD_REJECT'
  readonly selectedBenchmark: 'buy-and-hold' | 'direct-volatility-timing'
  readonly gates: readonly CandidateDevelopmentCommandGate[]
}

export interface CandidateDevelopmentCommandReportMaterial {
  readonly schemaVersion: 'bayn.candidate-development-command-report.v1'
  readonly candidateOrdinal: number
  readonly priorTrialCount: number
  readonly strategyProtocolHash: string
  readonly decision: CandidateDevelopmentCommandDecision
  readonly baseline: EvaluationResult
  readonly development: CandidateDevelopmentReport
}

export interface CandidateDevelopmentCommandReport extends CandidateDevelopmentCommandReportMaterial {
  readonly contentHash: string
}

export type CandidateDevelopmentCommandFailure =
  | CandidateDevelopmentRunFailure
  | {
      readonly _tag: 'CandidateDevelopmentCommandHashFailed'
      readonly cause: CanonicalHashFailure
    }
  | {
      readonly _tag: 'CandidateDevelopmentCommandModulePathMissing'
    }
  | {
      readonly _tag: 'CandidateDevelopmentCommandModuleLoadFailed'
      readonly modulePath: string
      readonly cause: unknown
    }
  | {
      readonly _tag: 'CandidateDevelopmentCommandProgramInvalid'
      readonly reason:
        | 'module-export-missing'
        | 'schema-version-mismatch'
        | 'input-missing'
        | 'input-invalid'
        | 'effects-missing'
        | 'effect-function-missing'
      readonly cause?: unknown
    }
  | {
      readonly _tag: 'CandidateDevelopmentCommandEvaluationMissing'
    }
  | {
      readonly _tag: 'CandidateDevelopmentCommandProgramExecutionFailed'
      readonly cause: unknown
    }
  | {
      readonly _tag: 'CandidateDevelopmentCommandOutputFailed'
      readonly cause: unknown
    }
  | {
      readonly _tag: 'CandidateDevelopmentCommandDoubledCostSeriesInvalid'
      readonly reason:
        | 'initial-capital-invalid'
        | 'observations-insufficient'
        | 'equity-invalid'
        | 'annualized-return-invalid'
        | 'baseline-summary-mismatch'
      readonly index: number | null
      readonly expected: number | string | null
      readonly observed: number | string | null
    }

const terminalCash = (marks: EvaluationResult['simulation']['dailyMarks']): boolean => {
  const last = marks.at(-1)
  return last !== undefined && last.positions.every((position) => position.quantityMicros === '0')
}

const positiveMicros = (
  value: string,
  reason: 'initial-capital-invalid' | 'equity-invalid',
  index: number | null,
): Result.Result<bigint, CandidateDevelopmentCommandFailure> => {
  if (!/^[0-9]+$/.test(value)) {
    return Result.fail({
      _tag: 'CandidateDevelopmentCommandDoubledCostSeriesInvalid',
      reason,
      index,
      expected: 'positive unsigned integer micros',
      observed: value,
    })
  }
  const parsed = BigInt(value)
  return parsed > 0n
    ? Result.succeed(parsed)
    : Result.fail({
        _tag: 'CandidateDevelopmentCommandDoubledCostSeriesInvalid',
        reason,
        index,
        expected: 'positive unsigned integer micros',
        observed: value,
      })
}

export const deriveCandidateDevelopmentDoubledCostAnnualizedReturn = (
  report: CandidateDevelopmentReport,
  baseline: EvaluationResult,
): Result.Result<number, CandidateDevelopmentCommandFailure> => {
  const marks = report.doubledCost.stressed.simulation.dailyMarks
  if (marks.length < 2) {
    return Result.fail({
      _tag: 'CandidateDevelopmentCommandDoubledCostSeriesInvalid',
      reason: 'observations-insufficient',
      index: null,
      expected: 2,
      observed: marks.length,
    })
  }
  return pipe(
    Result.all({
      initialCapital: positiveMicros(baseline.initialCapitalMicros, 'initial-capital-invalid', null),
      equity: Result.all(marks.map((mark, index) => positiveMicros(mark.equityMicros, 'equity-invalid', index))),
    }),
    Result.flatMap(({ equity, initialCapital }) => {
      const endingEquity = equity.at(-1)
      if (endingEquity === undefined) {
        return Result.fail<CandidateDevelopmentCommandFailure>({
          _tag: 'CandidateDevelopmentCommandDoubledCostSeriesInvalid',
          reason: 'observations-insufficient',
          index: null,
          expected: 2,
          observed: equity.length,
        })
      }
      const initialCapitalValue = microsToNumber(initialCapital)
      const endingEquityValue = microsToNumber(endingEquity)
      const annualizedReturn = Math.pow(endingEquityValue / initialCapitalValue, TRADING_DAYS / equity.length) - 1
      if (!Number.isFinite(annualizedReturn)) {
        return Result.fail<CandidateDevelopmentCommandFailure>({
          _tag: 'CandidateDevelopmentCommandDoubledCostSeriesInvalid',
          reason: 'annualized-return-invalid',
          index: null,
          expected: 'finite annualized return',
          observed: annualizedReturn,
        })
      }
      return baseline.doubleCostStrategy.annualizedReturn === annualizedReturn
        ? Result.succeed(annualizedReturn)
        : Result.fail<CandidateDevelopmentCommandFailure>({
            _tag: 'CandidateDevelopmentCommandDoubledCostSeriesInvalid',
            reason: 'baseline-summary-mismatch',
            index: null,
            expected: annualizedReturn,
            observed: baseline.doubleCostStrategy.annualizedReturn,
          })
    }),
  )
}

const decideCandidateDevelopment = (
  report: CandidateDevelopmentReport,
  baseline: EvaluationResult,
  doubledCostAnnualizedReturn: number,
): CandidateDevelopmentCommandDecision => {
  const { bootstrap, power, walkForward } = report.comparisonSemantics.analysis
  const protocolGates = candidateDevelopmentComparisonSemantics.gates
  const gates: readonly CandidateDevelopmentCommandGate[] = [
    {
      name: protocolGates.power.name,
      passed: power.sufficient,
      actual: power.sufficient,
      required: true,
    },
    {
      name: protocolGates.bootstrapTailResolution.name,
      passed: bootstrap.tailResolutionSufficient,
      actual: bootstrap.tailSampleCount,
      required: bootstrap.minimumTailSamples,
    },
    {
      name: protocolGates.annualizedExcessReturnLowerBound.name,
      passed: bootstrap.annualizedReturnDifferenceLowerBound > 0,
      actual: bootstrap.annualizedReturnDifferenceLowerBound,
      required: 0,
    },
    {
      name: protocolGates.sharpeDifferenceLowerBound.name,
      passed: bootstrap.sharpeDifferenceLowerBound > 0,
      actual: bootstrap.sharpeDifferenceLowerBound,
      required: 0,
    },
    {
      name: protocolGates.walkForwardFolds.name,
      passed: walkForward.sufficient,
      actual: walkForward.folds.length,
      required: walkForward.requiredFolds,
    },
    {
      name: protocolGates.walkForwardPositiveFraction.name,
      passed: walkForward.positiveFoldFraction >= walkForward.requiredPositiveFoldFraction,
      actual: walkForward.positiveFoldFraction,
      required: walkForward.requiredPositiveFoldFraction,
    },
    {
      name: protocolGates.walkForwardDrawdown.name,
      passed: walkForward.allDrawdownsWithinLimit,
      actual: walkForward.maximumFoldDrawdown,
      required: candidateDevelopmentStatisticsPolicy.walkForward.maximumFoldDrawdown,
    },
    {
      name: 'double_cost_return',
      passed: doubledCostAnnualizedReturn > 0,
      actual: doubledCostAnnualizedReturn,
      required: 0,
    },
    {
      name: 'economic_verdict',
      passed: baseline.verdict.status === 'PASS',
      actual: baseline.verdict.status === 'PASS',
      required: true,
    },
    {
      name: 'baseline_terminal_cash',
      passed: terminalCash(baseline.simulation.dailyMarks),
      actual: terminalCash(baseline.simulation.dailyMarks),
      required: true,
    },
    {
      name: 'stressed_terminal_cash',
      passed: terminalCash(report.doubledCost.stressed.simulation.dailyMarks),
      actual: terminalCash(report.doubledCost.stressed.simulation.dailyMarks),
      required: true,
    },
  ]
  return {
    status: gates.every((gate) => gate.passed) ? 'PASS' : 'HOLD_REJECT',
    selectedBenchmark: bootstrap.selectedBenchmark,
    gates,
  }
}

export const buildCandidateDevelopmentCommandReport = (
  report: CandidateDevelopmentReport,
  baseline: EvaluationResult,
): Result.Result<CandidateDevelopmentCommandReport, CandidateDevelopmentCommandFailure> =>
  pipe(
    deriveCandidateDevelopmentDoubledCostAnnualizedReturn(report, baseline),
    Result.flatMap((doubledCostAnnualizedReturn) => {
      const material: CandidateDevelopmentCommandReportMaterial = {
        schemaVersion: 'bayn.candidate-development-command-report.v1',
        candidateOrdinal: report.protocolIdentity.candidateOrdinal,
        priorTrialCount: report.protocolIdentity.priorTrialCount,
        strategyProtocolHash: report.comparisonSemantics.strategyProtocolHash,
        decision: decideCandidateDevelopment(report, baseline, doubledCostAnnualizedReturn),
        baseline,
        development: report,
      }
      return pipe(
        canonicalHashV1Result(material),
        Result.mapError(
          (cause): CandidateDevelopmentCommandFailure => ({
            _tag: 'CandidateDevelopmentCommandHashFailed',
            cause,
          }),
        ),
        Result.map((contentHash) => ({ ...material, contentHash })),
      )
    }),
  )

export const executeCandidateDevelopmentProgram = <Registration, DevelopmentData, Error, Requirements>(
  program: CandidateDevelopmentExecutableProgram<Registration, DevelopmentData, Error, Requirements>,
): Effect.Effect<CandidateDevelopmentCommandReport, CandidateDevelopmentCommandFailure | Error, Requirements> => {
  let evaluation: CandidateDevelopmentEvaluation | undefined
  const effects: CandidateDevelopmentEffects<Registration, DevelopmentData, Error, Requirements> = {
    ...program.effects,
    evaluateDevelopment: (data, preflight) =>
      program.effects.evaluateDevelopment(data, preflight).pipe(
        Effect.tap((value) =>
          Effect.sync(() => {
            evaluation = value
          }),
        ),
      ),
  }
  return runCandidateDevelopment(program.input, effects).pipe(
    Effect.flatMap((report) =>
      evaluation === undefined
        ? Effect.fail<CandidateDevelopmentCommandFailure>({ _tag: 'CandidateDevelopmentCommandEvaluationMissing' })
        : Effect.fromResult(buildCandidateDevelopmentCommandReport(report, evaluation.baseline)),
    ),
  )
}

export const renderCandidateDevelopmentCommandReport = (report: CandidateDevelopmentCommandReport): string =>
  `${JSON.stringify(report)}\n`

export type CandidateDevelopmentCommandReportWriter = (
  renderedReport: string,
) => Effect.Effect<void, CandidateDevelopmentCommandFailure>

const writeCandidateDevelopmentCommandReportToStdout: CandidateDevelopmentCommandReportWriter = (renderedReport) =>
  Effect.tryPromise({
    try: () =>
      new Promise<void>((resolveWrite, rejectWrite) => {
        process.stdout.write(renderedReport, (error) => {
          if (error === null || error === undefined) resolveWrite()
          else rejectWrite(error)
        })
      }),
    catch: (cause): CandidateDevelopmentCommandFailure => ({
      _tag: 'CandidateDevelopmentCommandOutputFailed',
      cause,
    }),
  })

export const writeCandidateDevelopmentCommandReport = (
  report: CandidateDevelopmentCommandReport,
  writer: CandidateDevelopmentCommandReportWriter = writeCandidateDevelopmentCommandReportToStdout,
): Effect.Effect<void, CandidateDevelopmentCommandFailure> =>
  writer(renderCandidateDevelopmentCommandReport(report)).pipe(Effect.uninterruptible)

export const runCandidateDevelopmentCommand = <Registration, DevelopmentData, Error, Requirements>(
  program: CandidateDevelopmentExecutableProgram<Registration, DevelopmentData, Error, Requirements>,
): Effect.Effect<CandidateDevelopmentCommandReport, CandidateDevelopmentCommandFailure | Error, Requirements> =>
  executeCandidateDevelopmentProgram(program).pipe(Effect.tap(writeCandidateDevelopmentCommandReport))

type ExecutableProgram = CandidateDevelopmentExecutableProgram<
  unknown,
  unknown,
  CandidateDevelopmentCommandFailure,
  never
>

const CandidateDevelopmentPreflightInputSchema = Schema.Struct({
  candidateOrdinal: PositiveIntegerSchema,
  priorTrialCount: NonNegativeIntegerSchema,
  expectedStrategyProtocolHash: Sha256Schema,
  officialSessions: Schema.Array(IsoDateSchema),
  signalSessionDates: Schema.Array(IsoDateSchema),
  featureLookbackSessions: NonNegativeIntegerSchema,
})

const decodeCandidateDevelopmentPreflightInput = Schema.decodeUnknownResult(
  CandidateDevelopmentPreflightInputSchema,
  strictParseOptions,
)

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

export const validateCandidateDevelopmentExecutableProgram = (
  value: unknown,
): Result.Result<ExecutableProgram, CandidateDevelopmentCommandFailure> => {
  const program = recordOf(value)
  if (program === undefined) {
    return Result.fail({ _tag: 'CandidateDevelopmentCommandProgramInvalid', reason: 'module-export-missing' })
  }
  if (program.schemaVersion !== candidateDevelopmentExecutableProgramSchemaVersion) {
    return Result.fail({ _tag: 'CandidateDevelopmentCommandProgramInvalid', reason: 'schema-version-mismatch' })
  }
  if (recordOf(program.input) === undefined) {
    return Result.fail({ _tag: 'CandidateDevelopmentCommandProgramInvalid', reason: 'input-missing' })
  }
  const effects = recordOf(program.effects)
  if (effects === undefined) {
    return Result.fail({ _tag: 'CandidateDevelopmentCommandProgramInvalid', reason: 'effects-missing' })
  }
  if (
    typeof effects.preregisterCandidate !== 'function' ||
    typeof effects.loadDevelopmentData !== 'function' ||
    typeof effects.evaluateDevelopment !== 'function'
  ) {
    return Result.fail({ _tag: 'CandidateDevelopmentCommandProgramInvalid', reason: 'effect-function-missing' })
  }
  const input = decodeCandidateDevelopmentPreflightInput(program.input)
  if (Result.isFailure(input)) {
    return Result.fail({
      _tag: 'CandidateDevelopmentCommandProgramInvalid',
      reason: 'input-invalid',
      cause: input.failure,
    })
  }
  return Result.succeed({
    schemaVersion: candidateDevelopmentExecutableProgramSchemaVersion,
    input: input.success,
    effects: effects as unknown as ExecutableProgram['effects'],
  })
}

export type CandidateDevelopmentModuleImporter = (
  moduleUrl: string,
) => Effect.Effect<unknown, CandidateDevelopmentCommandFailure>

const importCandidateDevelopmentModule: CandidateDevelopmentModuleImporter = (moduleUrl) =>
  Effect.tryPromise({
    try: () => import(moduleUrl),
    catch: (cause): CandidateDevelopmentCommandFailure => ({
      _tag: 'CandidateDevelopmentCommandModuleLoadFailed',
      modulePath: moduleUrl,
      cause,
    }),
  })

export const loadCandidateDevelopmentExecutableProgram = (
  modulePath: string,
  importer: CandidateDevelopmentModuleImporter = importCandidateDevelopmentModule,
): Effect.Effect<ExecutableProgram, CandidateDevelopmentCommandFailure> =>
  importer(pathToFileURL(resolve(modulePath)).href).pipe(
    Effect.uninterruptible,
    Effect.flatMap((module) =>
      Effect.fromResult(validateCandidateDevelopmentExecutableProgram(recordOf(module)?.candidateDevelopmentProgram)),
    ),
  )

const modulePath = process.argv.at(2)

const executeLoadedCandidateDevelopmentProgram = (
  program: ExecutableProgram,
): Effect.Effect<CandidateDevelopmentCommandReport, CandidateDevelopmentCommandFailure> =>
  runCandidateDevelopmentCommand(program).pipe(
    Effect.mapError(
      (cause): CandidateDevelopmentCommandFailure => ({
        _tag: 'CandidateDevelopmentCommandProgramExecutionFailed',
        cause,
      }),
    ),
  )

const main = (
  modulePath === undefined
    ? Effect.fail<CandidateDevelopmentCommandFailure>({ _tag: 'CandidateDevelopmentCommandModulePathMissing' })
    : loadCandidateDevelopmentExecutableProgram(modulePath).pipe(
        Effect.flatMap(executeLoadedCandidateDevelopmentProgram),
      )
).pipe(Effect.annotateLogs({ operation: 'candidate-development-command' }))

class CandidateDevelopmentCommandError extends Data.TaggedError('CandidateDevelopmentCommandError')<{
  readonly failure: CandidateDevelopmentCommandFailure
}> {}

if (import.meta.main) {
  NodeRuntime.runMain(main.pipe(Effect.mapError((failure) => new CandidateDevelopmentCommandError({ failure }))), {
    disableErrorReporting: false,
  })
}

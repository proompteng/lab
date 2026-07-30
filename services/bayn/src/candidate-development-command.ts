import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

import { NodeRuntime } from '@effect/platform-node'
import { Data, Effect, pipe, Result } from 'effect'

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
import { canonicalHashV1Result, type CanonicalHashFailure } from './hash'
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
        | 'effects-missing'
        | 'effect-function-missing'
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

const terminalCash = (marks: EvaluationResult['simulation']['dailyMarks']): boolean => {
  const last = marks.at(-1)
  return last !== undefined && last.positions.every((position) => position.quantityMicros === '0')
}

const decideCandidateDevelopment = (
  report: CandidateDevelopmentReport,
  baseline: EvaluationResult,
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
): Result.Result<CandidateDevelopmentCommandReport, CandidateDevelopmentCommandFailure> => {
  const material: CandidateDevelopmentCommandReportMaterial = {
    schemaVersion: 'bayn.candidate-development-command-report.v1',
    candidateOrdinal: report.protocolIdentity.candidateOrdinal,
    priorTrialCount: report.protocolIdentity.priorTrialCount,
    strategyProtocolHash: report.comparisonSemantics.strategyProtocolHash,
    decision: decideCandidateDevelopment(report, baseline),
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
}

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
  return Result.succeed(value as ExecutableProgram)
}

const loadCandidateDevelopmentExecutableProgram = (
  modulePath: string,
): Effect.Effect<ExecutableProgram, CandidateDevelopmentCommandFailure> =>
  Effect.tryPromise({
    try: () => import(pathToFileURL(resolve(modulePath)).href),
    catch: (cause): CandidateDevelopmentCommandFailure => ({
      _tag: 'CandidateDevelopmentCommandModuleLoadFailed',
      modulePath,
      cause,
    }),
  }).pipe(
    Effect.flatMap((module) =>
      Effect.fromResult(
        validateCandidateDevelopmentExecutableProgram(Reflect.get(module, 'candidateDevelopmentProgram')),
      ),
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

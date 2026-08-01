import { Result } from 'effect'

import { canonicalHashV1Result, type CanonicalHashFailure } from '../hash'
import type { SignalDecision, SimulatedOrder, SimulationTrace } from '../types'
import { candidateDevelopmentDoubledCostContract } from './protocol'

type CandidateDevelopmentOrderQuantityPathEntry = Pick<
  SimulatedOrder,
  | 'decisionId'
  | 'sessionDate'
  | 'symbol'
  | 'side'
  | 'requestedQuantityMicros'
  | 'filledQuantityMicros'
  | 'status'
  | 'rejectionReason'
  | 'unfilledRemainder'
>

export interface CandidateDevelopmentDoubledCostRun {
  readonly signalDecisions: readonly SignalDecision[]
  readonly simulation: SimulationTrace
}

export interface CandidateDevelopmentDoubledCostPass {
  readonly schemaVersion: 'bayn.candidate-development-doubled-cost-check.v1'
  readonly status: 'PASS'
  readonly signalDecisionsHash: string
  readonly orderQuantityPathHash: string
  readonly executionModelHash: string
}

export interface CandidateDevelopmentDoubledCostEvidence {
  readonly baseline: CandidateDevelopmentDoubledCostRun
  readonly stressed: CandidateDevelopmentDoubledCostRun
}

export type CandidateDevelopmentDoubledCostIssue =
  | {
      readonly _tag: 'CandidateDevelopmentDoubledCostMultiplierMismatch'
      readonly run: 'baseline' | 'stressed'
      readonly expected: string
      readonly observed: string
    }
  | {
      readonly _tag: 'CandidateDevelopmentDoubledCostHashFailed'
      readonly material:
        | 'baseline-signals'
        | 'stressed-signals'
        | 'baseline-orders'
        | 'stressed-orders'
        | 'baseline-execution-model'
        | 'stressed-execution-model'
      readonly cause: CanonicalHashFailure
    }
  | {
      readonly _tag: 'CandidateDevelopmentDoubledCostProtocolDeviation'
      readonly disposition: 'INVALID_PROTOCOL_DEVIATION'
      readonly reason: 'EXECUTION_MODEL_CHANGED' | 'SIGNAL_DECISIONS_CHANGED' | 'ORDER_QUANTITY_PATH_CHANGED'
      readonly baselineHash: string
      readonly stressedHash: string
    }

type CandidateDevelopmentDoubledCostHashMaterial = Extract<
  CandidateDevelopmentDoubledCostIssue,
  { readonly _tag: 'CandidateDevelopmentDoubledCostHashFailed' }
>['material']

const orderQuantityPath = (orders: readonly SimulatedOrder[]): readonly CandidateDevelopmentOrderQuantityPathEntry[] =>
  orders.map(
    ({
      decisionId,
      sessionDate,
      symbol,
      side,
      requestedQuantityMicros,
      filledQuantityMicros,
      status,
      rejectionReason,
      unfilledRemainder,
    }) => ({
      decisionId,
      sessionDate,
      symbol,
      side,
      requestedQuantityMicros,
      filledQuantityMicros,
      status,
      rejectionReason,
      unfilledRemainder,
    }),
  )

const doubledCostHash = (
  material: CandidateDevelopmentDoubledCostHashMaterial,
  value: unknown,
): Result.Result<string, CandidateDevelopmentDoubledCostIssue> =>
  canonicalHashV1Result(value).pipe(
    Result.mapError((cause) => ({
      _tag: 'CandidateDevelopmentDoubledCostHashFailed' as const,
      material,
      cause,
    })),
  )

const invariantHash = (
  reason: Extract<
    CandidateDevelopmentDoubledCostIssue,
    { readonly _tag: 'CandidateDevelopmentDoubledCostProtocolDeviation' }
  >['reason'],
  baselineHash: string,
  stressedHash: string,
): Result.Result<string, CandidateDevelopmentDoubledCostIssue> =>
  baselineHash === stressedHash
    ? Result.succeed(baselineHash)
    : Result.fail({
        _tag: 'CandidateDevelopmentDoubledCostProtocolDeviation',
        disposition: candidateDevelopmentDoubledCostContract.divergenceDisposition,
        reason,
        baselineHash,
        stressedHash,
      })

export const validateCandidateDevelopmentDoubledCostCausalPath = (
  baseline: CandidateDevelopmentDoubledCostRun,
  stressed: CandidateDevelopmentDoubledCostRun,
): Result.Result<CandidateDevelopmentDoubledCostPass, CandidateDevelopmentDoubledCostIssue> => {
  const multiplierMismatch = [
    {
      run: 'baseline' as const,
      expected: candidateDevelopmentDoubledCostContract.baselineCostMultiplierMicros,
      observed: baseline.simulation.costMultiplierMicros,
    },
    {
      run: 'stressed' as const,
      expected: candidateDevelopmentDoubledCostContract.stressedCostMultiplierMicros,
      observed: stressed.simulation.costMultiplierMicros,
    },
  ].find(({ expected, observed }) => expected !== observed)
  if (multiplierMismatch !== undefined) {
    return Result.fail({ _tag: 'CandidateDevelopmentDoubledCostMultiplierMismatch', ...multiplierMismatch })
  }

  return Result.all({
    baselineSignals: doubledCostHash('baseline-signals', baseline.signalDecisions),
    stressedSignals: doubledCostHash('stressed-signals', stressed.signalDecisions),
    baselineOrders: doubledCostHash('baseline-orders', orderQuantityPath(baseline.simulation.orders)),
    stressedOrders: doubledCostHash('stressed-orders', orderQuantityPath(stressed.simulation.orders)),
    baselineExecutionModel: doubledCostHash('baseline-execution-model', baseline.simulation.executionModel),
    stressedExecutionModel: doubledCostHash('stressed-execution-model', stressed.simulation.executionModel),
  }).pipe(
    Result.flatMap(
      ({
        baselineExecutionModel,
        baselineOrders,
        baselineSignals,
        stressedExecutionModel,
        stressedOrders,
        stressedSignals,
      }) =>
        Result.all({
          executionModelHash: invariantHash('EXECUTION_MODEL_CHANGED', baselineExecutionModel, stressedExecutionModel),
          signalDecisionsHash: invariantHash('SIGNAL_DECISIONS_CHANGED', baselineSignals, stressedSignals),
          orderQuantityPathHash: invariantHash('ORDER_QUANTITY_PATH_CHANGED', baselineOrders, stressedOrders),
        }),
    ),
    Result.map(({ executionModelHash, orderQuantityPathHash, signalDecisionsHash }) => ({
      schemaVersion: 'bayn.candidate-development-doubled-cost-check.v1' as const,
      status: 'PASS' as const,
      signalDecisionsHash,
      orderQuantityPathHash,
      executionModelHash,
    })),
  )
}

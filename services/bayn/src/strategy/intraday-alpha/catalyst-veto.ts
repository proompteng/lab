import { Effect, Option, Result, Schema } from 'effect'

import { JevClient, type JevInference } from '../../jev/client'
import { JevContractError, prepareJevRequest, type JevRequest } from '../../jev/contract'
import { Sha256Schema, SymbolSchema, UnitIntervalSchema, UtcInstantSchema } from '../../schemas'
import { IntradayAlphaPhase, intradayAlphaPromptPolicy } from './policy'

export const catalystVetoQuestionName = intradayAlphaPromptPolicy.vetoQuestionName

export const CatalystVetoDirectionSchema = Schema.Literals(['LONG', 'SHORT'])
export type CatalystVetoDirection = typeof CatalystVetoDirectionSchema.Type

export const CatalystVetoReceiptSchema = Schema.Struct({
  symbol: SymbolSchema,
  phase: Schema.Literals([IntradayAlphaPhase.MorningOrb, IntradayAlphaPhase.MiddayReversion]),
  direction: CatalystVetoDirectionSchema,
  status: Schema.Literals(['ASSESSED', 'UNAVAILABLE']),
  requestHash: Schema.NullOr(Sha256Schema),
  responseHash: Schema.NullOr(Sha256Schema),
  vetoProbability: Schema.NullOr(UnitIntervalSchema),
  vetoed: Schema.Boolean,
  recordedAt: UtcInstantSchema,
})
export type CatalystVetoReceipt = typeof CatalystVetoReceiptSchema.Type

export interface CatalystVetoRequestInput {
  readonly model: JevRequest['model']
  readonly symbol: string
  readonly phase: IntradayAlphaPhase.MorningOrb | IntradayAlphaPhase.MiddayReversion
  readonly direction: CatalystVetoDirection
  readonly windowEndAt: string
  readonly sessionOpenPrice: number
  readonly sessionVwap: number
  readonly latestClose: number
  readonly relVwapDevBps: number
  readonly recentBars: readonly {
    readonly eventAt: string
    readonly open: number
    readonly high: number
    readonly low: number
    readonly close: number
    readonly volume: number
  }[]
}

export const makeCatalystVetoRequest = (input: CatalystVetoRequestInput) =>
  prepareJevRequest({
    model: input.model,
    state: {
      schemaVersion: 'bayn.intraday-alpha-catalyst-veto-state.v1',
      symbol: input.symbol,
      phase: input.phase,
      proposedDirection: input.direction,
      windowEndAt: input.windowEndAt,
      sessionSummary: {
        sessionOpenPriceUsd: input.sessionOpenPrice,
        sessionVwapUsd: input.sessionVwap,
        latestCloseUsd: input.latestClose,
        relativeVwapDeviationBps: Number(input.relVwapDevBps.toFixed(2)),
      },
      recentCompletedBars1m: input.recentBars.slice(-15),
    },
    questions: {
      [catalystVetoQuestionName]: {
        type: 'noul',
        instructions: {
          question:
            'Does the observed price and volume sequence show an extreme disorderly catalyst dislocation (such as a trading halt, abrupt multi-percent vertical news shock, or broken liquidity spike) that invalidates normal intraday structure?',
          evidence: intradayAlphaPromptPolicy.instructions,
        },
        criteria: {
          true: 'A severe, disorderly single-stock shock, halt gap, or vertical blowoff dominates the recent bars.',
          false:
            'Price action reflects ordinary intraday trend, pullback, or cross-sectional dispersion without a disorderly shock.',
        },
      },
    },
  })

export const evaluateCatalystVetoInference = (input: {
  readonly symbol: string
  readonly phase: IntradayAlphaPhase.MorningOrb | IntradayAlphaPhase.MiddayReversion
  readonly direction: CatalystVetoDirection
  readonly inference: JevInference
  readonly vetoThreshold: number
}): Result.Result<CatalystVetoReceipt, JevContractError> => {
  const answer = input.inference.response.answers[catalystVetoQuestionName]
  if (answer?.type !== 'noul')
    return Result.fail(new JevContractError({ message: 'Catalyst veto response lacks required noul answer' }))
  return Result.succeed({
    symbol: input.symbol,
    phase: input.phase,
    direction: input.direction,
    status: 'ASSESSED',
    requestHash: input.inference.requestHash,
    responseHash: input.inference.responseHash,
    vetoProbability: answer.noul,
    vetoed: answer.noul >= input.vetoThreshold,
    recordedAt: input.inference.completedAt,
  })
}

/**
 * Runs fast single-stage numerical Jev vetos across finalist candidates.
 * Unavailable provider responses fail open to the deterministic quant signal
 * (recorded explicitly as UNAVAILABLE) so inference outages never starve sessions.
 */
export const evaluateCatalystVetos = (input: {
  readonly candidates: readonly CatalystVetoRequestInput[]
  readonly vetoThreshold: number
  readonly budgetMs: number
  readonly recordedAt: string
}): Effect.Effect<readonly CatalystVetoReceipt[]> =>
  Effect.gen(function* () {
    const client = yield* Effect.serviceOption(JevClient)
    if (Option.isNone(client) || input.candidates.length === 0 || input.budgetMs <= 0) return []
    const boundedBudgetMs = Math.max(1, Math.min(10_000, Math.floor(input.budgetMs)))
    return yield* Effect.forEach(
      input.candidates,
      (candidate) =>
        Effect.gen(function* () {
          const prepared = makeCatalystVetoRequest(candidate)
          if (Result.isFailure(prepared)) {
            return {
              symbol: candidate.symbol,
              phase: candidate.phase,
              direction: candidate.direction,
              status: 'UNAVAILABLE' as const,
              requestHash: null,
              responseHash: null,
              vetoProbability: null,
              vetoed: false,
              recordedAt: input.recordedAt,
            }
          }
          const result = yield* client.value.evaluate(prepared.success.request, boundedBudgetMs).pipe(Effect.result)
          if (Result.isFailure(result)) {
            yield* Effect.logWarning('Intraday alpha catalyst veto unavailable; preserving quant candidate').pipe(
              Effect.annotateLogs({
                symbol: candidate.symbol,
                phase: candidate.phase,
                failure: result.failure.failure,
              }),
            )
            return {
              symbol: candidate.symbol,
              phase: candidate.phase,
              direction: candidate.direction,
              status: 'UNAVAILABLE' as const,
              requestHash: prepared.success.requestHash,
              responseHash: null,
              vetoProbability: null,
              vetoed: false,
              recordedAt: input.recordedAt,
            }
          }
          const evaluated = evaluateCatalystVetoInference({
            symbol: candidate.symbol,
            phase: candidate.phase,
            direction: candidate.direction,
            inference: result.success,
            vetoThreshold: input.vetoThreshold,
          })
          return Result.isSuccess(evaluated)
            ? evaluated.success
            : {
                symbol: candidate.symbol,
                phase: candidate.phase,
                direction: candidate.direction,
                status: 'UNAVAILABLE' as const,
                requestHash: prepared.success.requestHash,
                responseHash: result.success.responseHash,
                vetoProbability: null,
                vetoed: false,
                recordedAt: input.recordedAt,
              }
        }),
      { concurrency: 4 },
    )
  })

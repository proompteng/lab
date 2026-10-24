import { jevInstructions } from './instructions'
import { BigDecimal, Result, Schema } from 'effect'

import { quantizeInstrumentPriceMicros } from '../broker/alpaca-price'
import type { StrategyMarketSnapshot } from '../market-data/streaming/snapshot'
import { numberToMicros, priceNumberToMicros, scaledNumber } from '../strategy/execution-model/fixed-point'
import { JevContractError, type JevRequest, type JevResponse } from './contract'
import { fundJevTradePlan, type JevEntryEconomics } from './entry-economics'
import { jevBreakEvenExitLimitPrice, jevExitLimitValue } from './liquidation-economics'
import type { JevProtocol } from './protocol'
import { jevHoldingMinutesForSymbol } from './markets'
import { JevFundedExitPlanSchema, JevStrategyExitPlanSchema } from './strategy-exit-plan'

export enum JevEntrySetup {
  Upward = 'upward',
  Unclear = 'unclear',
  Adverse = 'adverse',
}

export const jevEntrySetupQuestion = {
  type: 'choice',
  instructions:
    'Assess whether `candidate`, `benchmark` and `relativeSignals` show a current long continuation setup over the supplied observation window. Compare recent completed bars with the current quote, trend, participation and benchmark. Judge the observed setup rather than predicting a future price or guaranteeing a profitable trade. An old rise contradicted by current deterioration is not upward support.',
  criteria: {
    [JevEntrySetup.Upward]:
      'The current observed price structure, direction and participation support a long continuation setup.',
    [JevEntrySetup.Unclear]:
      'The current observations are flat, mixed, contradictory or insufficient for a supported long continuation setup.',
    [JevEntrySetup.Adverse]:
      'Current deterioration, exhaustion or a failed upward structure argues against a long continuation setup.',
  },
} satisfies JevRequest['questions'][string]

const representativePrices = (values: readonly bigint[], maximum: number) => {
  const prices = [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
  return prices.filter((_, index) =>
    Array.from({ length: Math.min(maximum, prices.length) }, (_, slot) =>
      Math.floor((slot * (prices.length - 1)) / Math.max(1, Math.min(maximum, prices.length) - 1)),
    ).includes(index),
  )
}

export const jevTradePlanQuestion = (input: {
  readonly snapshot: StrategyMarketSnapshot
  readonly symbol: string
  readonly economics: JevEntryEconomics | null
  readonly protocol: JevProtocol
}) =>
  Result.gen(function* () {
    const { snapshot, symbol, economics, protocol } = input
    const criteria: Record<
      string,
      Extract<JevRequest['questions'][string], { readonly type: 'choice' }>['criteria'][string]
    > = {
      wait: 'No supplied complete plan has sufficient current observational support for a cost-covering long trade within the holding horizon.',
      avoid:
        'The current setup, stop placement, target distance or net reward versus loss argues against entering any supplied complete long plan now.',
    }
    if (economics !== null) {
      const quote = snapshot.latestQuotes[symbol]
      if (quote === undefined)
        return yield* Result.fail(new JevContractError({ message: 'Trade plans require a verified quote' }))
      const bid = yield* priceNumberToMicros(quote.bidPrice, 'plan bid', 'DOWN')
      const values = yield* Result.all(
        snapshot.bars
          .filter((bar) => bar.symbol === symbol)
          .flatMap((bar) => [bar.open, bar.high, bar.low, bar.close])
          .map((price) =>
            Result.gen(function* () {
              yield* numberToMicros(price, 'observed plan context')
              const rounded = BigDecimal.round(BigDecimal.fromNumberUnsafe(price), { scale: 6, mode: 'floor' })
              return yield* scaledNumber(Number(BigDecimal.scale(rounded, 6).value), 'observed plan context', 1)
            }),
          ),
      )
      if (values.length === 0)
        return yield* Result.fail(new JevContractError({ message: 'Trade plans require completed price history' }))
      const high = values.reduce((left, right) => (left > right ? left : right))
      const low = values.reduce((left, right) => (left < right ? left : right))
      const tick =
        quantizeInstrumentPriceMicros(symbol, bid + 1n, 'UP') - quantizeInstrumentPriceMicros(symbol, bid, 'DOWN')
      const rangeStep = (high - low + 3n) / 4n
      const step = rangeStep > tick ? rangeStep : tick
      const acquisition = BigInt(economics.acquisitionCostMicros)
      const upperLimit = BigInt(economics.maximumEntryPriceMicros) * 2n
      const liquidation = { protocol, symbol, quantityAtoms: BigInt(economics.receivedQuantityAtoms) }
      const maximumTarget = yield* jevExitLimitValue({ ...liquidation, limitPriceMicros: upperLimit })
      const profitableLimit = yield* jevBreakEvenExitLimitPrice({
        ...liquidation,
        acquisitionCostMicros: acquisition + 1n,
        upperLimitPriceMicros: upperLimit,
      })
      const minimumProfitPrice = quantizeInstrumentPriceMicros(symbol, profitableLimit, 'UP')
      const moves = [1n, 2n, 4n, 8n]
      const stops = representativePrices(
        [...values.filter((price) => price < bid), ...moves.map((multiple) => bid - step * multiple)]
          .map((price) => quantizeInstrumentPriceMicros(symbol, price, 'DOWN'))
          .filter((price) => price > 0n && price < bid),
        4,
      )
      const marketProfits = representativePrices(
        [...values, ...moves.map((multiple) => bid + step * multiple)]
          .map((price) => quantizeInstrumentPriceMicros(symbol, price, 'UP'))
          .filter((price) => price >= minimumProfitPrice),
        3,
      )
      for (const stop of stops) {
        const stopLimit = quantizeInstrumentPriceMicros(
          symbol,
          (stop * BigInt(10_000 - protocol.maximumEntryLimitSlippageBps) + 9_999n) / 10_000n,
          'UP',
        )
        const stopValue = yield* jevExitLimitValue({ ...liquidation, limitPriceMicros: stopLimit })
        const loss = acquisition - stopValue.conservativeNetMicros
        const requiredTargetNet = acquisition + loss
        const rewardPrice =
          stopValue.conservativeNetMicros > 0n && loss > 0n && requiredTargetNet <= maximumTarget.conservativeNetMicros
            ? quantizeInstrumentPriceMicros(
                symbol,
                yield* jevBreakEvenExitLimitPrice({
                  ...liquidation,
                  acquisitionCostMicros: requiredTargetNet,
                  upperLimitPriceMicros: upperLimit,
                }),
                'UP',
              )
            : undefined
        const profits = representativePrices([...marketProfits, ...(rewardPrice === undefined ? [] : [rewardPrice])], 4)
        for (const profit of profits) {
          const levels = yield* Schema.decodeUnknownResult(JevStrategyExitPlanSchema)({
            schemaVersion: 'bayn.jev-strategy-exit-plan.v3',
            rule: 'model-selected-complete-plan',
            symbol,
            sourceStartAt: snapshot.manifest.rangeStartAt,
            sourceEndAt: snapshot.manifest.rangeEndAt,
            maximumHoldingMinutes: jevHoldingMinutesForSymbol(protocol, symbol),
            maximumEntryPriceMicros: economics.maximumEntryPriceMicros,
            stopPriceMicros: stop.toString(),
            stopLimitPriceMicros: stopLimit.toString(),
            profitLimitPriceMicros: profit.toString(),
          }).pipe(
            Result.mapError((cause) => new JevContractError({ message: 'Proposed trade plan is invalid', cause })),
          )
          const funded = yield* fundJevTradePlan({ protocol, economics, levels })
          if (funded === null) continue
          criteria[`plan_${Object.keys(criteria).length - 2}`] = {
            priceBasis: 'HYPOTHETICAL_ORDER_PRICES',
            targetBasis: profit === rewardPrice ? 'NET_REWARD_ORDER_SCENARIO' : 'OBSERVED_RANGE_ORDER_SCENARIO',
            meaning:
              'A supplied complete long entry, stop and target plan. Its payoff numbers are conditional on execution at the proposed prices; assess whether entering this trade now is supported by the observations and holding horizon.',
            plan: funded.exitPlan,
            stopPriceUsd: Number(stop) / 1_000_000,
            targetPriceUsd: Number(profit) / 1_000_000,
            estimatedLossUsd:
              Number(BigInt(economics.acquisitionCostMicros) - BigInt(funded.exitPlan.estimatedStopNetMicros)) /
              1_000_000,
            estimatedProfitUsd:
              Number(BigInt(funded.exitPlan.estimatedTargetNetMicros) - BigInt(economics.acquisitionCostMicros)) /
              1_000_000,
          }
        }
      }
    }
    return {
      type: 'choice' as const,
      instructions: jevInstructions.entry,
      criteria,
    }
  })

export const selectedJevTradePlan = (request: JevRequest, response: JevResponse) =>
  Result.gen(function* () {
    const setup = response.answers['setup']
    if (
      request.questions['setup']?.type !== 'choice' ||
      setup?.type !== 'choice' ||
      !Object.values(JevEntrySetup).some((choice) => choice === setup.choice)
    )
      return yield* Result.fail(new JevContractError({ message: 'Entry requires a typed current-setup judgment' }))
    if (setup.choice !== JevEntrySetup.Upward) return null
    const answer = response.answers['action']
    const question = request.questions['action']
    if (answer?.type !== 'choice' || question?.type !== 'choice')
      return yield* Result.fail(new JevContractError({ message: 'Entry requires a typed complete-plan choice' }))
    if (answer.choice === 'wait' || answer.choice === 'avoid') return null
    const selected = question.criteria[answer.choice]
    if (selected === null || typeof selected !== 'object' || Array.isArray(selected) || !('plan' in selected))
      return yield* Result.fail(new JevContractError({ message: 'Jev selected a plan outside its sealed request' }))
    return yield* Schema.decodeUnknownResult(JevFundedExitPlanSchema)(selected['plan']).pipe(
      Result.mapError((cause) => new JevContractError({ message: 'Selected complete plan is invalid', cause })),
    )
  })

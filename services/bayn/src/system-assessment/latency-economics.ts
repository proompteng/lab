import { InferenceRateCardSchema } from '../inference-costs'
import { Result, Schema } from 'effect'

import { OrderStatus } from '../broker/alpaca/model'
import { canonicalHashV1Result } from '../hash'
import { restoreReplayBrokerCheckpoint, type ReplayBrokerEvidenceConfig } from '../intraday-replay/broker-checkpoint'
import { calculateReplayInferenceCosts, registeredReplayInferenceTariff } from '../intraday-replay/inference-costs'
import { ReplayInferenceCallSchema } from '../intraday-replay/inference-timing'
import { validateReplayInferenceCalls } from '../intraday-replay/recorded-inference'
import {
  applyReplayFill,
  createReplayLedger,
  type EconomicReplayFill,
  type ReplayLedger,
} from '../intraday-replay/ledger'
import type { ExecutionModel } from '../execution-model-contract'
import { JevResearchPolicy } from '../jev/acceptance'
import { makeOperatingCostReport, OperatingCostEvidenceSchema } from '../operating-costs'
import { validateOperatingCostWindow } from '../operating-cost-window'
import { Sha256Schema, UtcInstantSchema, strictParseOptions } from '../schemas'
import { SystemAssessmentError } from './economics'
import { validateFrozenCostAllocations } from './cost-allocation'
import { registeredAllocationMicros, type SystemRegistration, verifyStoredSystemRegistration } from './policy'

export const ReplaySessionCostsSchema = Schema.Struct({
  policy: Schema.Enum(JevResearchPolicy),
  allocationRuleHash: Sha256Schema,
  asOf: UtcInstantSchema,
  inferenceCalls: Schema.Array(ReplayInferenceCallSchema),
  inferenceTariff: InferenceRateCardSchema,
  sessions: Schema.Array(OperatingCostEvidenceSchema).check(Schema.isMinLength(1)),
})

interface ReplayEconomicConfig {
  readonly openingCashMicros: string
  readonly feeModel: Pick<ExecutionModel, 'fees'>
  readonly feeMultiplierPpm: number
}

export interface ReplayFinancialCheckpoint {
  readonly checkpointHash: string
  readonly observedAt: string
  readonly state: {
    readonly createdAt: string
    readonly ledger: ReplayLedger<EconomicReplayFill>
    readonly orders: readonly {
      readonly order: { readonly status: OrderStatus; readonly submittedAt: string; readonly updatedAt: string }
    }[]
    readonly sessionCloses: readonly {
      readonly sessionDate: string
      readonly equityMicros: string
      readonly valuationQualified: boolean
    }[]
  }
}

/** Native execution validates its complete broker checkpoint before sharing the economic evaluator. */
export const reproduceReplaySessionEconomics = (
  registration: SystemRegistration,
  config: ReplayBrokerEvidenceConfig,
  checkpoint: unknown,
  rawCosts: unknown,
  verifiedSources: ReadonlySet<string>,
) =>
  Result.gen(function* () {
    const retained = yield* restoreReplayBrokerCheckpoint(checkpoint, config)
    return yield* reproduceSessionEconomics(
      registration,
      {
        openingCashMicros: config.openingCashMicros,
        feeModel: config.protocol.executionModel,
        feeMultiplierPpm: config.assumptions.feeMultiplierPpm,
      },
      retained,
      rawCosts,
      verifiedSources,
    )
  })

/** Reproduce every fill, flat close and operating charge after the producer's evidence has been authenticated. */
export const reproduceSessionEconomics = (
  registration: SystemRegistration,
  config: ReplayEconomicConfig,
  retained: ReplayFinancialCheckpoint,
  rawCosts: unknown,
  verifiedSources: ReadonlySet<string>,
) =>
  Result.gen(function* () {
    const fail = (message: string) => Result.fail(new SystemAssessmentError({ message }))
    const { registrationHash } = yield* verifyStoredSystemRegistration(registration)
    const costs = yield* Schema.decodeUnknownResult(ReplaySessionCostsSchema, strictParseOptions)(rawCosts)
    yield* validateOperatingCostWindow(costs.sessions)
    for (const session of costs.sessions)
      for (const source of yield* validateFrozenCostAllocations(registration.costAllocationPlans, session))
        if (!verifiedSources.has(source))
          return yield* fail('Replay cost allocation basis source has not been verified')
    yield* validateReplayInferenceCalls(costs.inferenceCalls)
    const definition = registration.policies.find((policy) => policy.policy === costs.policy)
    if (
      definition === undefined ||
      definition.costAllocationRuleHash !== costs.allocationRuleHash ||
      !verifiedSources.has(costs.allocationRuleHash) ||
      config.openingCashMicros !== registeredAllocationMicros(registration)
    )
      return yield* fail('Replay economics differs from the registered allocation or cost rule')
    const first = registration.calendar.sessions[0]
    const last = registration.calendar.sessions.at(-1)
    if (
      first === undefined ||
      last === undefined ||
      retained.observedAt < last.closeAt ||
      retained.observedAt > costs.asOf ||
      retained.state.createdAt > first.openAt
    )
      return yield* fail('Replay accounting does not cover the registered evaluation window')
    const tariff = yield* registeredReplayInferenceTariff(
      definition.inferenceRateCard,
      {
        startAt: first.openAt,
        endAt: last.closeAt,
      },
      costs.policy,
    )
    if ((yield* canonicalHashV1Result(tariff)) !== (yield* canonicalHashV1Result(costs.inferenceTariff)))
      return yield* fail('Replay accounting changed the registered inference tariff')
    const closes = retained.state.sessionCloses
    if (
      closes.length !== registration.calendar.sessions.length ||
      closes.some((close, index) => close.sessionDate !== registration.calendar.sessions[index]?.sessionDate) ||
      costs.sessions.some(
        (session, index) => session.sessionDate !== registration.calendar.sessions[index]?.sessionDate,
      )
    )
      return yield* fail('Replay economics omits, substitutes or reorders registered sessions')
    const fills = retained.state.ledger.fills
    if (fills.some((fill, index) => index > 0 && fill.observedAt < (fills[index - 1]?.observedAt ?? '')))
      return yield* fail('Replay fills are not in chronological execution order')
    let ledger = yield* createReplayLedger(config.openingCashMicros)
    let nextFill = 0
    let countedCalls = 0
    const sessions = []
    const terminalStatuses = new Set([
      OrderStatus.Filled,
      OrderStatus.Canceled,
      OrderStatus.Expired,
      OrderStatus.Rejected,
    ])
    for (const [index, window] of registration.calendar.sessions.entries()) {
      const openingCash = BigInt(ledger.cashMicros)
      const firstFill = nextFill
      while (nextFill < fills.length) {
        const fill = fills[nextFill]
        if (fill === undefined || fill.observedAt > window.closeAt) break
        if (fill.observedAt < window.openAt)
          return yield* fail('Replay contains execution outside a registered session')
        ledger = yield* applyReplayFill(ledger, fill, fill.quantityAtoms, config.feeModel, config.feeMultiplierPpm)
        nextFill++
      }
      const close = closes[index]
      if (
        ledger.positions.length !== 0 ||
        close === undefined ||
        !close.valuationQualified ||
        close.equityMicros !== ledger.cashMicros ||
        retained.state.orders.some(
          ({ order }) =>
            order.submittedAt <= window.closeAt &&
            (!terminalStatuses.has(order.status) || order.updatedAt > window.closeAt),
        )
      )
        return yield* fail('Replay session close is not flat, settled and reproduced by its fills')
      const executionPnlMicros = (BigInt(ledger.cashMicros) - openingCash).toString()
      const financialSourceHash = yield* canonicalHashV1Result({
        checkpointHash: retained.checkpointHash,
        sessionDate: window.sessionDate,
        fills: fills.slice(firstFill, nextFill),
        openingCashMicros: openingCash.toString(),
        closingCashMicros: ledger.cashMicros,
      })
      const calls = costs.inferenceCalls.filter(
        (call) => window.openAt <= call.simulatedStartedAt && call.simulatedStartedAt <= window.closeAt,
      )
      countedCalls += calls.length
      const tariff = calculateReplayInferenceCosts(calls, costs.inferenceTariff)
      const expense = costs.sessions[index]
      if (
        expense === undefined ||
        expense.asOf < window.closeAt ||
        expense.asOf > costs.asOf ||
        expense.accountBindingHash !== definition.accountBindingHash ||
        (expense.trading !== null &&
          (expense.trading.sourceHash !== financialSourceHash ||
            expense.trading.netPnlAfterExecutionFeesMicros !== executionPnlMicros))
      )
        return yield* fail('Replay operating costs have a different policy, evidence cut or trading result')
      const basis = {
        schemaVersion: 'bayn.replay-inference-cost-basis.v1',
        accountBindingHash: definition.accountBindingHash,
        sessionDate: window.sessionDate,
        asOf: expense.asOf,
        evidenceHash: yield* canonicalHashV1Result(calls),
        rateCardHash: yield* canonicalHashV1Result(costs.inferenceTariff),
        knownEstimatedCostMicros: tariff.knownCostMicros,
        estimatedTotalCostMicros: tariff.unresolvedCallCount === 0 ? tariff.knownCostMicros : null,
        unknownUsageCount: tariff.unresolvedCallCount,
        unpricedUsageCount: 0,
        tariff,
      }
      const sources = new Set([...verifiedSources, financialSourceHash])
      const operating = yield* makeOperatingCostReport(
        { ...basis, reportHash: yield* canonicalHashV1Result(basis) },
        {
          ...expense,
          trading: { netPnlAfterExecutionFeesMicros: executionPnlMicros, sourceHash: financialSourceHash },
        },
        sources,
      )
      const qualificationPnlMicros = operating.qualificationPnlMicros
      sessions.push({
        sessionDate: window.sessionDate,
        financialSourceHash,
        executionPnlMicros,
        netEconomicPnlMicros: operating.netEconomicPnlMicros,
        qualificationPnlMicros,
        inference: basis,
        operating,
        complete: operating.fullyCosted && qualificationPnlMicros !== null,
      })
    }
    if (nextFill !== fills.length || countedCalls !== costs.inferenceCalls.length)
      return yield* fail('Replay fills or inference charges fall outside the registered session coverage')
    if ((yield* canonicalHashV1Result(ledger)) !== (yield* canonicalHashV1Result(retained.state.ledger)))
      return yield* fail('Replay session aggregation does not reproduce the complete ledger')
    const material = {
      schemaVersion: 'bayn.replay-session-economics.v1',
      environment: 'PAPER',
      evidenceMode: 'COUNTERFACTUAL',
      registrationHash,
      definitionHash: yield* canonicalHashV1Result(definition),
      checkpointHash: retained.checkpointHash,
      costEvidenceHash: yield* canonicalHashV1Result(costs),
      asOf: costs.asOf,
      sessions,
      complete: sessions.every((session) => session.complete),
    }
    return { ...material, evidenceHash: yield* canonicalHashV1Result(material) }
  }).pipe(
    Result.mapError(
      (cause) => new SystemAssessmentError({ message: 'Replay session economics could not be reproduced', cause }),
    ),
  )

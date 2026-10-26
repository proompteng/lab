import { Effect, Option } from 'effect'

import { MutationOperation } from '../broker/alpaca-mutations/model'
import type { AutonomousCycle } from '../cycle/model'
import {
  intentPlanSchemaVersion,
  IntentState,
  OrderSide,
  OrderStatus,
  OrderType,
  RiskOutcome,
  TimeInForce,
} from '../execution/contracts'
import { IntentStore, planExecutionIntent } from '../execution/intents/domain'
import { MutationStore } from '../execution/mutations/model'
import { decidePositionProtection, type ProtectionOrderState } from '../execution/position-protection'
import { canonicalHashV1Result } from '../hash'
import { JevPositionStore } from '../jev/portfolio'
import type { JevProtocol } from '../jev/protocol'
import { evaluateJevPositionManagement } from '../jev/runtime'
import type { JevExitTarget } from '../jev/exit'
import type { ReconciliationPassResult } from '../reconciler'
import { BrokerMode, evaluate, type Policy, type State } from '../risk'
import type { ExecutionDecisionDocument } from '../shadow-decision-contract'
import { currentUtcInstant } from '../time'
import { quantityScale } from '../quantity'
import type { CycleWaitReason } from '../cycle/runner/readiness'
import { CycleRunnerError } from '../cycle/runner/model'
import {
  decidePreparedMutationRecovery,
  mutationRecoveryIsDue,
  type PreparedMutationCycleStep,
} from './mutation-decisions'
import { mutationRunnerError } from './mutation-interpreter'
import type { ExecutionCapability, ObserveAutonomousCycleInput, PostMutationReconciliation } from './model'

const terminal = (status: OrderStatus) =>
  [OrderStatus.Filled, OrderStatus.Canceled, OrderStatus.Expired, OrderStatus.Rejected].includes(status)

type ProtectionAdvance =
  | { readonly _tag: 'Ready'; readonly exitTarget?: JevExitTarget }
  | { readonly _tag: 'Step'; readonly step: PreparedMutationCycleStep }
  | PostMutationReconciliation

/** One account writer owns entry settlement, native coverage, cancellation and residual liquidation. */
export const advancePositionProtection = (request: {
  readonly input: ObserveAutonomousCycleInput
  readonly cycle: AutonomousCycle
  readonly document: ExecutionDecisionDocument
  readonly protocol: JevProtocol
  readonly policy: Policy
  readonly reconciliation: ReconciliationPassResult
  readonly capability: ExecutionCapability
  readonly closeDue: boolean
  readonly closeExpiresAt: string
}): Effect.Effect<ProtectionAdvance, CycleRunnerError, IntentStore | MutationStore | JevPositionStore> =>
  Effect.gen(function* () {
    const { input, cycle, document, protocol, policy, reconciliation, capability } = request
    const target = document.strategyDecision
    if (target?.schemaVersion !== 'bayn.jev-entry-target.v7' || Object.keys(target.exitPolicy.plans).length === 0)
      return { _tag: 'Ready' } as const
    const plan = Object.values(target.exitPolicy.plans)[0]
    if (plan === undefined) return { _tag: 'Ready' } as const
    const observedAt = yield* currentUtcInstant
    const intents = yield* IntentStore
    const mutations = yield* MutationStore
    const protective = yield* intents.protectionForCycle(cycle.identity.cycleId)
    const entries = yield* Effect.forEach(document.orderedIntentIds, (id) => intents.read(id))
    const state = reconciliation.brokerState
    const quantityAtoms = state.positions
      .filter((position) => position.symbol === plan.levels.symbol)
      .reduce((sum, position) => sum + BigInt(position.quantityAtoms), 0n)
    const execute = (
      intentId: string,
      action: 'CANCEL' | 'RECOVER_SUBMIT' | 'RECOVER_CANCEL' | 'SUBMIT',
      submitExpiresAt?: string,
    ): ProtectionAdvance => ({
      _tag: 'Step',
      step: {
        _tag: 'Execute',
        intentId,
        action,
        observedAt,
        ...(submitExpiresAt === undefined ? {} : { submitExpiresAt }),
      } as PreparedMutationCycleStep,
    })
    const wait = (reason: CycleWaitReason): ProtectionAdvance => ({
      _tag: 'Step',
      step: { _tag: 'Wait', observedAt, waitReason: reason },
    })

    // Unknown submission/cancellation outcomes are resolved before placing or replacing coverage.
    for (const record of protective) {
      const submit = yield* mutations.latest(record.intent.intentId, MutationOperation.Submit)
      const cancel = yield* mutations.latest(record.intent.intentId, MutationOperation.Cancel)
      const recovery = yield* Effect.fromResult(decidePreparedMutationRecovery(record.intent, submit, cancel))
      if (recovery._tag === 'Recover')
        return mutationRecoveryIsDue(recovery.event, observedAt)
          ? execute(
              record.intent.intentId,
              recovery.operation === MutationOperation.Submit ? 'RECOVER_SUBMIT' : 'RECOVER_CANCEL',
            )
          : wait('PROTECTION_RECOVERY_BACKOFF')
      const rootOrder = state.orders.find((order) => order.clientOrderId === record.intent.clientOrderId)
      if (record.intent.state === IntentState.Acknowledged && rootOrder !== undefined && terminal(rootOrder.status))
        return execute(record.intent.intentId, 'RECOVER_SUBMIT')
      if (record.intent.state === IntentState.Approved && record.intent.protection?._tag !== 'Bracket') {
        if (capability._tag === 'RecoveryOnly') return wait('PROTECTION_RECOVERY_ONLY')
        return execute(record.intent.intentId, 'SUBMIT', request.closeExpiresAt)
      }
    }
    const workingEntry = entries.flatMap(Option.toArray).find(({ intent }) => intent.state !== IntentState.Terminal)
    if (workingEntry !== undefined) {
      if (quantityAtoms > 0n || request.closeDue) return execute(workingEntry.intent.intentId, 'CANCEL')
      return { _tag: 'Ready' } as const
    }
    const open = state.orders.filter(
      (order) =>
        order.side === OrderSide.Sell &&
        !terminal(order.status) &&
        protective.some((record) => record.intent.intentId === order.intentId),
    )
    let management: Effect.Success<ReturnType<typeof evaluateJevPositionManagement>> = {
      _tag: 'Wait',
      details: { waitReason: 'JEV_POSITION_HELD' },
    }
    if (quantityAtoms > 0n && !request.closeDue) {
      if (
        state.reconciliation.status !== 'EXACT' ||
        !reconciliation.report.metrics.accountingExact ||
        reconciliation.riskContext.unknownMutationCount !== 0 ||
        state.unknownOrderCount !== 0
      )
        return wait('PROTECTION_AWAITING_RECONCILIATION')
      if (input.intradayMarketData === undefined || document.executionSession === undefined)
        return yield* mutationRunnerError({
          message: 'Strategy protection requires its bound market reader and session',
          failure: 'contract',
        })
      management = yield* evaluateJevPositionManagement({
        cycle,
        entryDecisionHash: document.contentHash,
        authorityGenerationHash: input.authorityGenerationHash,
        protocol,
        calendar: document.executionSession.calendar,
        brokerState: state,
        marketData: input.intradayMarketData,
      })
    }
    let protection: ProtectionOrderState = { _tag: 'Absent' }
    const stop = open.find((order) => order.orderType === OrderType.StopLimit)
    if (stop !== undefined && stop.intentId !== undefined) {
      const owner = protective.find((record) => record.intent.intentId === stop.intentId)
      if (owner !== undefined && owner.intent.protection !== undefined)
        protection = {
          _tag: 'Armed',
          intentId: stop.intentId,
          method:
            owner.intent.protection._tag === 'Bracket'
              ? 'BRACKET'
              : owner.intent.protection._tag === 'Oco'
                ? 'OCO'
                : 'STOP_LIMIT',
          quantityAtoms: BigInt(stop.quantityAtoms ?? '0') - BigInt(stop.filledQuantityAtoms),
          stopPriceMicros: BigInt(stop.stopPriceMicros ?? '0'),
          stopLimitPriceMicros: BigInt(stop.limitPriceMicros ?? '0'),
          profitLimitPriceMicros:
            owner.intent.protection._tag === 'StopLimit'
              ? null
              : BigInt(
                  open.find((order) => order.intentId === stop.intentId && order.orderType === OrderType.Limit)
                    ?.limitPriceMicros ?? '0',
                ),
        }
    }
    const action = decidePositionProtection({
      plan,
      entry: { _tag: 'Settled' },
      quantityAtoms,
      protection,
      exitDue: request.closeDue || management._tag === 'Exit',
      observedAt,
    })
    // Even a terminal parent can leave children pending. The durable cancel command latches the exit;
    // a fresh, exact account observation must show every sell settled before the close can proceed.
    if (
      action._tag === 'CancelProtection' ||
      (open.length > 0 && (action._tag === 'Complete' || protection._tag === 'Absent'))
    ) {
      const order = open[0]
      if (order?.intentId === undefined || capability._tag === 'RecoveryOnly') return wait('PROTECTION_CANCEL_PENDING')
      const advanced = yield* capability.executionProgram
        .cancelProtectionOrder(
          order.intentId,
          order.brokerOrderId,
          management._tag === 'Exit' ? management.target : undefined,
        )
        .pipe(
          Effect.catchTag('BrokerMutationError', (cause) =>
            Effect.logWarning('Protective cancellation requires broker reconciliation').pipe(
              Effect.annotateLogs({ brokerOrderId: order.brokerOrderId, failure: cause._tag }),
              Effect.as(true),
            ),
          ),
        )
      return advanced
        ? ({
            _tag: 'PostMutationReconciliation',
            cycle,
            delayMs: 5_000,
            observedAt,
            logContext: {
              cycleId: cycle.identity.cycleId,
              intentId: order.intentId,
              mutationAction: 'CANCEL',
              mutationPhase: 'CLOSE',
            },
          } as const)
        : wait('PROTECTION_CANCEL_PENDING')
    }
    if (action._tag === 'Complete') {
      if (state.positions.some((position) => BigInt(position.quantityAtoms) !== 0n))
        return yield* mutationRunnerError({
          message: 'Native protection cannot complete with inventory outside its entry plan',
          failure: 'contract',
        })
      if (
        state.reconciliation.status !== 'EXACT' ||
        !reconciliation.report.metrics.accountingExact ||
        reconciliation.riskContext.unknownMutationCount !== 0 ||
        state.unknownOrderCount !== 0
      )
        return wait('PROTECTION_AWAITING_RECONCILIATION')
      return { _tag: 'Step', step: { _tag: 'Complete', observedAt } } as const
    }
    if (action._tag === 'Block')
      return yield* mutationRunnerError({
        message: `Strategy protection blocked: ${action.reason}`,
        failure: 'contract',
      })
    if (action._tag === 'Wait' && management._tag === 'Wait')
      return { _tag: 'Step', step: { _tag: 'Wait', observedAt, ...management.details } } as const
    if (action._tag !== 'Arm')
      return { _tag: 'Ready', ...(management._tag === 'Exit' ? { exitTarget: management.target } : {}) } as const
    if (capability._tag === 'RecoveryOnly' || observedAt >= request.closeExpiresAt)
      return wait('PROTECTION_AUTHORITY_UNAVAILABLE')
    const portfolio = yield* JevPositionStore.pipe(
      Effect.flatMap((store) =>
        store.read({ cycleId: cycle.identity.cycleId, entryDecisionHash: document.contentHash, brokerState: state }),
      ),
    )
    if (portfolio.exitRequestedAt !== null) return wait('PROTECTION_EXIT_COMMITTED')
    const facts = document.deltaRisk[0]?.facts
    if (facts === undefined)
      return yield* mutationRunnerError({
        message: 'Protection is missing its entry-bound risk and session facts',
        failure: 'contract',
      })
    const limit = BigInt(
      action.method === 'OCO' ? plan.levels.profitLimitPriceMicros : plan.levels.stopLimitPriceMicros,
    )
    const conditional =
      action.method === 'OCO'
        ? { _tag: 'Oco' as const, ...plan.levels, entryDecisionHash: document.contentHash }
        : {
            _tag: 'StopLimit' as const,
            stopPriceMicros: plan.levels.stopPriceMicros,
            entryDecisionHash: document.contentHash,
          }
    const protectionTerms =
      conditional._tag === 'Oco'
        ? {
            _tag: conditional._tag,
            stopPriceMicros: conditional.stopPriceMicros,
            stopLimitPriceMicros: conditional.stopLimitPriceMicros,
            profitLimitPriceMicros: conditional.profitLimitPriceMicros,
            entryDecisionHash: conditional.entryDecisionHash,
          }
        : conditional
    if (reconciliation.riskContext.authority === null || reconciliation.riskContext.authorityObservedAt === null)
      return yield* mutationRunnerError({
        message: 'Conditional protection has no current authority evidence',
        failure: 'contract',
      })
    const generation = yield* Effect.fromResult(
      canonicalHashV1Result({
        entryDecisionHash: document.contentHash,
        reconciliationId: state.reconciliation.reconciliationId,
        protection: protectionTerms,
      }),
    )
    const riskState: State = {
      ...facts.state,
      brokerMode: BrokerMode.Execution,
      account: state.account,
      positions: state.positions,
      positionsObservedAt: state.positionsObservedAt,
      orders: state.orders,
      ordersObservedAt: state.ordersObservedAt,
      reconciliation: state.reconciliation,
      accountingHash: state.accountingHash,
      authority: reconciliation.riskContext.authority,
      authorityObservedAt: reconciliation.riskContext.authorityObservedAt,
      unknownMutationCount: reconciliation.riskContext.unknownMutationCount,
      dailyTradedNotionalMicros: reconciliation.riskContext.dailyTradedNotionalMicros,
      dayStartEquityMicros: reconciliation.riskContext.dayStartEquityMicros,
      peakEquityMicros: reconciliation.riskContext.peakEquityMicros,
      marketDataHash: generation,
      executionMarketDataHash: generation,
      marketDataObservedAt: state.positionsObservedAt,
      // A conditional sell is priced against its sealed trigger, rather than the present spot price.
      referencePriceMicros: action.method === 'OCO' ? limit.toString() : plan.levels.stopPriceMicros,
      expectedExecutionPriceMicros: limit.toString(),
      marketDataSymbol: plan.levels.symbol,
      reservedBuyingPowerMicros: '0',
      evaluatedAt: observedAt,
      closeOnly: true,
      closeOnlyExpiresAt: request.closeExpiresAt,
    }
    const { entryQuote: _entryQuote, ...conditionalState } = riskState
    const intent = yield* planExecutionIntent(
      {
        schemaVersion: intentPlanSchemaVersion,
        strategyName: 'jev',
        cycleId: cycle.identity.cycleId,
        decisionHash: document.bindings.strategyDecisionHash,
        policyHash: document.bindings.policyHash,
        accountId: state.account.accountId,
        symbol: plan.levels.symbol,
        side: OrderSide.Sell,
        orderType: action.method === 'OCO' ? OrderType.Limit : OrderType.StopLimit,
        timeInForce:
          action.method === 'STOP_LIMIT' && plan.levels.symbol.includes('/')
            ? TimeInForce.GoodUntilCanceled
            : TimeInForce.Day,
        quantityAtoms: quantityAtoms.toString(),
        limitPriceMicros: limit.toString(),
        notionalLimitMicros: ((quantityAtoms * limit) / quantityScale).toString(),
        protection: protectionTerms,
        replanGenerationHash: generation,
        createdAt: observedAt,
      },
      { authority: conditionalState.authority },
    )
    const risk = yield* Effect.fromResult(evaluate({ intent, state: conditionalState, policy }))
    if (risk.decision.outcome !== RiskOutcome.Approved)
      return yield* mutationRunnerError({
        message: `Conditional protection rejected by risk: ${risk.decision.reasonCodes.join(',')}`,
        failure: 'contract',
      })
    if (intents.commitClosing === undefined)
      return yield* mutationRunnerError({
        message: 'Protection requires the close-only intent commit path',
        failure: 'contract',
      })
    yield* intents.commitClosing(intent, risk.decision)
    return execute(intent.intentId, 'SUBMIT', request.closeExpiresAt)
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof CycleRunnerError
        ? cause
        : mutationRunnerError({ message: 'Strategy protection could not advance', cause, failure: 'operational' }),
    ),
  )

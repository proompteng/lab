import { isBrokerManagedAlphaTarget, isProtectedEntryTarget } from '../strategy/runtime-decision'
import { Effect, Option, Result } from 'effect'

import { BrokerMutationError, MutationOperation } from '../broker/alpaca-mutations/model'
import type { AutonomousCycle } from '../cycle/model'
import {
  intentPlanSchemaVersion,
  IntentState,
  OrderSide,
  OrderStatus,
  OrderType,
  RiskOutcome,
  TimeInForce,
  isBracketProtection,
  isOcoProtection,
  isStopProtection,
} from '../execution/contracts'
import { IntentStore, planExecutionIntent } from '../execution/intents/domain'
import { MutationStore } from '../execution/mutations/model'
import { decidePositionProtection, type ProtectionOrderState } from '../execution/position-protection'
import { canonicalHashV1Result } from '../hash'
import { JevPositionStore, JevPurpose } from '../jev/portfolio'
import type { JevProtocol } from '../jev/protocol'
import { evaluateJevPositionManagement } from '../jev/runtime'
import { JevExitReason, jevMaximumHoldDueAt, jevProtectiveStopCrossed, type JevExitTarget } from '../jev/exit'
import { decodeIntradayQuoteRows } from '../market-data/intraday/rows'
import { compareIntradayInstants } from '../market-data/intraday/time'
import type { ReconciliationPassResult } from '../reconciler'
import { BrokerMode, evaluate, type Policy, type State } from '../risk'
import type { ExecutionDecisionDocument } from '../shadow-decision-contract'
import { currentUtcInstant } from '../time'
import { quantityScale } from '../quantity'
import { priceNumberToMicros } from '../strategy/execution-model/fixed-point'
import { isShortExitPlan, type FundedEntryExitPlan } from '../strategy/funded-exit-plan'
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

/**
 * Single-exchange IEX quotes frequently widen one side past stop while Alpaca's already-armed consolidated
 * STOP_LIMIT/OCO/BRACKET remains valid. Only cancel healthy native broker protection for ProtectiveStop when
 * non-IEX evidence or the opposite side of the quote also crosses stop (indicating a genuine market break/gap).
 */
export const armedNativeProtectionRequiresStopCancellation = (
  target: JevExitTarget,
  plan: FundedEntryExitPlan,
): boolean => {
  if (target.reason !== JevExitReason.ProtectiveStop) return true
  const trigger = target.evidence.trigger
  if (trigger.reason !== JevExitReason.ProtectiveStop) return true
  if (trigger.manifest['feed'] !== 'iex') return true
  const decodedQuotes = decodeIntradayQuoteRows(trigger.rows.quotes)
  if (Result.isFailure(decodedQuotes)) return true
  const quotes = decodedQuotes.success.filter((row) => row.symbol === plan.levels.symbol)
  if (quotes.length === 0 || quotes.some((row) => row.feed !== 'iex')) return true
  let latest = quotes[0]
  if (latest === undefined) return true
  for (const row of quotes) {
    if (compareIntradayInstants(row.event_at, latest.event_at) >= 0) latest = row
  }
  const short = isShortExitPlan(plan)
  const oppositeSize = Number(short ? latest.bid_size : latest.ask_size)
  if (!Number.isFinite(oppositeSize) || oppositeSize <= 0) return true
  const oppositePrice = Number(short ? latest.bid_price : latest.ask_price)
  const oppositeMicros = priceNumberToMicros(oppositePrice, short ? 'bid' : 'ask', short ? 'DOWN' : 'UP')
  return Result.isSuccess(oppositeMicros) ? jevProtectiveStopCrossed(oppositeMicros.success, plan.levels) : true
}

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
    if (!isProtectedEntryTarget(target) || Object.keys(target.exitPolicy.plans).length === 0)
      return { _tag: 'Ready' } as const
    const planEntries = Object.entries(target.exitPolicy.plans).toSorted(([a], [b]) => a.localeCompare(b))
    const observedAt = yield* currentUtcInstant
    const intents = yield* IntentStore
    const mutations = yield* MutationStore
    const protective = yield* intents.protectionForCycle(cycle.identity.cycleId)
    const entries = yield* Effect.forEach(document.orderedIntentIds, (id) => intents.read(id))
    const state = reconciliation.brokerState
    const quantityForSymbol = (symbol: string) =>
      state.positions
        .filter((position) => position.symbol === symbol)
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
      if (record.intent.state === IntentState.Approved && !isBracketProtection(record.intent.protection)) {
        if (capability._tag === 'RecoveryOnly') return wait('PROTECTION_RECOVERY_ONLY')
        return execute(record.intent.intentId, 'SUBMIT', request.closeExpiresAt)
      }
    }
    const workingEntries = entries.flatMap(Option.toArray).filter(({ intent }) => intent.state !== IntentState.Terminal)
    if (workingEntries.length > 0) {
      const cancelable = workingEntries.find(
        ({ intent }) => request.closeDue || quantityForSymbol(intent.symbol) !== 0n,
      )
      if (cancelable !== undefined) return execute(cancelable.intent.intentId, 'CANCEL')
      return { _tag: 'Ready' } as const
    }

    // Midday Reversion and Noise Area sleeves exit early through each leg's native orders.
    const brokerManagedExits = isBrokerManagedAlphaTarget(target)
    let pendingWait: Effect.Success<ReturnType<typeof evaluateJevPositionManagement>> | undefined
    let liquidationReady: { readonly _tag: 'Ready'; readonly exitTarget?: JevExitTarget } | undefined

    for (const [symbol, plan] of planEntries) {
      const short = isShortExitPlan(plan)
      const exitSide = short ? OrderSide.Buy : OrderSide.Sell
      const quantityAtoms = quantityForSymbol(symbol)
      const open = state.orders.filter(
        (order) =>
          order.symbol === symbol &&
          order.side === exitSide &&
          !terminal(order.status) &&
          protective.some((record) => record.intent.intentId === order.intentId),
      )
      let management: Effect.Success<ReturnType<typeof evaluateJevPositionManagement>> = {
        _tag: 'Wait',
        details: { waitReason: 'JEV_POSITION_HELD' },
      }
      if (
        quantityAtoms !== 0n &&
        !request.closeDue &&
        (state.reconciliation.status !== 'EXACT' ||
          !reconciliation.report.metrics.accountingExact ||
          reconciliation.riskContext.unknownMutationCount !== 0 ||
          state.unknownOrderCount !== 0)
      )
        return wait('PROTECTION_AWAITING_RECONCILIATION')
      if (quantityAtoms !== 0n && !request.closeDue && !brokerManagedExits) {
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
          symbol,
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
            method: isBracketProtection(owner.intent.protection)
              ? 'BRACKET'
              : isOcoProtection(owner.intent.protection)
                ? 'OCO'
                : 'STOP_LIMIT',
            quantityAtoms: BigInt(stop.quantityAtoms ?? '0') - BigInt(stop.filledQuantityAtoms),
            stopPriceMicros: BigInt(stop.stopPriceMicros ?? '0'),
            stopLimitPriceMicros: BigInt(stop.limitPriceMicros ?? '0'),
            profitLimitPriceMicros: isStopProtection(owner.intent.protection)
              ? null
              : BigInt(
                  open.find((order) => order.intentId === stop.intentId && order.orderType === OrderType.Limit)
                    ?.limitPriceMicros ?? '0',
                ),
          }
      }
      const nativeStatus = decidePositionProtection({
        plan,
        entry: { _tag: 'Settled' },
        quantityAtoms,
        protection,
        exitDue: false,
        observedAt,
      })
      if (
        !request.closeDue &&
        management._tag === 'Exit' &&
        management.target.reason === JevExitReason.ProtectiveStop &&
        nativeStatus._tag === 'Wait' &&
        nativeStatus.reason === 'PROTECTED' &&
        !armedNativeProtectionRequiresStopCancellation(management.target, plan)
      ) {
        const targetPortfolio = management.target.evidence.portfolio
        const firstFill =
          targetPortfolio.purpose === JevPurpose.Manage
            ? targetPortfolio.entryFills
                .filter((fill) => fill.symbol === symbol)
                .reduce<(typeof targetPortfolio.entryFills)[number] | undefined>(
                  (earliest, fill) =>
                    earliest === undefined || compareIntradayInstants(fill.occurredAt, earliest.occurredAt) < 0
                      ? fill
                      : earliest,
                  undefined,
                )
            : undefined
        const maximumHoldDueAt =
          firstFill !== undefined && targetPortfolio.purpose === JevPurpose.Manage
            ? jevMaximumHoldDueAt(firstFill.occurredAt, plan.levels.maximumHoldingMinutes)
            : undefined
        yield* Effect.logInfo('Holding armed native protection while IEX opposite quote stays clear of stop').pipe(
          Effect.annotateLogs({
            cycleId: cycle.identity.cycleId,
            symbol: plan.levels.symbol,
            exitSide,
            protectionIntentId: protection._tag === 'Armed' ? protection.intentId : '',
          }),
        )
        management = {
          _tag: 'Wait',
          details: {
            waitReason: 'JEV_POSITION_HELD',
            ...(maximumHoldDueAt === undefined
              ? {}
              : { maximumHoldDueAt, maximumHoldEvaluatedAt: management.target.observedAt }),
          },
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
      // a fresh, exact account observation must show every protective order settled before close can proceed.
      if (
        action._tag === 'CancelProtection' ||
        (open.length > 0 && (action._tag === 'Complete' || protection._tag === 'Absent'))
      ) {
        const order = open[0]
        if (order?.intentId === undefined || capability._tag === 'RecoveryOnly')
          return wait('PROTECTION_CANCEL_PENDING')
        const advanced = yield* capability.executionProgram
          .cancelProtectionOrder(
            order.intentId,
            order.brokerOrderId,
            management._tag === 'Exit' ? management.target : undefined,
          )
          .pipe(
            Effect.catch((cause) => {
              if (!(cause instanceof BrokerMutationError)) return Effect.fail(cause)
              return Effect.logWarning('Protective cancellation requires broker reconciliation').pipe(
                Effect.annotateLogs({
                  brokerOrderId: order.brokerOrderId,
                  failure: cause.failure,
                  outcome: cause.outcome,
                }),
                Effect.andThen(Effect.succeed(wait('PROTECTION_CANCEL_PENDING'))),
              )
            }),
          )
        if (advanced._tag === 'Accepted' && advanced.phase === 'Fresh')
          return {
            _tag: 'PostMutationReconciliation',
            cycle,
            delayMs: 5_000,
            observedAt,
            protectionReleaseCycleId: cycle.identity.cycleId,
            logContext: {
              cycleId: cycle.identity.cycleId,
              intentId: order.intentId,
              mutationAction: 'CANCEL',
              mutationPhase: 'CLOSE',
            },
          } as const
        if (advanced._tag === 'Accepted') return wait('PROTECTION_PUBLICATION_PENDING')
        return wait('PROTECTION_CANCEL_PENDING')
      }
      if (action._tag === 'Block')
        return yield* mutationRunnerError({
          message: `Strategy protection blocked: ${action.reason}`,
          failure: 'contract',
        })
      if (action._tag === 'Arm') {
        if (capability._tag === 'RecoveryOnly' || observedAt >= request.closeExpiresAt)
          return wait('PROTECTION_AUTHORITY_UNAVAILABLE')
        // For midday, an exit on one leg cannot prevent another leg from restoring exact native coverage.
        // The close window still cancels coverage and liquidates any residual inventory.
        if (!brokerManagedExits) {
          const portfolio = yield* JevPositionStore.pipe(
            Effect.flatMap((store) =>
              store.read({
                cycleId: cycle.identity.cycleId,
                entryDecisionHash: document.contentHash,
                brokerState: state,
              }),
            ),
          )
          if (portfolio.exitRequestedAt !== null) return wait('PROTECTION_EXIT_COMMITTED')
        }
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
            ? {
                _tag: short ? ('EquityShortOco' as const) : ('Oco' as const),
                ...plan.levels,
                entryDecisionHash: document.contentHash,
              }
            : {
                _tag: short ? ('EquityShortStopLimit' as const) : ('StopLimit' as const),
                stopPriceMicros: plan.levels.stopPriceMicros,
                entryDecisionHash: document.contentHash,
              }
        const protectionTerms = isOcoProtection(conditional)
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
            side: exitSide,
            orderType: action.method === 'OCO' ? OrderType.Limit : OrderType.StopLimit,
            timeInForce: protectionTimeInForce(action.method, plan.levels.symbol),
            quantityAtoms: action.quantityAtoms.toString(),
            limitPriceMicros: limit.toString(),
            notionalLimitMicros: (
              (action.quantityAtoms * limit + (short ? quantityScale - 1n : 0n)) /
              quantityScale
            ).toString(),
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
      }
      if (action._tag === 'Liquidate') {
        liquidationReady = { _tag: 'Ready', ...(management._tag === 'Exit' ? { exitTarget: management.target } : {}) }
        continue
      }
      if (action._tag === 'Wait' && management._tag === 'Wait') {
        if (pendingWait === undefined) {
          pendingWait = management
        } else if (
          pendingWait._tag === 'Wait' &&
          management.details.maximumHoldDueAt !== undefined &&
          (pendingWait.details.maximumHoldDueAt === undefined ||
            management.details.maximumHoldDueAt < pendingWait.details.maximumHoldDueAt)
        ) {
          pendingWait = management
        }
      }
    }

    if (liquidationReady !== undefined) return liquidationReady
    if (pendingWait !== undefined && pendingWait._tag === 'Wait')
      return { _tag: 'Step', step: { _tag: 'Wait', observedAt, ...pendingWait.details } } as const

    const planSymbols = new Set(planEntries.map(([symbol]) => symbol))
    const allowedUniverse = new Set(protocol.universe)
    const isConcurrentAlphaTarget = target.schemaVersion === 'bayn.intraday-alpha-target.v2'
    if (
      state.positions.some(
        (position) =>
          BigInt(position.quantityAtoms) !== 0n &&
          (planSymbols.has(position.symbol) || !isConcurrentAlphaTarget || !allowedUniverse.has(position.symbol)),
      )
    )
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
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof CycleRunnerError
        ? cause
        : mutationRunnerError({ message: 'Strategy protection could not advance', cause, failure: 'operational' }),
    ),
  )

const protectionTimeInForce = (method: 'OCO' | 'STOP_LIMIT', symbol: string): TimeInForce =>
  method === 'STOP_LIMIT' && symbol.includes('/') ? TimeInForce.GoodUntilCanceled : TimeInForce.Day

import { Result, Schema } from 'effect'

import { AccountingTransactionSchema } from '../accounting/schema'
import { StoredCashSettlementSchema } from '../accounting/cash-settlement'
import { MutationOperation } from '../broker/alpaca-mutations/model'
import { maximumBrokerObservationAgeMs } from '../broker/alpaca/observed-snapshot'
import { orderRequestBody, prepareCancel } from '../broker/alpaca-mutations/decisions'
import {
  Authority,
  OrderSide,
  OrderStatus,
  RiskDecisionSchema,
  RiskOutcome,
  intentPlanSchemaVersion,
} from '../execution/contracts'
import {
  IntentPlanSchema,
  makeExecutionIntentFromDecodedPlan,
  validateCommitIdentity,
} from '../execution/intents/domain'
import { decideMutationAuthority, mutationIdResult } from '../execution/mutations/decisions'
import { MutationEventType } from '../execution/mutations/model'
import { canonicalHashV1Result } from '../hash'
import { normalizeSnapshot } from '../simulation-reconciliation/broker-normalization'
import { SafetyViolationKind } from './assessment'
import { cashSettlementMatches } from './cash-settlements'
import { SystemAssessmentError } from './economics'
import { captureExecutionFills, captureExecutionOrders } from './execution-evidence'
import { resolveExecutionOrderTerms, nativeOrderEvidenceAssumptions } from './execution-order-terms'
import type { ExecutionOrderPlan } from './execution-plans'
import type { OperationalRegistration } from './operational-period'
import type { OperationalSourceCut } from './operational-source-cut'
import type { RecordedSystemSourceCut as SystemSourceCut } from './recorded-source-cut'
import { OperationalSafetySourceSchema, SafetyAuthorityStateSchema } from './operational-safety-source'
import { BrokerIdentitySchema } from '../broker/identity'
import { UtcInstantSchema } from '../schemas'
import { compareIntradayInstants } from '../market-data/intraday/time'

export enum SafetyCheckStatus {
  Pass = 'PASS',
  Violation = 'VIOLATION',
  Incomplete = 'INCOMPLETE',
}
export interface OperationalSafetyCheck {
  readonly kind: SafetyViolationKind
  readonly code: string
  readonly status: SafetyCheckStatus
  readonly sourceHash: string
  readonly occurredAt: string
}

export const nativeSafetyCoverage = (checks: readonly Pick<OperationalSafetyCheck, 'kind' | 'status'>[]) =>
  Object.values(SafetyViolationKind).every((kind) => checks.some((check) => check.kind === kind)) &&
  checks.every((check) => check.status !== SafetyCheckStatus.Incomplete)
    ? ('COMPLETE' as const)
    : ('INCOMPLETE' as const)

const FinancialSourceSchema = Schema.Struct({
  accounts: Schema.Array(
    Schema.Struct({
      identity: BrokerIdentitySchema,
      forward: Schema.Struct({
        accountingReceiptsExact: Schema.Boolean,
        ledgerExact: Schema.Boolean,
        missingLedgerAccountCount: Schema.Int,
        unresolvedMutationCount: Schema.Int,
        accountTransactions: Schema.Array(AccountingTransactionSchema),
        accountCashSettlements: Schema.Array(StoredCashSettlementSchema),
        accountPositionCounts: Schema.Struct({ reconciledAt: UtcInstantSchema, exact: Schema.Boolean }),
      }),
    }),
  ),
})

/** Consume each decoded decision once; keep execution identities and checks, never the large decision bodies. */
export const makeOperationalSafetyScan = (
  cut: OperationalSourceCut | SystemSourceCut,
  registration: OperationalRegistration,
) =>
  Result.gen(function* () {
    const checks: OperationalSafetyCheck[] = []
    const add = (
      kind: SafetyViolationKind,
      code: string,
      status: SafetyCheckStatus,
      sourceHash = cut.sourceMaterialHash,
      occurredAt = cut.asOf,
    ) => checks.push({ kind, code, status, sourceHash, occurredAt })
    const assert = (
      kind: SafetyViolationKind,
      code: string,
      valid: boolean,
      missing = false,
      sourceHash?: string,
      occurredAt?: string,
    ) =>
      add(
        kind,
        code,
        valid ? SafetyCheckStatus.Pass : missing ? SafetyCheckStatus.Incomplete : SafetyCheckStatus.Violation,
        sourceHash,
        occurredAt,
      )
    const definition = registration.policies[0]
    const accountId = definition.riskPolicy.accountId
    const first = registration.calendar.sessions[0]
    const last = registration.calendar.sessions.at(-1)
    if (first === undefined || last === undefined)
      return yield* Result.fail(new SystemAssessmentError({ message: 'Safety scan requires the registered calendar' }))
    const material = Schema.decodeUnknownResult(
      Schema.Struct({ safety: Schema.optionalKey(OperationalSafetySourceSchema) }),
    )(cut.sourceMaterial)
    const source = Result.isSuccess(material) ? material.success.safety : undefined
    const covered = new Set<string>()
    const ownedFills = new Set<string>()
    const coveredMutations = new Set<string>()
    const ownerByFill = new Map<string, string>()
    const admitted = new Map(source?.admissions.map((row) => [row.eventId, row]) ?? [])
    const inPeriod = (time: string) => time >= first.openAt && time <= cut.asOf
    assert(SafetyViolationKind.Identity, 'COMPLETE_REGISTERED_PERIOD', cut.asOf >= last.closeAt, true)
    assert(SafetyViolationKind.Identity, 'NATIVE_SAFETY_SOURCE', source !== undefined, true)
    if (source !== undefined) {
      assert(SafetyViolationKind.Identity, 'SOURCE_SCOPE', source.accountId === accountId && source.asOf === cut.asOf)
      const baseline = source.baseline
      assert(
        SafetyViolationKind.Unauthorized,
        'PROSPECTIVE_AUTHORITY_BASELINE',
        baseline !== null && compareIntradayInstants(baseline.capturedAt, first.openAt) < 0,
        true,
      )
      const state =
        baseline === null
          ? Result.fail(null)
          : Schema.decodeUnknownResult(SafetyAuthorityStateSchema)(baseline.authority)
      const initial = Result.isSuccess(state) ? state.success : undefined
      let previous = initial
      for (const transition of source.authorityTransitions) {
        const before = Schema.decodeUnknownResult(SafetyAuthorityStateSchema)(transition.previous)
        const after = Schema.decodeUnknownResult(SafetyAuthorityStateSchema)(transition.authority)
        const complete =
          previous !== undefined &&
          Result.isSuccess(before) &&
          Result.isSuccess(after) &&
          (yield* canonicalHashV1Result(previous)) === (yield* canonicalHashV1Result(before.success)) &&
          after.success.version === previous.version + 1
        assert(SafetyViolationKind.Unauthorized, 'CONTIGUOUS_AUTHORITY_HISTORY', complete, true)
        previous = Result.isSuccess(after) ? after.success : undefined
      }
      const current = Schema.decodeUnknownResult(SafetyAuthorityStateSchema)(source.authority)
      assert(
        SafetyViolationKind.Unauthorized,
        'AUTHORITY_HISTORY_REACHES_CUT',
        previous !== undefined &&
          Result.isSuccess(current) &&
          (yield* canonicalHashV1Result(previous)) === (yield* canonicalHashV1Result(current.success)),
        true,
      )
      assert(
        SafetyViolationKind.Duplicate,
        'UNIQUE_NATIVE_IDENTITIES',
        new Set(source.orders.map((row) => row.order.brokerOrderId)).size === source.orders.length &&
          new Set(source.fills.map((row) => row.eventId)).size === source.fills.length &&
          admitted.size === source.admissions.length,
      )
      if (source.broker.status === 'UNAVAILABLE')
        add(SafetyViolationKind.Identity, 'BROKER_SOURCE_UNAVAILABLE', SafetyCheckStatus.Incomplete)
      else {
        const snapshot = source.broker.snapshot
        assert(
          SafetyViolationKind.Identity,
          'BROKER_CLOSED_PERIOD_COVERAGE',
          snapshot.startedAt >= last.closeAt &&
            snapshot.completedAt <= cut.asOf &&
            Date.parse(cut.asOf) - Date.parse(snapshot.observedAt) < maximumBrokerObservationAgeMs,
          true,
        )
        const native = normalizeSnapshot(snapshot.snapshot, source.bindings)
        if (Result.isFailure(native))
          add(SafetyViolationKind.Identity, 'BROKER_NORMALIZATION_FAILED', SafetyCheckStatus.Incomplete)
        else {
          const orders = new Map(source.orders.map((row) => [row.order.brokerOrderId, row]))
          const fills = new Map(source.fills.map((row) => [row.fill.fillId, row]))
          assert(
            SafetyViolationKind.Identity,
            'COMPLETE_BROKER_HISTORY',
            native.success.orderEvents.length === source.orders.length &&
              native.success.fillEvents.length === source.fills.length,
            true,
          )
          for (const row of native.success.orderEvents) {
            const stored = orders.get(row.order.brokerOrderId)
            const { observedAt: _observed, ...terms } = row.order
            const { observedAt: _storedAt, ...storedTerms } = stored?.order ?? { observedAt: null }
            assert(
              SafetyViolationKind.Identity,
              'BROKER_ORDER_MATCH',
              stored !== undefined &&
                stored.contentHash === row.contentHash &&
                (yield* canonicalHashV1Result(terms)) === (yield* canonicalHashV1Result(storedTerms)),
              stored === undefined,
            )
          }
          for (const row of native.success.fillEvents) {
            const stored = fills.get(row.fill.fillId)
            assert(
              SafetyViolationKind.Identity,
              'BROKER_FILL_MATCH',
              stored !== undefined &&
                stored.contentHash === row.contentHash &&
                stored.sourceTimestamp === row.sourceTimestamp &&
                (yield* canonicalHashV1Result(stored.fill)) === (yield* canonicalHashV1Result(row.fill)),
              stored === undefined,
            )
          }
        }
      }
      const financial = Schema.decodeUnknownResult(FinancialSourceSchema)(cut.sourceMaterial)
      const account = Result.isSuccess(financial)
        ? financial.success.accounts.find((row) => row.identity.accountId === accountId)
        : undefined
      assert(
        SafetyViolationKind.Duplicate,
        'UNIQUE_ACCOUNT_TRANSACTIONS',
        account !== undefined &&
          new Set(account.forward.accountTransactions.map((row) => row.transactionId)).size ===
            account.forward.accountTransactions.length &&
          new Set(account.forward.accountTransactions.map((row) => row.brokerEventId)).size ===
            account.forward.accountTransactions.length,
        true,
      )
      assert(
        SafetyViolationKind.Ledger,
        'EXACT_ACCOUNT_LEDGER_AND_SETTLEMENTS',
        account !== undefined &&
          account.forward.accountingReceiptsExact &&
          account.forward.ledgerExact &&
          account.forward.missingLedgerAccountCount === 0 &&
          account.forward.accountPositionCounts.exact &&
          account.forward.accountTransactions.every((trade) =>
            cashSettlementMatches(
              trade,
              account.forward.accountCashSettlements.find((row) => row.data.transactionId === trade.transactionId),
              accountId,
              account.forward.accountPositionCounts.reconciledAt,
            ),
          ),
        true,
      )
      assert(
        SafetyViolationKind.Ledger,
        'ACCOUNT_FILL_COVERAGE',
        account !== undefined &&
          account.forward.accountTransactions.length === source.fills.length &&
          source.fills.every(
            (fill) =>
              fill.transactionId !== null &&
              fill.receiptId !== null &&
              account.forward.accountTransactions.some(
                (trade) =>
                  trade.transactionId === fill.transactionId &&
                  trade.brokerEventId === fill.eventId &&
                  trade.accountId === fill.fill.accountId &&
                  trade.intentId === fill.fill.intentId &&
                  trade.symbol === fill.fill.symbol &&
                  trade.side === fill.fill.side &&
                  trade.quantityAtoms === fill.fill.quantityAtoms &&
                  trade.priceAtoms === fill.fill.priceAtoms &&
                  trade.feeMicros === fill.fill.feeMicros &&
                  trade.occurredAt === fill.fill.occurredAt,
              ),
          ),
        true,
      )
      assert(
        SafetyViolationKind.Ledger,
        'RESOLVED_ACCOUNT_MUTATIONS',
        account?.forward.unresolvedMutationCount === 0,
        true,
      )
    }

    const consume = (plans: ReadonlyMap<string, ExecutionOrderPlan>) =>
      Result.gen(function* () {
        if (source === undefined) return
        for (const [intentId, plan] of plans) {
          const index = plan.document.orderedIntentIds.indexOf(intentId)
          const target = plan.document.targetPlan.intentTargets[index]
          const delta = plan.document.deltaRisk[index]
          if (plan.protectionIntent === null && (target === undefined || delta === undefined))
            return yield* Result.fail(
              new SystemAssessmentError({ message: 'Native intent lacks its full target and risk material' }),
            )
          const original =
            plan.protectionIntent?.plan ??
            (target !== undefined && delta !== undefined
              ? {
                  schemaVersion: intentPlanSchemaVersion,
                  ...target,
                  notionalLimitMicros: delta.notionalLimitMicros,
                  limitPriceMicros: delta.limitPriceMicros,
                  ...(delta.protection === undefined ? {} : { protection: delta.protection }),
                  ...(plan.document.replanGenerationHash === undefined
                    ? {}
                    : { replanGenerationHash: plan.document.replanGenerationHash }),
                }
              : undefined)
          const approval = plan.protectionIntent?.riskDecision ?? delta?.evaluation.decision
          if (original === undefined || approval === undefined)
            return yield* Result.fail(new SystemAssessmentError({ message: 'Missing native approved intent' }))
          const intent = yield* makeExecutionIntentFromDecodedPlan(original, definition.authorityGenerationHash)
          yield* validateCommitIdentity(intent, approval)
          assert(SafetyViolationKind.Identity, 'NATIVE_INTENT_IDENTITY', intent.intentId === intentId)
          const rawOrders = source.orders.filter((row) => row.order.intentId === intentId)
          const rawFills = source.fills.filter((row) => row.fill.intentId === intentId)
          const persisted = source.intents.find((row) => row.intentId === intentId)
          if (
            rawOrders.length > 0 ||
            rawFills.length > 0 ||
            cut.mutations.some((row) => row.event.intentId === intentId)
          ) {
            assert(SafetyViolationKind.Unauthorized, 'COMMITTED_INTENT_AND_RISK', persisted !== undefined, true)
            if (persisted !== undefined) {
              const storedPlan = yield* Schema.decodeUnknownResult(IntentPlanSchema)(persisted.plan)
              const storedRisk = yield* Schema.decodeUnknownResult(RiskDecisionSchema)(persisted.risk)
              const storedIntent = yield* makeExecutionIntentFromDecodedPlan(
                storedPlan,
                persisted.authorityGenerationHash,
              )
              yield* validateCommitIdentity(storedIntent, storedRisk)
              assert(
                SafetyViolationKind.Identity,
                'IMMUTABLE_ECONOMIC_INTENT',
                (yield* canonicalHashV1Result(storedIntent)) === (yield* canonicalHashV1Result(intent)) &&
                  (yield* canonicalHashV1Result(storedRisk)) === (yield* canonicalHashV1Result(approval)),
              )
            }
          }
          const orders = yield* captureExecutionOrders(plans, rawOrders, accountId, definition.authorityGenerationHash)
          const fills = yield* captureExecutionFills(plans, rawFills, accountId, definition.authorityGenerationHash)
          const events = cut.mutations.filter((row) => row.event.intentId === intentId).map((row) => row.event)
          const roots = orders.filter((row) => row.order.parentBrokerOrderId === undefined)
          assert(SafetyViolationKind.Duplicate, 'ONE_ROOT_EFFECT_PER_INTENT', roots.length <= 1)
          assert(
            SafetyViolationKind.Unauthorized,
            'ORIGINAL_SUBMIT_COVERAGE',
            roots.every((root) => !inPeriod(root.occurredAt)) ||
              events.some((event) => event.eventType === MutationEventType.SubmitStarted),
            true,
          )
          for (const operation of [MutationOperation.Submit, MutationOperation.Cancel]) {
            const mutation = events
              .filter((row) => row.operation === operation)
              .toSorted((a, b) => a.sequence - b.sequence)
            const start = mutation[0]
            if (start === undefined) continue
            coveredMutations.add(start.mutationId)
            assert(
              SafetyViolationKind.Identity,
              'ORIGINAL_MUTATION_START',
              start.eventType ===
                (operation === MutationOperation.Submit
                  ? MutationEventType.SubmitStarted
                  : MutationEventType.CancelStarted),
            )
            const expected = yield* mutationIdResult(intentId, operation)
            let expectedRequest: string | null = null
            if (operation === MutationOperation.Submit) {
              const body = yield* orderRequestBody(intent)
              expectedRequest = yield* canonicalHashV1Result(body)
            } else {
              const cancel = prepareCancel(start.brokerOrderId)
              if (Result.isSuccess(cancel)) expectedRequest = cancel.success.requestHash
              assert(
                SafetyViolationKind.Ownership,
                'CANCEL_OWNED_BROKER_ORDER',
                rawOrders.some((row) => row.order.brokerOrderId === start.brokerOrderId),
              )
            }
            assert(
              SafetyViolationKind.Identity,
              'ORIGINAL_REQUEST_CONTENT',
              expectedRequest !== null && start.requestHash === expectedRequest,
            )
            for (const [index, event] of mutation.entries()) {
              const { eventId, ...content } = event
              const previous = mutation[index - 1]
              assert(
                SafetyViolationKind.Identity,
                'MUTATION_IDENTITY',
                eventId === (yield* canonicalHashV1Result(content)) &&
                  event.mutationId === expected &&
                  event.sequence === index + 1 &&
                  event.requestHash === start.requestHash &&
                  (previous === undefined || event.occurredAt >= previous.occurredAt),
              )
            }
            const receipt = admitted.get(start.eventId)
            const state =
              receipt === undefined
                ? Result.fail(null)
                : Schema.decodeUnknownResult(SafetyAuthorityStateSchema)(receipt.authority)
            assert(
              SafetyViolationKind.Unauthorized,
              'DURABLE_AUTHORITY_AT_ADMISSION',
              receipt !== undefined && Result.isSuccess(state),
              true,
            )
            if (Result.isSuccess(state)) {
              const allowed = decideMutationAuthority(
                operation,
                {
                  maximum: state.success.maximum,
                  effective: state.success.effective,
                  killState: state.success.kill_state,
                  generationHash: state.success.generation_hash,
                  generationMaximum: Authority.Execution,
                  generationAccountId: accountId,
                },
                plan.target.side === OrderSide.Sell,
              )
              assert(
                SafetyViolationKind.Unauthorized,
                'AUTHORIZED_MUTATION',
                Result.isSuccess(allowed) && state.success.generation_hash === definition.authorityGenerationHash,
                false,
                start.eventId,
                start.occurredAt,
              )
            }
            if (operation === MutationOperation.Submit) {
              assert(
                SafetyViolationKind.Risk,
                'ORIGINAL_APPROVED_RISK_AND_DEADLINE',
                approval.outcome === RiskOutcome.Approved &&
                  approval.decidedAt <= start.occurredAt &&
                  start.occurredAt < approval.expiresAt &&
                  start.occurredAt < plan.submissionDeadlineAt,
                false,
                start.eventId,
                start.occurredAt,
              )
              const route = mutation.find((row) => row.routing !== undefined)?.routing
              assert(
                SafetyViolationKind.Unauthorized,
                'MEASURED_ROUTING',
                roots.length === 0 || (route?.requestDispatchedAt !== null && route?.requestDispatchedAt !== undefined),
                true,
              )
              if (route?.requestDispatchedAt !== null && route?.requestDispatchedAt !== undefined)
                assert(
                  SafetyViolationKind.Risk,
                  'TRANSMISSION_BEFORE_EXPIRY',
                  start.occurredAt <= route.startedAt &&
                    route.startedAt <= route.requestDispatchedAt &&
                    route.requestDispatchedAt < plan.submissionDeadlineAt,
                  false,
                  start.eventId,
                  route.requestDispatchedAt,
                )
            }
          }
          for (const order of orders) {
            covered.add(order.order.brokerOrderId)
            const root =
              order.order.parentBrokerOrderId === undefined
                ? order
                : orders.find((row) => row.order.brokerOrderId === order.order.parentBrokerOrderId)
            if (root === undefined) {
              add(SafetyViolationKind.Ownership, 'MISSING_ORDER_PARENT', SafetyCheckStatus.Incomplete)
              continue
            }
            const children = orders.filter((row) => row.order.parentBrokerOrderId === root.order.brokerOrderId)
            assert(
              SafetyViolationKind.Identity,
              'ROOT_CLIENT_ORDER_ID',
              root.order.clientOrderId === intent.clientOrderId,
            )
            const terms = yield* resolveExecutionOrderTerms(order.order.brokerOrderId, root, children, plan)
            if (terms._tag !== 'Bound') {
              add(SafetyViolationKind.Ownership, 'INCOMPLETE_NATIVE_ORDER_GROUP', SafetyCheckStatus.Incomplete)
              continue
            }
            const actual = fills.filter((fill) => fill.brokerOrderId === order.order.brokerOrderId)
            const quantity = actual.reduce((sum, fill) => sum + BigInt(fill.quantityAtoms), 0n)
            assert(SafetyViolationKind.Risk, 'FILLS_WITHIN_SEALED_QUANTITY', quantity <= BigInt(terms.quantityAtoms))
            if ([OrderStatus.Filled, OrderStatus.Canceled, OrderStatus.Expired].includes(order.order.status))
              assert(
                SafetyViolationKind.Ownership,
                'COMPLETE_TERMINAL_FILLS',
                quantity === BigInt(order.order.filledQuantityAtoms),
                true,
              )
            for (const fill of actual) {
              ownedFills.add(fill.fillId)
              const price = BigInt(fill.priceAtoms),
                limit = BigInt(terms.limitPriceMicros) * 1000n
              assert(
                SafetyViolationKind.Risk,
                'NATIVE_LIMIT_AND_SIDE',
                fill.side === terms.order.side && (fill.side === OrderSide.Buy ? price <= limit : price >= limit),
                false,
                fill.sourceHash,
                fill.occurredAt,
              )
              ownerByFill.set(fill.fillId, plan.positionOwnerDecisionId)
            }
          }
        }
      })
    const finish = () =>
      Result.gen(function* () {
        if (source !== undefined) {
          for (const admission of source.admissions) {
            if (compareIntradayInstants(admission.capturedAt, first.openAt) < 0) continue
            assert(
              SafetyViolationKind.Unauthorized,
              'REGISTERED_MUTATION_GENERATION',
              admission.authorityGenerationHash === definition.authorityGenerationHash,
              false,
              admission.eventId,
              admission.capturedAt,
            )
            assert(
              SafetyViolationKind.Unauthorized,
              'COMPLETE_NATIVE_ADMISSIONS',
              cut.mutations.some(
                (row) => row.event.eventId === admission.eventId && row.event.intentId === admission.intentId,
              ),
              true,
            )
          }
          const balances = new Map<string, bigint>()
          for (const row of source.fills.toSorted(
            (a, b) =>
              a.fill.occurredAt.localeCompare(b.fill.occurredAt) ||
              (BigInt(a.sourceSequence) < BigInt(b.sourceSequence)
                ? -1
                : BigInt(a.sourceSequence) > BigInt(b.sourceSequence)
                  ? 1
                  : a.eventId.localeCompare(b.eventId)),
          )) {
            const owner = ownerByFill.get(row.eventId)
            if (owner === undefined) continue
            const balance =
              (balances.get(owner) ?? 0n) +
              (row.fill.side === OrderSide.Buy ? 1n : -1n) * BigInt(row.fill.quantityAtoms)
            assert(
              SafetyViolationKind.Ownership,
              'CHRONOLOGICAL_OWNED_INVENTORY',
              balance >= 0n,
              false,
              row.eventId,
              row.fill.occurredAt,
            )
            balances.set(owner, balance)
          }
          if (source.broker.status === 'AVAILABLE')
            for (const row of source.broker.snapshot.snapshot.history.orders.rows) {
              if (!inPeriod(row.value.createdAt)) continue
              const native = source.orders.find((order) => order.order.brokerOrderId === row.value.brokerOrderId)
              assert(
                SafetyViolationKind.Ownership,
                'REGISTERED_PERIOD_BROKER_ORDER_OWNER',
                native?.order.intentId !== undefined,
                false,
                native?.eventId,
                row.value.createdAt,
              )
              assert(
                SafetyViolationKind.Ownership,
                'REGISTERED_PERIOD_BROKER_ORDER_PLAN',
                covered.has(row.value.brokerOrderId),
                true,
              )
            }
          const exposed = new Set([
            ...cut.mutations.map((row) => row.event.intentId),
            ...source.fills.filter((row) => inPeriod(row.fill.occurredAt)).map((row) => row.fill.intentId),
          ])
          assert(
            SafetyViolationKind.Ownership,
            'COMPLETE_ECONOMIC_ORDER_OWNERSHIP',
            source.orders
              .filter((row) => row.order.intentId !== undefined && exposed.has(row.order.intentId))
              .every((row) => covered.has(row.order.brokerOrderId)),
            true,
          )
          assert(
            SafetyViolationKind.Ownership,
            'COMPLETE_PERIOD_FILL_OWNERSHIP',
            source.fills.filter((row) => inPeriod(row.fill.occurredAt)).every((row) => ownedFills.has(row.eventId)),
            true,
          )
          assert(
            SafetyViolationKind.Unauthorized,
            'COMPLETE_MUTATION_OWNERSHIP',
            cut.mutations.every((row) => coveredMutations.has(row.event.mutationId)),
            true,
          )
          assert(
            SafetyViolationKind.Risk,
            'COMPLETE_RISK_SOURCE_COVERAGE',
            cut.mutations.every((row) => coveredMutations.has(row.event.mutationId)) &&
              source.fills.filter((row) => inPeriod(row.fill.occurredAt)).every((row) => ownedFills.has(row.eventId)),
            true,
          )
        }
        for (const kind of Object.values(SafetyViolationKind))
          if (!checks.some((check) => check.kind === kind))
            add(kind, 'MISSING_SAFETY_CLASS_COVERAGE', SafetyCheckStatus.Incomplete)
        const evidence = {
          schemaVersion: 'bayn.native-operational-safety-audit.v1' as const,
          registrationHash: cut.registrationHash,
          sourceCutHash: yield* canonicalHashV1Result(cut),
          asOf: cut.asOf,
          coverage: nativeSafetyCoverage(checks),
          checks,
          assumptions: [
            ...nativeOrderEvidenceAssumptions,
            'Provider receipts and the complete broker history represent the provider state faithfully.',
            'PostgreSQL executes the reviewed admission guards; metadata journals share the original transactions and roll back with them.',
          ],
        }
        return {
          ...evidence,
          evidenceHash: yield* canonicalHashV1Result(evidence),
          violations: checks
            .filter((check) => check.status === SafetyCheckStatus.Violation)
            .map((check) => ({ kind: check.kind, sourceHash: check.sourceHash, occurredAt: check.occurredAt })),
        }
      })
    return { consume, finish }
  })

export type NativeOperationalSafetyAudit = Result.Result.Success<
  ReturnType<Result.Result.Success<ReturnType<typeof makeOperationalSafetyScan>>['finish']>
>

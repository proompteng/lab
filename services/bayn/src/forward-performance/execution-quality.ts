import { protectiveExecutionOrders } from './protective-executions'
import { validIntradayPerformanceVolumeEvidence } from './intraday-volume'
import { DateTime, Option, Result } from 'effect'

import { canonicalHashV1Result, type CanonicalHashFailure } from '../hash'
import type {
  ForwardPerformanceEvidenceInput,
  ForwardPerformanceExecutionEvidence,
  ForwardPerformanceExecutionQualityReasonCode,
  ForwardPerformanceMarketVolumeEvidence,
  ForwardPerformanceObservedCapacityReasonCode,
  ForwardPerformanceReceiptMaterial,
  ForwardPerformanceTransactionEvidence,
} from './model'

const SIGNED_MICROS_MIN = -(1n << 127n)
const SIGNED_MICROS_MAX = (1n << 127n) - 1n
const RATIO_DECIMAL_PLACES = 12
const RATIO_SCALE = 10n ** BigInt(RATIO_DECIMAL_PLACES)
const SOURCE_TIMESTAMP_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{9}Z$/
const UTC_INSTANT_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/

type ExecutionQuality = ForwardPerformanceReceiptMaterial['executionQuality']
type ObservedCapacity = ForwardPerformanceReceiptMaterial['observedCapacity']

export enum ExecutionDiagnosticEvaluation {
  NotEvaluated = 'NOT_EVALUATED',
  NoExecutionEvidence = 'NO_EXECUTION_EVIDENCE',
  Evaluated = 'EVALUATED',
}

const newExecutionDiagnostics = (): {
  schemaVersion: 'bayn.forward-performance-execution-diagnostics.v2'
  evaluation: ExecutionDiagnosticEvaluation
  inputExecutionCount: number
  inputTransactionCount: number | null
  evaluatedFillCount: number | null
  nativeProtection: {
    inputGroupCount: number
    boundGroupCount: number
    childOrderCount: number
    evaluatedChildFillCount: number
  }
  reasonOccurrences: Record<ForwardPerformanceExecutionQualityReasonCode, number>
} => ({
  schemaVersion: 'bayn.forward-performance-execution-diagnostics.v2',
  evaluation: ExecutionDiagnosticEvaluation.NotEvaluated,
  inputExecutionCount: 0,
  inputTransactionCount: null,
  evaluatedFillCount: null,
  nativeProtection: { inputGroupCount: 0, boundGroupCount: 0, childOrderCount: 0, evaluatedChildFillCount: 0 },
  reasonOccurrences: {
    ACCOUNT_LEDGER_RECONCILIATION_GAP: 0,
    ACCOUNTING_FILL_BINDING_GAP: 0,
    DUPLICATE_EXECUTION_EVIDENCE: 0,
    EXPLICIT_COST_EVIDENCE_GAP: 0,
    FILL_EVIDENCE_GAP: 0,
    FILL_IDENTITY_DRIFT: 0,
    FILL_QUANTITY_MISMATCH: 0,
    FILL_TIMESTAMP_GAP: 0,
    INVALID_EXECUTION_MICROS: 0,
    PLANNED_DECISION_EVIDENCE_GAP: 0,
    PROTECTION_EVIDENCE_GAP: 0,
    REFERENCE_PRICE_EVIDENCE_GAP: 0,
    TERMINAL_ORDER_EVIDENCE_GAP: 0,
    TERMINAL_PRICE_EVIDENCE_GAP: 0,
    ZERO_COMPLETED_EXECUTIONS: 0,
  },
})

export type ForwardPerformanceExecutionDiagnostics = Readonly<ReturnType<typeof newExecutionDiagnostics>>

export interface ForwardPerformanceExecutionMeasurements {
  readonly executionQuality: ExecutionQuality
  readonly observedCapacity: ObservedCapacity
  readonly diagnostics: ForwardPerformanceExecutionDiagnostics
}

interface ExecutionContribution {
  readonly cycleId: string
  readonly symbol: string
  readonly coverageOpenedAt: string
  readonly terminalOrderOccurredAt: string
  readonly preBrokerBlocked: boolean
  readonly filledQuantity: bigint
  readonly filledReferenceNotional: bigint
  readonly executedNotional: bigint
}

const parseUnsigned = (value: string | undefined, positive: boolean): bigint | undefined => {
  if (value === undefined || !/^(?:0|[1-9][0-9]*)$/.test(value)) return undefined
  const parsed = BigInt(value)
  if (parsed > SIGNED_MICROS_MAX || (positive && parsed === 0n)) return undefined
  return parsed
}

const inSignedRange = (value: bigint): boolean => value >= SIGNED_MICROS_MIN && value <= SIGNED_MICROS_MAX

const checkedAdd = (left: bigint, right: bigint): bigint | undefined => {
  const value = left + right
  return inSignedRange(value) ? value : undefined
}

const roundHalfUp = (quantity: bigint, price: bigint, denominator = 1_000_000_000n): bigint | undefined => {
  const value = (quantity * price + denominator / 2n) / denominator
  return inSignedRange(value) ? value : undefined
}

const validInstant = (value: string): boolean => {
  if (!UTC_INSTANT_PATTERN.test(value)) return false
  const instant = DateTime.make(value)
  return Option.isSome(instant) && DateTime.formatIso(instant.value) === value
}

const validIsoDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const instant = DateTime.make(`${value}T00:00:00.000Z`)
  return Option.isSome(instant) && DateTime.formatIsoDate(instant.value) === value
}

const compareStrings = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

const formatRatio = (numerator: bigint, denominator: bigint): string => {
  const negative = numerator < 0n
  const magnitude = negative ? -numerator : numerator
  const scaledNumerator = magnitude * RATIO_SCALE
  const quotient = scaledNumerator / denominator
  const remainder = scaledNumerator % denominator
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient
  const integer = rounded / RATIO_SCALE
  const fraction = (rounded % RATIO_SCALE).toString().padStart(RATIO_DECIMAL_PLACES, '0')
  return `${negative ? '-' : ''}${integer}.${fraction}`
}

const executionSortKey = (evidence: ForwardPerformanceExecutionEvidence): string =>
  JSON.stringify([evidence.decisionCreatedAt, evidence.cycleId, evidence.intentId])

const transactionSortKey = (transaction: ForwardPerformanceTransactionEvidence): string =>
  JSON.stringify([transaction.occurredAt, transaction.brokerEventId ?? '', transaction.transactionId])

const fillSortKey = (fill: ForwardPerformanceExecutionEvidence['fills'][number]): string =>
  JSON.stringify([fill.sourceTimestamp, fill.fillId, fill.brokerEventId])

const volumeSortKey = (volume: NonNullable<ForwardPerformanceEvidenceInput['marketVolumeEvidence']>[number]): string =>
  JSON.stringify([volume.cycleId, volume.symbol, volume.windowOpenedAt, volume.windowClosedAt, volume.contentHash])

const groupMarketVolumes = (volumes: readonly ForwardPerformanceMarketVolumeEvidence[]) => {
  const groups = new Map<string, ForwardPerformanceMarketVolumeEvidence[]>()
  for (const volume of volumes) {
    const key = JSON.stringify([volume.cycleId, volume.symbol])
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [volume])
    else group.push(volume)
  }
  return groups
}

const sourceEvidenceHash = (
  input: ForwardPerformanceEvidenceInput,
  executionEvidence: readonly ForwardPerformanceExecutionEvidence[],
  transactions: readonly ForwardPerformanceTransactionEvidence[],
): Result.Result<string, CanonicalHashFailure> =>
  canonicalHashV1Result({
    schemaVersion: 'bayn.forward-performance-execution-evidence.v1',
    account: input.account,
    reconciliation: input.reconciliation ?? null,
    accountingReceiptsExact: input.accountingReceiptsExact,
    ledgerExact: input.ledgerExact,
    missingLedgerAccountCount: input.missingLedgerAccountCount,
    ledgerTotals: input.ledgerTotals ?? null,
    ...((input.brokerFees?.length ?? 0) === 0
      ? {}
      : { brokerFees: [...(input.brokerFees ?? [])].sort((a, b) => compareStrings(a.activityId, b.activityId)) }),
    ...((input.brokerFeeAccruals?.length ?? 0) === 0
      ? {}
      : {
          brokerFeeAccruals: [...(input.brokerFeeAccruals ?? [])].sort((a, b) =>
            compareStrings(a.accrualId, b.accrualId),
          ),
        }),
    executions: executionEvidence,
    transactions,
  })

const emptyExecutionQuality = (
  status: ExecutionQuality['status'],
  reasonCodes: readonly ForwardPerformanceExecutionQualityReasonCode[],
): ExecutionQuality => ({
  status,
  reasonCodes,
  evidenceHash: null,
  implementationShortfall: null,
})

const emptyObservedCapacity = (
  status: ObservedCapacity['status'],
  reasonCodes: readonly ForwardPerformanceObservedCapacityReasonCode[],
): ObservedCapacity => ({
  status,
  reasonCodes,
  evidenceHash: null,
  observations: [],
  boundedObservedReferenceNotionalMicros: null,
  boundedObservedExecutedNotionalMicros: null,
  maximumParticipationRate: null,
})

const identityMatches = (
  input: ForwardPerformanceEvidenceInput,
  evidence: ForwardPerformanceExecutionEvidence,
  completedCycleIds: ReadonlySet<string>,
): boolean => {
  const intent = evidence.intent
  if (intent === undefined) return false
  return (
    SHA256_PATTERN.test(evidence.cycleId) &&
    SHA256_PATTERN.test(evidence.decisionDocumentHash) &&
    SHA256_PATTERN.test(evidence.decisionHash) &&
    SHA256_PATTERN.test(evidence.intentId) &&
    completedCycleIds.has(evidence.cycleId) &&
    evidence.accountId === input.account.accountId &&
    intent.intentId === evidence.intentId &&
    intent.accountId === evidence.accountId &&
    intent.cycleId === evidence.cycleId &&
    intent.decisionHash === evidence.decisionHash &&
    intent.symbol === evidence.symbol &&
    intent.side === evidence.side &&
    intent.quantityAtoms === evidence.plannedQuantityAtoms &&
    intent.createdAt === evidence.decisionCreatedAt
  )
}

const orderMatches = (evidence: ForwardPerformanceExecutionEvidence): boolean => {
  const intent = evidence.intent
  const order = evidence.terminalOrder
  if (intent === undefined || order === undefined) return false
  const representationMatches =
    order.quantityAtoms === evidence.plannedQuantityAtoms && order.notionalMicros === undefined
  return (
    SHA256_PATTERN.test(order.eventId) &&
    order.intentId === evidence.intentId &&
    order.accountId === evidence.accountId &&
    order.clientOrderId === intent.clientOrderId &&
    order.symbol === evidence.symbol &&
    order.side === evidence.side &&
    representationMatches &&
    ((order.status === 'FILLED' && intent.terminalOutcome === 'FILLED') ||
      (order.status === 'CANCELED' && intent.terminalOutcome === 'CANCELED') ||
      (order.status === 'EXPIRED' && intent.terminalOutcome === 'EXPIRED') ||
      (order.status === 'REJECTED' && intent.terminalOutcome === 'REJECTED'))
  )
}

const blockedIntentMatches = (evidence: ForwardPerformanceExecutionEvidence): boolean =>
  evidence.intent?.terminalOutcome === 'BLOCKED' &&
  evidence.terminalOrder === undefined &&
  evidence.fills.length === 0 &&
  validInstant(evidence.intent.updatedAt) &&
  evidence.intent.updatedAt >= evidence.decisionCreatedAt

const transactionMatchesFill = (
  transaction: ForwardPerformanceTransactionEvidence,
  evidence: ForwardPerformanceExecutionEvidence,
  fill: ForwardPerformanceExecutionEvidence['fills'][number],
): boolean =>
  transaction.brokerEventId === fill.brokerEventId &&
  transaction.intentId === evidence.intentId &&
  transaction.cycleId === evidence.cycleId &&
  transaction.symbol === evidence.symbol &&
  transaction.side === fill.side &&
  transaction.quantityAtoms === fill.quantityAtoms &&
  transaction.priceAtoms === fill.priceAtoms &&
  transaction.feeMicros === fill.feeMicros &&
  transaction.occurredAt === fill.occurredAt

const validMarketVolumeEvidence = (
  volume: NonNullable<ForwardPerformanceEvidenceInput['marketVolumeEvidence']>[number],
): Result.Result<boolean, CanonicalHashFailure> => {
  if (volume.schemaVersion === 'bayn.forward-performance-intraday-volume-evidence.v2') {
    return Result.succeed(validIntradayPerformanceVolumeEvidence(volume))
  }
  const marketVolume = parseUnsigned(volume.quantityAtoms, true)
  const closePrice = parseUnsigned(volume.closePriceMicros, true)
  const { contentHash, ...material } = volume
  return Result.map(canonicalHashV1Result(material), (expectedHash) =>
    Boolean(
      marketVolume !== undefined &&
      closePrice !== undefined &&
      volume.schemaVersion === 'bayn.forward-performance-market-volume-evidence.v1' &&
      SHA256_PATTERN.test(contentHash) &&
      contentHash === expectedHash &&
      SHA256_PATTERN.test(volume.decisionSnapshotId) &&
      SHA256_PATTERN.test(volume.snapshotId) &&
      volume.snapshotId !== volume.decisionSnapshotId &&
      SHA256_PATTERN.test(volume.manifestContentHash) &&
      SHA256_PATTERN.test(volume.barsContentHash) &&
      SHA256_PATTERN.test(volume.universeSymbolHash) &&
      volume.universeId === 'cross-asset-taa-v1' &&
      volume.calendarVersion.length > 0 &&
      volume.calendarVersion === volume.calendarVersion.trim() &&
      validIsoDate(volume.executionSessionDate) &&
      validIsoDate(volume.decisionSnapshotAsOfSession) &&
      volume.decisionSnapshotAsOfSession < volume.executionSessionDate &&
      validIsoDate(volume.requestedStart) &&
      validIsoDate(volume.evaluationStart) &&
      volume.requestedStart <= volume.evaluationStart &&
      volume.evaluationStart <= volume.executionSessionDate &&
      volume.source === 'alpaca' &&
      volume.sourceFeed === 'sip' &&
      volume.adjustment === 'all' &&
      validInstant(volume.windowOpenedAt) &&
      validInstant(volume.windowClosedAt) &&
      validInstant(volume.evidenceCutoffAt) &&
      validInstant(volume.finalizedAt) &&
      volume.windowOpenedAt.startsWith(`${volume.executionSessionDate}T`) &&
      volume.windowClosedAt.startsWith(`${volume.executionSessionDate}T`) &&
      volume.finalizedAt >= volume.windowClosedAt &&
      volume.finalizedAt <= volume.evidenceCutoffAt &&
      volume.windowClosedAt > volume.windowOpenedAt,
    ),
  )
}

const validTerminalReferencePrice = (
  matchingVolumes: readonly ForwardPerformanceMarketVolumeEvidence[] | undefined,
  evidence: ForwardPerformanceExecutionEvidence,
  terminalOccurredAt: string,
  terminalObservedAt: string,
  preBrokerBlocked: boolean,
): Result.Result<bigint | undefined, CanonicalHashFailure> => {
  const terminal = evidence.terminalReferencePrice
  if (terminal === undefined) return Result.succeed(undefined)
  const volume = matchingVolumes?.length === 1 ? matchingVolumes[0] : undefined
  if (volume === undefined) return Result.succeed(undefined)
  return Result.flatMap(validMarketVolumeEvidence(volume), (validVolume) => {
    const terminalPrice = parseUnsigned(terminal.priceMicros, true)
    const { contentHash, ...material } = terminal
    return Result.map(canonicalHashV1Result(material), (expectedHash) =>
      validVolume &&
      terminalPrice !== undefined &&
      terminal.schemaVersion === 'bayn.forward-performance-terminal-reference-price.v1' &&
      terminal.cycleId === evidence.cycleId &&
      terminal.symbol === evidence.symbol &&
      terminal.executionSessionDate === volume.executionSessionDate &&
      terminal.priceMicros === volume.closePriceMicros &&
      terminal.observedAt === volume.finalizedAt &&
      terminal.sourceEvidenceHash === volume.contentHash &&
      SHA256_PATTERN.test(contentHash) &&
      contentHash === expectedHash &&
      terminalObservedAt <= volume.evidenceCutoffAt &&
      terminalOccurredAt <= volume.windowClosedAt &&
      (preBrokerBlocked || terminalOccurredAt >= volume.windowOpenedAt)
        ? terminalPrice
        : undefined,
    )
  })
}

const measureExecutionQuality = (
  input: ForwardPerformanceEvidenceInput,
  diagnostics: ReturnType<typeof newExecutionDiagnostics>,
): Result.Result<
  {
    readonly executionQuality: ExecutionQuality
    readonly contributions: readonly ExecutionContribution[]
  },
  CanonicalHashFailure
> => {
  const executions = [...(input.executionEvidence ?? [])].sort((left, right) =>
    compareStrings(executionSortKey(left), executionSortKey(right)),
  )
  diagnostics.inputExecutionCount = executions.length
  if ((input.unverifiedDecisionHashes?.length ?? 0) > 0) {
    diagnostics.reasonOccurrences.PLANNED_DECISION_EVIDENCE_GAP = 1
    const unverifiedDecisionHashes = [...new Set(input.unverifiedDecisionHashes)].sort()
    return Result.map(canonicalHashV1Result({ unverifiedDecisionHashes }), (evidenceHash) => ({
      executionQuality: {
        ...emptyExecutionQuality('UNDETERMINED', ['PLANNED_DECISION_EVIDENCE_GAP']),
        evidenceHash,
        unverifiedDecisionHashes,
      },
      contributions: [],
    }))
  }
  if (executions.length === 0) {
    const transactionCount = input.transactions.length
    diagnostics.evaluation = ExecutionDiagnosticEvaluation.NoExecutionEvidence
    diagnostics.inputTransactionCount = transactionCount
    diagnostics.evaluatedFillCount = 0
    diagnostics.reasonOccurrences[
      transactionCount === 0 ? 'ZERO_COMPLETED_EXECUTIONS' : 'PLANNED_DECISION_EVIDENCE_GAP'
    ] = 1
    return Result.succeed({
      executionQuality:
        transactionCount === 0
          ? emptyExecutionQuality('NOT_ELIGIBLE', ['ZERO_COMPLETED_EXECUTIONS'])
          : emptyExecutionQuality('UNDETERMINED', ['PLANNED_DECISION_EVIDENCE_GAP']),
      contributions: [],
    })
  }

  const transactions = [...input.transactions].sort((left, right) =>
    compareStrings(transactionSortKey(left), transactionSortKey(right)),
  )
  const orderedExecutions = executions.map((evidence) => ({
    ...evidence,
    ...(evidence.nativeProtection === undefined
      ? {}
      : {
          nativeProtection: {
            ...evidence.nativeProtection,
            orders: [...evidence.nativeProtection.orders].sort(
              (a, b) =>
                compareStrings(a.order.brokerOrderId, b.order.brokerOrderId) || compareStrings(a.eventId, b.eventId),
            ),
          },
        }),
    fills: [...evidence.fills].sort((left, right) => compareStrings(fillSortKey(left), fillSortKey(right))),
  }))
  const evidenceHash = sourceEvidenceHash(input, orderedExecutions, transactions)
  if (Result.isFailure(evidenceHash)) return Result.fail(evidenceHash.failure)
  diagnostics.evaluation = ExecutionDiagnosticEvaluation.Evaluated
  diagnostics.inputTransactionCount = transactions.length
  diagnostics.evaluatedFillCount = 0

  const volumeGroups = groupMarketVolumes(input.marketVolumeEvidence ?? [])
  const completedCycleIds = new Set<string>()
  for (const cycle of input.cycles) {
    if (cycle.state === 'COMPLETED') completedCycleIds.add(cycle.cycleId)
  }
  const reasons = new Set<ForwardPerformanceExecutionQualityReasonCode>()
  // Count the existing predicate failures, not unique rows or independent root causes.
  const recordReason = (reason: ForwardPerformanceExecutionQualityReasonCode) => {
    diagnostics.reasonOccurrences[reason] += 1
    reasons.add(reason)
  }
  const seenIntents = new Set<string>()
  const seenFillEvents = new Set<string>()
  const transactionByBrokerEvent = new Map<string, ForwardPerformanceTransactionEvidence>()
  for (const transaction of transactions) {
    const brokerEventId = transaction.brokerEventId
    if (brokerEventId === undefined || transactionByBrokerEvent.has(brokerEventId)) {
      recordReason('ACCOUNTING_FILL_BINDING_GAP')
      continue
    }
    transactionByBrokerEvent.set(brokerEventId, transaction)
  }

  if (
    input.reconciliation?.performanceExact !== true ||
    !input.accountingReceiptsExact ||
    !input.ledgerExact ||
    input.missingLedgerAccountCount > 0
  ) {
    recordReason('ACCOUNT_LEDGER_RECONCILIATION_GAP')
  }

  const brokerFees = parseUnsigned(input.ledgerTotals?.brokerExecutionFeesMicros, false)
  const otherCosts = parseUnsigned(input.ledgerTotals?.otherChargedCostsMicros ?? undefined, false)
  if (brokerFees === undefined || otherCosts === undefined) recordReason('EXPLICIT_COST_EVIDENCE_GAP')

  let plannedQuantity = 0n
  let filledQuantity = 0n
  let plannedReferenceNotional = 0n
  let executedNotional = 0n
  let executionPriceShortfall = 0n
  let opportunityShortfall = 0n
  let observedFillFees = 0n
  let firstDecisionAt: string | undefined
  let firstFillAt: string | undefined
  let lastFillAt: string | undefined
  let lastTerminalOrderObservedAt: string | undefined
  let fillCount = 0
  const contributions: ExecutionContribution[] = []

  for (const evidence of orderedExecutions) {
    if (seenIntents.has(evidence.intentId)) recordReason('DUPLICATE_EXECUTION_EVIDENCE')
    seenIntents.add(evidence.intentId)

    if (!identityMatches(input, evidence, completedCycleIds)) recordReason('FILL_IDENTITY_DRIFT')
    const protective = protectiveExecutionOrders(evidence, input.reconciliation?.reconciledAt)
    if (Result.isFailure(protective)) recordReason('PROTECTION_EVIDENCE_GAP')
    const children = Result.isSuccess(protective) ? protective.success : []
    const native = evidence.nativeProtection
    if (native !== undefined) {
      diagnostics.nativeProtection.inputGroupCount++
      if (Result.isSuccess(protective)) {
        diagnostics.nativeProtection.boundGroupCount++
        diagnostics.nativeProtection.childOrderCount += children.length
      }
    }
    const groups = [
      { order: evidence.terminalOrder, side: evidence.side, reference: evidence.referencePriceMicros, child: false },
      ...children.map((receipt) => ({
        order: { ...receipt.order, eventId: receipt.eventId, occurredAt: receipt.occurredAt },
        side: receipt.order.side,
        reference:
          native?.protection._tag === 'Bracket' || native?.protection._tag === 'Oco'
            ? receipt.order.orderType === 'STOP_LIMIT'
              ? native.protection.stopPriceMicros
              : native.protection.profitLimitPriceMicros
            : undefined,
        child: true,
      })),
    ]
    const groupOrderIds = new Set(groups.map((group) => group.order?.brokerOrderId))
    if (native !== undefined && evidence.fills.some((fill) => !groupOrderIds.has(fill.brokerOrderId)))
      recordReason('FILL_IDENTITY_DRIFT')
    for (const group of groups) {
      const { order, side, child } = group
      const fills =
        native === undefined
          ? evidence.fills
          : evidence.fills.filter((fill) => fill.brokerOrderId === order?.brokerOrderId)
      // Dormant/canceled conditional exits are not missed unconditional sell decisions. Their full
      // quantity and terminal status are still checked below; only executed conditional volume enters shortfall.
      const planned = parseUnsigned(child ? order?.filledQuantityAtoms : evidence.plannedQuantityAtoms, !child)
      const referencePrice = parseUnsigned(group.reference, true)
      if (planned === undefined) recordReason('PLANNED_DECISION_EVIDENCE_GAP')
      if (referencePrice === undefined) recordReason('REFERENCE_PRICE_EVIDENCE_GAP')
      const blocked = !child && blockedIntentMatches(evidence)
      if (!child && !blocked && (order === undefined || !orderMatches(evidence)))
        recordReason('TERMINAL_ORDER_EVIDENCE_GAP')
      const terminalOccurredAt = blocked ? evidence.intent?.updatedAt : order?.occurredAt
      const terminalObservedAt = blocked ? evidence.intent?.updatedAt : order?.observedAt
      if (
        !validInstant(evidence.decisionCreatedAt) ||
        terminalOccurredAt === undefined ||
        terminalObservedAt === undefined ||
        !validInstant(terminalOccurredAt) ||
        !validInstant(terminalObservedAt) ||
        terminalObservedAt < terminalOccurredAt ||
        terminalObservedAt < evidence.decisionCreatedAt
      ) {
        recordReason('FILL_TIMESTAMP_GAP')
      }

      const reportedFilledQuantity = parseUnsigned(order?.filledQuantityAtoms, false)
      if (reportedFilledQuantity !== undefined && reportedFilledQuantity > 0n && fills.length === 0) {
        recordReason('FILL_EVIDENCE_GAP')
      }

      let executionFilledQuantity = 0n
      let executionFilledReferenceNotional = 0n
      let executionActualNotional = 0n
      let executionFirstFillAt: string | undefined
      let executionLastFillAt: string | undefined

      for (const fill of fills) {
        if (child) diagnostics.nativeProtection.evaluatedChildFillCount++
        fillCount += 1
        diagnostics.evaluatedFillCount = fillCount
        if (seenFillEvents.has(fill.brokerEventId)) recordReason('DUPLICATE_EXECUTION_EVIDENCE')
        seenFillEvents.add(fill.brokerEventId)

        const quantity = parseUnsigned(fill.quantityAtoms, true)
        const price = parseUnsigned(fill.priceAtoms, true)
        const fee = parseUnsigned(fill.feeMicros, false)
        if (quantity === undefined || price === undefined || fee === undefined) {
          recordReason('INVALID_EXECUTION_MICROS')
          continue
        }
        if (
          !SHA256_PATTERN.test(fill.brokerEventId) ||
          !SHA256_PATTERN.test(fill.intentId) ||
          fill.intentId !== evidence.intentId ||
          fill.accountId !== evidence.accountId ||
          fill.symbol !== evidence.symbol ||
          fill.side !== side ||
          fill.clientOrderId !== (child ? order?.clientOrderId : evidence.intent?.clientOrderId) ||
          fill.brokerOrderId !== order?.brokerOrderId
        ) {
          recordReason('FILL_IDENTITY_DRIFT')
        }
        if (
          !SOURCE_TIMESTAMP_PATTERN.test(fill.sourceTimestamp) ||
          !validInstant(fill.occurredAt) ||
          !validInstant(fill.observedAt) ||
          fill.observedAt < fill.occurredAt ||
          fill.occurredAt < evidence.decisionCreatedAt ||
          (order !== undefined && fill.occurredAt > order.occurredAt)
        ) {
          recordReason('FILL_TIMESTAMP_GAP')
        }

        const transaction = transactionByBrokerEvent.get(fill.brokerEventId)
        const transactionNotional = parseUnsigned(transaction?.notionalMicros, true)
        const expectedNotional = roundHalfUp(quantity, price, 1_000_000_000_000n)
        if (
          transaction === undefined ||
          transactionNotional === undefined ||
          expectedNotional === undefined ||
          transactionNotional !== expectedNotional ||
          !transactionMatchesFill(transaction, evidence, fill)
        ) {
          recordReason('ACCOUNTING_FILL_BINDING_GAP')
          continue
        }
        const referenceNotional = referencePrice === undefined ? undefined : roundHalfUp(quantity, referencePrice)
        if (referenceNotional === undefined) {
          recordReason('INVALID_EXECUTION_MICROS')
          continue
        }

        // Perold shortfall is positive when execution is worse than the immutable decision price.
        const priceShortfall =
          side === 'BUY' ? transactionNotional - referenceNotional : referenceNotional - transactionNotional
        const nextExecutionFilled = checkedAdd(executionFilledQuantity, quantity)
        const nextFilled = checkedAdd(filledQuantity, quantity)
        const nextReference = checkedAdd(executionFilledReferenceNotional, referenceNotional)
        const nextActual = checkedAdd(executionActualNotional, transactionNotional)
        const nextObservedFees = checkedAdd(observedFillFees, fee)
        const nextPriceShortfall = checkedAdd(executionPriceShortfall, priceShortfall)
        if (
          nextExecutionFilled === undefined ||
          nextFilled === undefined ||
          nextReference === undefined ||
          nextActual === undefined ||
          nextObservedFees === undefined ||
          nextPriceShortfall === undefined
        ) {
          recordReason('INVALID_EXECUTION_MICROS')
          continue
        }
        executionFilledQuantity = nextExecutionFilled
        filledQuantity = nextFilled
        executionFilledReferenceNotional = nextReference
        executionActualNotional = nextActual
        observedFillFees = nextObservedFees
        executionPriceShortfall = nextPriceShortfall
        executionFirstFillAt =
          executionFirstFillAt === undefined || fill.occurredAt < executionFirstFillAt
            ? fill.occurredAt
            : executionFirstFillAt
        executionLastFillAt =
          executionLastFillAt === undefined || fill.occurredAt > executionLastFillAt
            ? fill.occurredAt
            : executionLastFillAt
      }

      if (planned !== undefined && referencePrice !== undefined) {
        const planNotional = roundHalfUp(planned, referencePrice)
        const nextPlannedQuantity = checkedAdd(plannedQuantity, planned)
        const nextPlanNotional =
          planNotional === undefined ? undefined : checkedAdd(plannedReferenceNotional, planNotional)
        if (planNotional === undefined || nextPlannedQuantity === undefined || nextPlanNotional === undefined) {
          recordReason('INVALID_EXECUTION_MICROS')
        } else {
          plannedQuantity = nextPlannedQuantity
          plannedReferenceNotional = nextPlanNotional
        }

        const orderFilled = blocked ? 0n : parseUnsigned(order?.filledQuantityAtoms, false)
        const orderQuantity = blocked
          ? planned
          : order?.quantityAtoms === undefined
            ? undefined
            : parseUnsigned(order.quantityAtoms, true)
        const orderNotional =
          order?.notionalMicros === undefined ? undefined : parseUnsigned(order.notionalMicros, true)
        const representationMatches =
          blocked ||
          (orderQuantity !== undefined &&
            (child ? orderQuantity >= planned : orderQuantity === planned) &&
            orderNotional === undefined)
        if (
          orderFilled === undefined ||
          !representationMatches ||
          orderFilled !== executionFilledQuantity ||
          (orderQuantity !== undefined && executionFilledQuantity > planned) ||
          (orderQuantity !== undefined && order?.status === 'FILLED' && executionFilledQuantity !== orderQuantity)
        ) {
          recordReason('FILL_QUANTITY_MISMATCH')
        }

        const unfilled = planned >= executionFilledQuantity ? planned - executionFilledQuantity : 0n
        if (unfilled > 0n) {
          const terminalPriceResult =
            terminalOccurredAt === undefined || terminalObservedAt === undefined
              ? Result.succeed<bigint | undefined>(undefined)
              : validTerminalReferencePrice(
                  volumeGroups.get(JSON.stringify([evidence.cycleId, evidence.symbol])),
                  evidence,
                  terminalOccurredAt,
                  terminalObservedAt,
                  blocked,
                )
          if (Result.isFailure(terminalPriceResult)) return Result.fail(terminalPriceResult.failure)
          const terminalPrice = terminalPriceResult.success
          if (terminalPrice === undefined) {
            recordReason('TERMINAL_PRICE_EVIDENCE_GAP')
          } else {
            const terminalNotional = roundHalfUp(unfilled, terminalPrice)
            const unfilledReference = roundHalfUp(unfilled, referencePrice)
            if (terminalNotional === undefined || unfilledReference === undefined) {
              recordReason('INVALID_EXECUTION_MICROS')
            } else {
              const opportunity =
                side === 'BUY' ? terminalNotional - unfilledReference : unfilledReference - terminalNotional
              const nextOpportunity = checkedAdd(opportunityShortfall, opportunity)
              if (nextOpportunity === undefined) recordReason('INVALID_EXECUTION_MICROS')
              else opportunityShortfall = nextOpportunity
            }
          }
        }
      }

      const nextExecutedNotional = checkedAdd(executedNotional, executionActualNotional)
      if (nextExecutedNotional === undefined) recordReason('INVALID_EXECUTION_MICROS')
      else executedNotional = nextExecutedNotional

      if (
        terminalOccurredAt !== undefined &&
        terminalObservedAt !== undefined &&
        planned !== undefined &&
        referencePrice !== undefined
      ) {
        contributions.push({
          cycleId: evidence.cycleId,
          symbol: evidence.symbol,
          coverageOpenedAt: executionFirstFillAt ?? terminalOccurredAt,
          terminalOrderOccurredAt: terminalOccurredAt,
          preBrokerBlocked: blocked,
          filledQuantity: executionFilledQuantity,
          filledReferenceNotional: executionFilledReferenceNotional,
          executedNotional: executionActualNotional,
        })
        firstDecisionAt =
          firstDecisionAt === undefined || evidence.decisionCreatedAt < firstDecisionAt
            ? evidence.decisionCreatedAt
            : firstDecisionAt
        if (executionFirstFillAt !== undefined) {
          firstFillAt =
            firstFillAt === undefined || executionFirstFillAt < firstFillAt ? executionFirstFillAt : firstFillAt
        }
        if (executionLastFillAt !== undefined) {
          lastFillAt = lastFillAt === undefined || executionLastFillAt > lastFillAt ? executionLastFillAt : lastFillAt
        }
        lastTerminalOrderObservedAt =
          lastTerminalOrderObservedAt === undefined || terminalObservedAt > lastTerminalOrderObservedAt
            ? terminalObservedAt
            : lastTerminalOrderObservedAt
      }
    }
  }

  const seenFees = new Set<string>()
  for (const fee of input.brokerFees ?? []) {
    if (
      !/^(?:0|-?[1-9][0-9]*)$/.test(fee.netAmountMicros) ||
      fee.accountId !== input.account.accountId ||
      seenFees.has(fee.activityId) ||
      !validIsoDate(fee.date)
    ) {
      recordReason('EXPLICIT_COST_EVIDENCE_GAP')
      continue
    }
    seenFees.add(fee.activityId)
    const net = BigInt(fee.netAmountMicros)
    const inventoryCost =
      fee.inventoryCostMicros === undefined
        ? fee.coinDebit === undefined
          ? 0n
          : undefined
        : parseUnsigned(fee.inventoryCostMicros, false)
    const next =
      inSignedRange(net) && inventoryCost !== undefined ? checkedAdd(observedFillFees, -net + inventoryCost) : undefined
    if (next === undefined) recordReason('INVALID_EXECUTION_MICROS')
    else observedFillFees = next
  }

  const seenAccruals = new Set<string>()
  for (const accrual of input.brokerFeeAccruals ?? []) {
    const expense = parseUnsigned(accrual.expenseMicros, false)
    const next = expense === undefined ? undefined : checkedAdd(observedFillFees, expense)
    if (
      next === undefined ||
      accrual.accountId !== input.account.accountId ||
      seenAccruals.has(accrual.accrualId) ||
      !accrual.settled
    )
      recordReason('EXPLICIT_COST_EVIDENCE_GAP')
    if (next !== undefined) observedFillFees = next
    seenAccruals.add(accrual.accrualId)
  }
  if (seenFillEvents.size !== transactions.length) recordReason('ACCOUNTING_FILL_BINDING_GAP')
  if (brokerFees === undefined || observedFillFees !== brokerFees) recordReason('EXPLICIT_COST_EVIDENCE_GAP')

  const reasonCodes = [...reasons].sort()
  if (
    reasonCodes.length > 0 ||
    brokerFees === undefined ||
    otherCosts === undefined ||
    firstDecisionAt === undefined ||
    lastTerminalOrderObservedAt === undefined ||
    plannedReferenceNotional <= 0n
  ) {
    return Result.succeed({
      executionQuality: {
        status: 'UNDETERMINED',
        reasonCodes,
        evidenceHash: evidenceHash.success,
        implementationShortfall: null,
      },
      contributions: [],
    })
  }

  const explicitCosts = checkedAdd(brokerFees, otherCosts)
  const priceAndOpportunity = checkedAdd(executionPriceShortfall, opportunityShortfall)
  const total =
    explicitCosts === undefined || priceAndOpportunity === undefined
      ? undefined
      : checkedAdd(priceAndOpportunity, explicitCosts)
  if (explicitCosts === undefined || total === undefined) {
    recordReason('INVALID_EXECUTION_MICROS')
    return Result.succeed({
      executionQuality: {
        status: 'UNDETERMINED',
        reasonCodes: ['INVALID_EXECUTION_MICROS'],
        evidenceHash: evidenceHash.success,
        implementationShortfall: null,
      },
      contributions: [],
    })
  }

  return Result.succeed({
    executionQuality: {
      status: 'MEASURED',
      reasonCodes: [],
      evidenceHash: evidenceHash.success,
      implementationShortfall: {
        plannedOrderCount: executions.length,
        fillCount,
        plannedQuantityAtoms: plannedQuantity.toString(),
        filledQuantityAtoms: filledQuantity.toString(),
        unfilledQuantityAtoms: (plannedQuantity >= filledQuantity ? plannedQuantity - filledQuantity : 0n).toString(),
        plannedReferenceNotionalMicros: plannedReferenceNotional.toString(),
        executedNotionalMicros: executedNotional.toString(),
        executionPriceShortfallMicros: executionPriceShortfall.toString(),
        opportunityShortfallMicros: opportunityShortfall.toString(),
        explicitCostsMicros: explicitCosts.toString(),
        totalImplementationShortfallMicros: total.toString(),
        implementationShortfallRate: {
          numeratorMicros: total.toString(),
          denominatorMicros: plannedReferenceNotional.toString(),
          decimal: formatRatio(total, plannedReferenceNotional),
        },
        firstDecisionAt,
        firstFillAt: firstFillAt ?? null,
        lastFillAt: lastFillAt ?? null,
        lastTerminalOrderObservedAt,
      },
    },
    contributions,
  })
}

const measureObservedCapacity = (
  input: ForwardPerformanceEvidenceInput,
  executionQuality: ExecutionQuality,
  contributions: readonly ExecutionContribution[],
): Result.Result<ObservedCapacity, CanonicalHashFailure> => {
  if (executionQuality.status === 'NOT_ELIGIBLE') {
    return Result.succeed(emptyObservedCapacity('NOT_ELIGIBLE', ['ZERO_COMPLETED_EXECUTIONS']))
  }

  const volumes = [...(input.marketVolumeEvidence ?? [])].sort((left, right) =>
    compareStrings(volumeSortKey(left), volumeSortKey(right)),
  )
  const reasons = new Set<ForwardPerformanceObservedCapacityReasonCode>()
  if (executionQuality.status !== 'MEASURED') reasons.add('EXECUTION_QUALITY_UNDETERMINED')
  if (volumes.length === 0) reasons.add('MARKET_VOLUME_EVIDENCE_GAP')
  if (reasons.size > 0) return Result.succeed(emptyObservedCapacity('UNDETERMINED', [...reasons].sort()))

  const executionHash = executionQuality.evidenceHash
  if (executionHash === null) {
    return Result.succeed(emptyObservedCapacity('UNDETERMINED', ['EXECUTION_QUALITY_UNDETERMINED']))
  }
  const evidenceHash = canonicalHashV1Result({
    schemaVersion: 'bayn.forward-performance-observed-capacity-evidence.v1',
    executionEvidenceHash: executionHash,
    marketVolumeEvidence: volumes,
  })
  if (Result.isFailure(evidenceHash)) return Result.fail(evidenceHash.failure)

  const contributionGroups = new Map<string, ExecutionContribution[]>()
  for (const contribution of contributions) {
    const key = JSON.stringify([contribution.cycleId, contribution.symbol])
    const group = contributionGroups.get(key)
    if (group === undefined) contributionGroups.set(key, [contribution])
    else group.push(contribution)
  }
  const volumeGroups = groupMarketVolumes(volumes)

  let boundedReferenceNotional = 0n
  let boundedExecutedNotional = 0n
  let maximumNumerator = 0n
  let maximumDenominator = 0n
  const observations: ObservedCapacity['observations'][number][] = []

  for (const [key, group] of [...contributionGroups.entries()].sort(([left], [right]) => compareStrings(left, right))) {
    const matchingVolumes = volumeGroups.get(key) ?? []
    const volume = matchingVolumes[0]
    if (matchingVolumes.length !== 1 || volume === undefined) {
      reasons.add(matchingVolumes.length === 0 ? 'MARKET_VOLUME_EVIDENCE_GAP' : 'INVALID_MARKET_VOLUME_EVIDENCE')
      continue
    }
    const marketVolume = parseUnsigned(volume.quantityAtoms, true)
    const validVolume = validMarketVolumeEvidence(volume)
    if (Result.isFailure(validVolume)) return Result.fail(validVolume.failure)
    if (marketVolume === undefined || !validVolume.success) {
      reasons.add('INVALID_MARKET_VOLUME_EVIDENCE')
      continue
    }

    if (
      volume.schemaVersion === 'bayn.forward-performance-intraday-volume-evidence.v2' &&
      volume.missingMinutes.length > 0
    ) {
      reasons.add('MARKET_VOLUME_EVIDENCE_GAP')
    }

    let filled = 0n
    let referenceNotional = 0n
    let actualNotional = 0n
    let coverageOpenedAt: string | undefined
    let lastTerminalAt: string | undefined
    for (const contribution of group) {
      filled += contribution.filledQuantity
      referenceNotional += contribution.filledReferenceNotional
      actualNotional += contribution.executedNotional
      const contributionCoverageOpenedAt =
        contribution.preBrokerBlocked && contribution.coverageOpenedAt < volume.windowOpenedAt
          ? volume.windowOpenedAt
          : contribution.coverageOpenedAt
      if (coverageOpenedAt === undefined || contributionCoverageOpenedAt < coverageOpenedAt) {
        coverageOpenedAt = contributionCoverageOpenedAt
      }
      const contributionTerminalAt =
        contribution.preBrokerBlocked && contribution.terminalOrderOccurredAt < volume.windowOpenedAt
          ? volume.windowOpenedAt
          : contribution.terminalOrderOccurredAt
      if (lastTerminalAt === undefined || contributionTerminalAt > lastTerminalAt) {
        lastTerminalAt = contributionTerminalAt
      }
    }
    if (
      coverageOpenedAt === undefined ||
      lastTerminalAt === undefined ||
      volume.windowOpenedAt > coverageOpenedAt ||
      volume.windowClosedAt < lastTerminalAt ||
      filled > marketVolume
    ) {
      reasons.add('MARKET_VOLUME_IDENTITY_DRIFT')
      continue
    }

    boundedReferenceNotional += referenceNotional
    boundedExecutedNotional += actualNotional
    if (observations.length === 0 || filled * maximumDenominator > maximumNumerator * marketVolume) {
      maximumNumerator = filled
      maximumDenominator = marketVolume
    }
    const [cycleId, symbol] = JSON.parse(key) as [string, string]
    observations.push({
      cycleId,
      symbol,
      windowOpenedAt: volume.windowOpenedAt,
      windowClosedAt: volume.windowClosedAt,
      filledQuantityAtoms: filled.toString(),
      marketVolumeQuantityAtoms: marketVolume.toString(),
      ...(volume.schemaVersion === 'bayn.forward-performance-intraday-volume-evidence.v2'
        ? {
            intradaySource: {
              feed: volume.sourceFeed,
              volumeScope: volume.volumeScope,
              evidenceHash: volume.contentHash,
            },
          }
        : {}),
      participationRate: {
        numeratorQuantityAtoms: filled.toString(),
        denominatorQuantityAtoms: marketVolume.toString(),
        decimal: formatRatio(filled, marketVolume),
      },
    })
  }

  for (const key of volumeGroups.keys()) {
    if (!contributionGroups.has(key)) reasons.add('MARKET_VOLUME_IDENTITY_DRIFT')
  }
  const reasonCodes = [...reasons].sort()
  if (reasonCodes.length > 0 || observations.length !== contributionGroups.size) {
    return Result.succeed({
      ...emptyObservedCapacity('UNDETERMINED', reasonCodes),
      evidenceHash: evidenceHash.success,
      observations: observations.filter((observation) => observation.intradaySource !== undefined),
    })
  }

  return Result.succeed({
    status: 'MEASURED',
    reasonCodes: [],
    evidenceHash: evidenceHash.success,
    observations,
    boundedObservedReferenceNotionalMicros: boundedReferenceNotional.toString(),
    boundedObservedExecutedNotionalMicros: boundedExecutedNotional.toString(),
    maximumParticipationRate: {
      numeratorQuantityAtoms: maximumNumerator.toString(),
      denominatorQuantityAtoms: maximumDenominator.toString(),
      decimal: formatRatio(maximumNumerator, maximumDenominator),
    },
  })
}

export const makeForwardPerformanceExecutionMeasurements = (
  input: ForwardPerformanceEvidenceInput,
): Result.Result<ForwardPerformanceExecutionMeasurements, CanonicalHashFailure> => {
  const diagnostics = newExecutionDiagnostics()
  return Result.flatMap(measureExecutionQuality(input, diagnostics), ({ executionQuality, contributions }) =>
    Result.map(measureObservedCapacity(input, executionQuality, contributions), (observedCapacity) => {
      const intradaySources = (input.marketVolumeEvidence ?? [])
        .filter((volume) => volume.schemaVersion === 'bayn.forward-performance-intraday-volume-evidence.v2')
        .filter(validIntradayPerformanceVolumeEvidence)
        .toSorted((left, right) => compareStrings(volumeSortKey(left), volumeSortKey(right)))
      return {
        diagnostics,
        executionQuality,
        observedCapacity: {
          ...observedCapacity,
          ...(intradaySources.length === 0 ? {} : { intradaySources }),
        },
      }
    }),
  )
}

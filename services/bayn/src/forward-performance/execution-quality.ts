import { DateTime, Option, Result } from 'effect'

import { alpacaBuyNotionalMicros } from '../broker/alpaca-mutations'
import { canonicalHashV1Result, type CanonicalHashFailure } from '../hash'
import type {
  ForwardPerformanceEvidenceInput,
  ForwardPerformanceExecutionEvidence,
  ForwardPerformanceExecutionQualityReasonCode,
  ForwardPerformanceObservedCapacityReasonCode,
  ForwardPerformanceReceiptMaterial,
  ForwardPerformanceTransactionEvidence,
} from './model'

const MICROS = 1_000_000n
const SIGNED_MICROS_MIN = -(1n << 127n)
const SIGNED_MICROS_MAX = (1n << 127n) - 1n
const RATIO_DECIMAL_PLACES = 12
const RATIO_SCALE = 10n ** BigInt(RATIO_DECIMAL_PLACES)
const SOURCE_TIMESTAMP_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{9}Z$/
const UTC_INSTANT_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/

type ExecutionQuality = ForwardPerformanceReceiptMaterial['executionQuality']
type ObservedCapacity = ForwardPerformanceReceiptMaterial['observedCapacity']

export interface ForwardPerformanceExecutionMeasurements {
  readonly executionQuality: ExecutionQuality
  readonly observedCapacity: ObservedCapacity
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

const roundHalfUp = (quantity: bigint, price: bigint): bigint | undefined => {
  const value = (quantity * price + MICROS / 2n) / MICROS
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
    executions: executionEvidence.map((evidence) => ({
      ...evidence,
      fills: [...evidence.fills].sort((left, right) => compareStrings(fillSortKey(left), fillSortKey(right))),
    })),
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
): boolean => {
  const intent = evidence.intent
  if (intent === undefined) return false
  return (
    SHA256_PATTERN.test(evidence.cycleId) &&
    SHA256_PATTERN.test(evidence.decisionDocumentHash) &&
    SHA256_PATTERN.test(evidence.decisionHash) &&
    SHA256_PATTERN.test(evidence.intentId) &&
    input.cycles.some((cycle) => cycle.cycleId === evidence.cycleId && cycle.state === 'COMPLETED') &&
    evidence.accountId === input.account.accountId &&
    intent.intentId === evidence.intentId &&
    intent.accountId === evidence.accountId &&
    intent.cycleId === evidence.cycleId &&
    intent.decisionHash === evidence.decisionHash &&
    intent.symbol === evidence.symbol &&
    intent.side === evidence.side &&
    intent.quantityMicros === evidence.plannedQuantityMicros &&
    intent.createdAt === evidence.decisionCreatedAt
  )
}

const notionalOrderMatchesIntent = (
  intent: NonNullable<ForwardPerformanceExecutionEvidence['intent']>,
  orderNotionalMicros: string,
): boolean => {
  if (intent.notionalLimitMicros === undefined) return false
  const currentNotional = alpacaBuyNotionalMicros(intent.notionalLimitMicros)
  return (
    orderNotionalMicros === intent.notionalLimitMicros ||
    (Result.isSuccess(currentNotional) && orderNotionalMicros === currentNotional.success)
  )
}

const orderMatches = (evidence: ForwardPerformanceExecutionEvidence): boolean => {
  const intent = evidence.intent
  const order = evidence.terminalOrder
  if (intent === undefined || order === undefined) return false
  const representationMatches =
    order.quantityMicros !== undefined
      ? order.quantityMicros === evidence.plannedQuantityMicros && order.notionalMicros === undefined
      : order.notionalMicros !== undefined && notionalOrderMatchesIntent(intent, order.notionalMicros)
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
  transaction.side === evidence.side &&
  transaction.quantityMicros === fill.quantityMicros &&
  transaction.priceMicros === fill.priceMicros &&
  transaction.feeMicros === fill.feeMicros &&
  transaction.occurredAt === fill.occurredAt

const validMarketVolumeEvidence = (
  volume: NonNullable<ForwardPerformanceEvidenceInput['marketVolumeEvidence']>[number],
): Result.Result<boolean, CanonicalHashFailure> => {
  const marketVolume = parseUnsigned(volume.quantityMicros, true)
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
  input: ForwardPerformanceEvidenceInput,
  evidence: ForwardPerformanceExecutionEvidence,
  terminalOccurredAt: string,
  terminalObservedAt: string,
  preBrokerBlocked: boolean,
): Result.Result<bigint | undefined, CanonicalHashFailure> => {
  const terminal = evidence.terminalReferencePrice
  if (terminal === undefined) return Result.succeed(undefined)
  const matchingVolumes = (input.marketVolumeEvidence ?? []).filter(
    (volume) => volume.cycleId === evidence.cycleId && volume.symbol === evidence.symbol,
  )
  const volume = matchingVolumes.length === 1 ? matchingVolumes[0] : undefined
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
  if (executions.length === 0) {
    return Result.succeed({
      executionQuality:
        input.transactions.length === 0
          ? emptyExecutionQuality('NOT_ELIGIBLE', ['ZERO_COMPLETED_EXECUTIONS'])
          : emptyExecutionQuality('UNDETERMINED', ['PLANNED_DECISION_EVIDENCE_GAP']),
      contributions: [],
    })
  }

  const transactions = [...input.transactions].sort((left, right) =>
    compareStrings(transactionSortKey(left), transactionSortKey(right)),
  )
  const evidenceHash = sourceEvidenceHash(input, executions, transactions)
  if (Result.isFailure(evidenceHash)) return Result.fail(evidenceHash.failure)

  const reasons = new Set<ForwardPerformanceExecutionQualityReasonCode>()
  const seenIntents = new Set<string>()
  const seenFillEvents = new Set<string>()
  const transactionByBrokerEvent = new Map<string, ForwardPerformanceTransactionEvidence>()
  for (const transaction of transactions) {
    const brokerEventId = transaction.brokerEventId
    if (brokerEventId === undefined || transactionByBrokerEvent.has(brokerEventId)) {
      reasons.add('ACCOUNTING_FILL_BINDING_GAP')
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
    reasons.add('ACCOUNT_LEDGER_RECONCILIATION_GAP')
  }

  const brokerFees = parseUnsigned(input.ledgerTotals?.brokerExecutionFeesMicros, false)
  const otherCosts = parseUnsigned(input.ledgerTotals?.otherChargedCostsMicros, false)
  if (brokerFees === undefined || otherCosts === undefined) reasons.add('EXPLICIT_COST_EVIDENCE_GAP')

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

  for (const evidence of executions) {
    if (seenIntents.has(evidence.intentId)) reasons.add('DUPLICATE_EXECUTION_EVIDENCE')
    seenIntents.add(evidence.intentId)

    const planned = parseUnsigned(evidence.plannedQuantityMicros, true)
    const referencePrice = parseUnsigned(evidence.referencePriceMicros, true)
    if (planned === undefined) reasons.add('PLANNED_DECISION_EVIDENCE_GAP')
    if (referencePrice === undefined) reasons.add('REFERENCE_PRICE_EVIDENCE_GAP')
    if (!identityMatches(input, evidence)) reasons.add('FILL_IDENTITY_DRIFT')

    const order = evidence.terminalOrder
    const blocked = blockedIntentMatches(evidence)
    if (!blocked && (order === undefined || !orderMatches(evidence))) reasons.add('TERMINAL_ORDER_EVIDENCE_GAP')
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
      reasons.add('FILL_TIMESTAMP_GAP')
    }

    const fills = [...evidence.fills].sort((left, right) => compareStrings(fillSortKey(left), fillSortKey(right)))
    const reportedFilledQuantity = parseUnsigned(order?.filledQuantityMicros, false)
    if (reportedFilledQuantity !== undefined && reportedFilledQuantity > 0n && fills.length === 0) {
      reasons.add('FILL_EVIDENCE_GAP')
    }

    let executionFilledQuantity = 0n
    let executionFilledReferenceNotional = 0n
    let executionActualNotional = 0n
    let executionFirstFillAt: string | undefined
    let executionLastFillAt: string | undefined

    for (const fill of fills) {
      fillCount += 1
      if (seenFillEvents.has(fill.brokerEventId)) reasons.add('DUPLICATE_EXECUTION_EVIDENCE')
      seenFillEvents.add(fill.brokerEventId)

      const quantity = parseUnsigned(fill.quantityMicros, true)
      const price = parseUnsigned(fill.priceMicros, true)
      const fee = parseUnsigned(fill.feeMicros, false)
      if (quantity === undefined || price === undefined || fee === undefined) {
        reasons.add('INVALID_EXECUTION_MICROS')
        continue
      }
      if (
        !SHA256_PATTERN.test(fill.brokerEventId) ||
        !SHA256_PATTERN.test(fill.intentId) ||
        fill.intentId !== evidence.intentId ||
        fill.accountId !== evidence.accountId ||
        fill.symbol !== evidence.symbol ||
        fill.side !== evidence.side ||
        fill.clientOrderId !== evidence.intent?.clientOrderId ||
        fill.brokerOrderId !== order?.brokerOrderId
      ) {
        reasons.add('FILL_IDENTITY_DRIFT')
      }
      if (
        !SOURCE_TIMESTAMP_PATTERN.test(fill.sourceTimestamp) ||
        !validInstant(fill.occurredAt) ||
        !validInstant(fill.observedAt) ||
        fill.observedAt < fill.occurredAt ||
        fill.occurredAt < evidence.decisionCreatedAt ||
        (order !== undefined && fill.occurredAt > order.occurredAt)
      ) {
        reasons.add('FILL_TIMESTAMP_GAP')
      }

      const transaction = transactionByBrokerEvent.get(fill.brokerEventId)
      const transactionNotional = parseUnsigned(transaction?.notionalMicros, true)
      const expectedNotional = roundHalfUp(quantity, price)
      if (
        transaction === undefined ||
        transactionNotional === undefined ||
        expectedNotional === undefined ||
        transactionNotional !== expectedNotional ||
        !transactionMatchesFill(transaction, evidence, fill)
      ) {
        reasons.add('ACCOUNTING_FILL_BINDING_GAP')
        continue
      }
      const referenceNotional = referencePrice === undefined ? undefined : roundHalfUp(quantity, referencePrice)
      if (referenceNotional === undefined) {
        reasons.add('INVALID_EXECUTION_MICROS')
        continue
      }

      // Perold shortfall is positive when execution is worse than the immutable decision price.
      const priceShortfall =
        evidence.side === 'BUY' ? transactionNotional - referenceNotional : referenceNotional - transactionNotional
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
        reasons.add('INVALID_EXECUTION_MICROS')
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
        reasons.add('INVALID_EXECUTION_MICROS')
      } else {
        plannedQuantity = nextPlannedQuantity
        plannedReferenceNotional = nextPlanNotional
      }

      const orderFilled = blocked ? 0n : parseUnsigned(order?.filledQuantityMicros, false)
      const orderQuantity = blocked
        ? planned
        : order?.quantityMicros === undefined
          ? undefined
          : parseUnsigned(order.quantityMicros, true)
      const orderNotional = order?.notionalMicros === undefined ? undefined : parseUnsigned(order.notionalMicros, true)
      const representationMatches = blocked
        ? true
        : orderQuantity !== undefined
          ? orderQuantity === planned && orderNotional === undefined
          : orderNotional !== undefined &&
            evidence.intent !== undefined &&
            notionalOrderMatchesIntent(evidence.intent, orderNotional.toString())
      if (
        orderFilled === undefined ||
        !representationMatches ||
        orderFilled !== executionFilledQuantity ||
        (orderQuantity !== undefined && executionFilledQuantity > planned) ||
        (orderQuantity !== undefined && order?.status === 'FILLED' && executionFilledQuantity !== planned)
      ) {
        reasons.add('FILL_QUANTITY_MISMATCH')
      }

      const unfilled = planned >= executionFilledQuantity ? planned - executionFilledQuantity : 0n
      if (unfilled > 0n) {
        const terminalPriceResult =
          terminalOccurredAt === undefined || terminalObservedAt === undefined
            ? Result.succeed<bigint | undefined>(undefined)
            : validTerminalReferencePrice(input, evidence, terminalOccurredAt, terminalObservedAt, blocked)
        if (Result.isFailure(terminalPriceResult)) return Result.fail(terminalPriceResult.failure)
        const terminalPrice = terminalPriceResult.success
        if (terminalPrice === undefined) {
          reasons.add('TERMINAL_PRICE_EVIDENCE_GAP')
        } else {
          const terminalNotional = roundHalfUp(unfilled, terminalPrice)
          const unfilledReference = roundHalfUp(unfilled, referencePrice)
          if (terminalNotional === undefined || unfilledReference === undefined) {
            reasons.add('INVALID_EXECUTION_MICROS')
          } else {
            const opportunity =
              evidence.side === 'BUY' ? terminalNotional - unfilledReference : unfilledReference - terminalNotional
            const nextOpportunity = checkedAdd(opportunityShortfall, opportunity)
            if (nextOpportunity === undefined) reasons.add('INVALID_EXECUTION_MICROS')
            else opportunityShortfall = nextOpportunity
          }
        }
      }
    }

    const nextExecutedNotional = checkedAdd(executedNotional, executionActualNotional)
    if (nextExecutedNotional === undefined) reasons.add('INVALID_EXECUTION_MICROS')
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

  if (seenFillEvents.size !== transactions.length) reasons.add('ACCOUNTING_FILL_BINDING_GAP')
  if (brokerFees === undefined || observedFillFees !== brokerFees) reasons.add('EXPLICIT_COST_EVIDENCE_GAP')

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
        plannedQuantityMicros: plannedQuantity.toString(),
        filledQuantityMicros: filledQuantity.toString(),
        unfilledQuantityMicros: (plannedQuantity >= filledQuantity ? plannedQuantity - filledQuantity : 0n).toString(),
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
  const volumeGroups = new Map<string, typeof volumes>()
  for (const volume of volumes) {
    const key = JSON.stringify([volume.cycleId, volume.symbol])
    const group = volumeGroups.get(key)
    if (group === undefined) volumeGroups.set(key, [volume])
    else volumeGroups.set(key, [...group, volume])
  }

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
    const marketVolume = parseUnsigned(volume.quantityMicros, true)
    const validVolume = validMarketVolumeEvidence(volume)
    if (Result.isFailure(validVolume)) return Result.fail(validVolume.failure)
    if (marketVolume === undefined || !validVolume.success) {
      reasons.add('INVALID_MARKET_VOLUME_EVIDENCE')
      continue
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
      filledQuantityMicros: filled.toString(),
      marketVolumeQuantityMicros: marketVolume.toString(),
      participationRate: {
        numeratorQuantityMicros: filled.toString(),
        denominatorQuantityMicros: marketVolume.toString(),
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
      numeratorQuantityMicros: maximumNumerator.toString(),
      denominatorQuantityMicros: maximumDenominator.toString(),
      decimal: formatRatio(maximumNumerator, maximumDenominator),
    },
  })
}

export const makeForwardPerformanceExecutionMeasurements = (
  input: ForwardPerformanceEvidenceInput,
): Result.Result<ForwardPerformanceExecutionMeasurements, CanonicalHashFailure> =>
  Result.flatMap(measureExecutionQuality(input), ({ executionQuality, contributions }) =>
    Result.map(measureObservedCapacity(input, executionQuality, contributions), (observedCapacity) => ({
      executionQuality,
      observedCapacity,
    })),
  )

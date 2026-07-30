import { Result } from 'effect'

import { canonicalHashV1Result } from '../hash'
import {
  FORWARD_PERFORMANCE_SCHEMA_VERSION,
  type ForwardPerformanceCycleEvidence,
  type ForwardPerformanceEvidenceInput,
  type ForwardPerformanceReasonCode,
  type ForwardPerformanceReceipt,
  type ForwardPerformanceReceiptMaterial,
} from './model'

const SIGNED_MICROS_MIN = -(1n << 127n)
const SIGNED_MICROS_MAX = (1n << 127n) - 1n
const RETURN_DECIMAL_PLACES = 12
const RETURN_SCALE = 10n ** BigInt(RETURN_DECIMAL_PLACES)

export interface ForwardPerformanceDomainFailure {
  readonly _tag: 'ForwardPerformanceDomainFailure'
  readonly operation: 'hash-receipt'
  readonly cause: unknown
}

interface ParsedTotals {
  readonly startingCapital: bigint
  readonly realizedGains: bigint
  readonly realizedLosses: bigint
  readonly brokerExecutionFees: bigint
  readonly otherChargedCosts: bigint
  readonly cashYield: bigint
  readonly grossRealizedPnl: bigint
  readonly netRealizedPnlAfterCosts: bigint
}

const inSignedMicrosRange = (value: bigint): boolean => value >= SIGNED_MICROS_MIN && value <= SIGNED_MICROS_MAX

const parseSignedMicros = (value: string): bigint | undefined => {
  if (!/^(?:0|-?[1-9][0-9]*)$/.test(value)) return undefined
  const parsed = BigInt(value)
  return inSignedMicrosRange(parsed) ? parsed : undefined
}

const checkedAdd = (left: bigint, right: bigint): bigint | undefined => {
  const value = left + right
  return inSignedMicrosRange(value) ? value : undefined
}

const compareCycles = (left: ForwardPerformanceCycleEvidence, right: ForwardPerformanceCycleEvidence): number => {
  if (left.submissionOpenAt !== right.submissionOpenAt) return left.submissionOpenAt < right.submissionOpenAt ? -1 : 1
  return left.cycleId < right.cycleId ? -1 : left.cycleId > right.cycleId ? 1 : 0
}

const formatReturn = (numerator: bigint, denominator: bigint): string => {
  const negative = numerator < 0n
  const magnitude = negative ? -numerator : numerator
  const scaledNumerator = magnitude * RETURN_SCALE
  const quotient = scaledNumerator / denominator
  const remainder = scaledNumerator % denominator
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient
  const integer = rounded / RETURN_SCALE
  const fraction = (rounded % RETURN_SCALE).toString().padStart(RETURN_DECIMAL_PLACES, '0')
  return `${negative ? '-' : ''}${integer}.${fraction}`
}

const sameCycleIdentity = (left: ForwardPerformanceCycleEvidence, right: ForwardPerformanceCycleEvidence): boolean =>
  left.qualificationRunId === right.qualificationRunId &&
  left.strategyName === right.strategyName &&
  left.strategyProtocolHash === right.strategyProtocolHash &&
  left.accountId === right.accountId &&
  left.executionPolicyHash === right.executionPolicyHash &&
  left.strategyExecutionModelHash === right.strategyExecutionModelHash

const durableExecutionSortKey = (
  binding: ForwardPerformanceEvidenceInput['durableExecutionBindings'][number],
): string =>
  JSON.stringify([
    binding.accountReferenceHash,
    binding.provider,
    binding.environment,
    binding.qualificationRunId,
    binding.strategyName,
    binding.strategyProtocolHash,
    binding.strategyBehaviorHash,
    binding.strategyParameterHash,
    binding.strategyParameterSchemaVersion,
    binding.executionPolicyHash,
    binding.sourceRevision,
    binding.imageRepository,
    binding.imageDigest,
  ])

const parseTotals = (
  input: ForwardPerformanceEvidenceInput,
  reasons: Set<ForwardPerformanceReasonCode>,
): ParsedTotals | undefined => {
  const ledger = input.ledgerTotals
  if (input.startingCapitalMicros === undefined) {
    reasons.add('STARTING_CAPITAL_GAP')
    return undefined
  }
  if (ledger === undefined) {
    reasons.add('MISSING_LEDGER_ACCOUNT')
    return undefined
  }
  const startingCapital = parseSignedMicros(input.startingCapitalMicros)
  const realizedGains = parseSignedMicros(ledger.realizedGainMicros)
  const realizedLosses = parseSignedMicros(ledger.realizedLossMicros)
  const brokerExecutionFees = parseSignedMicros(ledger.brokerExecutionFeesMicros)
  const otherChargedCosts = parseSignedMicros(ledger.otherChargedCostsMicros)
  const cashYield = parseSignedMicros(ledger.cashYieldMicros)
  if (
    startingCapital === undefined ||
    startingCapital <= 0n ||
    realizedGains === undefined ||
    realizedGains < 0n ||
    realizedLosses === undefined ||
    realizedLosses < 0n ||
    brokerExecutionFees === undefined ||
    brokerExecutionFees < 0n ||
    otherChargedCosts === undefined ||
    otherChargedCosts < 0n ||
    cashYield === undefined ||
    cashYield < 0n
  ) {
    reasons.add('INVALID_MICROS')
    return undefined
  }
  const grossRealizedPnl = checkedAdd(realizedGains, -realizedLosses)
  const afterFees = grossRealizedPnl === undefined ? undefined : checkedAdd(grossRealizedPnl, -brokerExecutionFees)
  const afterOtherCosts = afterFees === undefined ? undefined : checkedAdd(afterFees, -otherChargedCosts)
  const netRealizedPnlAfterCosts = afterOtherCosts === undefined ? undefined : checkedAdd(afterOtherCosts, cashYield)
  if (grossRealizedPnl === undefined || netRealizedPnlAfterCosts === undefined) {
    reasons.add('INVALID_MICROS')
    return undefined
  }
  return {
    startingCapital,
    realizedGains,
    realizedLosses,
    brokerExecutionFees,
    otherChargedCosts,
    cashYield,
    grossRealizedPnl,
    netRealizedPnlAfterCosts,
  }
}

const transactionTotalsMatch = (
  input: ForwardPerformanceEvidenceInput,
  totals: ParsedTotals,
  reasons: Set<ForwardPerformanceReasonCode>,
): void => {
  let gains = 0n
  let losses = 0n
  let fees = 0n
  for (const transaction of input.transactions) {
    const realizedPnl = parseSignedMicros(transaction.realizedPnlMicros)
    const fee = parseSignedMicros(transaction.feeMicros)
    if (realizedPnl === undefined || fee === undefined || fee < 0n) {
      reasons.add('INVALID_MICROS')
      return
    }
    const nextFees = checkedAdd(fees, fee)
    const nextGains = realizedPnl > 0n ? checkedAdd(gains, realizedPnl) : gains
    const nextLosses = realizedPnl < 0n ? checkedAdd(losses, -realizedPnl) : losses
    if (nextFees === undefined || nextGains === undefined || nextLosses === undefined) {
      reasons.add('INVALID_MICROS')
      return
    }
    fees = nextFees
    gains = nextGains
    losses = nextLosses
  }
  if (gains !== totals.realizedGains || losses !== totals.realizedLosses || fees !== totals.brokerExecutionFees) {
    reasons.add('LEDGER_MISMATCH')
  }
}

const makeMaterial = (input: ForwardPerformanceEvidenceInput): ForwardPerformanceReceiptMaterial => {
  const reasons = new Set<ForwardPerformanceReasonCode>()
  const cycles = [...input.cycles].sort(compareCycles)
  const firstCycle = cycles[0]
  const lastCycle = cycles.at(-1)
  const strategy = input.strategy
  const reconciliation = input.reconciliation
  const durableExecutions = [...input.durableExecutionBindings].sort((left, right) => {
    const leftKey = durableExecutionSortKey(left)
    const rightKey = durableExecutionSortKey(right)
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
  })
  const durableExecution = durableExecutions[0]

  if (input.account.accountId.length === 0 || input.account.accountReferenceHash.length === 0) {
    reasons.add('ACCOUNT_IDENTITY_GAP')
  }
  if (
    input.transactions.length > 0 &&
    (durableExecutions.length !== 1 ||
      durableExecution === undefined ||
      durableExecution.accountId !== input.account.accountId ||
      durableExecution.accountReferenceHash !== input.account.accountReferenceHash ||
      durableExecution.provider !== input.account.provider ||
      durableExecution.environment !== input.account.environment)
  ) {
    reasons.add('ACCOUNT_IDENTITY_GAP')
  }
  if (
    input.transactions.length > 0 &&
    (durableExecution === undefined ||
      firstCycle === undefined ||
      strategy === undefined ||
      durableExecution.qualificationRunId !== firstCycle.qualificationRunId ||
      durableExecution.strategyName !== firstCycle.strategyName ||
      durableExecution.strategyProtocolHash !== firstCycle.strategyProtocolHash ||
      durableExecution.strategyBehaviorHash !== strategy.strategyBehaviorHash ||
      durableExecution.strategyParameterHash !== strategy.strategyParameterHash ||
      durableExecution.strategyParameterSchemaVersion !== strategy.strategyParameterSchemaVersion ||
      durableExecution.executionPolicyHash !== firstCycle.executionPolicyHash ||
      durableExecution.sourceRevision !== strategy.sourceRevision ||
      durableExecution.imageRepository !== strategy.imageRepository ||
      durableExecution.imageDigest !== strategy.imageDigest)
  ) {
    reasons.add('CYCLE_IDENTITY_DRIFT')
  }
  if (strategy === undefined || firstCycle === undefined) reasons.add('IDENTITY_GAP')
  if (firstCycle !== undefined) {
    if (
      firstCycle.accountId !== input.account.accountId ||
      cycles.some((cycle) => !sameCycleIdentity(firstCycle, cycle))
    ) {
      reasons.add('CYCLE_IDENTITY_DRIFT')
    }
    if (
      strategy !== undefined &&
      (strategy.qualificationRunId !== firstCycle.qualificationRunId ||
        strategy.strategyName !== firstCycle.strategyName ||
        strategy.strategyProtocolHash !== firstCycle.strategyProtocolHash)
    ) {
      reasons.add('CYCLE_IDENTITY_DRIFT')
    }
  }
  if (reconciliation === undefined || reconciliation.performanceExact !== true) {
    reasons.add('NON_EXACT_RECONCILIATION')
  }
  if (lastCycle !== undefined && reconciliation !== undefined && reconciliation.reconciledAt < lastCycle.terminalAt) {
    reasons.add('UNCLOSED_WINDOW')
  }
  if (input.unclosedCycleCount > 0) reasons.add('UNCLOSED_WINDOW')
  if (input.unresolvedMutationCount > 0) reasons.add('UNRESOLVED_MUTATION')
  if (input.openPositionCount > 0) reasons.add('OPEN_POSITION')
  if (!input.accountingReceiptsExact) reasons.add('ACCOUNTING_RECEIPT_MISMATCH')
  if (!input.ledgerExact) reasons.add('LEDGER_MISMATCH')
  if (input.missingLedgerAccountCount > 0) reasons.add('MISSING_LEDGER_ACCOUNT')
  if (input.cashYieldEvidenceRequired && input.cashYieldEvidence === undefined) {
    reasons.add('CASH_YIELD_EVIDENCE_GAP')
  }
  if (input.transactions.length === 0) reasons.add('ZERO_COMPLETED_EXECUTIONS')

  const cycleIds = new Set(cycles.map((cycle) => cycle.cycleId))
  if (input.transactions.some((transaction) => !cycleIds.has(transaction.cycleId))) reasons.add('CYCLE_IDENTITY_DRIFT')

  const totals = parseTotals(input, reasons)
  if (totals !== undefined) transactionTotalsMatch(input, totals, reasons)
  if (input.cashYieldEvidence !== undefined) {
    const evidenceAmount = parseSignedMicros(input.cashYieldEvidence.amountMicros)
    if (
      !input.cashYieldEvidenceRequired ||
      evidenceAmount === undefined ||
      evidenceAmount <= 0n ||
      totals === undefined ||
      totals.cashYield !== evidenceAmount
    ) {
      reasons.add('CASH_YIELD_EVIDENCE_GAP')
    }
  } else if (totals !== undefined && totals.cashYield > 0n) {
    reasons.add('CASH_YIELD_EVIDENCE_GAP')
  }

  const realizedCloseCount = input.transactions.filter((transaction) => transaction.side === 'SELL').length
  const reasonCodes = [...reasons].sort()
  const sufficient = reasonCodes.length === 0
  const strategyBinding =
    strategy === undefined || firstCycle === undefined
      ? null
      : {
          qualificationRunId: strategy.qualificationRunId,
          strategyName: strategy.strategyName,
          strategyProtocolHash: strategy.strategyProtocolHash,
          strategyBehaviorHash: strategy.strategyBehaviorHash,
          strategyParameterHash: strategy.strategyParameterHash,
          strategyParameterSchemaVersion: strategy.strategyParameterSchemaVersion,
          executionPolicyHash: firstCycle.executionPolicyHash,
          strategyExecutionModelHash: firstCycle.strategyExecutionModelHash,
        }

  return {
    schemaVersion: FORWARD_PERFORMANCE_SCHEMA_VERSION,
    bindings: {
      runtime: input.runtime,
      source:
        strategy === undefined
          ? null
          : {
              sourceRevision: strategy.sourceRevision,
              imageRepository: strategy.imageRepository,
              imageDigest: strategy.imageDigest,
            },
      strategy: strategyBinding,
      account: {
        accountReferenceHash: durableExecution?.accountReferenceHash ?? input.account.accountReferenceHash,
        provider: durableExecution?.provider ?? input.account.provider,
        environment: durableExecution?.environment ?? input.account.environment,
      },
    },
    window: {
      firstCycleId: firstCycle?.cycleId ?? null,
      lastCycleId: lastCycle?.cycleId ?? null,
      openedAt: firstCycle?.submissionOpenAt ?? null,
      closedAt: reconciliation?.reconciledAt ?? null,
      reconciliationId: reconciliation?.reconciliationId ?? null,
      reconciliationContentHash: reconciliation?.contentHash ?? null,
      reconciliationStatus: reconciliation?.status ?? null,
      cashYieldAdjustedExact: reconciliation?.cashYieldAdjustedExact ?? null,
    },
    totals: {
      startingCapitalMicros: totals?.startingCapital.toString() ?? null,
      realizedGainsMicros: totals?.realizedGains.toString() ?? null,
      realizedLossesMicros: totals?.realizedLosses.toString() ?? null,
      brokerExecutionFeesMicros: totals?.brokerExecutionFees.toString() ?? null,
      otherChargedCostsMicros: totals?.otherChargedCosts.toString() ?? null,
      cashYieldMicros: totals?.cashYield.toString() ?? null,
      grossRealizedPnlMicros: totals?.grossRealizedPnl.toString() ?? null,
      netRealizedPnlAfterCostsMicros: totals?.netRealizedPnlAfterCosts.toString() ?? null,
      netRealizedReturn:
        totals === undefined
          ? null
          : {
              numeratorMicros: totals.netRealizedPnlAfterCosts.toString(),
              denominatorMicros: totals.startingCapital.toString(),
              decimal: formatReturn(totals.netRealizedPnlAfterCosts, totals.startingCapital),
            },
    },
    counts: {
      cycleCount: cycles.length,
      completedExecutionCount: input.transactions.length,
      realizedCloseCount,
    },
    evidence: {
      status: sufficient ? 'SUFFICIENT' : 'INSUFFICIENT_EVIDENCE',
      reasonCodes,
      cashYield: input.cashYieldEvidence ?? null,
    },
    profitability:
      !sufficient || totals === undefined
        ? 'UNDETERMINED'
        : totals.netRealizedPnlAfterCosts > 0n
          ? 'PROFITABLE'
          : 'NOT_PROFITABLE',
  }
}

export const makeForwardPerformanceReceipt = (
  input: ForwardPerformanceEvidenceInput,
): Result.Result<ForwardPerformanceReceipt, ForwardPerformanceDomainFailure> => {
  const material = makeMaterial(input)
  return Result.mapError(
    Result.map(canonicalHashV1Result(material), (receiptHash) => ({ ...material, receiptHash })),
    (cause): ForwardPerformanceDomainFailure => ({
      _tag: 'ForwardPerformanceDomainFailure',
      operation: 'hash-receipt',
      cause,
    }),
  )
}

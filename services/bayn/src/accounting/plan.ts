import { Effect } from 'effect'
import { TransferFlags, type Account, type Transfer } from 'tigerbeetle-node'

import { BaynAccountingValidationError } from './errors'
import { accountId, stableU128, stableU64, transferId } from './identifiers'
import {
  ACCOUNT_HISTORY_FLAG,
  BAYN_ACCOUNTING_MODEL_V1,
  MAX_U128,
  NON_NEGATIVE_ASSET_FLAGS,
  type BaynAccountCode,
  type BaynLedger,
  type BaynTransferCode,
} from './model'
import type {
  BaynEvaluationEconomicsV1,
  BaynJournalPlanV1,
  EvaluationCashEntry,
  EvaluationFee,
  EvaluationTrade,
  PlannedAccount,
  PlannedAccountKind,
  PlannedTransfer,
  PlannedTransferKind,
} from './types'

type TimelineEvent =
  | { readonly type: 'cash'; readonly value: EvaluationCashEntry }
  | { readonly type: 'trade'; readonly value: EvaluationTrade }
  | { readonly type: 'fee'; readonly value: EvaluationFee }

interface MutablePlannedAccount {
  readonly semanticKey: string
  readonly kind: PlannedAccountKind
  readonly symbol?: string
  readonly ledger: BaynLedger
  readonly code: BaynAccountCode
  readonly account: Account
  debitsPosted: bigint
  creditsPosted: bigint
}

const invalid = (rule: string, message: string): never => {
  throw new BaynAccountingValidationError({ rule, message })
}

const requireIdentity = (field: string, value: string): void => {
  if (value.length === 0 || value !== value.trim()) {
    invalid('stable-identities', `${field} must be a non-empty, whitespace-trimmed stable identity`)
  }
  if (Buffer.byteLength(value, 'utf8') > 512) {
    invalid('stable-identities', `${field} must not exceed 512 UTF-8 bytes`)
  }
}

const requirePositive = (field: string, value: bigint): void => {
  if (typeof value !== 'bigint' || value <= 0n) {
    invalid('positive-amounts', `${field} must be a positive bigint in the declared model unit`)
  }
  if (value > MAX_U128) {
    invalid('amount-range', `${field} must fit in TigerBeetle's unsigned 128-bit amount field`)
  }
}

const requireNonNegative = (field: string, value: bigint): void => {
  if (typeof value !== 'bigint' || value < 0n) {
    invalid('non-negative-balances', `${field} must be a non-negative bigint in the declared model unit`)
  }
  if (value > MAX_U128) {
    invalid('amount-range', `${field} must fit in an unsigned 128-bit accounting value`)
  }
}

const requireSequence = (field: string, value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalid('event-ordering', `${field} must be a non-negative safe integer`)
  }
}

const requireSymbol = (field: string, symbol: string): void => {
  if (!/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(symbol)) {
    invalid('canonical-symbols', `${field} must be a canonical uppercase symbol of at most 32 characters`)
  }
}

const validateEventIdentitiesAndSequence = (events: readonly TimelineEvent[]): void => {
  const identities = new Set<string>()
  const sequences = new Set<number>()
  for (const event of events) {
    const { eventId, sequence } = event.value
    requireIdentity(`${event.type}.eventId`, eventId)
    requireSequence(`${event.type}.sequence`, sequence)
    if (identities.has(eventId)) {
      invalid('stable-identities', `eventId ${eventId} is duplicated across evaluation economic events`)
    }
    if (sequences.has(sequence)) {
      invalid('event-ordering', `sequence ${sequence} is duplicated across evaluation economic events`)
    }
    identities.add(eventId)
    sequences.add(sequence)
  }
}

const timelineFor = (evaluation: BaynEvaluationEconomicsV1): readonly TimelineEvent[] => {
  const events: TimelineEvent[] = [
    ...evaluation.cashEntries.map((value) => ({ type: 'cash' as const, value })),
    ...evaluation.trades.map((value) => ({ type: 'trade' as const, value })),
    ...evaluation.fees.map((value) => ({ type: 'fee' as const, value })),
  ]
  validateEventIdentitiesAndSequence(events)
  return events.sort((left, right) => left.value.sequence - right.value.sequence)
}

const validateAndDeriveEconomics = (
  evaluation: BaynEvaluationEconomicsV1,
  timeline: readonly TimelineEvent[],
): Readonly<Record<string, { readonly quantity: bigint; readonly marketValue: bigint }>> => {
  const schemaVersion: unknown = (evaluation as { readonly schemaVersion: unknown }).schemaVersion
  if (schemaVersion !== BAYN_ACCOUNTING_MODEL_V1.evaluationSchemaVersion) {
    invalid(
      'schema-version',
      `evaluation schema ${String(schemaVersion)} does not match ${BAYN_ACCOUNTING_MODEL_V1.evaluationSchemaVersion}`,
    )
  }
  requireIdentity('evaluationId', evaluation.evaluationId)
  requireNonNegative('initialCash', evaluation.initialCash)
  requireNonNegative('ending.cash', evaluation.ending.cash)
  requireNonNegative('ending.totalFees', evaluation.ending.totalFees)
  requireNonNegative('ending.equity', evaluation.ending.equity)

  const tradeIds = new Set(evaluation.trades.map((trade) => trade.eventId))
  let cash = evaluation.initialCash
  let totalFees = 0n
  const quantities = new Map<string, bigint>()

  for (const event of timeline) {
    switch (event.type) {
      case 'cash': {
        requirePositive(`cash entry ${event.value.eventId} amount`, event.value.amount)
        if (event.value.direction === 'DEPOSIT') {
          cash += event.value.amount
        } else if (event.value.direction === 'WITHDRAWAL') {
          cash -= event.value.amount
        } else {
          invalid('cash-entry-direction', `cash entry ${event.value.eventId} has an unsupported direction`)
        }
        break
      }
      case 'trade': {
        requireSymbol(`trade ${event.value.eventId} symbol`, event.value.symbol)
        requirePositive(`trade ${event.value.eventId} quantity`, event.value.quantity)
        requirePositive(`trade ${event.value.eventId} grossAmount`, event.value.grossAmount)
        const previousQuantity = quantities.get(event.value.symbol) ?? 0n
        if (event.value.side === 'BUY') {
          cash -= event.value.grossAmount
          quantities.set(event.value.symbol, previousQuantity + event.value.quantity)
        } else if (event.value.side === 'SELL') {
          cash += event.value.grossAmount
          quantities.set(event.value.symbol, previousQuantity - event.value.quantity)
        } else {
          invalid('trade-side', `trade ${event.value.eventId} has an unsupported side`)
        }
        if ((quantities.get(event.value.symbol) ?? 0n) < 0n) {
          invalid('long-only', `trade ${event.value.eventId} would make ${event.value.symbol} quantity negative`)
        }
        break
      }
      case 'fee': {
        requirePositive(`fee ${event.value.eventId} amount`, event.value.amount)
        if (event.value.tradeEventId !== undefined && !tradeIds.has(event.value.tradeEventId)) {
          invalid(
            'fee-trade-reference',
            `fee ${event.value.eventId} references missing trade ${event.value.tradeEventId}`,
          )
        }
        cash -= event.value.amount
        totalFees += event.value.amount
        break
      }
    }
    if (cash < 0n) {
      invalid('cash-only', `event ${event.value.eventId} at sequence ${event.value.sequence} would make cash negative`)
    }
  }

  if (cash !== evaluation.ending.cash) {
    invalid(
      'ending-cash-exact',
      `computed ending cash ${cash} does not equal evaluator ending cash ${evaluation.ending.cash}`,
    )
  }
  if (totalFees !== evaluation.ending.totalFees) {
    invalid(
      'fees-exact',
      `computed total fees ${totalFees} does not equal evaluator total fees ${evaluation.ending.totalFees}`,
    )
  }

  const endingPositions: Record<string, { quantity: bigint; marketValue: bigint }> = {}
  for (const position of evaluation.ending.positions) {
    requireSymbol('ending position symbol', position.symbol)
    requirePositive(`ending position ${position.symbol} quantity`, position.quantity)
    requirePositive(`ending position ${position.symbol} marketValue`, position.marketValue)
    if (endingPositions[position.symbol] !== undefined) {
      invalid('ending-positions-exact', `ending position ${position.symbol} is duplicated`)
    }
    endingPositions[position.symbol] = { quantity: position.quantity, marketValue: position.marketValue }
  }

  const expectedSymbols = [...quantities.entries()]
    .filter(([, quantity]) => quantity !== 0n)
    .map(([symbol]) => symbol)
    .sort()
  const endingSymbols = Object.keys(endingPositions).sort()
  if (expectedSymbols.join('\0') !== endingSymbols.join('\0')) {
    invalid(
      'ending-positions-exact',
      `computed ending symbols [${expectedSymbols.join(', ')}] do not equal evaluator symbols [${endingSymbols.join(', ')}]`,
    )
  }
  for (const symbol of expectedSymbols) {
    const computed = quantities.get(symbol) ?? 0n
    const declared = endingPositions[symbol]
    if (declared === undefined || declared.quantity !== computed) {
      invalid(
        'ending-positions-exact',
        `computed ${symbol} quantity ${computed} does not equal evaluator quantity ${declared?.quantity ?? 'missing'}`,
      )
    }
  }

  const computedEquity = cash + Object.values(endingPositions).reduce((sum, position) => sum + position.marketValue, 0n)
  if (computedEquity !== evaluation.ending.equity) {
    invalid(
      'ending-equity-exact',
      `computed ending equity ${computedEquity} does not equal evaluator ending equity ${evaluation.ending.equity}`,
    )
  }

  return endingPositions
}

const economicsFingerprint = (evaluation: BaynEvaluationEconomicsV1, timeline: readonly TimelineEvent[]): bigint => {
  const parts: string[] = [
    BAYN_ACCOUNTING_MODEL_V1.evaluationSchemaVersion,
    evaluation.evaluationId,
    evaluation.initialCash.toString(),
  ]
  for (const event of timeline) {
    parts.push('event', event.type, event.value.sequence.toString(), event.value.eventId)
    if (event.type === 'cash') {
      parts.push(event.value.direction, event.value.amount.toString())
    } else if (event.type === 'trade') {
      parts.push(
        event.value.symbol,
        event.value.side,
        event.value.quantity.toString(),
        event.value.grossAmount.toString(),
      )
    } else {
      parts.push(event.value.amount.toString(), event.value.tradeEventId ?? '')
    }
  }
  parts.push(
    'ending',
    evaluation.ending.cash.toString(),
    evaluation.ending.totalFees.toString(),
    evaluation.ending.equity.toString(),
  )
  for (const position of [...evaluation.ending.positions].sort((left, right) => {
    if (left.symbol < right.symbol) return -1
    if (left.symbol > right.symbol) return 1
    return 0
  })) {
    parts.push('position', position.symbol, position.quantity.toString(), position.marketValue.toString())
  }
  return stableU128('evaluation-economics-content', parts)
}

const buildJournalPlanUnsafe = (evaluation: BaynEvaluationEconomicsV1): BaynJournalPlanV1 => {
  const timeline = timelineFor(evaluation)
  const endingPositions = validateAndDeriveEconomics(evaluation, timeline)
  const fingerprint = economicsFingerprint(evaluation, timeline)
  const mutableAccounts = new Map<string, MutablePlannedAccount>()

  const addAccount = (
    semanticKey: string,
    kind: PlannedAccountKind,
    ledger: BaynLedger,
    code: BaynAccountCode,
    flags: number,
    symbol?: string,
  ): void => {
    const id = accountId(evaluation.evaluationId, semanticKey)
    mutableAccounts.set(semanticKey, {
      semanticKey,
      kind,
      ...(symbol === undefined ? {} : { symbol }),
      ledger,
      code,
      account: {
        id,
        debits_pending: 0n,
        debits_posted: 0n,
        credits_pending: 0n,
        credits_posted: 0n,
        user_data_128: fingerprint,
        user_data_64: stableU64('account-metadata', [evaluation.evaluationId, semanticKey]),
        user_data_32: BAYN_ACCOUNTING_MODEL_V1.modelVersion,
        reserved: 0,
        ledger,
        code,
        flags,
        timestamp: 0n,
      },
      debitsPosted: 0n,
      creditsPosted: 0n,
    })
  }

  addAccount(
    'cash',
    'cash',
    BAYN_ACCOUNTING_MODEL_V1.ledgers.usdMicros,
    BAYN_ACCOUNTING_MODEL_V1.accountCodes.cashAsset,
    NON_NEGATIVE_ASSET_FLAGS,
  )
  addAccount(
    'capital',
    'capital',
    BAYN_ACCOUNTING_MODEL_V1.ledgers.usdMicros,
    BAYN_ACCOUNTING_MODEL_V1.accountCodes.contributedCapital,
    ACCOUNT_HISTORY_FLAG,
  )
  addAccount(
    'trade-settlement',
    'trade-settlement',
    BAYN_ACCOUNTING_MODEL_V1.ledgers.usdMicros,
    BAYN_ACCOUNTING_MODEL_V1.accountCodes.tradeSettlement,
    ACCOUNT_HISTORY_FLAG,
  )
  addAccount(
    'fee-expense',
    'fee-expense',
    BAYN_ACCOUNTING_MODEL_V1.ledgers.usdMicros,
    BAYN_ACCOUNTING_MODEL_V1.accountCodes.feeExpense,
    ACCOUNT_HISTORY_FLAG,
  )
  addAccount(
    'ending-valuation',
    'ending-valuation',
    BAYN_ACCOUNTING_MODEL_V1.ledgers.usdMicros,
    BAYN_ACCOUNTING_MODEL_V1.accountCodes.endingValuationAsset,
    ACCOUNT_HISTORY_FLAG,
  )
  addAccount(
    'ending-valuation-offset',
    'ending-valuation-offset',
    BAYN_ACCOUNTING_MODEL_V1.ledgers.usdMicros,
    BAYN_ACCOUNTING_MODEL_V1.accountCodes.endingValuationOffset,
    ACCOUNT_HISTORY_FLAG,
  )

  const tradedSymbols = new Set(evaluation.trades.map((trade) => trade.symbol))
  for (const symbol of [...tradedSymbols].sort()) {
    addAccount(
      `position:${symbol}`,
      'security-position',
      BAYN_ACCOUNTING_MODEL_V1.ledgers.shareE8,
      BAYN_ACCOUNTING_MODEL_V1.accountCodes.securityPosition,
      NON_NEGATIVE_ASSET_FLAGS,
      symbol,
    )
    addAccount(
      `market:${symbol}`,
      'security-market',
      BAYN_ACCOUNTING_MODEL_V1.ledgers.shareE8,
      BAYN_ACCOUNTING_MODEL_V1.accountCodes.securityMarket,
      ACCOUNT_HISTORY_FLAG,
      symbol,
    )
  }

  const plannedTransfers: PlannedTransfer[] = []
  const addTransfer = (
    stableEventIdentity: string,
    leg: string,
    kind: PlannedTransferKind,
    sourceEventId: string,
    debitSemanticKey: string,
    creditSemanticKey: string,
    amount: bigint,
    ledger: BaynLedger,
    code: BaynTransferCode,
    symbol?: string,
  ): void => {
    const debit = mutableAccounts.get(debitSemanticKey)
    const credit = mutableAccounts.get(creditSemanticKey)
    if (debit === undefined) {
      invalid(
        'journal-account-coverage',
        `transfer ${stableEventIdentity}/${leg} references unplanned debit account ${debitSemanticKey}`,
      )
    }
    if (credit === undefined) {
      invalid(
        'journal-account-coverage',
        `transfer ${stableEventIdentity}/${leg} references unplanned credit account ${creditSemanticKey}`,
      )
    }
    const debitAccount = debit!
    const creditAccount = credit!
    if (debitAccount.ledger !== ledger || creditAccount.ledger !== ledger) {
      invalid('ledger-balancing', `transfer ${stableEventIdentity}/${leg} does not balance within ledger ${ledger}`)
    }
    const id = transferId(evaluation.evaluationId, stableEventIdentity, leg)
    const transfer: Transfer = {
      id,
      debit_account_id: debitAccount.account.id,
      credit_account_id: creditAccount.account.id,
      amount,
      pending_id: 0n,
      user_data_128: fingerprint,
      user_data_64: stableU64('event-metadata', [evaluation.evaluationId, stableEventIdentity, leg]),
      user_data_32: BAYN_ACCOUNTING_MODEL_V1.modelVersion,
      timeout: 0,
      ledger,
      code,
      flags: TransferFlags.none,
      timestamp: 0n,
    }
    if (debitAccount.debitsPosted + amount > MAX_U128 || creditAccount.creditsPosted + amount > MAX_U128) {
      invalid('account-balance-range', `transfer ${stableEventIdentity}/${leg} would overflow a u128 account balance`)
    }
    debitAccount.debitsPosted += amount
    creditAccount.creditsPosted += amount
    plannedTransfers.push({
      stableEventIdentity,
      kind,
      sourceEventId,
      ...(symbol === undefined ? {} : { symbol }),
      ledger,
      code,
      transfer,
    })
  }

  if (evaluation.initialCash > 0n) {
    addTransfer(
      'initial-cash',
      'usd',
      'initial-cash',
      evaluation.evaluationId,
      'cash',
      'capital',
      evaluation.initialCash,
      BAYN_ACCOUNTING_MODEL_V1.ledgers.usdMicros,
      BAYN_ACCOUNTING_MODEL_V1.transferCodes.initialCash,
    )
  }

  for (const event of timeline) {
    if (event.type === 'cash') {
      const isDeposit = event.value.direction === 'DEPOSIT'
      addTransfer(
        `cash:${event.value.eventId}`,
        'usd',
        'cash-entry',
        event.value.eventId,
        isDeposit ? 'cash' : 'capital',
        isDeposit ? 'capital' : 'cash',
        event.value.amount,
        BAYN_ACCOUNTING_MODEL_V1.ledgers.usdMicros,
        isDeposit
          ? BAYN_ACCOUNTING_MODEL_V1.transferCodes.cashDeposit
          : BAYN_ACCOUNTING_MODEL_V1.transferCodes.cashWithdrawal,
      )
      continue
    }
    if (event.type === 'fee') {
      addTransfer(
        `fee:${event.value.eventId}`,
        'usd',
        'fee',
        event.value.eventId,
        'fee-expense',
        'cash',
        event.value.amount,
        BAYN_ACCOUNTING_MODEL_V1.ledgers.usdMicros,
        BAYN_ACCOUNTING_MODEL_V1.transferCodes.fee,
      )
      continue
    }

    const isBuy = event.value.side === 'BUY'
    addTransfer(
      `trade:${event.value.eventId}`,
      'cash',
      'trade-cash',
      event.value.eventId,
      isBuy ? 'trade-settlement' : 'cash',
      isBuy ? 'cash' : 'trade-settlement',
      event.value.grossAmount,
      BAYN_ACCOUNTING_MODEL_V1.ledgers.usdMicros,
      isBuy
        ? BAYN_ACCOUNTING_MODEL_V1.transferCodes.tradeBuyCash
        : BAYN_ACCOUNTING_MODEL_V1.transferCodes.tradeSellCash,
      event.value.symbol,
    )
    addTransfer(
      `trade:${event.value.eventId}`,
      'quantity',
      'trade-quantity',
      event.value.eventId,
      isBuy ? `position:${event.value.symbol}` : `market:${event.value.symbol}`,
      isBuy ? `market:${event.value.symbol}` : `position:${event.value.symbol}`,
      event.value.quantity,
      BAYN_ACCOUNTING_MODEL_V1.ledgers.shareE8,
      isBuy
        ? BAYN_ACCOUNTING_MODEL_V1.transferCodes.tradeBuyQuantity
        : BAYN_ACCOUNTING_MODEL_V1.transferCodes.tradeSellQuantity,
      event.value.symbol,
    )
  }

  for (const symbol of Object.keys(endingPositions).sort()) {
    addTransfer(
      `ending:${symbol}`,
      'valuation',
      'ending-valuation',
      symbol,
      'ending-valuation',
      'ending-valuation-offset',
      endingPositions[symbol]!.marketValue,
      BAYN_ACCOUNTING_MODEL_V1.ledgers.usdMicros,
      BAYN_ACCOUNTING_MODEL_V1.transferCodes.endingValuation,
      symbol,
    )
  }

  const accounts: PlannedAccount[] = [...mutableAccounts.values()].map((planned) => ({
    semanticKey: planned.semanticKey,
    kind: planned.kind,
    ...(planned.symbol === undefined ? {} : { symbol: planned.symbol }),
    ledger: planned.ledger,
    code: planned.code,
    account: planned.account,
    expectedDebitsPosted: planned.debitsPosted,
    expectedCreditsPosted: planned.creditsPosted,
  }))

  const cashAccount = accounts.find((account) => account.kind === 'cash')
  if (
    cashAccount === undefined ||
    cashAccount.expectedDebitsPosted - cashAccount.expectedCreditsPosted !== evaluation.ending.cash
  ) {
    invalid('ending-cash-exact', 'planned cash account does not reproduce evaluator ending cash')
  }

  return {
    schemaVersion: 'bayn.tigerbeetle-journal-plan.v1',
    accountingModelVersion: BAYN_ACCOUNTING_MODEL_V1.modelVersion,
    evaluationId: evaluation.evaluationId,
    evaluationFingerprint: fingerprint,
    accounts,
    transfers: plannedTransfers,
    expected: {
      endingCash: evaluation.ending.cash,
      endingEquity: evaluation.ending.equity,
      totalFees: evaluation.ending.totalFees,
      positions: endingPositions,
    },
  }
}

export const buildJournalPlan = (
  evaluation: BaynEvaluationEconomicsV1,
): Effect.Effect<BaynJournalPlanV1, BaynAccountingValidationError> =>
  Effect.try({
    try: () => buildJournalPlanUnsafe(evaluation),
    catch: (cause) => {
      if (cause instanceof BaynAccountingValidationError) {
        return cause
      }
      return new BaynAccountingValidationError({
        rule: 'model-input',
        message: cause instanceof Error ? cause.message : String(cause),
      })
    },
  })

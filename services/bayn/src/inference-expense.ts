import { Result, Schema } from 'effect'

import { canonicalHashV1Result, stableU128, stableU64 } from './hash'
import {
  InferenceCostError,
  HistoricalInferenceCostLineSchema,
  StagedInferenceCostLineSchema,
  CheckpointInferenceCostLineSchema,
  HistoricalInferenceRateSchema,
  InferenceStage,
  inferenceStageKey,
  priceInferenceUsage,
  InferenceCostRequestSchema,
  InferenceRateSchema,
  InferenceUsageStatus,
  makeInferenceCostReport,
  decodeInferenceCostEvidence,
  decodeInferenceCostRequest,
  type DecodedInferenceCostEvidence,
  type DecodedInferenceCostRequest,
  type InferenceCostEvidence,
} from './inference-costs'
import type { LedgerAccountRecord, LedgerTransferRecord } from './ledger-plan/model'
import { transferMetadataMatches } from './ledger-plan/verification'
import {
  IsoDateSchema,
  Sha256Schema,
  StrictNonEmptyStringSchema,
  UtcInstantSchema,
  strictParseOptions,
} from './schemas'

export const inferenceExpenseLedger = 7_002
export const inferenceExpenseSchemaVersion = 1
export const inferenceExpenseBatchSize = 64
export const inferenceExpenseCoverageFrom = '2026-10-05'

/** A frozen list-price assumption, never an invoice or a negotiated account tariff. */
export const inferenceExpenseRateCard = {
  schemaVersion: 'bayn.inference-rate-card.v1',
  rates: [
    {
      provider: 'typesafe',
      model: 'jev-1.13.0',
      currency: 'USD',
      source:
        'Published https://docs.typesafe.ai/models, verified 2026-10-07 UTC. Assumed list price for metered consumption since 2026-10-05; not invoice-reconciled. Freeze each quote; later tariff revisions apply only to new quotes.',
      effectiveFrom: '2026-10-05T00:00:00.000Z',
      effectiveUntil: '9999-12-31T23:59:59.999Z',
      inputMicrosPerMillionTokens: '42000',
      outputMicrosPerMillionTokens: '0',
    },
    {
      provider: 'openai',
      model: 'gpt-6-luna',
      currency: 'USD',
      source:
        'OpenAI Decisions API standard list price with 30-minute cache writes, https://developers.openai.com/api/docs/pricing, verified 2026-10-25 UTC; not invoice-reconciled.',
      effectiveFrom: '2026-10-22T00:00:00.000Z',
      effectiveUntil: '9999-12-31T23:59:59.999Z',
      inputMicrosPerMillionTokens: '100000',
      cachedInputMicrosPerMillionTokens: '10000',
      cacheWriteInputMicrosPerMillionTokens: '125000',
      outputMicrosPerMillionTokens: '0',
    },
  ],
} as const

export const InferenceExpenseSourceSchema = Schema.Struct({
  accountId: StrictNonEmptyStringSchema,
  sessionDate: IsoDateSchema,
  asOf: UtcInstantSchema,
  ...InferenceCostRequestSchema.fields,
})
export type InferenceExpenseSource = typeof InferenceExpenseSourceSchema.Type

export const InferenceExpenseQuoteSchema = Schema.Union([
  Schema.Struct({
    schemaVersion: Schema.Literal('bayn.inference-expense-quote.v3'),
    accountBindingHash: Sha256Schema,
    sessionDate: IsoDateSchema,
    line: CheckpointInferenceCostLineSchema,
    rate: Schema.NullOr(InferenceRateSchema),
    quoteHash: Sha256Schema,
  }),
  Schema.Struct({
    schemaVersion: Schema.Literal('bayn.inference-expense-quote.v1'),
    accountBindingHash: Sha256Schema,
    sessionDate: IsoDateSchema,
    line: HistoricalInferenceCostLineSchema,
    rate: Schema.NullOr(HistoricalInferenceRateSchema),
    quoteHash: Sha256Schema,
  }),
  Schema.Struct({
    schemaVersion: Schema.Literal('bayn.inference-expense-quote.v2'),
    accountBindingHash: Sha256Schema,
    sessionDate: IsoDateSchema,
    line: StagedInferenceCostLineSchema,
    rate: Schema.NullOr(InferenceRateSchema),
    quoteHash: Sha256Schema,
  }),
])
export type InferenceExpenseQuote = typeof InferenceExpenseQuoteSchema.Type

export interface InferenceExpenseRecord {
  readonly quote: InferenceExpenseQuote
  readonly verifiedAt: string | null
}

export interface InferenceExpenseSnapshot {
  readonly evidence: Pick<InferenceCostEvidence, 'accountBindingHash' | 'sessionDate' | 'asOf'>
  readonly quotes: readonly InferenceExpenseRecord[]
}

export enum InferenceExpenseCoverageIssue {
  MissingQuote = 'MISSING_FROZEN_QUOTE',
  UnverifiedLedger = 'UNVERIFIED_LEDGER',
  UnknownUsage = 'UNKNOWN_USAGE',
  UnpricedUsage = 'UNPRICED_USAGE',
}

type InferenceExpenseRequestCoverage = Pick<
  InferenceExpenseQuote['line'],
  'requestId' | 'model' | 'purpose' | 'usageStatus' | 'receiptHash' | 'resolutionHash'
> & { readonly issues: readonly InferenceExpenseCoverageIssue[] }

type ExpenseRateCard = {
  readonly schemaVersion: 'bayn.inference-rate-card.v1'
  readonly rates: readonly (typeof InferenceRateSchema.Type)[]
}

const expenseSourceEvidence = (source: InferenceExpenseSource) =>
  Result.gen(function* () {
    const accountBindingHash = yield* canonicalHashV1Result({
      schemaVersion: 'bayn.inference-cost-account.v1',
      accountId: source.accountId,
    })
    return yield* decodeInferenceCostEvidence({
      schemaVersion:
        source.chartCheckpoint === undefined ? 'bayn.inference-cost-evidence.v2' : 'bayn.inference-cost-evidence.v3',
      accountBindingHash,
      sessionDate: source.sessionDate,
      asOf: source.asOf,
      requests: [
        {
          requestId: source.requestId,
          cycleId: source.cycleId,
          authorityGenerationHash: source.authorityGenerationHash,
          request: source.request,
          receipt: source.receipt,
          resolution: source.resolution,
          handoff: source.handoff,
          ...(source.chartCheckpoint === undefined ? {} : { chartCheckpoint: source.chartCheckpoint }),
        },
      ],
    })
  })

const quotesFromEvidence = (evidence: DecodedInferenceCostEvidence, rateCard: ExpenseRateCard) =>
  Result.gen(function* () {
    const report = yield* makeInferenceCostReport(evidence, rateCard)
    const sources = new Map(evidence.requests.map((source) => [source.requestId, source]))
    return yield* Result.all(
      report.requests
        .filter((line) => {
          const source = sources.get(line.requestId)
          return (
            source?.chartCheckpoint === undefined ||
            source.resolution !== null ||
            ('stage' in line && line.stage === InferenceStage.Chart)
          )
        })
        .map((line) =>
          Result.gen(function* () {
            let rate: typeof InferenceRateSchema.Type | null = null
            for (const candidate of rateCard.rates)
              if ((yield* canonicalHashV1Result(candidate)) === line.rateHash) rate = candidate
            const material = {
              schemaVersion:
                'chartClaimHash' in line
                  ? 'bayn.inference-expense-quote.v3'
                  : 'stage' in line
                    ? 'bayn.inference-expense-quote.v2'
                    : 'bayn.inference-expense-quote.v1',
              accountBindingHash: evidence.accountBindingHash,
              sessionDate: evidence.sessionDate,
              line,
              rate,
            }
            return yield* Schema.decodeUnknownResult(
              InferenceExpenseQuoteSchema,
              strictParseOptions,
            )({ ...material, quoteHash: yield* canonicalHashV1Result(material) })
          }),
        ),
    )
  })

export const makeInferenceExpenseQuotes = (
  source: InferenceExpenseSource,
  rateCard: ExpenseRateCard,
): Result.Result<readonly InferenceExpenseQuote[], InferenceCostError> =>
  expenseSourceEvidence(source).pipe(
    Result.flatMap((evidence) => quotesFromEvidence(evidence, rateCard)),
    Result.mapError((cause) =>
      cause instanceof InferenceCostError
        ? cause
        : new InferenceCostError({ message: 'Inference expense quotes cannot be constructed', cause }),
    ),
  )

const selectExpenseQuote = (quotes: readonly InferenceExpenseQuote[], stage?: InferenceStage) => {
  const selected =
    stage === undefined
      ? quotes.length === 1
        ? quotes[0]
        : undefined
      : quotes.find((quote) => 'stage' in quote.line && quote.line.stage === stage)
  return selected === undefined
    ? Result.fail(
        new InferenceCostError({ message: 'A provider stage is required for a sequential inference expense' }),
      )
    : Result.succeed(selected)
}

export const makeInferenceExpenseQuote = (
  source: InferenceExpenseSource,
  rateCard: ExpenseRateCard,
  stage?: InferenceStage,
) => makeInferenceExpenseQuotes(source, rateCard).pipe(Result.flatMap((quotes) => selectExpenseQuote(quotes, stage)))

export const decodeInferenceExpenseQuote = (input: unknown): Result.Result<InferenceExpenseQuote, InferenceCostError> =>
  Result.gen(function* () {
    const quote = yield* Schema.decodeUnknownResult(
      InferenceExpenseQuoteSchema,
      strictParseOptions,
    )(input).pipe(
      Result.mapError(() => new InferenceCostError({ message: 'Frozen inference expense quote is malformed' })),
    )
    const { quoteHash, ...material } = quote
    const expected = yield* canonicalHashV1Result(material).pipe(
      Result.mapError(() => new InferenceCostError({ message: 'Frozen inference expense quote cannot be hashed' })),
    )
    if (quoteHash !== expected)
      return yield* Result.fail(new InferenceCostError({ message: 'Frozen inference expense quote hash differs' }))
    const line = quote.line
    if ('chartClaimHash' in line && line.usageStatus === InferenceUsageStatus.NotDispatched)
      return yield* Result.fail(
        new InferenceCostError({ message: 'A dispatch checkpoint cannot prove no provider call' }),
      )
    if ('stage' in line) {
      if (
        line.usageStatus === InferenceUsageStatus.Unknown
          ? line.cachedInputTokens !== null || line.cacheWriteInputTokens !== null
          : line.cachedInputTokens === null || line.cacheWriteInputTokens === null
      )
        return yield* Result.fail(
          new InferenceCostError({ message: 'Stage cache metering must agree with usage coverage' }),
        )
      if (
        line.usageStatus === InferenceUsageStatus.NotDispatched &&
        (line.cachedInputTokens !== '0' || line.cacheWriteInputTokens !== '0')
      )
        return yield* Result.fail(
          new InferenceCostError({ message: 'Undispatched inference cannot consume cache tokens' }),
        )
      if (quote.rate !== null && quote.rate.provider !== (line.stage === InferenceStage.Chart ? 'openai' : 'typesafe'))
        return yield* Result.fail(new InferenceCostError({ message: 'Stage tariff belongs to another provider' }))
    }
    if (line.usageStatus === InferenceUsageStatus.Unknown) {
      if (
        line.inputTokens !== null ||
        line.outputTokens !== null ||
        line.estimatedCostPicoUsd !== null ||
        line.rateHash !== null ||
        quote.rate !== null
      )
        return yield* Result.fail(
          new InferenceCostError({ message: 'Unknown inference usage cannot carry a priced expense' }),
        )
    } else if (line.usageStatus === InferenceUsageStatus.NotDispatched) {
      if (
        (line.receiptHash === null &&
          !('handoffHash' in line && line.handoffHash !== null) &&
          !('chartTerminalHash' in line && line.chartTerminalHash !== null)) ||
        line.inputTokens !== '0' ||
        line.outputTokens !== '0' ||
        line.estimatedCostPicoUsd !== '0' ||
        line.rateHash !== null ||
        quote.rate !== null
      )
        return yield* Result.fail(
          new InferenceCostError({
            message: 'Undispatched inference expense requires a receipt, zero usage and cost, and no tariff',
          }),
        )
    } else {
      if (
        (line.receiptHash === null &&
          !('handoffHash' in line && line.handoffHash !== null) &&
          !('chartTerminalHash' in line && line.chartTerminalHash !== null)) ||
        line.inputTokens === null ||
        line.outputTokens === null
      )
        return yield* Result.fail(new InferenceCostError({ message: 'Metered inference expense has incomplete usage' }))
      if (line.estimatedCostPicoUsd === null) {
        if (line.rateHash !== null || quote.rate !== null)
          return yield* Result.fail(
            new InferenceCostError({ message: 'Unpriced inference expense cannot carry a tariff' }),
          )
      } else {
        if (quote.rate === null || line.rateHash === null || quote.rate.model !== line.model)
          return yield* Result.fail(
            new InferenceCostError({ message: 'Priced inference expense has no matching tariff' }),
          )
        const rateHash = yield* canonicalHashV1Result(quote.rate).pipe(
          Result.mapError(() => new InferenceCostError({ message: 'Frozen inference rate cannot be hashed' })),
        )
        const cost = yield* priceInferenceUsage(
          {
            inputTokens: BigInt(line.inputTokens),
            outputTokens: BigInt(line.outputTokens),
            cachedInputTokens:
              'cachedInputTokens' in line && line.cachedInputTokens !== null ? BigInt(line.cachedInputTokens) : 0n,
            cacheWriteInputTokens:
              'cacheWriteInputTokens' in line && line.cacheWriteInputTokens !== null
                ? BigInt(line.cacheWriteInputTokens)
                : 0n,
          },
          quote.rate,
        )
        if (rateHash !== line.rateHash || cost.toString() !== line.estimatedCostPicoUsd || cost >= 2n ** 128n)
          return yield* Result.fail(
            new InferenceCostError({ message: 'Frozen inference expense price differs from its usage and tariff' }),
          )
      }
    }
    return quote
  })

const verifyQuoteFromEvidence = (evidence: DecodedInferenceCostEvidence, valid: InferenceExpenseQuote) =>
  Result.gen(function* () {
    const quotes = yield* quotesFromEvidence(evidence, {
      schemaVersion: 'bayn.inference-rate-card.v1',
      rates: valid.rate === null ? [] : [valid.rate],
    })
    const expected = yield* selectExpenseQuote(quotes, 'stage' in valid.line ? valid.line.stage : undefined)
    if (expected.quoteHash !== valid.quoteHash)
      return yield* Result.fail(
        new InferenceCostError({ message: 'Frozen inference expense differs from the immutable request evidence' }),
      )
    return valid
  })

type QuoteSourcePrefix = Pick<InferenceExpenseSource, 'receipt' | 'handoff' | 'resolution' | 'chartCheckpoint'>

const quoteSourcePrefix = (source: QuoteSourcePrefix, quote: InferenceExpenseQuote) =>
  Result.gen(function* () {
    const line = quote.line
    const staged = 'stage' in line
    const checkpoint = 'chartClaimHash' in line ? source.chartCheckpoint : undefined
    if (
      'chartClaimHash' in line &&
      (checkpoint === undefined ||
        checkpoint.claim.claimHash !== line.chartClaimHash ||
        (line.chartTerminalHash !== null && checkpoint.terminal?.terminalHash !== line.chartTerminalHash))
    )
      return yield* Result.fail(
        new InferenceCostError({ message: 'Frozen chart expense differs from its checkpoint identity' }),
      )
    const independentHandoff =
      staged &&
      line.handoffHash !== null &&
      (line.stage === InferenceStage.Chart || line.usageStatus === InferenceUsageStatus.NotDispatched)
    return {
      receipt: line.receiptHash !== null || independentHandoff ? source.receipt : null,
      handoff: staged && line.handoffHash !== null ? source.handoff : null,
      resolution: checkpoint === undefined ? source.resolution : null,
      ...(checkpoint === undefined
        ? {}
        : {
            chartCheckpoint:
              'chartTerminalHash' in line && line.chartTerminalHash === null && checkpoint.terminal !== null
                ? { ...checkpoint, terminal: null }
                : checkpoint,
          }),
    }
  })

const sameQuoteSourcePrefix = (source: QuoteSourcePrefix, prefix: QuoteSourcePrefix) =>
  prefix.receipt === source.receipt &&
  prefix.handoff === source.handoff &&
  prefix.resolution === source.resolution &&
  prefix.chartCheckpoint === source.chartCheckpoint

const decodeQuoteSourcePrefix = (source: DecodedInferenceCostRequest, prefix: QuoteSourcePrefix, asOf: string) =>
  decodeInferenceCostRequest(
    {
      requestId: source.requestId,
      cycleId: source.cycleId,
      authorityGenerationHash: source.authorityGenerationHash,
      request: source.request,
      ...prefix,
    },
    asOf,
  )

export const verifyInferenceExpenseQuote = (source: InferenceExpenseSource, quote: InferenceExpenseQuote) =>
  Result.gen(function* () {
    const valid = yield* decodeInferenceExpenseQuote(quote)
    // Validate the complete graph before projecting an older immutable quote cut.
    const evidence = yield* expenseSourceEvidence(source)
    const current = evidence.requests[0]
    if (current === undefined) return yield* Result.fail(new InferenceCostError({ message: 'Missing expense source' }))
    const prefix = yield* quoteSourcePrefix(current, valid)
    const prepared = sameQuoteSourcePrefix(current, prefix)
      ? current
      : yield* decodeQuoteSourcePrefix(current, prefix, evidence.asOf)
    return yield* verifyQuoteFromEvidence({ ...evidence, requests: [prepared] }, valid)
  })

export const verifyInferenceExpenseCoverage = (
  evidence: DecodedInferenceCostEvidence,
  accountId: string,
  frozen: readonly { readonly quote: InferenceExpenseQuote; readonly verifiedAt: string | null }[],
) =>
  Result.gen(function* () {
    const binding = yield* canonicalHashV1Result({ schemaVersion: 'bayn.inference-cost-account.v1', accountId }).pipe(
      Result.mapError(() => new InferenceCostError({ message: 'Inference expense coverage account cannot be hashed' })),
    )
    if (evidence.accountBindingHash !== binding)
      return yield* Result.fail(
        new InferenceCostError({ message: 'Inference expense coverage account differs from the request cut' }),
      )
    const original = yield* makeInferenceCostReport(evidence, {
      schemaVersion: 'bayn.inference-rate-card.v1',
      rates: [],
    })
    const sources = new Map(evidence.requests.map((request) => [request.requestId, request]))
    const byRequest = new Map<string, typeof frozen>()
    const prefixes = new Map<string, DecodedInferenceCostRequest>()
    for (const row of frozen) {
      const quote = row.quote
      const source = sources.get(quote.line.requestId)
      if (
        source === undefined ||
        quote.accountBindingHash !== evidence.accountBindingHash ||
        quote.sessionDate !== evidence.sessionDate
      )
        return yield* Result.fail(
          new InferenceCostError({ message: 'Frozen inference expense is outside the complete request cut' }),
        )
      const valid = yield* decodeInferenceExpenseQuote(quote)
      const prefix = yield* quoteSourcePrefix(source, valid)
      let prepared = source
      if (!sameQuoteSourcePrefix(source, prefix)) {
        // A frozen pending charge can bind an earlier source prefix. Reproduce each such prefix once.
        const key = JSON.stringify([
          source.requestId,
          prefix.receipt !== null,
          prefix.handoff !== null,
          prefix.resolution !== null,
          prefix.chartCheckpoint?.claim.claimHash ?? null,
          prefix.chartCheckpoint?.terminal?.terminalHash ?? null,
        ])
        const existing = prefixes.get(key)
        if (existing !== undefined) prepared = existing
        else {
          prepared = yield* decodeQuoteSourcePrefix(source, prefix, evidence.asOf)
          prefixes.set(key, prepared)
        }
      }
      yield* verifyQuoteFromEvidence({ ...evidence, requests: [prepared] }, valid)
      const prior = byRequest.get(inferenceStageKey(quote.line)) ?? []
      byRequest.set(inferenceStageKey(quote.line), [...prior, row])
    }
    let missingQuoteCount = 0
    let unverifiedRequestCount = 0
    let gapRequestCount = 0
    const requestsWithCoverageIssues: InferenceExpenseRequestCoverage[] = []
    for (const line of original.requests) {
      const issues: InferenceExpenseCoverageIssue[] = []
      const matches = (byRequest.get(inferenceStageKey(line)) ?? []).filter(
        (row) =>
          row.quote.line.receiptHash === line.receiptHash &&
          ('handoffHash' in row.quote.line ? row.quote.line.handoffHash : null) ===
            ('handoffHash' in line ? line.handoffHash : null) &&
          ('chartClaimHash' in row.quote.line ? row.quote.line.chartClaimHash : null) ===
            ('chartClaimHash' in line ? line.chartClaimHash : null) &&
          ('chartTerminalHash' in row.quote.line ? row.quote.line.chartTerminalHash : null) ===
            ('chartTerminalHash' in line ? line.chartTerminalHash : null),
      )
      if (matches.length === 0) {
        missingQuoteCount++
        issues.push(InferenceExpenseCoverageIssue.MissingQuote)
      } else {
        const current = matches[0]
        if (matches.length !== 1 || current === undefined)
          return yield* Result.fail(
            new InferenceCostError({ message: 'Inference expense request has conflicting frozen coverage' }),
          )
        if (current.verifiedAt === null) {
          unverifiedRequestCount++
          issues.push(InferenceExpenseCoverageIssue.UnverifiedLedger)
        }
        if (current.quote.line.estimatedCostPicoUsd === null) {
          gapRequestCount++
          issues.push(
            current.quote.line.usageStatus === InferenceUsageStatus.Unknown
              ? InferenceExpenseCoverageIssue.UnknownUsage
              : InferenceExpenseCoverageIssue.UnpricedUsage,
          )
        }
      }
      if (issues.length > 0)
        requestsWithCoverageIssues.push({
          requestId: line.requestId,
          model: line.model,
          purpose: line.purpose,
          usageStatus: line.usageStatus,
          receiptHash: line.receiptHash,
          resolutionHash: line.resolutionHash,
          issues,
        })
    }
    return {
      sourceAsOf: evidence.asOf,
      claimedRequestCount: original.requestCount,
      missingQuoteCount,
      unverifiedRequestCount,
      gapRequestCount,
      requestsWithCoverageIssues,
      completeMeteredCoverage: missingQuoteCount === 0 && unverifiedRequestCount === 0 && gapRequestCount === 0,
    }
  })

export const inferenceExpenseScope = (accountBindingHash: string, sessionDate: string) =>
  `bayn.inference-expense.session.v1:${accountBindingHash}:${sessionDate}`

export interface InferenceExpensePlan {
  readonly accounts: readonly LedgerAccountRecord[]
  readonly transfers: readonly LedgerTransferRecord[]
}

export const inferenceExpensePosting = (
  scope: string,
  transferIdentity: string,
  evidenceHash: string,
  amount: bigint,
): InferenceExpensePlan => {
  const account = (code: number): LedgerAccountRecord => ({
    id: stableU128(`${scope}:account:${code}`),
    debits_pending: 0n,
    debits_posted: 0n,
    credits_pending: 0n,
    credits_posted: 0n,
    user_data_128: stableU128(scope),
    user_data_64: stableU64(scope),
    user_data_32: inferenceExpenseSchemaVersion,
    reserved: 0,
    ledger: inferenceExpenseLedger,
    code,
    flags: 1 << 3,
    timestamp: 0n,
  })
  const expense = account(510)
  const clearing = account(230)
  return {
    accounts: [expense, clearing],
    transfers:
      amount === 0n
        ? []
        : [
            {
              id: stableU128(transferIdentity),
              debit_account_id: expense.id,
              credit_account_id: clearing.id,
              amount,
              pending_id: 0n,
              user_data_128: stableU128(evidenceHash),
              user_data_64: stableU64(scope),
              user_data_32: inferenceExpenseSchemaVersion,
              timeout: 0,
              ledger: inferenceExpenseLedger,
              code: 1,
              flags: 0,
              timestamp: 0n,
            },
          ],
  }
}

export const buildInferenceExpensePlan = (
  quotes: readonly InferenceExpenseQuote[],
): Result.Result<InferenceExpensePlan, InferenceCostError> =>
  Result.gen(function* () {
    const accounts = new Map<bigint, LedgerAccountRecord>()
    const transfers = new Map<bigint, LedgerTransferRecord>()
    const pricedRequests = new Map<string, string>()
    for (const input of quotes) {
      const quote = yield* decodeInferenceExpenseQuote(input)
      const amount = quote.line.estimatedCostPicoUsd
      if (amount === null) continue
      const requestKey = `${quote.accountBindingHash}:${inferenceStageKey(quote.line)}`
      const previousQuote = pricedRequests.get(requestKey)
      if (previousQuote !== undefined && previousQuote !== quote.quoteHash)
        return yield* Result.fail(
          new InferenceCostError({ message: 'Conflicting inference expense quotes share a request identity' }),
        )
      pricedRequests.set(requestKey, quote.quoteHash)
      const scope = inferenceExpenseScope(quote.accountBindingHash, quote.sessionDate)
      const posting = inferenceExpensePosting(
        scope,
        'stage' in quote.line && quote.line.stage === InferenceStage.Chart
          ? `bayn.inference-expense.transfer.v2:${quote.accountBindingHash}:${quote.line.requestId}:CHART`
          : `bayn.inference-expense.transfer.v1:${quote.accountBindingHash}:${quote.line.requestId}`,
        quote.quoteHash,
        BigInt(amount),
      )
      for (const account of posting.accounts) accounts.set(account.id, account)
      const transfer = posting.transfers[0]
      if (transfer === undefined) continue
      const previous = transfers.get(transfer.id)
      if (previous !== undefined && !transferMetadataMatches(previous, transfer))
        return yield* Result.fail(
          new InferenceCostError({ message: 'Conflicting inference expense quotes share a request identity' }),
        )
      transfers.set(transfer.id, transfer)
    }
    return { accounts: [...accounts.values()], transfers: [...transfers.values()] }
  })

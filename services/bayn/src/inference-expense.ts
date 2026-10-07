import { Result, Schema } from 'effect'

import { canonicalHashV1Result, stableU128, stableU64 } from './hash'
import {
  InferenceCostError,
  InferenceCostLineSchema,
  InferenceCostRequestSchema,
  InferenceRateSchema,
  InferenceUsageStatus,
  makeInferenceCostReport,
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
  ],
} as const

export const InferenceExpenseSourceSchema = Schema.Struct({
  accountId: StrictNonEmptyStringSchema,
  sessionDate: IsoDateSchema,
  asOf: UtcInstantSchema,
  ...InferenceCostRequestSchema.fields,
})
export type InferenceExpenseSource = typeof InferenceExpenseSourceSchema.Type

export const InferenceExpenseQuoteSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.inference-expense-quote.v1'),
  accountBindingHash: Sha256Schema,
  sessionDate: IsoDateSchema,
  line: InferenceCostLineSchema,
  rate: Schema.NullOr(InferenceRateSchema),
  quoteHash: Sha256Schema,
})
export type InferenceExpenseQuote = typeof InferenceExpenseQuoteSchema.Type

export const makeInferenceExpenseQuote = (
  source: InferenceExpenseSource,
  rateCard: {
    readonly schemaVersion: 'bayn.inference-rate-card.v1'
    readonly rates: readonly (typeof InferenceRateSchema.Type)[]
  },
): Result.Result<InferenceExpenseQuote, InferenceCostError> =>
  Result.gen(function* () {
    const accountBindingHash = yield* canonicalHashV1Result({
      schemaVersion: 'bayn.inference-cost-account.v1',
      accountId: source.accountId,
    }).pipe(Result.mapError(() => new InferenceCostError({ message: 'Inference expense account cannot be hashed' })))
    const report = yield* makeInferenceCostReport(
      {
        schemaVersion: 'bayn.inference-cost-evidence.v1',
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
          },
        ],
      },
      rateCard,
    )
    const line = report.requests[0]
    if (line === undefined)
      return yield* Result.fail(new InferenceCostError({ message: 'Inference expense request is absent' }))
    let rate: typeof InferenceRateSchema.Type | null = null
    for (const candidate of rateCard.rates) {
      const hash = yield* canonicalHashV1Result(candidate).pipe(
        Result.mapError(() => new InferenceCostError({ message: 'Inference expense rate cannot be hashed' })),
      )
      if (hash === line.rateHash) rate = candidate
    }
    const material = {
      schemaVersion: 'bayn.inference-expense-quote.v1' as const,
      accountBindingHash,
      sessionDate: source.sessionDate,
      line,
      rate,
    }
    const quoteHash = yield* canonicalHashV1Result(material).pipe(
      Result.mapError(() => new InferenceCostError({ message: 'Inference expense quote cannot be hashed' })),
    )
    return { ...material, quoteHash }
  })

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
    } else {
      if (line.receiptHash === null || line.inputTokens === null || line.outputTokens === null)
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
        const cost =
          BigInt(line.inputTokens) * BigInt(quote.rate.inputMicrosPerMillionTokens) +
          BigInt(line.outputTokens) * BigInt(quote.rate.outputMicrosPerMillionTokens)
        if (rateHash !== line.rateHash || cost.toString() !== line.estimatedCostPicoUsd || cost >= 2n ** 128n)
          return yield* Result.fail(
            new InferenceCostError({ message: 'Frozen inference expense price differs from its usage and tariff' }),
          )
      }
    }
    return quote
  })

export const verifyInferenceExpenseQuote = (source: InferenceExpenseSource, quote: InferenceExpenseQuote) =>
  Result.gen(function* () {
    const valid = yield* decodeInferenceExpenseQuote(quote)
    const expected = yield* makeInferenceExpenseQuote(source, {
      schemaVersion: 'bayn.inference-rate-card.v1',
      rates: valid.rate === null ? [] : [valid.rate],
    })
    if (expected.quoteHash !== valid.quoteHash)
      return yield* Result.fail(
        new InferenceCostError({ message: 'Frozen inference expense differs from the immutable request evidence' }),
      )
    return valid
  })

export const verifyInferenceExpenseCoverage = (
  evidence: InferenceCostEvidence,
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
      yield* verifyInferenceExpenseQuote(
        {
          ...source,
          accountId,
          sessionDate: evidence.sessionDate,
          asOf: evidence.asOf,
          receipt: quote.line.receiptHash === null ? null : source.receipt,
        },
        quote,
      )
      const prior = byRequest.get(quote.line.requestId) ?? []
      byRequest.set(quote.line.requestId, [...prior, row])
    }
    let missingQuoteCount = 0
    let unverifiedRequestCount = 0
    let gapRequestCount = 0
    for (const line of original.requests) {
      const matches = (byRequest.get(line.requestId) ?? []).filter(
        (row) => row.quote.line.receiptHash === line.receiptHash,
      )
      if (matches.length === 0) {
        missingQuoteCount++
        continue
      }
      const current = matches[0]
      if (matches.length !== 1 || current === undefined)
        return yield* Result.fail(
          new InferenceCostError({ message: 'Inference expense request has conflicting frozen coverage' }),
        )
      if (current.verifiedAt === null) unverifiedRequestCount++
      if (current.quote.line.estimatedCostPicoUsd === null) gapRequestCount++
    }
    return {
      sourceAsOf: evidence.asOf,
      claimedRequestCount: original.requestCount,
      missingQuoteCount,
      unverifiedRequestCount,
      gapRequestCount,
      completeMeteredCoverage: missingQuoteCount === 0 && unverifiedRequestCount === 0 && gapRequestCount === 0,
    }
  })

export const inferenceExpenseScope = (accountBindingHash: string, sessionDate: string) =>
  `bayn.inference-expense.session.v1:${accountBindingHash}:${sessionDate}`

export interface InferenceExpensePlan {
  readonly accounts: readonly LedgerAccountRecord[]
  readonly transfers: readonly LedgerTransferRecord[]
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
      const requestKey = `${quote.accountBindingHash}:${quote.line.requestId}`
      const previousQuote = pricedRequests.get(requestKey)
      if (previousQuote !== undefined && previousQuote !== quote.quoteHash)
        return yield* Result.fail(
          new InferenceCostError({ message: 'Conflicting inference expense quotes share a request identity' }),
        )
      pricedRequests.set(requestKey, quote.quoteHash)
      const scope = inferenceExpenseScope(quote.accountBindingHash, quote.sessionDate)
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
      accounts.set(expense.id, expense)
      accounts.set(clearing.id, clearing)
      if (amount === '0') continue
      const transfer: LedgerTransferRecord = {
        id: stableU128(`bayn.inference-expense.transfer.v1:${quote.accountBindingHash}:${quote.line.requestId}`),
        debit_account_id: expense.id,
        credit_account_id: clearing.id,
        amount: BigInt(amount),
        pending_id: 0n,
        user_data_128: stableU128(quote.quoteHash),
        user_data_64: stableU64(scope),
        user_data_32: inferenceExpenseSchemaVersion,
        timeout: 0,
        ledger: inferenceExpenseLedger,
        code: 1,
        flags: 0,
        timestamp: 0n,
      }
      const previous = transfers.get(transfer.id)
      if (previous !== undefined && !transferMetadataMatches(previous, transfer))
        return yield* Result.fail(
          new InferenceCostError({ message: 'Conflicting inference expense quotes share a request identity' }),
        )
      transfers.set(transfer.id, transfer)
    }
    return { accounts: [...accounts.values()], transfers: [...transfers.values()] }
  })

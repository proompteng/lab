import { Data, Result, Schema } from 'effect'

import { canonicalHashV1Result } from './hash'
import type { InferenceCostReport } from './inference-costs'
import {
  IsoDateSchema,
  Sha256Schema,
  SignedMicrosSchema,
  StrictNonEmptyStringSchema,
  UnsignedMicrosSchema,
  UtcInstantSchema,
  strictParseOptions,
} from './schemas'

export enum OperatingCostCategory {
  Inference = 'INFERENCE',
  Data = 'DATA',
  Infrastructure = 'INFRASTRUCTURE',
  Research = 'RESEARCH',
}

export enum OperatingCostCoverage {
  Complete = 'COMPLETE',
  Partial = 'PARTIAL',
  Unknown = 'UNKNOWN',
}

export class OperatingCostError extends Data.TaggedError('OperatingCostError')<{
  readonly message: string
  readonly cause?: unknown
}> {}
const fail = (message: string) => new OperatingCostError({ message })
const hash = (value: unknown) =>
  canonicalHashV1Result(value).pipe(Result.mapError(() => fail('Cost evidence is not canonical')))
const SourceHash = Sha256Schema

const AllocationSchema = Schema.Struct({
  accountBindingHash: Sha256Schema,
  sessionDate: IsoDateSchema,
  amountMicros: UnsignedMicrosSchema,
  sourceHash: SourceHash,
})

/** Normalized, reviewed invoice lines. Source hashes establish reproducibility, not provider authenticity. */
export const OperatingCostEvidenceSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.operating-cost-evidence.v1'),
  accountBindingHash: Sha256Schema,
  sessionDate: IsoDateSchema,
  asOf: UtcInstantSchema,
  currency: Schema.Literal('USD'),
  trading: Schema.NullOr(Schema.Struct({ netPnlAfterExecutionFeesMicros: SignedMicrosSchema, sourceHash: SourceHash })),
  coverage: Schema.Array(
    Schema.Struct({
      category: Schema.Enum(OperatingCostCategory),
      status: Schema.Enum(OperatingCostCoverage),
      sourceHash: Schema.NullOr(SourceHash),
    }),
  ),
  consumption: Schema.Array(
    Schema.Struct({
      provider: StrictNonEmptyStringSchema,
      documentId: Sha256Schema,
      lineId: StrictNonEmptyStringSchema,
      sourceHash: SourceHash,
      category: Schema.Enum(OperatingCostCategory),
      serviceStartDate: IsoDateSchema,
      serviceEndDateExclusive: IsoDateSchema,
      grossAmountMicros: UnsignedMicrosSchema,
      credits: Schema.Array(
        Schema.Struct({ documentId: Sha256Schema, sourceHash: SourceHash, amountMicros: UnsignedMicrosSchema }),
      ),
      allocations: Schema.Array(AllocationSchema),
      unallocatedMicros: UnsignedMicrosSchema,
    }),
  ),
  prepaidFunding: Schema.Array(
    Schema.Struct({
      provider: StrictNonEmptyStringSchema,
      documentId: Sha256Schema,
      invoiceSourceHash: SourceHash,
      issuedOn: IsoDateSchema,
      creditAmountMicros: UnsignedMicrosSchema,
      payment: Schema.NullOr(
        Schema.Struct({ paidOn: IsoDateSchema, paidMicros: UnsignedMicrosSchema, receiptSourceHash: SourceHash }),
      ),
    }),
  ),
})
export type OperatingCostEvidence = typeof OperatingCostEvidenceSchema.Type

export const operatingCostSourceHashes = (evidence: OperatingCostEvidence): readonly string[] =>
  [
    ...new Set([
      ...(evidence.trading === null ? [] : [evidence.trading.sourceHash]),
      ...evidence.coverage.flatMap((c) => (c.sourceHash === null ? [] : [c.sourceHash])),
      ...evidence.consumption.flatMap((c) => [
        c.sourceHash,
        ...c.credits.map((v) => v.sourceHash),
        ...c.allocations.map((v) => v.sourceHash),
      ]),
      ...evidence.prepaidFunding.flatMap((c) => [
        c.invoiceSourceHash,
        ...(c.payment === null ? [] : [c.payment.receiptSourceHash]),
      ]),
    ]),
  ].sort()

/** External expenses never become broker cash movements or overwrite immutable inference receipts. */
export const makeOperatingCostReport = (
  inference: InferenceCostReport,
  input: unknown,
  verifiedSourceHashes: ReadonlySet<string>,
) =>
  Result.gen(function* () {
    const evidence = yield* Schema.decodeUnknownResult(
      OperatingCostEvidenceSchema,
      strictParseOptions,
    )(input).pipe(Result.mapError(() => fail('Operating-cost evidence is malformed')))
    if (evidence.accountBindingHash !== inference.accountBindingHash || evidence.sessionDate !== inference.sessionDate)
      return yield* Result.fail(fail('Operating costs and inference must bind the same account and session'))
    if (evidence.asOf < inference.asOf || evidence.sessionDate > evidence.asOf.slice(0, 10))
      return yield* Result.fail(fail('Cost evidence cannot predate its inference evidence or session'))
    const { reportHash: inferenceHash, ...inferenceMaterial } = inference
    if ((yield* hash(inferenceMaterial)) !== inferenceHash)
      return yield* Result.fail(fail('Inference report hash differs from its material'))
    const sourceHashes = operatingCostSourceHashes(evidence)
    if (sourceHashes.some((source) => !verifiedSourceHashes.has(source)))
      return yield* Result.fail(fail('A referenced expense artifact has not been verified'))
    const categories = Object.values(OperatingCostCategory)
    if (
      evidence.coverage.length !== categories.length ||
      new Set(evidence.coverage.map((c) => c.category)).size !== categories.length
    )
      return yield* Result.fail(fail('Every operating-cost category requires exactly one explicit coverage record'))
    if (evidence.coverage.some((c) => c.status !== OperatingCostCoverage.Unknown && c.sourceHash === null))
      return yield* Result.fail(
        fail('Partial and complete expense coverage require source evidence, including explicit zero costs'),
      )

    const consumption = new Map<string, OperatingCostEvidence['consumption'][number]>()
    const creditIds = new Set<string>()
    const creditArtifacts = new Set<string>()
    // Inspect all invoice artifacts before credits so import order cannot authorize a reused source.
    const invoiceArtifacts = new Set([
      ...evidence.consumption.map((entry) => entry.sourceHash),
      ...evidence.prepaidFunding.map((entry) => entry.invoiceSourceHash),
    ])
    const paymentArtifacts = new Set<string>()
    const funding = new Map<string, OperatingCostEvidence['prepaidFunding'][number]>()
    const fundingDocuments = new Set<string>()
    const documentSources = new Map<string, string>()
    const documentArtifacts = new Map<string, string>()
    for (const entry of evidence.prepaidFunding) {
      const key = `${entry.provider}:${entry.documentId}`
      const prior = funding.get(key)
      if (prior !== undefined) {
        if ((yield* hash(prior)) !== (yield* hash(entry)))
          return yield* Result.fail(fail('Conflicting duplicate prepaid funding'))
        continue
      }
      if (
        entry.issuedOn > evidence.asOf.slice(0, 10) ||
        (entry.payment !== null &&
          (entry.payment.paidOn < entry.issuedOn ||
            entry.payment.paidOn > evidence.asOf.slice(0, 10) ||
            entry.payment.paidMicros !== entry.creditAmountMicros))
      )
        return yield* Result.fail(fail('Prepaid payment must match its invoice amount and temporal scope'))
      if (entry.payment !== null) {
        const paymentKey = entry.payment.receiptSourceHash
        if (paymentArtifacts.has(paymentKey))
          return yield* Result.fail(fail('One payment receipt cannot fund multiple imported invoices'))
        paymentArtifacts.add(paymentKey)
      }
      funding.set(key, entry)
      fundingDocuments.add(key)
      const sourceKey = entry.invoiceSourceHash
      if (documentSources.has(sourceKey) && documentSources.get(sourceKey) !== key)
        return yield* Result.fail(fail('One source invoice cannot acquire multiple funding identities'))
      documentSources.set(sourceKey, key)
      documentArtifacts.set(key, entry.invoiceSourceHash)
    }
    const allocated = new Map(categories.map((category) => [category, 0n]))
    let unallocatedMicros = 0n
    for (const entry of evidence.consumption) {
      const documentKey = `${entry.provider}:${entry.documentId}`
      const key = `${documentKey}:${entry.lineId}`
      if (paymentArtifacts.has(entry.sourceHash))
        return yield* Result.fail(fail('A funding payment receipt cannot also be a consumption invoice'))
      if (fundingDocuments.has(documentKey) || creditIds.has(documentKey))
        return yield* Result.fail(fail('A prepaid purchase or credit note cannot also be a consumption expense'))
      const sourceKey = entry.sourceHash
      if (documentSources.has(sourceKey) && documentSources.get(sourceKey) !== documentKey)
        return yield* Result.fail(fail('One source invoice cannot acquire multiple document identities'))
      documentSources.set(sourceKey, documentKey)
      if (documentArtifacts.has(documentKey) && documentArtifacts.get(documentKey) !== entry.sourceHash)
        return yield* Result.fail(fail('One invoice identity cannot refer to conflicting original artifacts'))
      documentArtifacts.set(documentKey, entry.sourceHash)
      const prior = consumption.get(key)
      if (prior !== undefined) {
        if ((yield* hash(prior)) !== (yield* hash(entry)))
          return yield* Result.fail(fail('Conflicting duplicate invoice line'))
        continue
      }
      if (entry.serviceStartDate >= entry.serviceEndDateExclusive)
        return yield* Result.fail(fail('Expense service interval must be nonempty'))
      let credits = 0n
      for (const credit of entry.credits) {
        const creditKey = `${entry.provider}:${credit.documentId}`
        const artifactKey = credit.sourceHash
        if (
          creditIds.has(creditKey) ||
          creditArtifacts.has(artifactKey) ||
          paymentArtifacts.has(artifactKey) ||
          invoiceArtifacts.has(credit.sourceHash) ||
          documentArtifacts.has(creditKey) ||
          credit.documentId === entry.documentId
        )
          return yield* Result.fail(fail('A credit note must have one distinct original invoice line'))
        creditIds.add(creditKey)
        creditArtifacts.add(artifactKey)
        credits += BigInt(credit.amountMicros)
      }
      const net = BigInt(entry.grossAmountMicros) - credits
      const allocations = new Set<string>()
      let assigned = 0n
      for (const allocation of entry.allocations) {
        const allocationKey = `${allocation.accountBindingHash}:${allocation.sessionDate}`
        if (
          allocations.has(allocationKey) ||
          allocation.sessionDate < entry.serviceStartDate ||
          allocation.sessionDate >= entry.serviceEndDateExclusive ||
          allocation.sessionDate > evidence.asOf.slice(0, 10)
        )
          return yield* Result.fail(fail('Duplicate, premature, or out-of-service-period expense allocation'))
        allocations.add(allocationKey)
        assigned += BigInt(allocation.amountMicros)
        if (
          allocation.accountBindingHash === evidence.accountBindingHash &&
          allocation.sessionDate === evidence.sessionDate
        )
          allocated.set(entry.category, (allocated.get(entry.category) ?? 0n) + BigInt(allocation.amountMicros))
      }
      if (net < 0n || assigned + BigInt(entry.unallocatedMicros) !== net)
        return yield* Result.fail(
          fail('Invoice less credits must reconcile exactly to allocations plus unallocated remainder'),
        )
      if (
        BigInt(entry.unallocatedMicros) > 0n &&
        entry.serviceStartDate <= evidence.sessionDate &&
        evidence.sessionDate < entry.serviceEndDateExclusive &&
        evidence.coverage.some((c) => c.category === entry.category && c.status === OperatingCostCoverage.Complete)
      )
        return yield* Result.fail(
          fail('Complete category coverage cannot retain an unallocated invoice in the session interval'),
        )
      unallocatedMicros += BigInt(entry.unallocatedMicros)
      consumption.set(key, entry)
    }
    const rows = categories.map((category) => {
      const coverage = evidence.coverage.find((c) => c.category === category)
      return {
        category,
        coverage: coverage?.status ?? OperatingCostCoverage.Unknown,
        coverageSourceHash: coverage?.sourceHash ?? null,
        knownInvoicedCostMicros: (allocated.get(category) ?? 0n).toString(),
      }
    })
    const inferenceComplete = rows.some(
      (r) => r.category === OperatingCostCategory.Inference && r.coverage === OperatingCostCoverage.Complete,
    )
    const allComplete = rows.every((r) => r.coverage === OperatingCostCoverage.Complete)
    const actualInference = allocated.get(OperatingCostCategory.Inference) ?? 0n
    const totalActual = [...allocated.values()].reduce((sum, value) => sum + value, 0n)
    const pnl = evidence.trading === null ? null : BigInt(evidence.trading.netPnlAfterExecutionFeesMicros)
    const tariff = BigInt(inference.knownEstimatedCostMicros)
    const qualificationInference =
      inferenceComplete && inference.estimatedTotalCostMicros !== null
        ? (actualInference > tariff ? actualInference : tariff).toString()
        : null
    const material = {
      schemaVersion: 'bayn.operating-cost-report.v1' as const,
      accountBindingHash: evidence.accountBindingHash,
      sessionDate: evidence.sessionDate,
      asOf: evidence.asOf,
      currency: evidence.currency,
      sourceHashes,
      evidenceHash: yield* hash(evidence),
      inferenceReportHash: inference.reportHash,
      tradingSourceHash: evidence.trading?.sourceHash ?? null,
      netTradingPnlMicros: pnl?.toString() ?? null,
      categories: rows,
      invoiceReconciled: inferenceComplete,
      fullyCosted: allComplete,
      knownInvoicedOperatingCostMicros: totalActual.toString(),
      netPnlAfterKnownInvoicedCostsMicros: pnl === null ? null : (pnl - totalActual).toString(),
      knownInferenceTariffCostMicros: inference.knownEstimatedCostMicros,
      netPnlAfterKnownInferenceTariffMicros: pnl === null ? null : (pnl - tariff).toString(),
      // Do not blend partially overlapping invoices and tariff accruals. Complete consumption replaces the estimate.
      totalOperatingCostMicros: allComplete ? totalActual.toString() : null,
      netEconomicPnlMicros: allComplete && pnl !== null ? (pnl - totalActual).toString() : null,
      qualificationInferenceCostMicros: qualificationInference,
      unknownInferenceUsageCount: inference.unknownUsageCount,
      unpricedInferenceUsageCount: inference.unpricedUsageCount,
      importedUnallocatedCostMicros: unallocatedMicros.toString(),
      prepaidFunding: {
        scope: 'IMPORTED_DOCUMENTS_THROUGH_AS_OF' as const,
        uniqueInvoices: funding.size,
        creditPurchasesMicros: [...funding.values()]
          .reduce((sum, row) => sum + BigInt(row.creditAmountMicros), 0n)
          .toString(),
        providerReceiptedPaymentsMicros: [...funding.values()]
          .reduce((sum, row) => sum + BigInt(row.payment?.paidMicros ?? '0'), 0n)
          .toString(),
        providerReceiptedPaymentsOnSessionMicros: [...funding.values()]
          .reduce(
            (sum, row) => sum + (row.payment?.paidOn === evidence.sessionDate ? BigInt(row.payment.paidMicros) : 0n),
            0n,
          )
          .toString(),
        balanceMicros: null,
        balanceReconciled: false,
      },
      limitations: [
        'Normalized source classifications and allocation completeness are reviewed assertions; file hashes do not authenticate the provider.',
        'Prepaid funding and payment receipts are not consumption, and no opening/closing credit-balance reconciliation is implied.',
        'Known invoiced and tariff-estimated P&L are separate partial views. Never add the two deductions without request-level overlap evidence.',
        'External expenses do not mutate broker cash, size, risk authority, or immutable accounting receipts.',
      ],
    }
    return { ...material, reportHash: yield* hash(material) }
  })

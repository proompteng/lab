import { Result, Schema } from 'effect'

import { OrderSide } from '../execution/contracts'
import { intradayInstantNanos } from '../market-data/intraday/time'
import { Sha256Schema, UnsignedMicrosSchema, UtcSourceTimestampSchema, strictParseOptions } from '../schemas'
import { SystemAssessmentError } from './economics'

export enum RealismStatus {
  Supported = 'SUPPORTED',
  Violated = 'VIOLATED',
  Incomplete = 'INCOMPLETE',
}

export enum ExecutionEvidenceKind {
  Broker = 'BROKER_RECEIPT',
  Model = 'CONSERVATIVE_MODEL',
}

export const DecisionRealismSchema = Schema.Struct({
  decisionId: Sha256Schema,
  policyDefinitionHash: Sha256Schema,
  authorityGenerationHash: Sha256Schema,
  snapshotHash: Sha256Schema,
  decisionAt: UtcSourceTimestampSchema,
  persistedAt: UtcSourceTimestampSchema,
  inputs: Schema.Array(
    Schema.Struct({
      contentHash: Sha256Schema,
      availableAt: UtcSourceTimestampSchema,
    }),
  ),
})

export const FillRealismSchema = Schema.Struct({
  fillId: Sha256Schema,
  intentId: Sha256Schema,
  decisionId: Sha256Schema,
  positionOwnerGenerationHash: Sha256Schema,
  kind: Schema.Enum(ExecutionEvidenceKind),
  sourceHash: Sha256Schema,
  side: Schema.Enum(OrderSide),
  requestedQuantityAtoms: UnsignedMicrosSchema,
  cumulativeFilledQuantityAtoms: UnsignedMicrosSchema,
  fillQuantityAtoms: UnsignedMicrosSchema,
  quantityStepAtoms: UnsignedMicrosSchema,
  fillPriceAtoms: UnsignedMicrosSchema,
  priceTickAtoms: UnsignedMicrosSchema,
  limitPriceAtoms: UnsignedMicrosSchema,
  bidPriceAtoms: UnsignedMicrosSchema,
  askPriceAtoms: UnsignedMicrosSchema,
  quoteHash: Sha256Schema,
  quoteAvailableAt: UtcSourceTimestampSchema,
  quoteFreshUntil: UtcSourceTimestampSchema,
  supportedCapacityAtoms: Schema.NullOr(UnsignedMicrosSchema),
  capacitySourceHash: Schema.NullOr(Sha256Schema),
  routingStartedAt: UtcSourceTimestampSchema,
  requestDispatchedAt: UtcSourceTimestampSchema,
  submissionDeadlineAt: UtcSourceTimestampSchema,
  filledAt: UtcSourceTimestampSchema,
  expiresAt: UtcSourceTimestampSchema,
})

export const RealismEvidenceSchema = Schema.Struct({
  expectedDecisionIds: Schema.Array(Sha256Schema),
  expectedFillIds: Schema.Array(Sha256Schema),
  decisions: Schema.Array(DecisionRealismSchema),
  fills: Schema.Array(FillRealismSchema),
  unsupportedAssumptions: Schema.Array(Schema.String.check(Schema.isMinLength(1))),
})

export const measureRealism = (input: unknown, verifiedSourceHashes: ReadonlySet<string>) =>
  Schema.decodeUnknownResult(
    RealismEvidenceSchema,
    strictParseOptions,
  )(input).pipe(
    Result.mapError((cause) => new SystemAssessmentError({ message: 'Realism evidence is malformed', cause })),
    Result.flatMap((data) =>
      Result.gen(function* () {
        const violations: string[] = []
        const missing: string[] = []
        if (data.expectedDecisionIds.length === 0) missing.push('NO_DECISION_EVIDENCE')
        const decisions = new Map(data.decisions.map((decision) => [decision.decisionId, decision]))
        const fills = new Map(data.fills.map((fill) => [fill.fillId, fill]))
        if (
          decisions.size !== data.decisions.length ||
          fills.size !== data.fills.length ||
          new Set(data.expectedDecisionIds).size !== data.expectedDecisionIds.length ||
          new Set(data.expectedFillIds).size !== data.expectedFillIds.length
        )
          return yield* Result.fail(new SystemAssessmentError({ message: 'Duplicate realism evidence' }))
        for (const decision of data.decisions)
          if (!data.expectedDecisionIds.includes(decision.decisionId))
            violations.push(`UNREGISTERED_DECISION:${decision.decisionId}`)
        for (const fill of data.fills)
          if (!data.expectedFillIds.includes(fill.fillId)) violations.push(`UNREGISTERED_FILL:${fill.fillId}`)
        for (const id of data.expectedDecisionIds) if (!decisions.has(id)) missing.push(`MISSING_DECISION:${id}`)
        for (const id of data.expectedFillIds) if (!fills.has(id)) missing.push(`MISSING_FILL:${id}`)
        const requireSource = (hash: string) => {
          if (!verifiedSourceHashes.has(hash)) missing.push(`UNVERIFIED_SOURCE:${hash}`)
        }
        for (const decision of data.decisions) {
          requireSource(decision.snapshotHash)
          if (decision.inputs.length === 0) missing.push(`MISSING_INPUTS:${decision.decisionId}`)
          const at = intradayInstantNanos(decision.decisionAt)
          if (intradayInstantNanos(decision.persistedAt) < at)
            violations.push(`PERSISTED_BEFORE_DECISION:${decision.decisionId}`)
          for (const source of decision.inputs) {
            requireSource(source.contentHash)
            if (intradayInstantNanos(source.availableAt) > at) violations.push(`FUTURE_INPUT:${decision.decisionId}`)
          }
        }
        const lastQuantity = new Map<string, bigint>()
        const lastTime = new Map<string, bigint>()
        const intentTerms = new Map<string, typeof FillRealismSchema.Type>()
        const usedCapacity = new Map<string, bigint>()
        const capacityBounds = new Map<string, bigint>()
        for (const fill of data.fills) {
          requireSource(fill.sourceHash)
          requireSource(fill.quoteHash)
          const decision = decisions.get(fill.decisionId)
          if (decision === undefined) missing.push(`MISSING_DECISION:${fill.decisionId}`)
          else if (decision.authorityGenerationHash !== fill.positionOwnerGenerationHash)
            violations.push(`POSITION_OWNERSHIP_MISMATCH:${fill.fillId}`)
          const quantity = BigInt(fill.fillQuantityAtoms)
          const requested = BigInt(fill.requestedQuantityAtoms)
          const cumulative = BigInt(fill.cumulativeFilledQuantityAtoms)
          const step = BigInt(fill.quantityStepAtoms)
          const price = BigInt(fill.fillPriceAtoms)
          const tick = BigInt(fill.priceTickAtoms)
          const limit = BigInt(fill.limitPriceAtoms)
          const bid = BigInt(fill.bidPriceAtoms)
          const ask = BigInt(fill.askPriceAtoms)
          const previousQuantity = lastQuantity.get(fill.intentId) ?? 0n
          const prior = intentTerms.get(fill.intentId)
          if (
            prior !== undefined &&
            (prior.decisionId !== fill.decisionId ||
              prior.side !== fill.side ||
              prior.requestedQuantityAtoms !== fill.requestedQuantityAtoms ||
              prior.limitPriceAtoms !== fill.limitPriceAtoms ||
              intradayInstantNanos(prior.expiresAt) !== intradayInstantNanos(fill.expiresAt) ||
              prior.quantityStepAtoms !== fill.quantityStepAtoms ||
              prior.priceTickAtoms !== fill.priceTickAtoms)
          )
            violations.push(`INTENT_IDENTITY_DRIFT:${fill.fillId}`)
          if (quantity <= 0n || requested <= 0n || cumulative > requested || cumulative !== previousQuantity + quantity)
            violations.push(`INVALID_FILL_QUANTITY:${fill.fillId}`)
          if (
            step <= 0n ||
            requested % step !== 0n ||
            tick <= 0n ||
            limit % tick !== 0n ||
            (fill.kind === ExecutionEvidenceKind.Model && (quantity % step !== 0n || price % tick !== 0n))
          )
            violations.push(`INVALID_PRECISION:${fill.fillId}`)
          if (price <= 0n || limit <= 0n || bid <= 0n || ask < bid) violations.push(`INVALID_PRICE:${fill.fillId}`)
          if ((fill.side === OrderSide.Buy && price > limit) || (fill.side === OrderSide.Sell && price < limit))
            violations.push(`LIMIT_VIOLATION:${fill.fillId}`)
          const routingStarted = intradayInstantNanos(fill.routingStartedAt)
          const transmitted = intradayInstantNanos(fill.requestDispatchedAt)
          const filled = intradayInstantNanos(fill.filledAt)
          if (
            intradayInstantNanos(fill.quoteAvailableAt) > transmitted ||
            intradayInstantNanos(fill.quoteFreshUntil) < transmitted ||
            routingStarted > transmitted ||
            transmitted >= intradayInstantNanos(fill.submissionDeadlineAt) ||
            (decision !== undefined && intradayInstantNanos(decision.persistedAt) > routingStarted) ||
            filled < transmitted ||
            filled > intradayInstantNanos(fill.expiresAt) ||
            filled < (lastTime.get(fill.intentId) ?? filled)
          )
            violations.push(`INVALID_EXECUTION_TIMING:${fill.fillId}`)
          if (fill.kind === ExecutionEvidenceKind.Model) {
            if (fill.supportedCapacityAtoms === null || fill.capacitySourceHash === null)
              missing.push(`MISSING_LIQUIDITY:${fill.fillId}`)
            else {
              requireSource(fill.capacitySourceHash)
              const capacity = BigInt(fill.supportedCapacityAtoms)
              const consumed = (usedCapacity.get(fill.capacitySourceHash) ?? 0n) + quantity
              const priorBound = capacityBounds.get(fill.capacitySourceHash)
              if (consumed > capacity || (priorBound !== undefined && priorBound !== capacity))
                violations.push(`UNSUPPORTED_FILL:${fill.fillId}`)
              usedCapacity.set(fill.capacitySourceHash, consumed)
              capacityBounds.set(fill.capacitySourceHash, capacity)
            }
            if ((fill.side === OrderSide.Buy && price < ask) || (fill.side === OrderSide.Sell && price > bid))
              violations.push(`UNSUPPORTED_PRICE_IMPROVEMENT:${fill.fillId}`)
          }
          lastQuantity.set(fill.intentId, cumulative)
          lastTime.set(fill.intentId, filled)
          intentTerms.set(fill.intentId, fill)
        }
        for (const assumption of data.unsupportedAssumptions) missing.push(`UNSUPPORTED_ASSUMPTION:${assumption}`)
        return {
          status:
            violations.length > 0
              ? RealismStatus.Violated
              : missing.length > 0
                ? RealismStatus.Incomplete
                : RealismStatus.Supported,
          violations: [...new Set(violations)].sort(),
          missing: [...new Set(missing)].sort(),
          decisionCount: decisions.size,
          fillCount: fills.size,
        }
      }),
    ),
  )

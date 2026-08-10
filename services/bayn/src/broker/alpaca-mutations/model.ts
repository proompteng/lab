import { Context, Data, Effect, Schema } from 'effect'

import { MutationOutcome } from '../../paper'
import { StrictNonEmptyStringSchema as NonEmptyString, UtcInstantSchema as UtcInstant } from '../../schemas'
import type { Intent } from '../../paper'
import type { BrokerReadError, Order, ReadResult } from '../alpaca'
import { Pipeable } from '../../pipeable'

const RequestId = NonEmptyString.check(Schema.isMaxLength(256))

export enum MutationOperation {
  Submit = 'SUBMIT',
  Cancel = 'CANCEL',
}

export enum MutationFailure {
  Configuration = 'CONFIGURATION',
  InvalidRequest = 'INVALID_REQUEST',
  Rejected = 'REJECTED',
  Unknown = 'UNKNOWN',
}

export const MutationEvidenceSchema = Schema.Struct({
  requestId: RequestId,
  status: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })),
  contentHash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  observedAt: UtcInstant,
})
export type MutationEvidence = typeof MutationEvidenceSchema.Type
export type PartialMutationEvidence = {
  readonly [K in keyof MutationEvidence]?: MutationEvidence[K] | undefined
}

export class BrokerMutationError extends Data.TaggedError('BrokerMutationError')<{
  readonly operation: MutationOperation
  readonly failure: MutationFailure
  readonly outcome: MutationOutcome
  readonly message: string
  readonly requestHash?: string
  readonly evidence?: PartialMutationEvidence
  readonly brokerOrderId?: string
  readonly brokerCode?: string
  readonly cause?: Readonly<Record<string, string>>
}> {}

export interface SubmitReceipt {
  readonly requestHash: string
  readonly order: Order
  readonly evidence: MutationEvidence
}

export interface CancelReceipt {
  readonly requestHash: string
  readonly brokerOrderId: string
  readonly evidence: MutationEvidence
}

export interface BrokerMutationShape {
  readonly submit: (intent: Intent) => Effect.Effect<SubmitReceipt, BrokerMutationError>
  readonly cancel: (brokerOrderId: string) => Effect.Effect<CancelReceipt, BrokerMutationError>
  readonly orderById?: (brokerOrderId: string) => Effect.Effect<ReadResult<Order>, BrokerReadError>
  readonly orderByClientId?: (clientOrderId: string) => Effect.Effect<ReadResult<Order>, BrokerReadError>
}

export class BrokerMutation extends Context.Service<BrokerMutation, BrokerMutationShape>()('bayn/BrokerMutation') {}

const stringFact = (cause: object, name: string): string | undefined => {
  const value = name in cause ? cause[name as keyof typeof cause] : undefined
  return typeof value === 'string' ? value : undefined
}

export const causeSummary = (cause: unknown): Readonly<Record<string, string>> => {
  if (Schema.isSchemaError(cause)) return { tag: cause._tag, message: cause.message }
  if (typeof cause === 'object' && cause !== null && '_tag' in cause && typeof cause._tag === 'string') {
    const reason =
      'reason' in cause && typeof cause.reason === 'object' && cause.reason !== null && '_tag' in cause.reason
        ? String(cause.reason._tag)
        : stringFact(cause, 'reason')
    const path = stringFact(cause, 'path')
    const actualType = stringFact(cause, 'actualType')
    const failure = stringFact(cause, 'failure')
    return {
      tag: cause._tag,
      ...(reason === undefined ? {} : { reason }),
      ...(path === undefined ? {} : { path }),
      ...(actualType === undefined ? {} : { actualType }),
      ...(failure === undefined ? {} : { failure }),
    }
  }
  if (cause instanceof Error) return { tag: cause.name }
  return { tag: typeof cause }
}

export const configurationError = (message: string, cause?: unknown) =>
  new BrokerMutationError({
    operation: MutationOperation.Submit,
    failure: MutationFailure.Configuration,
    outcome: MutationOutcome.Known,
    message,
    ...(cause === undefined ? {} : { cause: causeSummary(cause) }),
  })

export const invalidRequest = (operation: MutationOperation, message: string, cause?: unknown) =>
  new BrokerMutationError({
    operation,
    failure: MutationFailure.InvalidRequest,
    outcome: MutationOutcome.Known,
    message,
    ...(cause === undefined ? {} : { cause: causeSummary(cause) }),
  })

export const unknownOutcome = (
  operation: MutationOperation,
  message: string,
  requestHash?: string,
  evidence?: PartialMutationEvidence,
  cause?: unknown,
) =>
  new BrokerMutationError({
    operation,
    failure: MutationFailure.Unknown,
    outcome: MutationOutcome.Unknown,
    message,
    ...(requestHash === undefined ? {} : { requestHash }),
    ...(evidence === undefined ? {} : { evidence }),
    ...(cause === undefined ? {} : { cause: causeSummary(cause) }),
  })

const knownRejectionDataFirst = (
  requestHash: string,
  evidence: MutationEvidence,
  code: string | number,
  message: string,
) =>
  new BrokerMutationError({
    operation: MutationOperation.Submit,
    failure: MutationFailure.Rejected,
    outcome: MutationOutcome.Known,
    message: `Alpaca rejected the order (${String(code)}): ${message}`,
    requestHash,
    evidence,
    brokerCode: String(code),
  })

export const knownRejection = Pipeable.dual(4, knownRejectionDataFirst)

const mismatchedAcceptedOrderDataFirst = (requestHash: string, evidence: MutationEvidence, brokerOrderId: string) =>
  new BrokerMutationError({
    operation: MutationOperation.Submit,
    failure: MutationFailure.Unknown,
    outcome: MutationOutcome.Unknown,
    message: 'Alpaca accepted an order that does not match the durable intent',
    requestHash,
    evidence,
    brokerOrderId,
  })

export const mismatchedAcceptedOrder = Pipeable.dual(3, mismatchedAcceptedOrderDataFirst)

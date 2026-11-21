import { createHmac, timingSafeEqual } from 'node:crypto'

import { Data, Redacted, Result, Schema } from 'effect'

import { decodeFeeActivityEffect } from './alpaca/activity-fees'
import { decodeTradeActivityEffect } from './alpaca/activity-fills'
import {
  OrderSide,
  OrderStatus,
  TradeActivityType,
  type FillActivity,
  type Observed,
  type ReadEvidence,
} from './alpaca/model'
import type { BrokerConnection } from './connection'
import { BrokerEnvironment } from './identity'
import { sha256 } from '../hash'
import {
  GitSourceRevisionSchema,
  Sha256Schema,
  StrictNonEmptyStringSchema,
  SymbolSchema,
  UtcInstantSchema,
  UtcOrderTimestampSchema,
  strictParseOptions,
} from '../schemas'

export const brokerActivityVersion = 'bayn.broker-activity.v1'
export const brokerActivityProjectionContract = 'bayn.broker-activity-projection.v1'
export const brokerActivityHeartbeatFreshnessMs = 45_000
const maximumMessageLength = 262_144
const canonicalOnlyActivityTypes = new Set([
  'ACATC',
  'ACATS',
  'CGD',
  'CSD',
  'CSW',
  'DIV',
  'DIVNRA',
  'FIMAT',
  'FOPT',
  'FXTRD',
  'INT',
  'JNLC',
  'JNLS',
  'MA',
  'MEM',
  'NC',
  'OPASN',
  'OPCA',
  'OPCSH',
  'OPEXC',
  'OPEXP',
  'OPTRD',
  'REO',
  'REORG',
  'SPIN',
  'SPLIT',
  'VOF',
  'WH',
])

export const ActivityEventIdSchema = Schema.String.check(Schema.isPattern(/^[0-9A-HJKMNP-TV-Z]{26}$/))
const ActivityReferenceSchema = Schema.String.check(Schema.isUUID())

export const SignedBrokerActivitySchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.signed-broker-activity.v1'),
  message: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximumMessageLength)),
  signature: Sha256Schema,
})

const ActivitySessionSchema = Schema.Struct({
  identityHash: Sha256Schema,
  accountId: StrictNonEmptyStringSchema,
  environment: Schema.Literal(BrokerEnvironment.Sandbox),
  credentialHash: Sha256Schema,
  sessionId: StrictNonEmptyStringSchema.check(Schema.isMaxLength(100)),
  sourceRevision: GitSourceRevisionSchema,
  verifiedAt: UtcInstantSchema,
  connectedAt: UtcInstantSchema,
  requestId: StrictNonEmptyStringSchema.check(Schema.isMaxLength(200)),
})

const activityCommon = {
  schemaVersion: Schema.Literal(brokerActivityVersion),
  eventId: Sha256Schema,
  session: ActivitySessionSchema,
  receivedAt: UtcInstantSchema,
}

export const BrokerActivityMessageSchema = Schema.TaggedUnion({
  Event: {
    ...activityCommon,
    sourceEventId: ActivityEventIdSchema,
    contentHash: Sha256Schema,
    refId: ActivityReferenceSchema,
    previousRefId: Schema.optionalKey(ActivityReferenceSchema),
    activityType: StrictNonEmptyStringSchema.check(Schema.isMaxLength(32)),
    activityJson: Schema.String.check(Schema.isMinLength(2), Schema.isMaxLength(maximumMessageLength)),
  },
  CatchupComplete: {
    ...activityCommon,
    cursor: Schema.NullOr(ActivityEventIdSchema),
    coveredThrough: UtcInstantSchema,
  },
  Heartbeat: { ...activityCommon, cursor: Schema.NullOr(ActivityEventIdSchema) },
})
export type BrokerActivityMessage = typeof BrokerActivityMessageSchema.Type
export type BrokerActivityEvent = Extract<BrokerActivityMessage, { readonly _tag: 'Event' }>
export type BrokerActivityCatchupComplete = Extract<BrokerActivityMessage, { readonly _tag: 'CatchupComplete' }>
export type BrokerActivityHeartbeat = Extract<BrokerActivityMessage, { readonly _tag: 'Heartbeat' }>

const ActivityHeaderSchema = Schema.fromJsonString(
  Schema.Struct({
    event_id: ActivityEventIdSchema,
    ref_id: ActivityReferenceSchema,
    previous_id: Schema.optionalKey(ActivityReferenceSchema),
    activity_type: StrictNonEmptyStringSchema.check(Schema.isMaxLength(32)),
    account_id: Schema.optionalKey(StrictNonEmptyStringSchema),
  }),
)

export enum BrokerActivityRejection {
  Envelope = 'envelope',
  Signature = 'signature',
  Message = 'message',
  Account = 'account',
  Credential = 'credential',
  Clock = 'clock',
  Source = 'source',
  Identity = 'event-identity',
}

export class BrokerActivityError extends Data.TaggedError('BrokerActivityError')<{
  readonly reason: BrokerActivityRejection
  readonly cause?: unknown
}> {}

const reject = (reason: BrokerActivityRejection, cause?: unknown) =>
  Result.fail(new BrokerActivityError({ reason, ...(cause === undefined ? {} : { cause }) }))

export const verifyBrokerActivity = (
  candidate: unknown,
  connection: Pick<BrokerConnection, 'identity' | 'key' | 'secret'>,
  nowMs: number,
): Result.Result<BrokerActivityMessage, BrokerActivityError> => {
  const signed = Schema.decodeUnknownResult(SignedBrokerActivitySchema, strictParseOptions)(candidate)
  if (Result.isFailure(signed)) return reject(BrokerActivityRejection.Envelope, signed.failure)
  const { message, signature } = signed.success
  const expectedSignature = createHmac('sha256', Redacted.value(connection.secret))
    .update(`${brokerActivityVersion}\n${message}`)
    .digest()
  if (!timingSafeEqual(expectedSignature, Buffer.from(signature, 'hex')))
    return reject(BrokerActivityRejection.Signature)
  const decoded = Schema.decodeUnknownResult(
    Schema.fromJsonString(BrokerActivityMessageSchema),
    strictParseOptions,
  )(message)
  if (Result.isFailure(decoded)) return reject(BrokerActivityRejection.Message, decoded.failure)
  const activity = decoded.success
  const { session } = activity
  if (
    session.accountId !== connection.identity.accountId ||
    session.environment !== connection.identity.environment ||
    session.identityHash !== connection.identity.identityHash
  )
    return reject(BrokerActivityRejection.Account)
  if (session.credentialHash !== sha256(Redacted.value(connection.key)))
    return reject(BrokerActivityRejection.Credential)
  const verifiedAt = Date.parse(session.verifiedAt)
  const connectedAt = Date.parse(session.connectedAt)
  const receivedAt = Date.parse(activity.receivedAt)
  const coveredThrough = activity._tag === 'CatchupComplete' ? Date.parse(activity.coveredThrough) : undefined
  if (
    verifiedAt > connectedAt ||
    connectedAt > receivedAt ||
    receivedAt > nowMs + 5_000 ||
    (coveredThrough !== undefined && (verifiedAt > coveredThrough || coveredThrough > connectedAt))
  )
    return reject(BrokerActivityRejection.Clock)
  if (activity._tag === 'Event') {
    const header = Schema.decodeUnknownResult(ActivityHeaderSchema)(activity.activityJson)
    if (Result.isFailure(header)) return reject(BrokerActivityRejection.Source, header.failure)
    if (
      header.success.event_id !== activity.sourceEventId ||
      header.success.ref_id !== activity.refId ||
      header.success.previous_id !== activity.previousRefId ||
      header.success.activity_type !== activity.activityType ||
      (header.success.account_id !== undefined && header.success.account_id !== session.accountId) ||
      sha256(activity.activityJson) !== activity.contentHash
    )
      return reject(BrokerActivityRejection.Source)
  }
  const identity =
    activity._tag === 'Event'
      ? `${session.identityHash}\nactivity\n${activity.sourceEventId}\n${activity.contentHash}`
      : activity._tag === 'CatchupComplete'
        ? `${session.identityHash}\nactivity-catchup\n${session.sessionId}\n${activity.cursor ?? 'empty'}\n${activity.coveredThrough}\n${activity.receivedAt}`
        : `${session.identityHash}\nactivity-heartbeat\n${session.sessionId}\n${activity.cursor ?? 'empty'}\n${activity.receivedAt}`
  const expectedId = sha256(identity)
  return activity.eventId === expectedId ? Result.succeed(activity) : reject(BrokerActivityRejection.Identity)
}

const easternClock = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

export const fillActivityIdentity = (executionId: string, executedAt: string) => {
  const wholeSecond = Date.parse(`${executedAt.slice(0, 19)}Z`)
  const nanoseconds = Number(executedAt.slice(20, -1).padEnd(9, '0'))
  const microseconds = Math.floor(nanoseconds / 1000)
  const remainder = nanoseconds % 1000
  const rounded = microseconds + Number(remainder > 500 || (remainder === 500 && microseconds % 2 === 1))
  const eastern = easternClock.format(wholeSecond).replace(/\D/g, '')
  const milliseconds = String(Math.floor(nanoseconds / 1_000_000)).padStart(3, '0')
  const transactionTime =
    new Date(wholeSecond + Math.floor(rounded / 1000)).toISOString().slice(0, -1) +
    String(rounded % 1000).padStart(3, '0') +
    '000Z'
  return { activityId: `${eastern}${milliseconds}::${executionId}`, transactionTime }
}

export const FillActivitySchema = Schema.Struct({
  accountId: StrictNonEmptyStringSchema,
  activityId: StrictNonEmptyStringSchema,
  cumulativeQuantityAtoms: Schema.String,
  leavesQuantityAtoms: Schema.String,
  priceAtoms: Schema.String,
  quantityAtoms: Schema.String,
  side: Schema.Enum(OrderSide),
  symbol: SymbolSchema,
  transactionTime: UtcOrderTimestampSchema,
  brokerOrderId: ActivityReferenceSchema,
  type: Schema.Enum(TradeActivityType),
  orderStatus: Schema.optionalKey(Schema.Enum(OrderStatus)),
})

export type BrokerActivityProjection =
  | {
      readonly _tag: 'Fill'
      readonly refId: string
      readonly previousRefId?: string
      readonly fill: FillActivity
    }
  | { readonly _tag: 'Fee'; readonly refId: string; readonly previousRefId?: string; readonly feeKey: string }
  | {
      readonly _tag: 'Bust'
      readonly refId: string
      readonly previousRefId: string
      readonly target: 'FILL'
    }
  | {
      readonly _tag: 'CanonicalOnly'
      readonly refId: string
      readonly previousRefId?: string
      readonly reason: 'OUTSIDE_FILL_FEE_VIEW'
    }
  | { readonly _tag: 'ReconcileRequired'; readonly refId: string; readonly reason: 'UNSUPPORTED_ACTIVITY' }

export const projectBrokerActivity = (event: BrokerActivityEvent): BrokerActivityProjection => {
  const raw = JSON.parse(event.activityJson) as unknown
  if (event.activityType === 'TRD') {
    const decoded = decodeTradeActivityEffect(raw, event.session.accountId)
    if (Result.isFailure(decoded))
      return { _tag: 'ReconcileRequired', refId: event.refId, reason: 'UNSUPPORTED_ACTIVITY' }
    if (decoded.success._tag === 'Bust') return { ...decoded.success, target: 'FILL' }
    const { executionId, ...execution } = decoded.success.execution
    return {
      _tag: 'Fill',
      refId: decoded.success.refId,
      ...(decoded.success.previousRefId === undefined ? {} : { previousRefId: decoded.success.previousRefId }),
      fill: { ...execution, ...fillActivityIdentity(executionId, execution.transactionTime) },
    }
  }
  if (event.activityType === 'FEE' || event.activityType === 'CFEE') {
    const decoded = decodeFeeActivityEffect(raw)
    return Result.isFailure(decoded)
      ? { _tag: 'ReconcileRequired', refId: event.refId, reason: 'UNSUPPORTED_ACTIVITY' }
      : {
          _tag: 'Fee',
          refId: decoded.success.refId,
          ...(decoded.success.previousRefId === undefined ? {} : { previousRefId: decoded.success.previousRefId }),
          feeKey: decoded.success.key,
        }
  }
  if (canonicalOnlyActivityTypes.has(event.activityType))
    return {
      _tag: 'CanonicalOnly',
      refId: event.refId,
      ...(event.previousRefId === undefined ? {} : { previousRefId: event.previousRefId }),
      reason: 'OUTSIDE_FILL_FEE_VIEW',
    }
  return { _tag: 'ReconcileRequired', refId: event.refId, reason: 'UNSUPPORTED_ACTIVITY' }
}

export interface AccountActivityCut {
  readonly version: string
  readonly feeVersion: string
  readonly fills: readonly Observed<FillActivity>[]
  readonly feeCounts: ReadonlyMap<string, number>
  readonly evidence: ReadEvidence
}

export interface BrokerActivityCursorState {
  readonly cursor: string | null
  readonly caughtUp: boolean
  readonly coveredThrough: string | null
  readonly fillFeeComplete: boolean
  readonly sourceRevision: string
}

export interface BrokerActivityHeartbeatReceipt extends BrokerActivityCursorState {
  readonly activated: boolean
}

export interface BrokerActivityReceipt extends BrokerActivityCursorState {
  readonly accepted: true
  readonly eventId: string
  readonly replayed: boolean
  readonly projection: BrokerActivityProjection['_tag'] | 'Duplicate'
  readonly projectionContract: typeof brokerActivityProjectionContract
}

export interface BrokerActivityCursorDecisionState {
  readonly cursor: string | null
  readonly caughtUp: boolean
  readonly coveredThrough: string | null
  readonly fillFeeComplete: boolean
  readonly sessionId: string | null
  readonly requestId: string | null
}

export enum BrokerActivityCursorRejection {
  Replay = 'REPLAY_CONFLICT',
  CatchupCursor = 'CATCHUP_CURSOR_MISMATCH',
  CatchupBoundary = 'CATCHUP_BOUNDARY_CONFLICT',
  Heartbeat = 'HEARTBEAT_WITHOUT_CATCHUP',
}

export type BrokerActivityEventDecision =
  | { readonly _tag: 'Replay' }
  | { readonly _tag: 'Append'; readonly fillFeeComplete: boolean; readonly preserveHeartbeat: boolean }

export const decideBrokerActivityEvent = (
  current: BrokerActivityCursorDecisionState,
  event: {
    readonly sourceEventId: string
    readonly contentHash: string
    readonly session: { readonly sessionId: string; readonly requestId: string }
  },
  retainedContentHash: string | undefined,
  projectionSupported: boolean,
): Result.Result<BrokerActivityEventDecision, BrokerActivityCursorRejection> => {
  if (current.cursor !== null && event.sourceEventId <= current.cursor)
    return retainedContentHash === event.contentHash
      ? Result.succeed({ _tag: 'Replay' })
      : Result.fail(BrokerActivityCursorRejection.Replay)
  return Result.succeed({
    _tag: 'Append',
    fillFeeComplete: current.fillFeeComplete && projectionSupported,
    preserveHeartbeat: current.sessionId === event.session.sessionId && current.requestId === event.session.requestId,
  })
}

export const decideBrokerActivityCatchup = (
  current: BrokerActivityCursorDecisionState,
  boundary: Pick<BrokerActivityCatchupComplete, 'cursor' | 'coveredThrough'>,
): Result.Result<{ readonly caughtUp: true; readonly coveredThrough: string }, BrokerActivityCursorRejection> => {
  if (current.cursor !== boundary.cursor) return Result.fail(BrokerActivityCursorRejection.CatchupCursor)
  if (current.caughtUp && current.coveredThrough !== boundary.coveredThrough)
    return Result.fail(BrokerActivityCursorRejection.CatchupBoundary)
  return Result.succeed({ caughtUp: true, coveredThrough: boundary.coveredThrough })
}

export const decideBrokerActivityHeartbeat = (
  current: BrokerActivityCursorDecisionState,
  heartbeat: {
    readonly cursor: string | null
    readonly session: { readonly sessionId: string; readonly requestId: string }
  },
): Result.Result<{ readonly activated: boolean }, BrokerActivityCursorRejection> => {
  if (!current.caughtUp || current.cursor !== heartbeat.cursor)
    return Result.fail(BrokerActivityCursorRejection.Heartbeat)
  return Result.succeed({
    activated: current.sessionId !== heartbeat.session.sessionId || current.requestId !== heartbeat.session.requestId,
  })
}

export type BrokerActivityReadableCursorState = BrokerActivityCursorDecisionState & {
  readonly sourceRevision: string
  readonly fresh: boolean
}

export type BrokerActivityReadyCursorState = Omit<
  BrokerActivityReadableCursorState,
  'caughtUp' | 'fillFeeComplete' | 'sessionId' | 'requestId' | 'fresh'
> & {
  readonly caughtUp: true
  readonly fillFeeComplete: true
  readonly sessionId: string
  readonly requestId: string
  readonly fresh: true
}

export const brokerActivityCursorIsReady = (
  current: BrokerActivityReadableCursorState,
  sourceRevision: string,
): current is BrokerActivityReadyCursorState =>
  current.sourceRevision === sourceRevision &&
  current.caughtUp &&
  current.fillFeeComplete &&
  current.sessionId !== null &&
  current.requestId !== null &&
  current.fresh

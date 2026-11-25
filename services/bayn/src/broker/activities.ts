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
  NonNegativeIntegerSchema,
  Sha256Schema,
  StrictNonEmptyStringSchema,
  SymbolSchema,
  UtcInstantSchema,
  UtcOrderTimestampSchema,
  strictParseOptions,
} from '../schemas'

export const brokerActivityVersion = 'bayn.broker-activity.v2'
export const brokerActivityProjectionContract = 'bayn.broker-activity-projection.v2'
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
    replayFromId: ActivityEventIdSchema,
    replayUntilId: ActivityEventIdSchema,
    eventCount: NonNegativeIntegerSchema,
    prefixHash: Sha256Schema,
    rangeRequestHash: Sha256Schema,
    completionHash: Sha256Schema,
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

export interface BrokerActivityPrefixEvidence {
  readonly eventCount: number
  readonly prefixHash: string
}

export const brokerActivityPrefixEvidence = (
  events: readonly { readonly sourceEventId: string; readonly sourceEventHash: string }[],
): BrokerActivityPrefixEvidence => ({
  eventCount: events.length,
  prefixHash: sha256(
    events.map(({ sourceEventId, sourceEventHash }) => `${sourceEventId}\n${sourceEventHash}`).join('\n\n'),
  ),
})

export const brokerActivityRangeRequestHash = (input: {
  readonly identityHash: string
  readonly sessionId: string
  readonly requestId: string
  readonly replayFromId: string
  readonly replayUntilId: string
}) =>
  sha256(`${input.identityHash}\n${input.sessionId}\n${input.requestId}\n${input.replayFromId}\n${input.replayUntilId}`)

export const brokerActivityCompletionHash = (input: {
  readonly rangeRequestHash: string
  readonly cursor: string | null
  readonly eventCount: number
  readonly prefixHash: string
}) =>
  sha256(`${input.rangeRequestHash}\n${input.cursor ?? 'empty'}\n${input.eventCount}\n${input.prefixHash}\nclean-eof`)

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
  if (verifiedAt > connectedAt || connectedAt > receivedAt || receivedAt > nowMs + 5_000)
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
        ? `${session.identityHash}\nactivity-catchup\n${session.sessionId}\n${activity.cursor ?? 'empty'}\n${activity.replayFromId}\n${activity.replayUntilId}\n${activity.eventCount}\n${activity.prefixHash}\n${activity.rangeRequestHash}\n${activity.completionHash}\n${activity.receivedAt}`
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
  readonly replayFromId: string | null
  readonly replayUntilId: string | null
  readonly completionHash: string | null
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

export type BrokerActivityPersistenceResult<A> =
  | { readonly _tag: 'Accepted'; readonly receipt: A }
  | { readonly _tag: 'RetiredRevision'; readonly activeSourceRevision: string | null }

export type BrokerActivityRecordResult =
  | BrokerActivityPersistenceResult<BrokerActivityReceipt>
  | { readonly _tag: 'SourceConflict'; readonly eventId: string }
  | { readonly _tag: 'CoverageConflict'; readonly eventId: string }

export type BrokerActivityCatchupResult =
  | BrokerActivityPersistenceResult<BrokerActivityCursorState>
  | { readonly _tag: 'CoverageConflict'; readonly eventId: string }

export interface BrokerActivityCursorDecisionState {
  readonly cursor: string | null
  readonly caughtUp: boolean
  readonly replayFromId: string | null
  readonly replayUntilId: string | null
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
  | {
      readonly _tag: 'Append'
      readonly fillFeeComplete: boolean
      readonly invalidatesCoverage: boolean
      readonly preserveHeartbeat: boolean
    }

export const decideBrokerActivityEvent = (
  current: BrokerActivityCursorDecisionState,
  event: {
    readonly sourceEventId: string
    readonly contentHash: string
    readonly session: { readonly sessionId: string; readonly requestId: string }
  },
  retained: { readonly sourceEventHash: string; readonly equivalentContent: boolean } | undefined,
  projectionSupported: boolean,
): Result.Result<BrokerActivityEventDecision, BrokerActivityCursorRejection> => {
  if (current.cursor !== null && event.sourceEventId <= current.cursor)
    return retained !== undefined && (retained.sourceEventHash === event.contentHash || retained.equivalentContent)
      ? Result.succeed({ _tag: 'Replay' })
      : Result.fail(BrokerActivityCursorRejection.Replay)
  const invalidatesCoverage =
    current.caughtUp &&
    current.replayFromId !== null &&
    current.replayUntilId !== null &&
    event.sourceEventId >= current.replayFromId &&
    event.sourceEventId <= current.replayUntilId
  return Result.succeed({
    _tag: 'Append',
    fillFeeComplete: current.fillFeeComplete && projectionSupported,
    invalidatesCoverage,
    preserveHeartbeat:
      !invalidatesCoverage &&
      current.sessionId === event.session.sessionId &&
      current.requestId === event.session.requestId,
  })
}

export const decideBrokerActivityCatchup = (
  current: BrokerActivityCursorDecisionState,
  boundary: Pick<BrokerActivityCatchupComplete, 'cursor' | 'replayFromId' | 'replayUntilId'>,
  evidenceMatches: boolean,
): Result.Result<
  { readonly caughtUp: true; readonly replayFromId: string; readonly replayUntilId: string },
  BrokerActivityCursorRejection
> => {
  if (current.cursor !== boundary.cursor) return Result.fail(BrokerActivityCursorRejection.CatchupCursor)
  if (
    !evidenceMatches ||
    boundary.replayFromId > boundary.replayUntilId ||
    (boundary.cursor !== null &&
      (boundary.cursor < boundary.replayFromId || boundary.cursor > boundary.replayUntilId)) ||
    (current.caughtUp &&
      (current.replayFromId !== boundary.replayFromId || current.replayUntilId !== boundary.replayUntilId))
  )
    return Result.fail(BrokerActivityCursorRejection.CatchupBoundary)
  return Result.succeed({
    caughtUp: true,
    replayFromId: boundary.replayFromId,
    replayUntilId: boundary.replayUntilId,
  })
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

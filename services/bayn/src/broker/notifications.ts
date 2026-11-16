import { createHmac, timingSafeEqual } from 'node:crypto'

import { Data, Redacted, Result, Schema } from 'effect'

import type { BrokerConnection } from './connection'
import { BrokerEnvironment } from './identity'
import { sha256 } from '../hash'
import {
  GitSourceRevisionSchema,
  Sha256Schema,
  StrictNonEmptyStringSchema,
  UtcInstantSchema,
  strictParseOptions,
} from '../schemas'

export const brokerNotificationVersion = 'bayn.broker-notification.v1'
const maximumMessageLength = 262_144

export const SignedBrokerNotificationSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.signed-broker-notification.v1'),
  message: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximumMessageLength)),
  signature: Sha256Schema,
})

const SessionSchema = Schema.Struct({
  identityHash: Sha256Schema,
  accountId: StrictNonEmptyStringSchema,
  environment: Schema.Literal(BrokerEnvironment.Sandbox),
  credentialHash: Sha256Schema,
  sessionId: StrictNonEmptyStringSchema.check(Schema.isMaxLength(100)),
  sourceRevision: GitSourceRevisionSchema,
  verifiedAt: UtcInstantSchema,
  authenticatedAt: UtcInstantSchema,
  subscribedAt: UtcInstantSchema,
})
const common = {
  schemaVersion: Schema.Literal(brokerNotificationVersion),
  eventId: Sha256Schema,
  session: SessionSchema,
  receivedAt: UtcInstantSchema,
}
export const BrokerNotificationSchema = Schema.TaggedUnion({
  SessionReady: common,
  TradeUpdate: {
    ...common,
    frameJson: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximumMessageLength)),
  },
})
export type BrokerNotification = typeof BrokerNotificationSchema.Type

const FrameSchema = Schema.fromJsonString(
  Schema.Struct({ stream: Schema.Literal('trade_updates'), data: Schema.Record(Schema.String, Schema.Unknown) }),
)

export enum BrokerNotificationRejection {
  Envelope = 'envelope',
  Signature = 'signature',
  Message = 'message',
  Account = 'account',
  Credential = 'credential',
  Clock = 'clock',
  Identity = 'event-identity',
  Frame = 'frame',
}

export class BrokerNotificationError extends Data.TaggedError('BrokerNotificationError')<{
  readonly reason: BrokerNotificationRejection
  readonly cause?: unknown
}> {}

const reject = (reason: BrokerNotificationRejection, cause?: unknown) =>
  Result.fail(new BrokerNotificationError({ reason, ...(cause === undefined ? {} : { cause }) }))

export const verifyBrokerNotification = (
  candidate: unknown,
  connection: Pick<BrokerConnection, 'identity' | 'key' | 'secret'>,
  nowMs: number,
): Result.Result<BrokerNotification, BrokerNotificationError> => {
  const signed = Schema.decodeUnknownResult(SignedBrokerNotificationSchema, strictParseOptions)(candidate)
  if (Result.isFailure(signed)) return reject(BrokerNotificationRejection.Envelope, signed.failure)
  const { message, signature } = signed.success
  const expectedSignature = createHmac('sha256', Redacted.value(connection.secret))
    .update(`${brokerNotificationVersion}\n${message}`)
    .digest()
  if (!timingSafeEqual(expectedSignature, Buffer.from(signature, 'hex')))
    return reject(BrokerNotificationRejection.Signature)
  const decoded = Schema.decodeUnknownResult(
    Schema.fromJsonString(BrokerNotificationSchema),
    strictParseOptions,
  )(message)
  if (Result.isFailure(decoded)) return reject(BrokerNotificationRejection.Message, decoded.failure)
  const notification = decoded.success
  const { session } = notification
  if (
    session.accountId !== connection.identity.accountId ||
    session.environment !== connection.identity.environment ||
    session.identityHash !== connection.identity.identityHash
  )
    return reject(BrokerNotificationRejection.Account)
  if (session.credentialHash !== sha256(Redacted.value(connection.key)))
    return reject(BrokerNotificationRejection.Credential)
  const verifiedAt = Date.parse(session.verifiedAt)
  const authenticatedAt = Date.parse(session.authenticatedAt)
  const subscribedAt = Date.parse(session.subscribedAt)
  const receivedAt = Date.parse(notification.receivedAt)
  if (
    verifiedAt > authenticatedAt ||
    authenticatedAt > subscribedAt ||
    subscribedAt > receivedAt ||
    receivedAt > nowMs + 5_000
  )
    return reject(BrokerNotificationRejection.Clock)
  const expectedId = sha256(
    notification._tag === 'SessionReady'
      ? `${session.identityHash}\n${session.sessionId}\nready`
      : `${session.identityHash}\n${notification.frameJson}`,
  )
  if (notification.eventId !== expectedId) return reject(BrokerNotificationRejection.Identity)
  if (notification._tag === 'TradeUpdate') {
    const frame = Schema.decodeUnknownResult(FrameSchema)(notification.frameJson)
    if (Result.isFailure(frame)) return reject(BrokerNotificationRejection.Frame, frame.failure)
  }
  return Result.succeed(notification)
}

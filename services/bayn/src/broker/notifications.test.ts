import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { Redacted, Result, Schema } from 'effect'

import { makeBrokerIdentity, BrokerEnvironment, BrokerProvider } from './identity'
import {
  BrokerNotificationSchema,
  BrokerNotificationRejection,
  SignedBrokerNotificationSchema,
  brokerNotificationVersion,
  verifyBrokerNotification,
  type BrokerNotification,
} from './notifications'
import { sha256 } from '../hash'

const FixtureSchema = Schema.Struct({
  description: Schema.String,
  accountId: Schema.String,
  keyId: Schema.String,
  secret: Schema.String,
  key: Schema.String,
  notification: SignedBrokerNotificationSchema,
})
const fixture = Result.getOrThrow(
  Schema.decodeUnknownResult(Schema.fromJsonString(FixtureSchema))(
    readFileSync(new URL('../../../dorvud/fixtures/bayn-broker-notification-v1.json', import.meta.url), 'utf8'),
  ),
)
const identity = Result.getOrThrow(
  makeBrokerIdentity({
    schemaVersion: 'bayn.broker-identity.v2',
    provider: BrokerProvider.Alpaca,
    environment: BrokerEnvironment.Sandbox,
    accountId: fixture.accountId,
  }),
)
const connection = { identity, key: Redacted.make(fixture.keyId), secret: Redacted.make(fixture.secret) }
const now = Date.parse('2026-11-11T17:37:20.000Z')
const notification = Result.getOrThrow(
  Schema.decodeUnknownResult(Schema.fromJsonString(BrokerNotificationSchema))(fixture.notification.message),
)

const sign = (value: BrokerNotification) => {
  const message = JSON.stringify(value)
  return {
    schemaVersion: 'bayn.signed-broker-notification.v1',
    message,
    signature: createHmac('sha256', fixture.secret).update(`${brokerNotificationVersion}\n${message}`).digest('hex'),
  }
}

describe('authenticated Dorvud broker notifications', () => {
  test('accepts the shared Kotlin/TypeScript vector with the existing broker identity and original precision', () => {
    expect(identity.identityHash).toBe(fixture.key)
    const result = Result.getOrThrow(verifyBrokerNotification(fixture.notification, connection, now))
    expect(result).toEqual(notification)
    expect(result._tag === 'TradeUpdate' && result.frameJson).toContain('2026-11-11T17:37:18.784802123Z')
    expect(result._tag === 'TradeUpdate' && result.frameJson).toContain('123.450000')
    expect(result.receivedAt).toBe('2026-11-11T17:37:19.003Z')
  })

  test('rejects untrusted labels and unsigned or malformed input before it can wake the account', () => {
    for (const candidate of [null, {}, notification, { ...fixture.notification, signature: 'f'.repeat(64) }]) {
      expect(Result.isFailure(verifyBrokerNotification(candidate, connection, now))).toBe(true)
    }
  })

  test('retains signed provider JSON whitespace without changing its identity or precision', () => {
    if (notification._tag !== 'TradeUpdate') throw new Error('fixture must be an update')
    const frameJson = `\n ${notification.frameJson}\r\n`
    const candidate = { ...notification, frameJson, eventId: sha256(`${identity.identityHash}\n${frameJson}`) }
    const result = Result.getOrThrow(verifyBrokerNotification(sign(candidate), connection, now))
    expect(result).toEqual(candidate)
    expect(result._tag === 'TradeUpdate' && result.frameJson).toBe(frameJson)
    expect(result.eventId === notification.eventId).toBe(false)
  })

  test('rejects tampered bytes and a valid signature for another secret', () => {
    expect(
      verifyBrokerNotification(
        { ...fixture.notification, message: fixture.notification.message + ' ' },
        connection,
        now,
      ),
    ).toMatchObject({ _tag: 'Failure', failure: { reason: BrokerNotificationRejection.Signature } })
    expect(
      verifyBrokerNotification(fixture.notification, { ...connection, secret: Redacted.make('another-secret') }, now),
    ).toMatchObject({ _tag: 'Failure', failure: { reason: BrokerNotificationRejection.Signature } })
  })

  test('rejects a signed notification for another account or environment', () => {
    const otherAccount = { ...notification, session: { ...notification.session, accountId: 'another-account' } }
    expect(verifyBrokerNotification(sign(otherAccount), connection, now)).toMatchObject({
      _tag: 'Failure',
      failure: { reason: BrokerNotificationRejection.Account },
    })
    const otherEnvironment = { ...notification, session: { ...notification.session, environment: 'live' } }
    const message = JSON.stringify(otherEnvironment)
    const candidate = {
      ...fixture.notification,
      message,
      signature: createHmac('sha256', fixture.secret).update(`${brokerNotificationVersion}\n${message}`).digest('hex'),
    }
    expect(Result.isFailure(verifyBrokerNotification(candidate, connection, now))).toBe(true)
  })

  test('binds the session to the exact currently configured credential identity', () => {
    const candidate = sign({
      ...notification,
      session: { ...notification.session, credentialHash: sha256('another-key') },
    })
    expect(verifyBrokerNotification(candidate, connection, now)).toMatchObject({
      _tag: 'Failure',
      failure: { reason: BrokerNotificationRejection.Credential },
    })
  })

  test('rejects subscription before authentication, verification after authentication and future receipt', () => {
    const candidates = [
      { ...notification, session: { ...notification.session, verifiedAt: '2026-11-11T17:37:19.002Z' } },
      { ...notification, session: { ...notification.session, subscribedAt: '2026-11-11T17:37:19.000Z' } },
      { ...notification, receivedAt: '2026-11-11T17:37:26.000Z' },
    ]
    for (const candidate of candidates)
      expect(verifyBrokerNotification(sign(candidate), connection, now)).toMatchObject({
        _tag: 'Failure',
        failure: { reason: BrokerNotificationRejection.Clock },
      })
  })

  test('replay retains original receipt time instead of becoming a fresh financial observation', () => {
    const result = Result.getOrThrow(verifyBrokerNotification(fixture.notification, connection, now + 86_400_000))
    expect(result.receivedAt).toBe(notification.receivedAt)
    expect(result.session).toEqual(notification.session)
    expect(result.eventId).toBe(notification.eventId)
  })

  test('checks source content under reused event identity', () => {
    if (notification._tag !== 'TradeUpdate') throw new Error('fixture must be an update')
    const candidate = sign({ ...notification, frameJson: notification.frameJson.replace('123.450000', '124.000000') })
    expect(verifyBrokerNotification(candidate, connection, now)).toMatchObject({
      _tag: 'Failure',
      failure: { reason: BrokerNotificationRejection.Identity },
    })
  })

  test('session readiness has a separate session-bound identity and never fabricates a fill', () => {
    const ready: BrokerNotification = {
      _tag: 'SessionReady',
      schemaVersion: brokerNotificationVersion,
      eventId: sha256(`${identity.identityHash}\n${notification.session.sessionId}\nready`),
      session: notification.session,
      receivedAt: notification.receivedAt,
    }
    expect(Result.getOrThrow(verifyBrokerNotification(sign(ready), connection, now))).toEqual(ready)
    expect(
      Result.isFailure(verifyBrokerNotification(sign({ ...ready, eventId: notification.eventId }), connection, now)),
    ).toBe(true)
  })

  test('rejects a signed payload that is not a provider trade-update frame', () => {
    if (notification._tag !== 'TradeUpdate') throw new Error('fixture must be an update')
    for (const frameJson of ['{}', '{"stream":"other","data":{}}', '{"stream":"trade_updates","data":null}']) {
      const candidate = { ...notification, frameJson, eventId: sha256(`${identity.identityHash}\n${frameJson}`) }
      expect(verifyBrokerNotification(sign(candidate), connection, now)).toMatchObject({
        _tag: 'Failure',
        failure: { reason: BrokerNotificationRejection.Frame },
      })
    }
  })
})

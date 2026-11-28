import { createHmac } from 'node:crypto'

import { describe, expect, test } from 'bun:test'
import { Redacted, Result } from 'effect'

import {
  brokerActivityVersion,
  brokerActivityCompletionHash,
  brokerActivityRangeRequestHash,
  projectBrokerActivity,
  verifyBrokerActivity,
  type BrokerActivityEvent,
  type BrokerActivityMessage,
} from './activities'
import { decodeBrokerConnection } from './connection'
import { BrokerEnvironment, BrokerProvider } from './identity'
import { sha256 } from '../hash'

const accountId = '00000000-0000-4000-8000-000000000001'
const secret = 'test-secret'
const connection = Result.getOrThrow(
  decodeBrokerConnection({
    provider: BrokerProvider.Alpaca,
    environment: BrokerEnvironment.Sandbox,
    baseUrl: 'https://paper-api.alpaca.markets',
    expectedAccountId: accountId,
    key: Redacted.make('test-key'),
    secret: Redacted.make(secret),
    proxyUrl: 'http://bayn-egress-proxy:3128',
    operationTimeoutMs: 1_000,
    retryAttempts: 0,
  }),
)
const identityHash = connection.identity.identityHash
const at = '2026-11-21T16:00:00.000Z'
const session = {
  identityHash,
  accountId,
  environment: BrokerEnvironment.Sandbox,
  credentialHash: sha256('test-key'),
  sessionId: 'activity-session',
  sourceRevision: 'a'.repeat(40),
  verifiedAt: at,
  connectedAt: at,
  requestId: 'activity-request',
} as const
const cursor = (value: number) => value.toString().padStart(26, '0')
const ref = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`

const event = (
  raw: Record<string, unknown> & { event_id: string; ref_id: string; previous_id?: string; activity_type: string },
): BrokerActivityEvent => {
  const activityJson = JSON.stringify(raw)
  const contentHash = sha256(activityJson)
  const sourceEventId = raw.event_id
  return {
    _tag: 'Event',
    schemaVersion: brokerActivityVersion,
    eventId: sha256(`${identityHash}\nactivity\n${sourceEventId}\n${contentHash}`),
    session,
    receivedAt: at,
    sourceEventId,
    contentHash,
    refId: raw.ref_id,
    ...(raw.previous_id === undefined ? {} : { previousRefId: raw.previous_id }),
    activityType: raw.activity_type,
    activityJson,
  }
}
const signed = (message: BrokerActivityMessage) => {
  const encoded = JSON.stringify(message)
  return {
    schemaVersion: 'bayn.signed-broker-activity.v1',
    message: encoded,
    signature: createHmac('sha256', secret).update(`${brokerActivityVersion}\n${encoded}`).digest('hex'),
  }
}
const trade = (
  source: number,
  reference: number,
  executionType: 'fill' | 'trade_correct' | 'trade_bust',
  previous?: number,
) =>
  event({
    activity_type: 'TRD',
    event_id: cursor(source),
    ref_id: ref(reference),
    ...(previous === undefined ? {} : { previous_id: ref(previous) }),
    account_id: accountId,
    executed_at: '2026-11-21T16:00:00.123456789Z',
    price: '100.25',
    qty: '1',
    details: {
      order_id: ref(99),
      cum_qty: '1',
      leaves_qty: '0',
      symbol: 'AAPL',
      side: 'buy',
      execution_type: executionType,
      order_status: 'filled',
    },
  })

describe('durable broker activities', () => {
  test('verifies the signed exact source and preserves ordinary fill identity', () => {
    const activity = trade(1, 1, 'fill')
    expect(verifyBrokerActivity(signed(activity), connection, Date.parse(at))).toEqual(Result.succeed(activity))
    expect(projectBrokerActivity(activity)).toMatchObject({
      _tag: 'Fill',
      refId: ref(1),
      fill: {
        activityId: `20261121110000123::${ref(1)}`,
        transactionTime: '2026-11-21T16:00:00.123457000Z',
        brokerOrderId: ref(99),
        quantityAtoms: '1000000000',
      },
    })
  })

  test('models corrections as a replacement and busts as a pure reversal', () => {
    expect(projectBrokerActivity(trade(2, 2, 'trade_correct', 1))).toMatchObject({
      _tag: 'Fill',
      refId: ref(2),
      previousRefId: ref(1),
    })
    expect(projectBrokerActivity(trade(3, 3, 'trade_bust', 2))).toEqual({
      _tag: 'Bust',
      refId: ref(3),
      previousRefId: ref(2),
      target: 'FILL',
    })
  })

  test('retains fee corrections and rejects a changed signed source', () => {
    const fee = event({
      activity_type: 'FEE',
      event_id: cursor(4),
      ref_id: ref(4),
      previous_id: ref(3),
      account_id: accountId,
      status: 'executed',
      currency: 'USD',
      net_amount: '-0.02',
      details: { system_date: '2026-11-21' },
    })
    expect(projectBrokerActivity(fee)).toEqual({
      _tag: 'Fee',
      refId: ref(4),
      previousRefId: ref(3),
      feeKey: '["FEE","2026-11-21","-20000","0"]',
    })
    expect(
      Result.isFailure(verifyBrokerActivity({ ...signed(fee), signature: '0'.repeat(64) }, connection, Date.parse(at))),
    ).toBe(true)
  })

  test('binds catchup coverage and live heartbeats to the durable cursor', () => {
    const receivedAt = '2026-11-21T16:00:01.000Z'
    const replayFromId = cursor(0)
    const replayUntilId = cursor(9)
    const prefixHash = sha256('publication-prefix')
    const rangeRequestHash = brokerActivityRangeRequestHash({
      identityHash,
      sessionId: session.sessionId,
      requestId: session.requestId,
      replayFromId,
      replayUntilId,
    })
    const completionHash = brokerActivityCompletionHash({
      rangeRequestHash,
      cursor: cursor(4),
      eventCount: 4,
      prefixHash,
    })
    const catchup = {
      _tag: 'CatchupComplete',
      schemaVersion: brokerActivityVersion,
      eventId: sha256(
        `${identityHash}\nactivity-catchup\n${session.sessionId}\n${cursor(4)}\n${replayFromId}\n${replayUntilId}\n4\n${prefixHash}\n${rangeRequestHash}\n${completionHash}\n${receivedAt}`,
      ),
      session,
      receivedAt,
      cursor: cursor(4),
      replayFromId,
      replayUntilId,
      eventCount: 4,
      prefixHash,
      rangeRequestHash,
      completionHash,
    } as const
    expect(verifyBrokerActivity(signed(catchup), connection, Date.parse(receivedAt))).toEqual(Result.succeed(catchup))
    const heartbeat = {
      _tag: 'Heartbeat',
      schemaVersion: brokerActivityVersion,
      eventId: sha256(`${identityHash}\nactivity-heartbeat\n${session.sessionId}\n${cursor(4)}\n${receivedAt}`),
      session,
      receivedAt,
      cursor: cursor(4),
    } as const
    expect(verifyBrokerActivity(signed(heartbeat), connection, Date.parse(receivedAt))).toEqual(
      Result.succeed(heartbeat),
    )
    const changed = { ...catchup, replayFromId: cursor(1) }
    expect(Result.isFailure(verifyBrokerActivity(signed(changed), connection, Date.parse(changed.receivedAt)))).toBe(
      true,
    )
  })

  test('retains documented non-fill activity for canonical account verification and closes on an unknown type', () => {
    const journal = event({
      activity_type: 'JNLC',
      event_id: cursor(5),
      ref_id: ref(5),
      account_id: accountId,
      status: 'executed',
      currency: 'USD',
      net_amount: '12.34',
      details: { system_date: '2026-11-21' },
    })
    expect(projectBrokerActivity(journal)).toEqual({
      _tag: 'CanonicalOnly',
      refId: ref(5),
      reason: 'OUTSIDE_FILL_FEE_VIEW',
    })
    const unknown = event({
      activity_type: 'FUTURE_TYPE',
      event_id: cursor(6),
      ref_id: ref(6),
      account_id: accountId,
      status: 'executed',
      currency: 'USD',
      net_amount: '12.34',
      details: {},
    })
    expect(projectBrokerActivity(unknown)).toEqual({
      _tag: 'ReconcileRequired',
      refId: ref(6),
      reason: 'UNSUPPORTED_ACTIVITY',
    })
  })
})

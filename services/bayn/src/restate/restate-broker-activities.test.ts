import { describe, expect, test } from 'bun:test'
import type { ObjectContext } from '@restatedev/restate-sdk'
import { Result } from 'effect'

import {
  brokerActivityProjectionContract,
  brokerActivityVersion,
  type BrokerActivityCatchupComplete,
  type BrokerActivityEvent,
  type BrokerActivityHeartbeat,
  type BrokerActivityMessage,
  type BrokerActivityRecordResult,
  type BrokerActivityReceipt,
} from '../broker/activities'
import { BrokerEnvironment } from '../broker/identity'
import { makeBaynBrokerActivities, type BrokerActivityRuntime } from './restate-broker-activities'

const controllerKey = 'a'.repeat(64)
const sourceRevision = 'b'.repeat(40)
const at = '2026-11-21T16:00:00.000Z'
const event: BrokerActivityEvent = {
  _tag: 'Event',
  schemaVersion: brokerActivityVersion,
  eventId: 'c'.repeat(64),
  sourceEventId: '00000000000000000000000001',
  contentHash: 'd'.repeat(64),
  refId: '00000000-0000-4000-8000-000000000001',
  activityType: 'TRD',
  activityJson: '{}',
  receivedAt: at,
  session: {
    identityHash: controllerKey,
    accountId: '00000000-0000-4000-8000-000000000002',
    environment: BrokerEnvironment.Sandbox,
    credentialHash: 'e'.repeat(64),
    sessionId: 'activity-session',
    sourceRevision,
    verifiedAt: at,
    connectedAt: at,
    requestId: 'activity-request',
  },
}

type Delivery = { service: string; method: string; idempotencyKey: string; parameter: unknown }

const harness = (
  caughtUp: boolean,
  verified: BrokerActivityMessage = event,
  recordResult?: BrokerActivityRecordResult,
) => {
  const deliveries: Delivery[] = []
  let recordCalls = 0
  const receipt: BrokerActivityReceipt = {
    accepted: true,
    eventId: event.eventId,
    cursor: event.sourceEventId,
    caughtUp,
    replayFromId: caughtUp ? '00000000000000000000000000' : null,
    replayUntilId: caughtUp ? event.sourceEventId : null,
    completionHash: caughtUp ? 'f'.repeat(64) : null,
    fillFeeComplete: true,
    sourceRevision,
    replayed: false,
    projection: 'Fill',
    projectionContract: brokerActivityProjectionContract,
  }
  const runtime: BrokerActivityRuntime = {
    verify: () => Result.succeed(verified),
    cursor: async () => ({
      cursor: null,
      caughtUp: false,
      replayFromId: null,
      replayUntilId: null,
      completionHash: null,
      fillFeeComplete: true,
      sourceRevision,
    }),
    record: async () => {
      recordCalls += 1
      return recordResult ?? { _tag: 'Accepted', receipt }
    },
    completeCatchup: async () => {
      throw new Error('unexpected catchup')
    },
    heartbeat: async () => {
      throw new Error('unexpected heartbeat')
    },
  }
  const object = makeBaynBrokerActivities(
    { controllerKey, sourceRevision, maxAgeMs: 60_000, freshnessLeadMs: 30_000, operationTimeoutMs: 30_000 },
    runtime,
  )
  const ingest = (
    object as unknown as { object: { ingest: (context: ObjectContext, candidate: unknown) => Promise<unknown> } }
  ).object.ingest
  const context = {
    key: controllerKey,
    request: () => ({ attemptCompletedSignal: new AbortController().signal }),
    run: async (_name: string, action: () => Promise<unknown>) => action(),
    genericSend: (delivery: Delivery) => deliveries.push(delivery),
  } as unknown as ObjectContext
  return { context, deliveries, ingest, recordCalls: () => recordCalls }
}

describe('durable broker activity owner', () => {
  test('suppresses historical catchup reconciliation and reconciles the live tail', async () => {
    const historical = harness(false)
    await historical.ingest(historical.context, event)
    expect(historical.deliveries).toEqual([])

    const live = harness(true)
    await live.ingest(live.context, event)
    expect(live.deliveries).toEqual([
      expect.objectContaining({
        service: 'BaynBrokerObservations',
        method: 'reconcile',
        idempotencyKey: `broker-activity-reconcile:${event.eventId}`,
        parameter: { eventId: event.eventId },
      }),
    ])
  })

  test('rejects a journaled predecessor revision before persistence', async () => {
    const predecessor = {
      ...event,
      session: { ...event.session, sourceRevision: 'c'.repeat(40) },
    } satisfies BrokerActivityEvent
    const retired = harness(false, predecessor)
    expect(await retired.ingest(retired.context, predecessor).catch((error: unknown) => error)).toMatchObject({
      message: 'broker activity source revision mismatch',
    })
    expect(retired.recordCalls()).toBe(0)
  })

  test('reconciles and rejects a late publication that contradicts retained coverage', async () => {
    const conflict = harness(false, event, { _tag: 'CoverageConflict', eventId: event.eventId })
    expect(await conflict.ingest(conflict.context, event).catch((error: unknown) => error)).toMatchObject({
      message: 'broker activity contradicts retained publication coverage',
    })
    expect(conflict.deliveries).toEqual([
      expect.objectContaining({
        service: 'BaynBrokerObservations',
        method: 'reconcile',
        idempotencyKey: `broker-activity-reconcile:${event.eventId}`,
        parameter: { eventId: event.eventId },
      }),
    ])
  })

  test('keeps clean range completion separate from liveness and reconciles the first live heartbeat', async () => {
    const replayFromId = '00000000000000000000000000'
    const replayUntilId = '00000000000000000000000009'
    const completionHash = 'f'.repeat(64)
    const catchup: BrokerActivityCatchupComplete = {
      _tag: 'CatchupComplete',
      schemaVersion: brokerActivityVersion,
      eventId: '1'.repeat(64),
      session: event.session,
      receivedAt: at,
      cursor: null,
      replayFromId,
      replayUntilId,
      eventCount: 0,
      prefixHash: '2'.repeat(64),
      rangeRequestHash: '3'.repeat(64),
      completionHash,
    }
    const heartbeat: BrokerActivityHeartbeat = {
      _tag: 'Heartbeat',
      schemaVersion: brokerActivityVersion,
      eventId: '4'.repeat(64),
      session: { ...event.session, sessionId: 'live-session', requestId: 'live-request' },
      receivedAt: at,
      cursor: null,
    }
    const deliveries: Delivery[] = []
    const runtime: BrokerActivityRuntime = {
      verify: (candidate) => Result.succeed(candidate as BrokerActivityMessage),
      cursor: async () => ({
        cursor: null,
        caughtUp: false,
        replayFromId: null,
        replayUntilId: null,
        completionHash: null,
        fillFeeComplete: true,
        sourceRevision,
      }),
      record: async () => {
        throw new Error('unexpected event')
      },
      completeCatchup: async () => ({
        _tag: 'Accepted',
        receipt: {
          cursor: null,
          caughtUp: true,
          replayFromId,
          replayUntilId,
          completionHash,
          fillFeeComplete: true,
          sourceRevision,
        },
      }),
      heartbeat: async () => ({
        _tag: 'Accepted',
        receipt: {
          cursor: null,
          caughtUp: true,
          replayFromId,
          replayUntilId,
          completionHash,
          fillFeeComplete: true,
          sourceRevision,
          activated: true,
        },
      }),
    }
    const object = makeBaynBrokerActivities(
      { controllerKey, sourceRevision, maxAgeMs: 60_000, freshnessLeadMs: 30_000, operationTimeoutMs: 30_000 },
      runtime,
    )
    const handlers = (
      object as unknown as {
        object: {
          catchup: (context: ObjectContext, candidate: unknown) => Promise<unknown>
          heartbeat: (context: ObjectContext, candidate: unknown) => Promise<unknown>
        }
      }
    ).object
    const context = {
      key: controllerKey,
      request: () => ({ attemptCompletedSignal: new AbortController().signal }),
      run: async (_name: string, action: () => Promise<unknown>) => action(),
      genericSend: (delivery: Delivery) => deliveries.push(delivery),
    } as unknown as ObjectContext

    await handlers.catchup(context, catchup)
    expect(deliveries).toEqual([])
    await handlers.heartbeat(context, heartbeat)
    expect(deliveries).toEqual([
      expect.objectContaining({
        service: 'BaynBrokerObservations',
        method: 'reconcile',
        idempotencyKey: `broker-activity-reconcile:${heartbeat.eventId}`,
      }),
    ])
  })
})

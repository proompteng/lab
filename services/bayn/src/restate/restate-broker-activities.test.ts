import { describe, expect, test } from 'bun:test'
import type { ObjectContext } from '@restatedev/restate-sdk'
import { Result } from 'effect'

import {
  brokerActivityProjectionContract,
  brokerActivityVersion,
  type BrokerActivityEvent,
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

const harness = (caughtUp: boolean) => {
  const deliveries: Delivery[] = []
  const receipt: BrokerActivityReceipt = {
    accepted: true,
    eventId: event.eventId,
    cursor: event.sourceEventId,
    caughtUp,
    coveredThrough: caughtUp ? at : null,
    fillFeeComplete: true,
    sourceRevision,
    replayed: false,
    projection: 'Fill',
    projectionContract: brokerActivityProjectionContract,
  }
  const runtime: BrokerActivityRuntime = {
    verify: () => Result.succeed(event),
    cursor: async () => ({
      cursor: null,
      caughtUp: false,
      coveredThrough: null,
      fillFeeComplete: true,
      sourceRevision,
    }),
    record: async () => receipt,
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
  return { context, deliveries, ingest }
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
})

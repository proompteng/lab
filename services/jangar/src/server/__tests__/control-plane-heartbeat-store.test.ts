import { afterEach, describe, expect, it } from 'vitest'

import {
  isHeartbeatFresh,
  resolveControlPlaneHeartbeatIntervalSeconds,
  resolveControlPlaneHeartbeatTtlSeconds,
  resolveControlPlanePodIdentity,
} from '~/server/control-plane-heartbeat-store'

describe('control-plane heartbeat store helpers', () => {
  afterEach(() => {
    delete process.env.JANGAR_CONTROL_PLANE_HEARTBEAT_TTL_SECONDS
    delete process.env.JANGAR_CONTROL_PLANE_HEARTBEAT_INTERVAL_SECONDS
    delete process.env.POD_NAME
    delete process.env.HOSTNAME
    delete process.env.JANGAR_DEPLOYMENT_NAME
    delete process.env.DEPLOYMENT_NAME
    delete process.env.JANGAR_POD_PREFIX
  })

  it('treats heartbeats as fresh only inside the observed/expiry window', () => {
    expect(
      isHeartbeatFresh(
        {
          observed_at: '2026-03-08T12:00:00Z',
          expires_at: '2026-03-08T12:02:00Z',
        },
        new Date('2026-03-08T12:01:00Z'),
      ),
    ).toBe(true)

    expect(
      isHeartbeatFresh(
        {
          observed_at: '2026-03-08T12:00:00Z',
          expires_at: '2026-03-08T12:02:00Z',
        },
        new Date('2026-03-08T12:03:00Z'),
      ),
    ).toBe(false)
  })

  it('uses sane defaults when heartbeat timing env vars are invalid', () => {
    process.env.JANGAR_CONTROL_PLANE_HEARTBEAT_TTL_SECONDS = '0'
    process.env.JANGAR_CONTROL_PLANE_HEARTBEAT_INTERVAL_SECONDS = 'not-a-number'

    expect(resolveControlPlaneHeartbeatTtlSeconds()).toBe(120)
    expect(resolveControlPlaneHeartbeatIntervalSeconds()).toBe(15)
  })

  it('derives pod identity from deployment and pod env vars', () => {
    process.env.POD_NAME = 'agents-controllers-0'
    process.env.JANGAR_DEPLOYMENT_NAME = 'agents-controllers'

    expect(resolveControlPlanePodIdentity()).toEqual({
      podName: 'agents-controllers-0',
      deploymentName: 'agents-controllers',
    })
  })
})

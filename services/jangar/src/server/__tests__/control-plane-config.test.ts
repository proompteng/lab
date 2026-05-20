import { describe, expect, it } from 'vitest'

import {
  resolveControlPlaneCacheReadConfig,
  resolveControlPlaneHeartbeatConfig,
  resolveControlPlaneStatusConfig,
} from '~/server/control-plane-config'

describe('control-plane-config', () => {
  it('normalizes cache and heartbeat settings', () => {
    expect(
      resolveControlPlaneHeartbeatConfig({
        JANGAR_CONTROL_PLANE_CACHE_CLUSTER: 'prod-a',
        JANGAR_CONTROL_PLANE_HEARTBEAT_TTL_SECONDS: '300',
        JANGAR_CONTROL_PLANE_HEARTBEAT_INTERVAL_SECONDS: '20',
        POD_NAME: 'jangar-0',
        JANGAR_DEPLOYMENT_NAME: 'jangar',
        JANGAR_POD_NAMESPACE: 'jangar',
      }),
    ).toEqual({
      clusterId: 'prod-a',
      ttlSeconds: 300,
      intervalSeconds: 20,
      podName: 'jangar-0',
      deploymentName: 'jangar',
      sourceNamespace: 'jangar',
    })
  })

  it('parses Jangar-owned status settings and leaves generic Agents runtime evidence to Agents', () => {
    expect(
      resolveControlPlaneStatusConfig({
        JANGAR_CONTROL_PLANE_EXECUTION_TRUST_SWARMS: 'jangar-control-plane,torghut-quant,jangar-control-plane',
        JANGAR_CONTROL_PLANE_STATUS_CACHE_TTL_MS: '10000',
        JANGAR_CONTROL_PLANE_STATUS_CACHE_MAX_ENTRIES: '64',
        JANGAR_TORGHUT_STATUS_TIMEOUT_MS: '6500',
      }),
    ).toMatchObject({
      executionTrustSwarms: ['jangar-control-plane', 'torghut-quant'],
      statusCacheTtlMs: 10000,
      statusCacheMaxEntries: 64,
      torghutStatusTimeoutMs: 6500,
    })
  })

  it('uses a rollout-safe Torghut status timeout default and bounds overrides', () => {
    expect(resolveControlPlaneStatusConfig({}).torghutStatusTimeoutMs).toBe(15000)
    expect(resolveControlPlaneStatusConfig({ JANGAR_TORGHUT_STATUS_TIMEOUT_MS: '20' }).torghutStatusTimeoutMs).toBe(
      15000,
    )
    expect(resolveControlPlaneStatusConfig({ JANGAR_TORGHUT_STATUS_TIMEOUT_MS: '45000' }).torghutStatusTimeoutMs).toBe(
      30000,
    )
  })

  it('parses cache enablement explicitly', () => {
    expect(resolveControlPlaneCacheReadConfig({ JANGAR_CONTROL_PLANE_CACHE_ENABLED: 'true' }).enabled).toBe(true)
    expect(resolveControlPlaneCacheReadConfig({}).clusterId).toBe('default')
  })
})

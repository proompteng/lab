import { describe, expect, it } from 'vitest'

import {
  resolveControlPlaneCacheReadConfig,
  resolveControlPlaneHeartbeatConfig,
  resolveControlPlaneStatusConfig,
  resolveLeaderElectionSettings,
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

  it('derives leader election requirement and repairs invalid timing', () => {
    const config = resolveLeaderElectionSettings({
      JANGAR_AGENTS_CONTROLLER_ENABLED: 'true',
      JANGAR_LEADER_ELECTION_RENEW_DEADLINE_SECONDS: '30',
      JANGAR_LEADER_ELECTION_RETRY_PERIOD_SECONDS: '30',
      JANGAR_LEADER_ELECTION_LEASE_DURATION_SECONDS: '30',
      JANGAR_POD_NAMESPACE: 'agents',
    })

    expect(config.required).toBe(true)
    expect(config.leaseDurationSeconds).toBe(30)
    expect(config.renewDeadlineSeconds).toBe(20)
    expect(config.retryPeriodSeconds).toBe(5)
    expect(config.podNamespace).toBe('agents')
  })

  it('parses status settings and keeps rollout lists unique', () => {
    expect(
      resolveControlPlaneStatusConfig({
        JANGAR_CONTROL_PLANE_EXECUTION_TRUST_SWARMS: 'jangar-control-plane,torghut-quant,jangar-control-plane',
        JANGAR_CONTROL_PLANE_ROLLOUT_DEPLOYMENTS: 'agents,agents-controllers,agents',
        JANGAR_WORKFLOWS_WINDOW_MINUTES: '45',
      }),
    ).toMatchObject({
      executionTrustSwarms: ['jangar-control-plane', 'torghut-quant'],
      rolloutDeployments: ['agents', 'agents-controllers'],
      workflowsWindowMinutes: 45,
    })
  })

  it('parses cache enablement explicitly', () => {
    expect(resolveControlPlaneCacheReadConfig({ JANGAR_CONTROL_PLANE_CACHE_ENABLED: 'true' }).enabled).toBe(true)
    expect(resolveControlPlaneCacheReadConfig({}).clusterId).toBe('default')
  })
})

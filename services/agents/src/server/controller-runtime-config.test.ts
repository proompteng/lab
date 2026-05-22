import { describe, expect, it } from 'vitest'

import {
  isControllerClusterScoped,
  resolveControlPlaneCacheConfig,
  resolveOrchestrationControllerConfig,
  resolvePrimitivesReconcilerConfig,
  resolveSupportingControllerConfig,
} from './controller-runtime-config'

describe('Agents controller runtime config', () => {
  it('reads canonical AGENTS control-plane cache env names', () => {
    const config = resolveControlPlaneCacheConfig({
      AGENTS_CONTROL_PLANE_CACHE_ENABLED: 'true',
      AGENTS_CONTROL_PLANE_CACHE_NAMESPACES: 'agents,agents-system',
      AGENTS_CONTROL_PLANE_CACHE_CLUSTER: 'prod-agents',
    })

    expect(config).toEqual({
      enabled: true,
      namespaces: ['agents', 'agents-system'],
      clusterId: 'prod-agents',
      resyncSeconds: 60,
      maxPendingWrites: 5000,
    })
  })

  it('bounds control-plane cache resync and write queue settings', () => {
    expect(
      resolveControlPlaneCacheConfig({
        AGENTS_CONTROL_PLANE_CACHE_RESYNC_SECONDS: '30',
        AGENTS_CONTROL_PLANE_CACHE_MAX_PENDING_WRITES: '750',
      }),
    ).toMatchObject({
      resyncSeconds: 30,
      maxPendingWrites: 750,
    })

    expect(
      resolveControlPlaneCacheConfig({
        AGENTS_CONTROL_PLANE_CACHE_RESYNC_SECONDS: '1',
        AGENTS_CONTROL_PLANE_CACHE_MAX_PENDING_WRITES: '12',
      }),
    ).toMatchObject({
      resyncSeconds: 60,
      maxPendingWrites: 5000,
    })
  })

  it('uses canonical AGENTS cluster-scoped env for wildcard namespace admission', () => {
    expect(isControllerClusterScoped({ AGENTS_RBAC_CLUSTER_SCOPED: '1' })).toBe(true)
    expect(
      resolveControlPlaneCacheConfig({
        AGENTS_RBAC_CLUSTER_SCOPED: '1',
        AGENTS_CONTROL_PLANE_CACHE_NAMESPACES: '*',
      }).namespaces,
    ).toEqual(['*'])
  })

  it('reads canonical AGENTS controller env names for generic controller toggles', () => {
    expect(
      resolveOrchestrationControllerConfig({
        AGENTS_ORCHESTRATION_CONTROLLER_ENABLED: 'false',
        AGENTS_ORCHESTRATION_CONTROLLER_NAMESPACES: 'agents',
        AGENTS_ORCHESTRATION_CONTROLLER_ENABLED_FLAG_KEY: 'agents.orchestration.enabled',
      }),
    ).toEqual({
      enabled: false,
      namespaces: ['agents'],
      enabledFlagKey: 'agents.orchestration.enabled',
    })

    expect(
      resolvePrimitivesReconcilerConfig({
        AGENTS_PRIMITIVES_RECONCILER: 'false',
        AGENTS_PRIMITIVES_NAMESPACES: 'agents',
        AGENTS_PRIMITIVES_RECONCILER_FLAG_KEY: 'agents.primitives.enabled',
      }),
    ).toEqual({
      enabled: false,
      namespaces: ['agents'],
      enabledFlagKey: 'agents.primitives.enabled',
    })

    expect(
      resolveSupportingControllerConfig({
        AGENTS_SUPPORTING_CONTROLLER_ENABLED: 'false',
        AGENTS_SUPPORTING_CONTROLLER_NAMESPACES: 'agents',
        AGENTS_SUPPORTING_CONTROLLER_ENABLED_FLAG_KEY: 'agents.supporting.enabled',
      }),
    ).toEqual({
      enabled: false,
      namespaces: ['agents'],
      enabledFlagKey: 'agents.supporting.enabled',
    })
  })
})

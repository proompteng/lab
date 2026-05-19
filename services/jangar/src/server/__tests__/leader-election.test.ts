import { afterEach, describe, expect, it } from 'vitest'

import * as agentsLeaderElection from '@proompteng/agents/server/leader-election'

import * as jangarLeaderElection from '../leader-election'

describe('Jangar leader election compatibility exports', () => {
  afterEach(() => {
    delete (globalThis as typeof globalThis & { __jangarLeaderElection?: unknown }).__jangarLeaderElection
  })

  it('delegates runtime ownership to the Agents service package', () => {
    expect(jangarLeaderElection.ensureLeaderElectionRuntime).toBe(agentsLeaderElection.ensureLeaderElectionRuntime)
    expect(jangarLeaderElection.isLeaderElectionRequired).toBe(agentsLeaderElection.isLeaderElectionRequired)
  })

  it('preserves the legacy Jangar leader-election global while routes migrate', () => {
    ;(globalThis as typeof globalThis & { __jangarLeaderElection?: unknown }).__jangarLeaderElection = {
      status: {
        enabled: true,
        required: true,
        isLeader: false,
        leaseName: 'lease',
        leaseNamespace: 'jangar',
        identity: 'pod_123',
        lastTransitionAt: null,
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastError: null,
      },
    }

    expect(jangarLeaderElection.getLeaderElectionStatus().isLeader).toBe(false)
    expect(jangarLeaderElection.isLeaderForControllers()).toBe(false)
    expect(jangarLeaderElection.requireLeaderForMutationHttp()?.status).toBe(503)
  })
})

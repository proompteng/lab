import { afterEach, describe, expect, it } from 'vitest'

import * as jangarLeaderElection from '../leader-election'

describe('Jangar leader election runtime', () => {
  afterEach(() => {
    delete (globalThis as typeof globalThis & { __jangarLeaderElection?: unknown }).__jangarLeaderElection
  })

  it('owns runtime exports locally without Agents internals', () => {
    expect(typeof jangarLeaderElection.ensureLeaderElectionRuntime).toBe('function')
    expect(typeof jangarLeaderElection.isLeaderElectionRequired).toBe('function')
    expect(jangarLeaderElection.getLeaderElectionStatus()).toMatchObject({
      enabled: true,
      required: false,
      isLeader: true,
    })
  })

  it('preserves the Jangar leader-election global for migrated routes', () => {
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

import { describe, expect, it, vi } from 'vitest'

import { PROVIDER_CAPACITY_EXHAUSTED_REASON } from './provider-capacity'
import { createResourceReconcilers } from './resource-reconcilers'

type SetStatus = (kube: unknown, resource: Record<string, unknown>, status: Record<string, unknown>) => Promise<void>

const createSetStatus = () => vi.fn<SetStatus>(async () => undefined)

const lastStatus = (setStatus: ReturnType<typeof createSetStatus>) => {
  const call = setStatus.mock.calls.at(-1)
  if (!call) {
    throw new Error('expected a status update')
  }
  return call[2]
}

const createReconcilers = (setStatus: SetStatus) =>
  createResourceReconcilers({
    setStatus,
    nowIso: () => '2026-05-18T14:00:00.000Z',
    implementationTextLimit: 128 * 1024,
    resolveVcsAuthMethod: () => 'token',
    validateVcsAuthConfig: () => ({ ok: true }),
    parseIntOrString: (value) => (typeof value === 'string' || typeof value === 'number' ? String(value) : null),
    resolveAuthSecretConfig: () => null,
    resolveSecretValue: () => null,
    secretHasKey: () => true,
    validateAutonomousCodexAuthSecret: () => ({ ok: true }),
  })

describe('agents controller resource reconcilers', () => {
  it('degrades a shared provider after a recent capacity failure without blocking new runs by default', async () => {
    const setStatus = createSetStatus()
    const { reconcileAgentProvider } = createReconcilers(setStatus)
    const provider = {
      metadata: { name: 'codex-spark', namespace: 'agents', generation: 7 },
      spec: { binary: '/usr/local/bin/agent-runner' },
    }
    const agents = [{ metadata: { name: 'codex-agent' }, spec: { providerRef: { name: 'codex-spark' } } }]
    const runs = [
      {
        metadata: { name: 'run-capacity', creationTimestamp: '2026-05-18T13:55:00.000Z' },
        spec: { agentRef: { name: 'codex-agent' } },
        status: {
          phase: 'Failed',
          reason: PROVIDER_CAPACITY_EXHAUSTED_REASON,
          message: 'provider capacity exhausted: Quota exceeded. Check your plan and billing details.',
        },
      },
    ]

    await reconcileAgentProvider({ get: vi.fn() }, provider, agents, runs)

    const status = lastStatus(setStatus)
    expect(status.observedGeneration).toBe(7)
    expect(status.conditions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'Ready',
          status: 'True',
          reason: 'ValidSpec',
        }),
        expect.objectContaining({
          type: 'Degraded',
          status: 'True',
          reason: PROVIDER_CAPACITY_EXHAUSTED_REASON,
          message: expect.stringContaining('latest failed AgentRun run-capacity'),
        }),
      ]),
    )
  })

  it('marks a provider not ready after a recent capacity failure when capacity policy is block', async () => {
    const setStatus = createSetStatus()
    const { reconcileAgentProvider } = createReconcilers(setStatus)
    const provider = {
      metadata: { name: 'dedicated-capacity-provider', namespace: 'agents', generation: 7 },
      spec: {
        binary: '/usr/local/bin/agent-runner',
        health: { capacityFailurePolicy: 'block' },
      },
    }
    const agents = [
      {
        metadata: { name: 'dedicated-capacity-agent' },
        spec: { providerRef: { name: 'dedicated-capacity-provider' } },
      },
    ]
    const runs = [
      {
        metadata: { name: 'run-capacity', creationTimestamp: '2026-05-18T13:55:00.000Z' },
        spec: { agentRef: { name: 'dedicated-capacity-agent' } },
        status: {
          phase: 'Failed',
          reason: PROVIDER_CAPACITY_EXHAUSTED_REASON,
          message: 'provider capacity exhausted: Quota exceeded. Check your plan and billing details.',
        },
      },
    ]

    await reconcileAgentProvider({ get: vi.fn() }, provider, agents, runs)

    const status = lastStatus(setStatus)
    expect(status.conditions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'Ready',
          status: 'False',
          reason: PROVIDER_CAPACITY_EXHAUSTED_REASON,
          message: expect.stringContaining('latest failed AgentRun run-capacity'),
        }),
        expect.objectContaining({
          type: 'Degraded',
          status: 'True',
          reason: PROVIDER_CAPACITY_EXHAUSTED_REASON,
        }),
      ]),
    )
  })

  it('clears provider capacity degradation after a newer success', async () => {
    const setStatus = createSetStatus()
    const { reconcileAgentProvider } = createReconcilers(setStatus)
    const provider = {
      metadata: { name: 'codex-spark', namespace: 'agents' },
      spec: { binary: '/usr/local/bin/agent-runner' },
    }
    const agents = [{ metadata: { name: 'codex-agent' }, spec: { providerRef: { name: 'codex-spark' } } }]
    const runs = [
      {
        metadata: { name: 'run-capacity', creationTimestamp: '2026-05-18T13:20:00.000Z' },
        spec: { agentRef: { name: 'codex-agent' } },
        status: {
          phase: 'Failed',
          reason: PROVIDER_CAPACITY_EXHAUSTED_REASON,
        },
      },
      {
        metadata: { name: 'run-ok', creationTimestamp: '2026-05-18T13:55:00.000Z' },
        spec: { agentRef: { name: 'codex-agent' } },
        status: { phase: 'Succeeded' },
      },
    ]

    await reconcileAgentProvider({ get: vi.fn() }, provider, agents, runs)

    const status = lastStatus(setStatus)
    expect(status.conditions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'Ready', status: 'True', reason: 'ValidSpec' }),
        expect.objectContaining({ type: 'Degraded', status: 'False', reason: 'Healthy' }),
      ]),
    )
  })
})

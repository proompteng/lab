import { describe, expect, it } from 'vitest'

import { buildResourceFingerprint, shouldApplyStatus } from '~/server/status-utils'

describe('status utils', () => {
  it('ignores updatedAt and condition transition timestamps when comparing status', () => {
    const current = {
      phase: 'Running',
      updatedAt: '2026-01-20T00:00:00Z',
      conditions: [
        {
          type: 'Ready',
          status: 'True',
          reason: 'Ok',
          message: '',
          lastTransitionTime: '2026-01-20T00:00:00Z',
        },
      ],
    }

    const next = {
      phase: 'Running',
      updatedAt: '2026-01-20T00:01:00Z',
      conditions: [
        {
          type: 'Ready',
          status: 'True',
          reason: 'Ok',
          message: '',
          lastTransitionTime: '2026-01-20T00:01:00Z',
        },
      ],
    }

    expect(shouldApplyStatus(current, next)).toBe(false)
  })

  it('detects meaningful status changes', () => {
    const current = {
      phase: 'Running',
      conditions: [
        {
          type: 'Ready',
          status: 'True',
          reason: 'Ok',
          message: '',
        },
      ],
    }

    const next = {
      ...current,
      phase: 'Failed',
    }

    expect(shouldApplyStatus(current, next)).toBe(true)
  })

  it('buildResourceFingerprint ignores managed fields and volatile status', () => {
    const base = {
      apiVersion: 'agents.proompteng.ai/v1alpha1',
      kind: 'Agent',
      metadata: {
        name: 'agent-1',
        namespace: 'agents',
        resourceVersion: '1',
        managedFields: [{ manager: 'kubectl' }],
      },
      spec: { runtime: { type: 'job' } },
      status: {
        updatedAt: '2026-01-20T00:00:00Z',
        conditions: [
          {
            type: 'Ready',
            status: 'True',
            reason: 'Ok',
            message: '',
            lastTransitionTime: '2026-01-20T00:00:00Z',
          },
        ],
      },
    }

    const updated = {
      ...base,
      metadata: { ...base.metadata, resourceVersion: '2' },
      status: {
        ...base.status,
        updatedAt: '2026-01-20T00:01:00Z',
        conditions: [
          {
            type: 'Ready',
            status: 'True',
            reason: 'Ok',
            message: '',
            lastTransitionTime: '2026-01-20T00:01:00Z',
          },
        ],
      },
    }

    expect(buildResourceFingerprint(base)).toBe(buildResourceFingerprint(updated))
  })
})
